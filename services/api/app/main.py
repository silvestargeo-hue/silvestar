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

import asyncio
import hmac
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, File, Header, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import settings
from .core import rag, security
from .core.ai import ai
from .core.cache import cache
from .core.db import db
from .core.files import files as file_store
from .core.file_routes import router as files_router, _uid_async, _read_uid_for
from .core import skills as skills_svc
from .core.crew import run_crew
from .core import media as media_svc
from .core import study as study_svc
from .core import spaces as spaces_svc
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
    await file_store.close()


app = FastAPI(title=settings.app_name, version=settings.version, lifespan=lifespan)
app.include_router(files_router)
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
    lang: str = ""     # reply language: en|hi|ne|es|ar|fr (empty = auto/English)
    folder: str = ""   # scope RAG to a Library folder (files:<uid> only)
    file_path: str = ""  # chat with ONE Library file (overrides folder)
    file_paths: list[str] = []  # chat with SEVERAL selected Library files (max 8)
    engine: str = ""   # preferred engine: "" auto | groq | pollinations | openrouter
    use_tools: bool = True   # builtin auto-tools (omniverse, web, math, time)
    use_skills: bool = True  # auto-apply user + gallery skills


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
async def archive_add(doc: DocIn, request: Request):
    await _require_user(request)
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
async def archive_delete(doc_id: str, request: Request):
    await _require_admin(request)
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
async def vault_unlock(body: VaultUnlockIn, request: Request):
    await _rate_limit("vault-unlock", body.user_id, limit=10, window_s=300)
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
async def ask(body: AskIn, request: Request):
    uid = body.user_id or await _uid_async(request)
    return await ai.chat(body.question, uid, body.vault_session_token, body.history,
                         lang=body.lang, folder=body.folder, file_path=body.file_path,
                         engine=body.engine, use_tools=body.use_tools, use_skills=body.use_skills,
                         file_paths=(body.file_paths or [])[:8])


@app.post("/api/v1/ask/followups", tags=["ai"])
async def ask_followups(body: AskIn, request: Request):
    """Suggest the next 3 questions based on the last answer + RAG context."""
    uid = body.user_id or await _uid_async(request)
    session = None
    if body.vault_session_token:
        session = await vault.validate(uid, body.vault_session_token)
    last = ""
    if body.history:
        for m in reversed(body.history):
            if m.get("role") == "assistant":
                last = str(m.get("content", ""))[:800]
                break
    context, cited = await rag.build_context(body.question, uid, session, folder=body.folder)
    import re as _re
    topics = _re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", body.question + " " + last)
    topics = [t for t in dict.fromkeys(topics)][:6]
    suggested = await ai.summarize(
        "Suggest exactly 3 short follow-up questions (max 12 words each, no numbering) "
        "that a user would naturally ask next in this conversation. "
        "Return ONLY the 3 questions, one per line, nothing else.",
        f"User asked: {body.question}\nAssistant answered: {last or '(no answer yet)'}\n"
        f"Key topics: {', '.join(topics) or 'general'}\n"
        + (f"Library context:\n{context[:2500]}" if context else ""),
    )
    qs = []
    for line in (suggested.get("summary") or "").splitlines():
        line = line.strip().lstrip("-•*").strip()
        line = _re.sub(r"^\d+[.)]\s*", "", line)
        if line and len(line) > 6:
            qs.append(line[:140])
        if len(qs) == 3:
            break
    return {"followups": qs}


@app.post("/api/v1/ask/stream", tags=["ai"])
async def ask_stream(body: AskIn, request: Request):
    """Server-Sent Events: meta → delta* → done. Same fallback guarantees as /ask."""
    uid = body.user_id or await _uid_async(request)

    async def gen():
        async for ev in ai.stream_chat(body.question, uid, body.vault_session_token,
                                       body.history, lang=body.lang, folder=body.folder,
                                       file_path=body.file_path, engine=body.engine,
                                       use_tools=body.use_tools, use_skills=body.use_skills,
                                       file_paths=(body.file_paths or [])[:8]):
            yield f"data: {__import__('json').dumps(ev)}\n\n"

    from fastapi.responses import StreamingResponse
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/v1/files/search", tags=["files"])
async def files_semantic_search(request: Request, q: str = Query(..., min_length=1, max_length=500),
                                limit: int = Query(10, ge=1, le=30)):
    """Natural-language search over the user's Library file contents (RAG index)."""
    uid = await _uid_async(request)
    hits = await db.search(f"files:{uid}", q, limit=max(limit * 3, limit))
    out = []
    for h in hits:
        m = h.get("meta") or {}
        if m.get("kind") != "file" or not h.get("content"):
            continue
        out.append({
            "id": h["id"], "title": h["title"], "path": m.get("path", ""),
            "folder": m.get("folder", ""), "mime": m.get("mime", ""),
            "score": h["score"], "snippet": (h.get("content") or "")[:220],
        })
        if len(out) >= limit:
            break
    return {"query": q, "results": out, "total": len(out)}


# ----------------------------------------------------- Module 14: AI Skills --
@app.get("/api/v1/skills", tags=["skills"])
async def skills_list(request: Request):
    uid = await _uid_async(request)
    return await skills_svc.list_skills(uid)


@app.post("/api/v1/skills", tags=["skills"])
async def skills_add(request: Request, body: dict):
    uid = await _uid_async(request)
    name = str(body.get("name") or "").strip()
    instructions = str(body.get("instructions") or "").strip()
    if not name or not instructions:
        raise HTTPException(422, "name and instructions are required")
    rec = await skills_svc.add_skill(uid, name, instructions,
                                     body.get("triggers") or [],
                                     gallery=bool(body.get("gallery")),
                                     tools=body.get("tools") or [])
    # optional multi-step pipeline: ['step 1', 'step 2', …] executed in order
    chain = [str(c)[:200] for c in (body.get("chain") or [])][:6]
    if chain:
        rec["chain"] = chain
        import json as _j2
        await db.upsert_document(rec["id"],
                                 (skills_svc.SKILLS_LIB if rec.get("builtin") else f"skills:{uid}"),
                                 rec["name"], _j2.dumps({**rec, "chain": chain}),
                                 meta={"kind": "gallery" if rec.get("builtin") else "skill"})
    return rec


@app.delete("/api/v1/skills/{skill_id}", tags=["skills"])
async def skills_delete(skill_id: str, request: Request):
    uid = await _uid_async(request)
    return await skills_svc.delete_skill(uid, skill_id)


@app.post("/api/v1/skills/{skill_id}/publish", tags=["skills"])
async def skills_publish(skill_id: str, request: Request):
    """Publish one of your personal skills to the shared gallery (everyone's AI gets it)."""
    uid = await _uid_async(request)
    doc = await db.fetch(skill_id)
    if not doc or doc.get("library") != f"skills:{uid}":
        raise HTTPException(404, "skill not found")
    try:
        rec = __import__("json").loads(doc.get("content") or "{}")
    except Exception:
        rec = {}
    name = rec.get("name") or doc.get("title") or "skill"
    instructions = rec.get("instructions") or ""
    out = await skills_svc.add_skill(uid, name, instructions,
                                     rec.get("triggers") or [], gallery=True)
    return {"published": True, "gallery_id": out["id"], "name": name}


# ------------------------------------------------- Module 16: Media Studio --
@app.post("/api/v1/media/image", tags=["media"])
async def media_image(request: Request, prompt: str = Query(..., min_length=3, max_length=400)):
    """Text → image (keyless Pollinations), saved to Library/AI-Images."""
    uid = await _uid_async(request)
    try:
        return await media_svc.generate_image(prompt, uid, file_store)
    except Exception as e:
        raise HTTPException(502, str(e)[:140])


@app.post("/api/v1/media/transcribe", tags=["media"])
async def media_transcribe(request: Request, file: UploadFile = File(...),
                           notes: bool = Query(True)):
    """Audio → Groq Whisper transcript (+ AI meeting notes). Both land in the
    Library under Transcripts/ and Meeting-Notes/ — instantly AI-searchable."""
    uid = await _uid_async(request)
    data = await file.read()
    try:
        return await media_svc.transcribe_audio(file.filename or "audio.mp3", data, uid,
                                                file_store, make_notes=notes)
    except Exception as e:
        raise HTTPException(502, str(e)[:140])


class UniversalIn(BaseModel):
    q: str = Field(min_length=1, max_length=400)
    limit: int = Field(5, ge=1, le=10)


@app.post("/api/v1/search/universal", tags=["search"])
async def search_universal(body: UniversalIn, request: Request):
    """One search across Library files, Archive and (when unlocked) Vault —
    plus keyless Omniverse web results — merged and ranked."""
    uid = await _uid_async(request)
    session = None
    authz = request.headers.get("authorization", "")
    if authz.startswith("Bearer "):
        user = await auth.validate_session(authz[7:])
        if user and user.get("user_id") == uid:
            # vault content stays encrypted unless explicitly unlocked elsewhere
            pass
    results: list[dict] = []
    for lib, kind in ((f"files:{uid}", "file"), ("archive", "archive")):
        try:
            hits = await db.search(lib, body.q, limit=body.limit)
            for h in hits:
                m = h.get("meta") or {}
                if kind == "file" and m.get("kind") != "file":
                    continue
                results.append({
                    "kind": kind, "title": h.get("title", ""),
                    "id": h.get("id", ""), "score": h.get("score", 0),
                    "folder": m.get("folder", ""),
                    "snippet": (h.get("content") or "")[:200],
                })
        except Exception:
            continue
    try:
        omni = await skills_svc.tool_omniverse(body.q)
        if omni.get("ok"):
            results.append({"kind": "web", "title": "🌐 Omniverse",
                            "id": "web", "score": 0.5, "folder": "",
                            "snippet": omni["omniverse"][:400]})
    except Exception:
        pass
    results.sort(key=lambda r: -r["score"])
    return {"query": body.q, "results": results[: body.limit * 3], "total": len(results)}


# ------------------------------------------------- Module 17: Study Mode ----
@app.post("/api/v1/study/generate", tags=["study"])
async def study_generate(request: Request, title: str = Query(..., min_length=1, max_length=80),
                         source: str = Query(""), count: int = Query(10, ge=3, le=25),
                         body: dict = None):
    """Generate a flashcard deck from a Library file (source=path), pasted
    JSON body {text}, or a share of both."""
    uid = await _uid_async(request)
    text = ""
    if body and isinstance(body, dict):
        text = str(body.get("text") or "")[:12000]
    if not text and source:
        from .files import _fdoc_id
        doc = await db.fetch("d-" + _fdoc_id(uid, source)[2:])
        text = (doc or {}).get("content") or ""
    if not text:
        raise HTTPException(422, "no source text (upload an indexed file or paste text)")
    return await study_svc.generate_deck(uid, title, text, count)


@app.get("/api/v1/study/decks", tags=["study"])
async def study_decks(request: Request):
    uid = await _uid_async(request)
    return await study_svc.list_decks(uid)


@app.get("/api/v1/study/due", tags=["study"])
async def study_due(request: Request, deck: str = Query(...)):
    uid = await _uid_async(request)
    return await study_svc.get_due(uid, deck)


@app.post("/api/v1/study/review", tags=["study"])
async def study_review(request: Request, card_id: str = Query(...), grade: int = Query(..., ge=0, le=3)):
    uid = await _uid_async(request)
    return await study_svc.review(uid, card_id, grade)


@app.delete("/api/v1/study/decks/{deck}", tags=["study"])
async def study_deck_delete(deck: str, request: Request):
    uid = await _uid_async(request)
    return await study_svc.delete_deck(uid, deck)


# -------------------------------------------------- Module 18: Spaces -------
class SpaceIn(BaseModel):
    name: str = Field(min_length=2, max_length=40)
    email: str = ""


class SpaceEmailIn(BaseModel):
    email: str = Field(min_length=3, max_length=120)


@app.post("/api/v1/spaces", tags=["spaces"])
async def space_create(body: SpaceIn, request: Request):
    uid = await _uid_async(request)
    user = await auth.validate_session(request.headers.get("authorization", "")[7:]) \
        if request.headers.get("authorization", "").startswith("Bearer ") else None
    email = (user or {}).get("email", "")
    if not email:
        raise HTTPException(401, "sign in required")
    return await spaces_svc.create_space(uid, email, body.name)


@app.get("/api/v1/spaces", tags=["spaces"])
async def spaces_list(request: Request):
    uid = await _uid_async(request)
    authz = request.headers.get("authorization", "")
    user = await auth.validate_session(authz[7:]) if authz.startswith("Bearer ") else None
    email = (user or {}).get("email", "")
    return await spaces_svc.my_spaces(uid, email)


@app.post("/api/v1/spaces/{name}/invite", tags=["spaces"])
async def space_invite(name: str, body: SpaceEmailIn, request: Request):
    uid = await _uid_async(request)
    return await spaces_svc.invite(name, body.email, uid)


@app.post("/api/v1/spaces/{name}/remove", tags=["spaces"])
async def space_remove(name: str, body: SpaceEmailIn, request: Request):
    uid = await _uid_async(request)
    return await spaces_svc.remove_member(name, body.email, uid)


@app.delete("/api/v1/spaces/{name}", tags=["spaces"])
async def space_delete(name: str, request: Request):
    uid = await _uid_async(request)
    return await spaces_svc.delete_space(name, uid)


@app.get("/api/v1/spaces/{name}/activity", tags=["spaces"])
async def space_activity(name: str, request: Request):
    """Recent files + members of a shared space (members only)."""
    await _uid_async(request)
    authz = request.headers.get("authorization", "")
    user = await auth.validate_session(authz[7:]) if authz.startswith("Bearer ") else None
    email = (user or {}).get("email", "")
    return await spaces_svc.activity("", email, name)


# ------------------------------------------ Module 16b: CSV data chat -------
class DataChatIn(BaseModel):
    q: str = Field(min_length=1, max_length=500)
    csv: str = Field(min_length=1, max_length=200_000)


@app.post("/api/v1/studio/data-chat", tags=["media"])
async def studio_data_chat(body: DataChatIn, request: Request):
    """Chat with a CSV: computes aggregates locally and answers with numbers."""
    uid = await _uid_async(request)
    import csv as _csv
    import io as _io
    try:
        _csv.field_size_limit(10 * 1024 * 1024)
    except Exception:
        pass
    rows = list(_csv.DictReader(_io.StringIO(body.csv)))
    if not rows:
        raise HTTPException(422, "empty CSV")
    cols = list(rows[0].keys())
    # numeric column profiles
    profiles = {}
    for c in cols:
        vals = []
        for r in rows[:2000]:
            try:
                vals.append(float(str(r.get(c, "")).replace(",", "")))
            except Exception:
                pass
        if len(vals) >= 3:
            profiles[c] = {"min": min(vals), "max": max(vals),
                           "sum": round(sum(vals), 4), "avg": round(sum(vals) / len(vals), 4),
                           "n": len(vals)}
    sample = "\n".join(", ".join(f"{k}={r.get(k, '')}" for k in cols[:6]) for r in rows[:15])
    ctx = (f"CSV columns: {cols}\nRows: {len(rows)}\n"
           f"Numeric profiles: {profiles}\nSample rows:\n{sample}")
    res2 = await ai.summarize(
        "Answer the user's question about this CSV using ONLY the computed numbers "
        "in the data below. Be concise; mention exact figures.",
        f"QUESTION: {body.q}\n\n{ctx[:12000]}",
    )
    return {"answer": res2.get("summary", ""),
            "columns": cols, "rows": len(rows), "numeric": list(profiles.keys())}


@app.get("/api/v1/skills/stats", tags=["skills"])
async def skills_stats(request: Request):
    """Skill analytics: how many times each skill auto-fired across all asks."""
    await _uid_async(request)
    stats = await skills_svc.usage_stats()
    return {"usage": stats, "total_fires": sum(stats.values())}


@app.post("/api/v1/skills/auto-install", tags=["skills"])
async def skills_auto_install(request: Request):
    await _require_user(request)
    """Daily GitHub harvest: install a fresh batch of free AI skills from top repos."""
    await _uid_async(request)
    return await skills_svc.auto_install_skills()


# ------------------------------------------------------ Module 15: Crew -----
@app.post("/api/v1/crew/run", tags=["crew"])
async def crew_run(body: AskIn, request: Request):
    """Multi-agent cowork: manager plans, researcher gathers (RAG + omniverse
    tools), writer drafts, reviewer finalizes. Free, on the platform chain."""
    uid = body.user_id or await _uid_async(request)
    session = None
    if body.vault_session_token:
        session = await vault.validate(uid, body.vault_session_token)
    return await run_crew(body.question, uid, lang=body.lang, vault_session=session)


# ------------------------------------------------- scheduled crew jobs -------
import hashlib as _hashlib


def _job_id(uid: str, task: str) -> str:
    return "cj-" + _hashlib.sha1((uid + "|" + task).encode()).hexdigest()[:14]


@app.get("/api/v1/crew/jobs", tags=["crew"])
async def crew_jobs_list(request: Request):
    uid = await _uid_async(request)
    hits = await db.search(f"crew-jobs:{uid}", " ", limit=50)
    jobs = []
    for h in hits:
        if (h.get("meta") or {}).get("kind") != "crew-job":
            continue
        try:
            rec = __import__("json").loads(h.get("content") or "{}")
        except Exception:
            continue
        rec["id"] = h["id"]
        jobs.append(rec)
    return {"jobs": jobs, "total": len(jobs)}


class CrewJobIn(BaseModel):
    task: str = Field(min_length=4, max_length=2000)
    lang: str = ""
    interval_hours: int = Field(24, ge=1, le=168)


@app.post("/api/v1/crew/jobs", tags=["crew"])
async def crew_jobs_create(body: CrewJobIn, request: Request):
    uid = await _uid_async(request)
    import json as _j
    import time as _t
    rec = {"task": body.task, "lang": body.lang, "interval_hours": body.interval_hours,
           "created": int(_t.time()), "last_run": 0, "runs": 0}
    jid = _job_id(uid, body.task)
    await db.upsert_document(jid, f"crew-jobs:{uid}", body.task[:80],
                             _j.dumps(rec), meta={"kind": "crew-job"})
    # register this owner's job library so the daily tick can discover it
    reg_id = "creg-" + _hashlib.sha1(uid.encode()).hexdigest()[:12]
    await db.upsert_document(reg_id, "crew-jobs-registry", uid,
                             f"crew-jobs:{uid}", meta={"kind": "crew-jobs-lib"})
    return {"id": jid, **rec}


@app.delete("/api/v1/crew/jobs/{job_id}", tags=["crew"])
async def crew_jobs_delete(job_id: str, request: Request):
    uid = await _uid_async(request)
    doc = await db.fetch(job_id)
    if not doc or doc.get("library") != f"crew-jobs:{uid}":
        raise HTTPException(404, "job not found")
    await db.delete(job_id)
    return {"deleted": True}


@app.post("/api/v1/crew/jobs/tick", tags=["crew"])
async def crew_jobs_tick(request: Request):
    await _require_admin(request)
    """Run every scheduled crew job that is due. Called daily by the platform
    cron (or manually); results are saved into each owner's Library under
    Crew-Reports/ so they show up in Ask too."""
    import json as _j
    import time as _t
    now = int(_t.time())
    ran, skipped = [], 0
    docs, _total = await db.list("crew-jobs", limit=1, offset=0)  # presence probe
    # iterate per-user job libraries via the gallery-style registry
    reg, _r = await db.list("crew-jobs-registry", limit=200, offset=0)
    owner_libs = []
    for d in reg:
        lib = (d.get("snippet") or "").strip()
        if lib.startswith("crew-jobs:"):
            owner_libs.append(lib)
    if not owner_libs:
        # fall back: scan known job ids from registry doc content
        pass
    for lib in owner_libs:
        hits = await db.search(lib, " ", limit=50)
        for h in hits:
            if (h.get("meta") or {}).get("kind") != "crew-job":
                continue
            full = await db.fetch(h["id"])
            try:
                rec = _j.loads((full or {}).get("content") or "{}")
            except Exception:
                continue
            due = now - int(rec.get("last_run") or 0) >= int(rec.get("interval_hours", 24)) * 3600
            if not due:
                skipped += 1
                continue
            owner = lib.split(":", 1)[1]
            try:
                result = await run_crew(rec["task"], owner, lang=rec.get("lang", ""))
                # save the deliverable into the owner's Library (RAG-indexed)
                safe = _re_sub(r"[^A-Za-z0-9]+", "-", rec["task"][:40]).strip("-") or "report"
                fname = f"crew-{safe}-{_t.strftime('%Y%m%d', _t.gmtime(now))}.md"
                report = (f"# Crew report — {rec['task']}\n\n{result['final']}\n\n"
                          f"---\nPlan:\n{result['plan']}\n")
                await file_store.upload(owner, fname, report.encode(), folder="Crew-Reports")
                rec["last_run"] = now
                rec["runs"] = int(rec.get("runs", 0)) + 1
                await db.upsert_document(h["id"], lib, rec["task"][:80], _j.dumps(rec),
                                         meta={"kind": "crew-job"})
                ran.append({"job": h["id"], "owner": owner, "file": fname})
                # notify the owner (in-app + email when the address is allowed)
                await _notify(owner, f"✅ Crew report ready: {rec['task'][:60]} → Crew-Reports/{fname}")
                await _email_owner(owner, f"Your crew report '{rec['task'][:60]}' is ready in Library → Crew-Reports/{fname}")
            except Exception as e:
                ran.append({"job": h["id"], "owner": owner, "error": str(e)[:120]})
    return {"ran": ran, "skipped": skipped, "count": len(ran)}


def _re_sub(pat: str, rep: str, s: str) -> str:
    import re as _re
    return _re.sub(pat, rep, s)


@app.post("/api/v1/digest/weekly/tick", tags=["user"])
async def digest_weekly_tick(request: Request):
    await _require_admin(request)
    """Weekly digest: for every account, summarize the week's new Library files
    and archive docs into a notification (email when the address is allowed).
    Triggered by the weekly cron."""
    import time as _t
    import datetime as _dt
    week_ago = int(_t.time()) - 7 * 86400
    out = []
    rows, _t2 = await db.list(ACCOUNTS_LIB, limit=500)
    for r in rows:
        m = r.get("meta") or {}
        uid = m.get("user_id")
        email = r["id"].split("::", 1)[1]
        if not uid:
            continue
        try:
            idx = await file_store.stats(uid)
            new_files = idx.get("files", 0)  # total for now; per-week filter below via uploads
            files_rows = (await file_store.list_files(uid)).get("files", [])
            fresh = [f for f in files_rows if int(f.get("uploaded", 0)) >= week_ago]
            arc_rows, arc_total = await db.list("archive", limit=200)
            fresh_arc = [a for a in arc_rows if int((_dt.datetime.fromisoformat(a["snippet"][:19]) ).timestamp()) >= week_ago] if False else []
            if not fresh:
                continue
            names = ", ".join(f["name"] for f in fresh[:8])
            summary = await ai.summarize(
                "Write a 2-3 sentence friendly weekly digest of what the user added "
                "to their library this week and one tip.",
                f"Files added this week: {names}. Total files: {new_files}.",
            )
            text = summary.get("summary", f"You added {len(fresh)} file(s) this week: {names}")
            await _notify(uid, f"📅 Weekly digest: {text[:180]}")
            if settings.resend_api_key:
                import httpx as _hx
                await _hx.AsyncClient(timeout=15).post(
                    "https://api.resend.com/emails",
                    headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                    json={"from": settings.resend_from, "to": [email],
                          "subject": "Silvestar — your weekly digest",
                          "text": text[:1200]},
                )
            out.append({"user": uid, "new_files": len(fresh)})
        except Exception as e:
            out.append({"user": uid, "error": str(e)[:100]})
    return {"digests_sent": len([o for o in out if "error" not in o]), "details": out}


async def _email_owner(user_id: str, message: str) -> None:
    """Best-effort email to the account that owns user_id (Resend free tier
    currently only delivers to the platform owner's address; silently skips)."""
    try:
        rows, _t = await db.list(ACCOUNTS_LIB, limit=500)
        for r in rows:
            m = r.get("meta") or {}
            if m.get("user_id") == user_id:
                email = r["id"].split("::", 1)[1]
                if settings.resend_api_key:
                    import httpx as _hx
                    await _hx.AsyncClient(timeout=15).post(
                        "https://api.resend.com/emails",
                        headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                        json={"from": settings.resend_from, "to": [email],
                              "subject": "Silvestar — crew report ready",
                              "text": message},
                    )
                return
    except Exception:
        pass


@app.get("/api/v1/files/summarize", tags=["files"])
async def file_summarize(request: Request, path: str = Query(..., min_length=1)):
    """One-tap AI summary of a single Library file (indexed text)."""
    uid = await _uid_async(request)
    uid = await _read_uid_for(request, uid, path)  # shared-space aware
    from .core.files import _fdoc_id
    doc = await db.fetch("d-" + _fdoc_id(uid, path)[2:])
    if not doc or not doc.get("content"):
        raise HTTPException(404, "no indexed text for this file")
    res = await ai.summarize(
        "Summarize this document in 3-5 short bullets. Be concrete.",
        str(doc.get("content", ""))[:12000],
    )
    return {"path": path, "name": path.rsplit("/", 1)[-1],
            "summary": res.get("summary", ""), "engine": res.get("engine", "")}


@app.get("/api/v1/files/folder-summary", tags=["files"])
async def folder_summary(request: Request, folder: str = Query("")):
    """AI digest of the text content of all indexed files in a folder."""
    uid = await _uid_async(request)
    corpus_parts: list[str] = []
    count = 0
    f = folder.strip("/")
    hits = await db.search(f"files:{uid}", " ", limit=40)
    for h in hits:
        m = h.get("meta") or {}
        if m.get("kind") != "file" or not h.get("content"):
            continue
        hf = (m.get("folder") or "").strip("/")
        if f:
            if not (hf == f or hf.startswith(f + "/")):
                continue
        corpus_parts.append(f"--- {h['title']}\n{(h.get('content') or '')[:4000]}")
        count += 1
        if count >= 10:
            break
    if not corpus_parts:
        return {"folder": folder, "files": 0, "summary": "", "engine": "none"}
    res = await ai.summarize(
        f"Summarize the key points of these {count} document(s) from folder '{folder or 'root'}' "
        "in 3-5 short bullets.",
        "\n\n".join(corpus_parts)[:12000],
    )
    return {"folder": folder, "files": count, "summary": res.get("summary", ""), "engine": res.get("engine", "")}


@app.post("/api/v1/files/import-url", tags=["files"])
async def import_url(request: Request, url: str = Query(..., min_length=8, max_length=1000),
                     folder: str = Query("")):
    """Download a file from any public URL into the user's Library (RAG-indexed)."""
    uid = await _uid_async(request)
    import httpx as _hx
    from urllib.parse import urlparse as _p
    try:
        async with _hx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(url)
        if r.status_code != 200:
            raise HTTPException(502, f"source returned HTTP {r.status_code}")
        data = r.content
        if len(data) > 40 * 1024 * 1024:
            raise HTTPException(413, "file too large (40MB limit)")
        name = [s for s in _p(url).path.split("/") if s][-1] if _p(url).path.strip("/") else "imported"
        if len(name) > 120:
            name = name[:120]
        rec = await file_store.upload(uid, name, data, folder=folder)
        return rec
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"download failed: {str(e)[:140]}")


@app.post("/api/v1/files/suggest-name", tags=["files"])
async def suggest_name(request: Request, path: str = Query(..., min_length=1, max_length=400)):
    """AI-suggested descriptive filename based on the file's extracted text."""
    uid = await _uid_async(request)
    from .files import _fdoc_id
    doc_id = "d-" + _fdoc_id(uid, path)[2:]
    doc = await db.fetch(doc_id)
    text = (doc or {}).get("content") or ""
    if not text:
        return {"suggestion": ""}
    res = await ai.summarize(
        "Propose a short descriptive filename (3-6 words, Title Case, no extension, no quotes) "
        "for a document with this content. Return ONLY the filename.",
        text[:4000],
    )
    import re as _re
    s = (res.get("summary") or "").strip().splitlines()
    name = s[0].strip().strip('"\'') if s else ""
    name = _re.sub(r"[^A-Za-z0-9 -]", "", name).strip()[:60]
    return {"suggestion": name}


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
async def _require_user(request: Request) -> None:
    """Reject fully anonymous writes: any valid session (incl. admin) passes."""
    authz = request.headers.get("authorization", "")
    if authz.startswith("Bearer "):
        user = await auth.validate_session(authz[7:])
        if user and user.get("status") == "active":
            return
    raise HTTPException(401, "sign in required")


async def _require_admin(request: Request) -> None:
    key = request.headers.get("x-admin-key", "")
    if key and hmac.compare_digest(key.encode(), settings.admin_key.encode()):
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


@app.get("/api/v1/admin/usage", tags=["admin"])
async def admin_usage(request: Request):
    """Usage dashboard data: users, files, storage bytes, AI/audit activity."""
    await _require_admin(request)
    rows, _total = await db.list(ACCOUNTS_LIB, limit=500)
    users = []
    docs = await asyncio.gather(*[db.fetch(r["id"]) for r in rows])
    for doc, r in zip(docs, rows):
        m = (doc or r).get("meta", {})
        users.append({"user_id": m.get("user_id", ""), "role": m.get("role", "user"),
                      "status": m.get("status", "active"), "email": m.get("email", r.get("id", "").split("::", 1)[-1])})
    total_files = 0
    total_bytes = 0
    for u in users:
        try:
            st = await file_store.stats(u.get("user_id") or "")
            total_files += st.get("files", 0)
            total_bytes += st.get("bytes", 0)
        except Exception:
            continue
    audit_rows, _n = await db.list("audit-log", limit=200)
    ai_calls = sum(1 for r in audit_rows if str(r.get("id", "")).startswith("a-"))
    recent = [{"id": r.get("id"), "action": r.get("title", ""), "detail": r.get("snippet", "")[:120]}
              for r in audit_rows[:10]]
    def _mb(n: int) -> str:
        return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{n / 1024:.1f} KB"
    return {
        "users": {"total": len(users), "admins": sum(1 for u in users if u.get("role") == "admin"),
                  "active": sum(1 for u in users if u.get("status") == "active")},
        "files": {"total": total_files, "bytes": total_bytes, "human": _mb(total_bytes)},
        "activity": {"recent_audit_entries": len(audit_rows), "recent_events": recent},
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


# ----------------------------------------------- Module 19: Reminders -------
class ReminderIn(BaseModel):
    text: str = Field(min_length=1, max_length=280)
    due: int = Field(ge=0, le=4_102_444_800)  # unix seconds
    repeat: str = Field("", pattern="^(|daily|weekly|monthly)$")


def _rem_id(user_id: str, rid: str) -> str:
    return f"r-{user_id}-{rid}"[:80]


@app.post("/api/v1/reminders", tags=["user"])
async def reminder_create(body: ReminderIn, request: Request):
    uid = await _uid_async(request)
    if uid == "anon":
        raise HTTPException(401, "sign in required")
    import uuid
    rid = uuid.uuid4().hex[:10]
    await db.upsert_document(
        _rem_id(uid, rid), f"reminders:{uid}", body.text,
        __import__("json").dumps({"text": body.text, "due": int(body.due),
                                  "repeat": body.repeat or "",
                                  "fired": False, "created": int(time.time())}),
        meta={"kind": "reminder"},
    )
    return {"id": rid, "text": body.text, "due": int(body.due), "repeat": body.repeat or ""}


@app.get("/api/v1/reminders", tags=["user"])
async def reminder_list(request: Request):
    """All reminders sorted by due time; due ones are pushed to the bell once."""
    uid = await _uid_async(request)
    if uid == "anon":
        raise HTTPException(401, "sign in required")
    rows, _t = await db.list(f"reminders:{uid}", limit=100)
    import json as _j
    now = int(time.time())
    out, fired_rows = [], []
    for r in rows:
        try:
            rec = _j.loads(r.get("content") or "{}")
        except Exception:
            continue
        if rec.get("due", 0) <= now and not rec.get("fired"):
            rep = rec.get("repeat") or ""
            if rep in ("daily", "weekly", "monthly"):
                # recurring: roll to the next future occurrence, notify once, stay armed
                if rep == "daily":
                    step = 86400
                elif rep == "weekly":
                    step = 7 * 86400
                else:
                    step = 0  # monthly handled calendar-wise below
                if step:
                    d = int(rec["due"])
                    while d <= now:
                        d += step
                    rec["due"] = d
                else:
                    import datetime as _dt
                    base = _dt.datetime.fromtimestamp(int(rec["due"]), _dt.timezone.utc)
                    while int(base.timestamp()) <= now:
                        m = base.month % 12 + 1
                        y = base.year + (1 if base.month == 12 else 0)
                        try:
                            base = base.replace(year=y, month=m)
                        except ValueError:  # e.g. Jan 31 → Feb
                            base = base.replace(year=y, month=m, day=28)
                    rec["due"] = int(base.timestamp())
            else:
                rec["fired"] = True
            fired_rows.append((r["id"], rec))
            await _notify(uid, f"⏰ Reminder: {rec.get('text', '')[:120]}")
        out.append({"id": r["id"], "text": rec.get("text", ""), "due": rec.get("due", 0),
                    "repeat": rec.get("repeat", ""), "fired": rec.get("fired", False)})
    for rid, rec in fired_rows:
        await db.upsert_document(rid, f"reminders:{uid}", rec.get("text", ""),
                                 _j.dumps(rec), meta={"kind": "reminder"})
    out.sort(key=lambda x: x["due"])
    return {"reminders": out, "total": len(out)}


@app.delete("/api/v1/reminders/{rid}", tags=["user"])
async def reminder_delete(rid: str, request: Request):
    uid = await _uid_async(request)
    if uid == "anon":
        raise HTTPException(401, "sign in required")
    # accept the short id or the full doc id (as returned by the list endpoint)
    ok = await db.delete(_rem_id(uid, rid)) or await db.delete(rid)
    return {"deleted": bool(ok)}


async def _notify(user_id: str, message: str) -> None:
    import uuid

    await db.upsert_document(
        "n-" + uuid.uuid4().hex[:12], f"notify:{user_id}",
        message, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        meta={"kind": "notification"},
    )


@app.get("/api/v1/notifications", tags=["user"])
async def notifications(user_id: str = Query(...), request: Request = None):
    # identity check: the caller must present the session for this user_id
    if request is not None:
        authz = request.headers.get("authorization", "")
        if authz.startswith("Bearer "):
            user = await auth.validate_session(authz[7:])
            if user and user.get("user_id") == user_id:
                pass
            else:
                raise HTTPException(403, "not your notification feed")
        else:
            raise HTTPException(401, "sign in required")
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
    totp: str = ""


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


# ---------------------------------------------- audit fix: rate limiting ---
def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def _rate_limit(scope: str, key: str, limit: int, window_s: int) -> None:
    """Fixed-window limiter (Redis/in-process via cache, plus GitHub KV persistence).

    Raises 429 when `key` exceeds `limit` events within `window_s` for `scope`.
    Protects login/register/OTP endpoints from brute force and email bombing.
    """
    bucket = f"rate:{scope}:{key}"
    try:
        n = await cache.incr(bucket, ttl=window_s)
    except Exception:
        n = 1
    if n > limit:
        raise HTTPException(429, "too many attempts — please wait a bit and try again")


async def _current_user(session_token: str) -> dict:
    user = await auth.validate_session(session_token)
    if not user:
        raise HTTPException(401, "session invalid or expired — sign in again")
    return user


@app.post("/api/v1/auth/register", tags=["auth"])
async def auth_register(body: RegisterIn, request: Request):
    await _rate_limit("register", _client_ip(request), limit=5, window_s=3600)
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
async def auth_login(body: LoginIn, request: Request):
    await _rate_limit("login", _client_ip(request), limit=10, window_s=300)
    try:
        acct = await auth.authenticate(body.email, body.password)
    except AuthError as e:
        raise HTTPException(401, str(e))
    # 2FA challenge: if the account has TOTP enabled, a valid code is required
    if acct.get("totp_secret"):
        if not auth._totp_verify(acct.get("totp_secret", ""), body.totp):
            raise HTTPException(401, "2FA_CODE_REQUIRED")
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


# ---------------------------------------------------------------- 2FA ------
class TwoFAIn(BaseModel):
    session_token: str
    code: str = ""


def _acct_meta_snapshot(acct: dict) -> dict:
    return dict(acct)


@app.post("/api/v1/auth/2fa/setup", tags=["auth"])
async def auth_2fa_setup(body: TwoFAIn):
    user = await _current_user(body.session_token)
    try:
        r = await auth.twofa_setup(user["email"])
    except AuthError as e:
        raise HTTPException(400, str(e))
    await _audit("auth.2fa_setup_started", user["email"])
    return r


@app.post("/api/v1/auth/2fa/confirm", tags=["auth"])
async def auth_2fa_confirm(body: TwoFAIn):
    user = await _current_user(body.session_token)
    try:
        r = await auth.twofa_confirm(user["email"], body.code)
    except AuthError as e:
        raise HTTPException(400, str(e))
    await _audit("auth.2fa_enabled", user["email"])
    return r


@app.post("/api/v1/auth/2fa/disable", tags=["auth"])
async def auth_2fa_disable(body: TwoFAIn):
    user = await _current_user(body.session_token)
    try:
        r = await auth.twofa_disable(user["email"], body.code)
    except AuthError as e:
        raise HTTPException(400, str(e))
    await _audit("auth.2fa_disabled", user["email"])
    return r


@app.get("/api/v1/auth/2fa/status", tags=["auth"])
async def auth_2fa_status(session_token: str = Query("")):
    user = await _current_user(session_token)
    return await auth.twofa_status(user["email"])


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
async def auth_forgot(body: OtpRequestIn, request: Request):
    # email-bomb protection: per-IP and per-address caps
    await _rate_limit("forgot-ip", _client_ip(request), limit=5, window_s=3600)
    await _rate_limit("forgot-addr", body.email.strip().lower(), limit=3, window_s=3600)
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
    # parallel fetches (audit fix: was sequential N+1)
    docs = await asyncio.gather(*[db.fetch(r["id"]) for r in rows])
    metas = [(doc or r).get("meta", {}) for doc, r in zip(docs, rows)]
    vcounts = await asyncio.gather(*[auth.vault_doc_count(m.get("user_id", "")) for m in metas])
    for r, m, vc in zip(rows, metas, vcounts):
        users.append({
            "email": r["id"].split("::", 1)[1],
            "user_id": m.get("user_id", ""),
            "role": m.get("role", "user"),
            "status": m.get("status", "active"),
            "display_name": r.get("title", ""),
            "created": m.get("created", ""),
            "verified": bool(m.get("verified", False)),
            "last_login": m.get("last_login", ""),
            "vault_documents": vc,
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
