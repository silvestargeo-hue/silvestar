"""Silvestar Platform API — FastAPI application.

Modules:
  1. Next.js frontend (separate app, talks to this API)
  2. FastAPI core (this app)
  3. RAG engine (cross-library)           → /api/v1/rag, /api/v1/ask
  4. Archive Library (public search)      → /api/v1/archive
  5. Personal Vault (encrypted)           → /api/v1/vault
  6. Realtime (WS + LiveKit)              → /ws/{room}, /api/v1/rooms
  7. Knowledge graph (Neo4j)              → /api/v1/graph
  8. Cache (Redis)                        → internal + /api/v1/health
  9. Silvestar AI assistant               → /api/v1/ask, /api/v1/ai
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import settings
from .core import rag, security
from .core.ai import ai
from .core.cache import cache
from .core.db import db
from .core.graph import graph
from .core.realtime import Client, hub, livekit
from .core.vault import VaultError, vault


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    await cache.connect()
    await graph.connect()
    yield
    await db.close()
    await cache.close()
    await graph.close()


app = FastAPI(title=settings.app_name, version=settings.version, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

started_at = time.time()


# ---------------------------------------------------------------- schemas ----
class DocIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=200_000)
    source: str = ""
    tags: list[str] = []


class SearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    limit: int = Field(default=8, ge=1, le=50)


class VaultCreateIn(BaseModel):
    user_id: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=8, max_length=128)


class VaultUnlockIn(BaseModel):
    user_id: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=8, max_length=128)


class VaultDocIn(BaseModel):
    user_id: str
    session_token: str
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=200_000)


class VaultSessionIn(BaseModel):
    user_id: str
    session_token: str


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    user_id: str = "anon"
    vault_session_token: str = ""
    history: list[dict] = []


class GraphNodeIn(BaseModel):
    id: str
    labels: list[str] = ["Node"]
    props: dict = {}


class GraphEdgeIn(BaseModel):
    src: str
    rel: str
    dst: str
    props: dict = {}


# ------------------------------------------------------------------ health ---
@app.get("/api/v1/health")
async def health():
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": settings.version,
        "uptime_s": int(time.time() - started_at),
        "db": await db.health(),
        "cache": await cache.health(),
        "graph": await graph.health(),
        "vault": await vault.stats(),
        "ai": await ai.health(),
        "livekit": {"enabled": livekit.enabled()},
        "realtime": hub.stats(),
    }


@app.get("/")
async def root():
    return {"service": settings.app_name, "docs": "/docs", "health": "/api/v1/health"}


# ------------------------------------------------- Module 4: Archive Library --
@app.post("/api/v1/archive/documents", tags=["archive"])
async def archive_add(doc: DocIn):
    import uuid
    doc_id = "a-" + uuid.uuid4().hex[:12]
    saved = await db.upsert_document(
        doc_id, "archive", doc.title, doc.content,
        meta={"source": doc.source, "tags": doc.tags},
    )
    await cache.delete("archive:stats")
    await graph.merge_node(doc_id, ["Document"], {"title": doc.title, "library": "archive"})
    return saved


@app.get("/api/v1/archive/documents", tags=["archive"])
async def archive_list(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    docs, total = await db.list("archive", limit, offset)
    return {"documents": docs, "total": total, "limit": limit, "offset": offset}


@app.get("/api/v1/archive/search", tags=["archive"])
async def archive_search(q: str = Query(..., min_length=1, max_length=500),
                         limit: int = Query(8, ge=1, le=50),
                         user_id: str = "anon",
                         vault_session_token: str = ""):
    """Public global search across the Archive AND (when unlocked) the user's Vault."""
    session = await vault.validate(user_id, vault_session_token) if vault_session_token else None
    hits = await rag.retrieve(q, user_id, session, limit_per_lib=limit)
    return {
        "query": q,
        "results": [
            {"doc_id": h.doc_id, "library": h.library, "title": h.title,
             "snippet": h.snippet, "score": h.score, "fingerprint": h.fingerprint}
            for h in hits
        ],
        "vault_included": bool(session and session.valid),
    }


@app.get("/api/v1/archive/documents/{doc_id}", tags=["archive"])
async def archive_get(doc_id: str):
    doc = await db.fetch(doc_id)
    if not doc or doc["library"] != "archive":
        raise HTTPException(404, "archive document not found")
    return doc


@app.delete("/api/v1/archive/documents/{doc_id}", tags=["archive"])
async def archive_delete(doc_id: str):
    doc = await db.fetch(doc_id)
    if not doc or doc["library"] != "archive":
        raise HTTPException(404, "archive document not found")
    ok = await db.delete(doc_id)
    await cache.delete("archive:stats")
    return {"deleted": ok}


@app.get("/api/v1/archive/stats", tags=["archive"])
async def archive_stats():
    cached = await cache.get("archive:stats")
    if cached:
        import orjson
        return orjson.loads(cached)
    docs, total = await db.list("archive", limit=1)
    stats = {"total_documents": total, "mode": db.mode}
    await cache.set("archive:stats", __import__("json").dumps(stats), ttl=30)
    return stats


# ------------------------------------------------- Module 5: Personal Vault ---
@app.post("/api/v1/vault/create", tags=["vault"])
async def vault_create(body: VaultCreateIn):
    try:
        return await vault.create_vault(body.user_id, body.password)
    except VaultError as e:
        raise HTTPException(409, str(e))


@app.post("/api/v1/vault/unlock", tags=["vault"])
async def vault_unlock(body: VaultUnlockIn):
    try:
        return await vault.unlock(body.user_id, body.password)
    except VaultError as e:
        raise HTTPException(401, str(e))


@app.post("/api/v1/vault/lock", tags=["vault"])
async def vault_lock(body: VaultSessionIn):
    return {"locked": await vault.lock(body.session_token)}


@app.post("/api/v1/vault/documents", tags=["vault"])
async def vault_add(body: VaultDocIn):
    try:
        return await vault.add_document(body.user_id, body.session_token, body.title, body.content)
    except VaultError as e:
        raise HTTPException(401, str(e))


@app.get("/api/v1/vault/documents", tags=["vault"])
async def vault_list(user_id: str, session_token: str):
    try:
        docs = await vault.list_documents(user_id, session_token)
        return {"documents": docs, "count": len(docs)}
    except VaultError as e:
        raise HTTPException(401, str(e))


@app.delete("/api/v1/vault/documents/{doc_id}", tags=["vault"])
async def vault_delete(doc_id: str, user_id: str, session_token: str):
    try:
        ok = await vault.delete_document(user_id, session_token, doc_id)
    except VaultError as e:
        raise HTTPException(401, str(e))
    if not ok:
        raise HTTPException(404, "vault document not found")
    return {"deleted": True}


# ------------------------------------------------------- Module 3/9: RAG+AI ---
@app.post("/api/v1/rag/query", tags=["rag"])
async def rag_query(body: AskIn):
    session = None
    if body.vault_session_token:
        session = await vault.validate(body.user_id, body.vault_session_token)
    context, cited = await rag.build_context(body.question, body.user_id, session)
    return {
        "context": context,
        "citations": [{"i": i, "library": c.library, "title": c.title,
                       "score": c.score, "doc_id": c.doc_id, "snippet": c.snippet[:200]}
                      for i, c in enumerate(cited, 1)],
        "vault_unlocked": bool(session and session.valid),
    }


@app.post("/api/v1/ask", tags=["ai"])
async def ask(body: AskIn):
    return await ai.chat(body.question, body.user_id, body.vault_session_token, body.history)


@app.get("/api/v1/ai/health", tags=["ai"])
async def ai_health():
    return await ai.health()


# ------------------------------------------------------- Module 6: Realtime ---
@app.get("/api/v1/rooms", tags=["realtime"])
async def rooms():
    return {"rooms": hub.stats(), "livekit": livekit.enabled()}


@app.get("/api/v1/rooms/{room}/token", tags=["realtime"])
async def room_token(room: str, identity: str = "guest"):
    return livekit.token_for(room, identity)


@app.websocket("/ws/{room}")
async def ws_endpoint(ws: WebSocket, room: str, user: str = "guest"):
    client = Client(ws=ws, room=room, user=user)
    await hub.join(client)
    try:
        while True:
            raw = await ws.receive_text()
            await hub.handle_message(client, raw)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.leave(client)


# ---------------------------------------------------------- Module 7: Graph ---
@app.post("/api/v1/graph/nodes", tags=["graph"])
async def graph_node(body: GraphNodeIn):
    return await graph.merge_node(body.id, body.labels, body.props)


@app.post("/api/v1/graph/edges", tags=["graph"])
async def graph_edge(body: GraphEdgeIn):
    for nid in (body.src, body.dst):
        if not await graph.neighbors(nid) and nid not in ("",):
            # auto-create dangling endpoint nodes so edges always resolve
            await graph.merge_node(nid, ["Node"], {})
    return await graph.merge_edge(body.src, body.rel, body.dst, body.props)


@app.get("/api/v1/graph/neighbors/{node_id}", tags=["graph"])
async def graph_neighbors(node_id: str, rel: Optional[str] = None, direction: str = "out"):
    return {"node_id": node_id, "neighbors": await graph.neighbors(node_id, rel, direction)}


@app.get("/api/v1/graph/path", tags=["graph"])
async def graph_path(src: str, dst: str, max_depth: int = 4):
    path = await graph.path(src, dst, max_depth)
    if path is None:
        raise HTTPException(404, f"no path between {src} and {dst} within {max_depth} hops")
    return {"src": src, "dst": dst, "path": path}


@app.get("/api/v1/graph/query", tags=["graph"])
async def graph_query(q: str):
    return {"results": await graph.query(q)}


@app.get("/api/v1/graph/stats", tags=["graph"])
async def graph_stats():
    return await graph.stats()


# ------------------------------------------- Modules 10-11: Admin/User panels ---
def _require_admin(request: Request) -> None:
    key = request.headers.get("x-admin-key", "")
    if not key or key != settings.admin_key:
        raise HTTPException(403, "admin key required")


class AdminDocIn(BaseModel):
    title: str
    content: str
    tags: list[str] = []


class ModelIn(BaseModel):
    model: str = ""


@app.get("/api/v1/admin/overview", tags=["admin"])
async def admin_overview(request: Request):
    _require_admin(request)
    _docs, total = await db.list("archive", limit=1)
    try:
        realtime_info = hub.stats() if hasattr(hub, "stats") else {"rooms": "n/a"}
    except Exception:
        realtime_info = {"rooms": 0}
    model_override = await cache.get("ai:model")
    return {
        "archive_documents": total,
        "vault": await vault.stats(),
        "realtime": realtime_info,
        "graph": await graph.stats(),
        "ai": {**await ai.health(), "model_override": model_override, "configured_model": settings.ai_model},
        "modes": {"db": (await db.health()).get("mode"), "cache": (await cache.health()).get("mode")},
        "uptime_s": int(time.time() - started_at),
    }


@app.post("/api/v1/admin/documents", tags=["admin"])
async def admin_add_document(request: Request, body: AdminDocIn):
    _require_admin(request)
    import uuid

    doc_id = "a-" + uuid.uuid4().hex[:12]
    saved = await db.upsert_document(
        doc_id, "archive", body.title, body.content,
        meta={"source": "admin", "tags": body.tags},
    )
    await cache.delete("archive:stats")
    await graph.merge_node(doc_id, ["Document"], {"title": body.title, "library": "archive"})
    return saved


@app.delete("/api/v1/admin/documents/{doc_id}", tags=["admin"])
async def admin_delete_document(doc_id: str, request: Request):
    _require_admin(request)
    doc = await db.fetch(doc_id)
    if not doc:
        raise HTTPException(404, "document not found")
    await db.delete(doc_id)
    await cache.delete("archive:stats")
    return {"deleted": True}


@app.post("/api/v1/admin/cache/clear", tags=["admin"])
async def admin_cache_clear(request: Request):
    _require_admin(request)
    await cache.clear()
    return {"cleared": True}


@app.post("/api/v1/admin/ai/model", tags=["admin"])
async def admin_set_ai_model(request: Request, body: ModelIn):
    """Runtime AI model switch — persisted in cache, applied on next ask."""
    _require_admin(request)
    if body.model:
        await cache.set("ai:model", body.model)
    else:
        await cache.delete("ai:model")
    return {"active_model": body.model or settings.ai_model, "persisted": bool(body.model)}


@app.get("/api/v1/me/stats", tags=["user"])
async def me_stats(user_id: str = Query(...), session_token: str = Query("")):
    session = await vault.validate(user_id, session_token) if session_token else None
    _docs, archive_total = await db.list("archive", limit=1)
    vault_count = 0
    if session and session.valid:
        vault_docs, _ = await db.list(f"vault:{user_id}", limit=200)
        vault_count = len(vault_docs)
    recent, _t = await db.list("archive", limit=5)
    ai_h = await ai.health()
    return {
        "user_id": user_id,
        "vault_unlocked": bool(session and session.valid),
        "vault_documents": vault_count,
        "archive_documents": archive_total,
        "recent_archive": [{"id": d["id"], "title": d["title"]} for d in recent],
        "ai": {"assistant": ai_h.get("assistant"), "reachable": ai_h.get("primary_reachable")},
    }
