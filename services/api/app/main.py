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
async def _require_admin(request: Request) -> None:
    key = request.headers.get("x-admin-key", "")
    if key and key == settings.admin_key:
        return
    authz = request.headers.get("authorization", "")
    if authz.startswith("Bearer "):
        user = await auth.validate_session(authz[7:])
        if user and user.get("role") == "admin" and user.get("status") == "active":
            return
    raise HTTPException(403, "admin key or admin session required")


class AdminDocIn(BaseModel):
    title: str
    content: str
    tags: list[str] = []


class ModelIn(BaseModel):
    model: str = ""


@app.get("/api/v1/admin/overview", tags=["admin"])
async def admin_overview(request: Request):
    await _require_admin(request)
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
    await _require_admin(request)
    import uuid

    doc_id = "a-" + uuid.uuid4().hex[:12]
    saved = await db.upsert_document(
        doc_id, "archive", body.title, body.content,
        meta={"source": "admin", "tags": body.tags},
    )
    await cache.delete("archive:stats")
    await graph.merge_node(doc_id, ["Document"], {"title": body.title, "library": "archive"})
    await _audit("admin.publish", f"doc={doc_id} title={body.title[:60]}")
    return saved


@app.delete("/api/v1/admin/documents/{doc_id}", tags=["admin"])
async def admin_delete_document(doc_id: str, request: Request):
    await _require_admin(request)
    doc = await db.fetch(doc_id)
    if not doc:
        raise HTTPException(404, "document not found")
    await db.delete(doc_id)
    await cache.delete("archive:stats")
    await _audit("admin.delete", f"doc={doc_id}")
    return {"deleted": True}


@app.post("/api/v1/admin/cache/clear", tags=["admin"])
async def admin_cache_clear(request: Request):
    await _require_admin(request)
    await cache.clear()
    await _audit("admin.cache_clear", "")
    return {"cleared": True}


@app.post("/api/v1/admin/ai/model", tags=["admin"])
async def admin_set_ai_model(request: Request, body: ModelIn):
    """Runtime AI model switch — persisted in cache, applied on next ask."""
    await _require_admin(request)
    if body.model:
        await cache.set("ai:model", body.model)
    else:
        await cache.delete("ai:model")
    await _audit("admin.model_switch", f"model={body.model or 'default'}")
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


# ----------------------------------------- Module 4+: library power tools ---
class ImportIn(BaseModel):
    documents: list[DocIn] = Field(default_factory=list)


class RevisionIn(BaseModel):
    title: str
    content: str


@app.get("/api/v1/archive/export")
async def archive_export():
    docs, _total = await db.list("archive", limit=1000)
    return {"format": "silvestar-archive-v1", "count": len(docs), "documents": docs}


@app.post("/api/v1/archive/import")
async def archive_import(body: ImportIn):
    import uuid

    added: list[str] = []
    for d in body.documents[:500]:
        doc_id = "a-" + uuid.uuid4().hex[:12]
        await db.upsert_document(doc_id, "archive", d.title, d.content,
                                 meta={"source": "import", "tags": d.tags})
        added.append(doc_id)
    await cache.delete("archive:stats")
    return {"imported": len(added), "ids": added}


@app.get("/api/v1/archive/rss")
async def archive_rss():
    from fastapi.responses import Response

    docs, _ = await db.list("archive", limit=50)

    def _x(s: str) -> str:
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    items = "".join(
        f"<item><title>{_x(d['title'])}</title>"
        f"<description>{_x(d.get('snippet', '')[:300])}</description></item>"
        for d in docs
    )
    xml = ("<?xml version=\"1.0\"?><rss version=\"2.0\"><channel>"
           "<title>Silvestar Archive</title><link>/</link>"
           "<description>Latest documents in the public archive</description>"
           f"{items}</channel></rss>")
    return Response(content=xml, media_type="application/rss+xml")


@app.get("/api/v1/archive/related/{doc_id}")
async def archive_related(doc_id: str, limit: int = Query(4, ge=1, le=10)):
    doc = await db.fetch(doc_id)
    if not doc or doc["library"] != "archive":
        raise HTTPException(404, "archive document not found")
    hits = await db.search("archive", doc["title"], limit=limit + 1)
    return {"related": [{"id": h["id"], "title": h["title"],
                         "snippet": h["content"][:160], "score": h["score"]}
                        for h in hits if h["id"] != doc_id][:limit]}


@app.post("/api/v1/archive/digest")
async def archive_digest(limit: int = Query(10, ge=1, le=30)):
    docs, _ = await db.list("archive", limit=limit)
    if not docs:
        return {"summary": "The archive is empty — nothing to digest.", "engine": "none", "count": 0}
    corpus = "\n\n".join(f"## {d['title']}\n{d.get('snippet', '')[:280]}" for d in docs)
    r = await ai.summarize(f"Digest these {len(docs)} archive documents into key themes and a brief bullet summary.", corpus)
    return {**r, "count": len(docs), "digested": [{"id": d["id"], "title": d["title"]} for d in docs]}


@app.put("/api/v1/archive/documents/{doc_id}")
async def archive_update(doc_id: str, body: RevisionIn):
    """Update a document; the previous content is snapshotted as a version."""
    old = await db.fetch(doc_id)
    if not old or old["library"] != "archive":
        raise HTTPException(404, "archive document not found")
    import uuid

    await db.upsert_document("r-" + uuid.uuid4().hex[:10], f"archive-versions:{doc_id}",
                             old["title"], old["content"], meta={"source": "revision"})
    saved = await db.upsert_document(doc_id, "archive", body.title, body.content,
                                     meta={"source": "web-ui", "revised": True})
    await cache.delete("archive:stats")
    return saved


@app.get("/api/v1/archive/documents/{doc_id}/versions")
async def archive_versions(doc_id: str):
    rows, _ = await db.list(f"archive-versions:{doc_id}", limit=50)
    return {"doc_id": doc_id,
            "versions": [{"id": r["id"], "title": r["title"], "snippet": r.get("snippet", "")} for r in rows]}


# ============================ LEVEL-50 WAVE: platform services ============================
class NotifyIn(BaseModel):
    message: str = Field(min_length=1, max_length=280)
    user_id: str = "anon"


async def _notify(user_id: str, message: str) -> None:
    import uuid

    await db.upsert_document(
        "n-" + uuid.uuid4().hex[:12], f"notify:{user_id}",
        message, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        meta={"kind": "notification"},
    )


@app.get("/api/v1/notifications", tags=["user"])
async def notifications(user_id: str = Query(...)):
    rows, total = await db.list(f"notify:{user_id}", limit=30)
    return {"notifications": [
        {"id": r["id"], "message": r["title"], "ts": r.get("snippet", "")}
        for r in rows
    ], "unread": total}


@app.post("/api/v1/notifications", tags=["user"])
async def notify_self(body: NotifyIn):
    """Personal reminder — arrives in your notification center."""
    await _notify(body.user_id, body.message)
    return {"queued": True}


@app.delete("/api/v1/notifications/{nid}", tags=["user"])
async def notification_read(nid: str, user_id: str = Query(...)):
    doc = await db.fetch(nid)
    if not doc or doc["library"] != f"notify:{user_id}":
        raise HTTPException(404, "notification not found")
    await db.delete(nid)
    return {"read": True}


@app.get("/api/v1/stats/public", tags=["user"])
async def public_stats():
    """Landing-page numbers — no auth required."""
    _d, archive_total = await db.list("archive", limit=1)
    try:
        rooms = (hub.stats() or {}).get("rooms", 0) if hasattr(hub, "stats") else 0
    except Exception:
        rooms = 0
    ai_h = await ai.health()
    return {
        "archive_documents": archive_total,
        "active_rooms": rooms,
        "ai_online": bool(ai_h.get("primary_reachable")),
        "assistant": ai_h.get("assistant"),
        "uptime_s": int(time.time() - started_at),
    }


@app.get("/api/v1/metrics", tags=["admin"])
async def metrics():
    async def _c(key: str) -> int:
        v = await cache.get(key)
        return int(v) if v else 0

    return {
        "uptime_s": int(time.time() - started_at),
        "requests_total": await _c("met:req"),
        "ai_asks_total": await _c("met:ask"),
        "searches_total": await _c("met:search"),
        "modes": {"db": (await db.health()).get("mode"), "cache": (await cache.health()).get("mode")},
    }


@app.get("/api/v1/admin/audit", tags=["admin"])
async def admin_audit(request: Request):
    await _require_admin(request)
    rows, total = await db.list("audit-log", limit=50)
    return {"total": total, "entries": [
        {"id": r["id"], "action": r["title"], "detail": r.get("snippet", "")}
        for r in rows
    ]}


async def _audit(action: str, detail: str = "") -> None:
    import uuid

    await db.upsert_document(
        "aud-" + uuid.uuid4().hex[:12], "audit-log", action,
        f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {detail}"[:280],
        meta={"kind": "audit"},
    )


@app.get("/api/v1/admin/backup", tags=["admin"])
async def admin_backup(request: Request):
    await _require_admin(request)
    docs, _ = await db.list("archive", limit=1000)
    return {
        "format": "silvestar-backup-v1",
        "created": time.strftime("%Y-%m-%dT%H:%M:%S Z", time.gmtime()).replace(" ", ""),
        "archive": docs,
        "graph": await graph.stats(),
    }


# ====================== Modules 12-13: accounts, auth, user control ======================
from .core.auth import ACCOUNTS_LIB, AuthError, auth  # noqa: E402
from .core.auth import SESSION_TTL, SESSION_TTL_REMEMBER  # noqa: E402


class RegisterIn(BaseModel):
    email: str
    password: str
    display_name: str = ""


class LoginIn(BaseModel):
    email: str
    password: str
    remember: bool = False


class VerifyIn(BaseModel):
    email: str
    code: str


class ProfileIn(BaseModel):
    session_token: str
    display_name: str = ""


class PasswordChangeIn(BaseModel):
    session_token: str
    old_password: str
    new_password: str


class OtpRequestIn(BaseModel):
    email: str


class OtpConfirmIn(BaseModel):
    email: str
    code: str
    new_password: str


class SessionIn(BaseModel):
    session_token: str


async def _current_user(session_token: str) -> dict:
    user = await auth.validate_session(session_token)
    if not user:
        raise HTTPException(401, "session invalid or expired — sign in again")
    return user


@app.post("/api/v1/auth/register", tags=["auth"])
async def auth_register(body: RegisterIn):
    try:
        r = await auth.register(body.email, body.password, body.display_name)
        user = r["user"]
        acct = await auth.authenticate(body.email, body.password)
        token = auth.issue_auth_token(acct)
        await _audit("auth.register", f"{user['email']} role={user['role']}")
        return {"user": user, "session_token": token, "verification": r.get("verification")}
    except AuthError as e:
        raise HTTPException(400, str(e))


@app.post("/api/v1/auth/login", tags=["auth"])
async def auth_login(body: LoginIn):
    try:
        acct = await auth.authenticate(body.email, body.password)
    except AuthError as e:
        raise HTTPException(401, str(e))
    ttl = SESSION_TTL_REMEMBER if body.remember else SESSION_TTL
    token = auth.issue_auth_token(acct, ttl)
    await auth.touch_login(body.email)
    await _audit("auth.login", f"{acct['email']} remember={body.remember}")
    return {"user": auth.public(acct), "session_token": token,
            "expires_in": ttl, "verified": bool(acct.get("verified"))}


@app.post("/api/v1/auth/verify", tags=["auth"])
async def auth_verify(body: VerifyIn):
    try:
        user = await auth.verify_email(body.email, body.code)
    except AuthError as e:
        raise HTTPException(400, str(e))
    await _audit("auth.verified", body.email)
    return {"user": user}


@app.post("/api/v1/auth/verify/resend", tags=["auth"])
async def auth_verify_resend(body: OtpRequestIn):
    r = await auth.resend_verification(body.email)
    return r


@app.post("/api/v1/auth/session", tags=["auth"])
async def auth_session(body: SessionIn):
    user = await auth.validate_session(body.session_token)
    if not user:
        raise HTTPException(401, "session invalid or expired")
    return {"user": user}


@app.post("/api/v1/auth/logout", tags=["auth"])
async def auth_logout(body: SessionIn):
    # Stateless JWT-style token: client discards it; audit the event.
    return {"logged_out": True}


@app.put("/api/v1/auth/profile", tags=["auth"])
async def auth_profile(body: ProfileIn):
    user = await _current_user(body.session_token)
    try:
        updated = await auth.update_display_name(user["email"], body.display_name)
    except AuthError as e:
        raise HTTPException(400, str(e))
    return {"user": updated}


@app.post("/api/v1/auth/password", tags=["auth"])
async def auth_password(body: PasswordChangeIn):
    user = await _current_user(body.session_token)
    try:
        updated = await auth.change_password(user["email"], body.old_password, body.new_password)
    except AuthError as e:
        raise HTTPException(400, str(e))
    await _audit("auth.password_change", user["email"])
    # all old sessions are dead by design — issue a fresh one for THIS device
    acct = await auth.authenticate(user["email"], body.new_password)
    return {"user": updated, "sessions_invalidated": True, "session_token": auth.issue_auth_token(acct)}


@app.post("/api/v1/auth/forgot", tags=["auth"])
async def auth_forgot(body: OtpRequestIn):
    r = await auth.request_reset(body.email)
    await _audit("auth.otp_request", body.email)
    return r


@app.post("/api/v1/auth/reset", tags=["auth"])
async def auth_reset(body: OtpConfirmIn):
    try:
        r = await auth.confirm_reset(body.email, body.code, body.new_password)
    except AuthError as e:
        raise HTTPException(400, str(e))
    await _audit("auth.otp_reset", body.email)
    return r


# --------------------------------------------- admin: full user control ---
def _require_role_admin(user: dict) -> None:
    if user.get("role") != "admin":
        raise HTTPException(403, "admin role required")


async def _other_active_admins(exclude_doc_id: str) -> list[str]:
    """Emails of active admins other than the excluded account doc."""
    rows, _t = await db.list(ACCOUNTS_LIB, limit=500)
    out: list[str] = []
    for r in rows:
        if r["id"] == exclude_doc_id:
            continue
        acct = await auth._account(r["id"].split("::", 1)[1])
        if acct and acct["role"] == "admin" and acct["status"] == "active":
            out.append(acct["email"])
    return out


@app.get("/api/v1/admin/users", tags=["admin"])
async def admin_users(request: Request):
    """Every registered user, for the admin panel."""
    await _require_admin(request)
    rows, total = await db.list(ACCOUNTS_LIB, limit=500)
    users = []
    for r in rows:
        m = r.get("meta", {})
        users.append({
            "email": r["id"].split("::", 1)[1],
            "user_id": m.get("user_id", ""),
            "role": m.get("role", "user"),
            "status": m.get("status", "active"),
            "display_name": r.get("title", ""),
            "created": m.get("created", ""),
            "verified": bool(m.get("verified", False)),
            "last_login": m.get("last_login", ""),
            "vault_documents": await auth.vault_doc_count(m.get("user_id", "")),
        })
    users.sort(key=lambda u: (u["role"] != "admin", u["created"]))
    return {"total": total, "users": users}


@app.post("/api/v1/admin/users/{email}/suspend", tags=["admin"])
async def admin_suspend(email: str, request: Request):
    await _require_admin(request)
    return await _set_user_status(email, "suspended")


@app.post("/api/v1/admin/users/{email}/activate", tags=["admin"])
async def admin_activate(email: str, request: Request):
    await _require_admin(request)
    return await _set_user_status(email, "active")


async def _set_user_status(email: str, status: str) -> dict:
    from .core.auth import _doc_id

    doc = await db.fetch(_doc_id(email))
    if not doc:
        raise HTTPException(404, "user not found")
    meta = doc.get("meta", {})
    if meta.get("role") == "admin" and status == "suspended":
        if not await _other_active_admins(doc["id"]):
            raise HTTPException(400, "cannot suspend the only admin")
    meta["status"] = status
    await db.upsert_document(_doc_id(email), ACCOUNTS_LIB, doc["title"], doc["content"], meta=meta)
    await _audit("admin.user_status", f"{email} → {status}")
    return {"email": email, "status": status}


@app.post("/api/v1/admin/users/{email}/promote", tags=["admin"])
async def admin_promote(email: str, request: Request):
    await _require_admin(request)
    return await _set_user_role(email, "admin")


@app.post("/api/v1/admin/users/{email}/demote", tags=["admin"])
async def admin_demote(email: str, request: Request):
    await _require_admin(request)
    return await _set_user_role(email, "user")


async def _set_user_role(email: str, role: str) -> dict:
    from .core.auth import _doc_id

    doc = await db.fetch(_doc_id(email))
    if not doc:
        raise HTTPException(404, "user not found")
    meta = doc.get("meta", {})
    if meta.get("role") == "admin" and role == "user":
        if not await _other_active_admins(doc["id"]):
            raise HTTPException(400, "cannot demote the only admin")
    meta["role"] = role
    await db.upsert_document(_doc_id(email), ACCOUNTS_LIB, doc["title"], doc["content"], meta=meta)
    await _audit("admin.user_role", f"{email} → {role}")
    return {"email": email, "role": role}


@app.post("/api/v1/admin/users/{email}/reset-password", tags=["admin"])
async def admin_reset_password(email: str, request: Request):
    """Admin sets a temporary password; the user changes it after signing in."""
    await _require_admin(request)
    import secrets as _s

    temp = "Tmp-" + _s.token_urlsafe(6)
    from .core.auth import _doc_id

    doc = await db.fetch(_doc_id(email))
    if not doc:
        raise HTTPException(404, "user not found")
    acct = {
        "hash": doc["content"], "salt": doc["meta"].get("salt", ""),
        "iterations": int(doc["meta"].get("iterations", 200000)),
    }
    rec = security.hash_password(temp)
    meta = doc.get("meta", {})
    meta.update({"salt": rec["salt"], "iterations": rec["iterations"]})
    await db.upsert_document(_doc_id(email), ACCOUNTS_LIB, doc["title"], rec["hash"], meta=meta)
    await _audit("admin.user_reset_password", email)
    return {"email": email, "temporary_password": temp}


@app.delete("/api/v1/admin/users/{email}", tags=["admin"])
async def admin_delete_user(email: str, request: Request):
    await _require_admin(request)
    from .core.auth import _doc_id

    doc = await db.fetch(_doc_id(email))
    if not doc:
        raise HTTPException(404, "user not found")
    meta = doc.get("meta", {})
    if meta.get("role") == "admin":
        if not await _other_active_admins(doc["id"]):
            raise HTTPException(400, "cannot delete the only admin")
    await db.delete(_doc_id(email))
    await _audit("admin.user_delete", email)
    return {"deleted": True}


@app.middleware("http")
async def telemetry(request: Request, call_next):
    import time as _t

    t0 = _t.perf_counter()
    response = await call_next(request)
    ms = (_t.perf_counter() - t0) * 1000
    response.headers["X-Response-Time"] = f"{ms:.1f}ms"
    try:
        await cache.incr("met:req", ttl=86400)
        path = request.url.path
        if path.endswith("/ask"):
            await cache.incr("met:ask", ttl=86400)
        elif "/search" in path:
            await cache.incr("met:search", ttl=86400)
    except Exception:
        pass
    return response
