"""Silvestar platform test suite — covers all 9 modules end-to-end.

Runs against the embedded fallback engines (no external services required).
Postgres/Redis/Neo4j/LiveKit paths are exercised in staging via the same
tests by setting the *_URL env vars.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "api"))

from app.config import settings  # noqa: E402
from app.core import security  # noqa: E402
from app.core.cache import cache, MemoryCache  # engines reset below
from app.core.db import Database, embed_text  # noqa: E40 fresh instance
from app.core.graph import EmbeddedGraph  # noqa: E402
from app.core.realtime import Client, Hub, livekit_token  # layer tests
from app.core.rag import chunk_text, VaultSessionInfo  # noqa: E402


# --------------------------------------------------------------- unit: m5 ---
def test_security_roundtrip():
    key = security.derive_key("correct horse battery staple", b"0123456789abcdef", 1000)
    env = security.encrypt("secret plans 🔐 ünïcode", key)
    assert security.decrypt(env, key) == "secret plans 🔐 ünïcode"
    # tamper → fail
    raw = bytearray(base64.b64decode(env))
    raw[-1] ^= 1
    with pytest.raises(Exception):
        security.decrypt(base64.b64encode(bytes(raw)).decode(), key)


def test_security_password_verifier():
    rec = security.hash_password("hunter2hunter2")
    assert security.verify_password("hunter2hunter2", rec["salt"], rec["hash"])
    assert not security.verify_password("wrong", rec["salt"], rec["hash"])
    fp1 = security.envelope_fingerprint("AAA")
    fp2 = security.envelope_fingerprint("BBB")
    assert fp1 != fp2


def test_wrong_key_fails():
    k1 = security.derive_key("pw-one", b"0123456789abcdef", 1000)
    k2 = security.deseved_key if False else security.derive_key("pw-two", b"0123456789abcdef", 1000)
    env = security.encrypt("data", k1)
    with pytest.raises(Exception):
        security.decrypt(env, k2)


# --------------------------------------------------------------- unit: m3 ---
def test_embed_deterministic_and_normalized():
    a = embed_text("hello world")
    b = embed_text("hello world")
    assert a == b and len(a) == settings.embedding_dim
    assert abs(sum(x * x for x in a) - 1.0) < 1e-6
    assert embed_text("completely different text here") != a


def test_chunking():
    text = ". ".join(f"Sentence number {i} talks about topic {i}" for i in range(50))
    chunks = chunk_text(text, chunk_chars=300, overlap=40)
    assert len(chunks) > 3
    assert all(len(c) <= 340 for c in chunks)


@pytest.mark.asyncio
async def test_db_embedded_crud_and_search():
    d = Database()  # fresh embedded instance
    await d.connect()
    assert d.mode == "embedded-sqlite"
    await d.upsert_document("x1", "archive", "Rust Engines", "Rust powers fast engines")
    await d.upsert_document("x2", "archive", "Cooking", "How to bake sourdough bread")
    hits = await d.search("archive", "rust engines", limit=2)
    assert hits and hits[0]["title"] == "Rust Engines"
    assert hits[0]["score"] >= hits[1]["score"]
    fetched = await d.fetch("x1")
    assert fetched["content"] == "Rust powers fast engines"
    docs, total = await d.list("archive")
    assert total == 2
    assert await d.delete("x2") is True
    docs, total = await d.list("archive")
    assert total == 1
    await d.close()


@pytest.mark.asyncio
async def test_cache_memory():
    c = MemoryCache()
    await c.set("k", "v", ttl=5)
    assert await c.get("k") == "v"
    await c.set("k2", "x", ttl=-1)  # already expired
    assert await c.get("k2") is None
    assert await c.incr("hits") == 1 and await c.incr("hits") == 2


@pytest.mark.asyncio
async def test_graph_embedded():
    g = EmbeddedGraph()
    await g.merge_node("alice", ["Person"], {"name": "Alice"})
    await g.merge_node("bob", ["Person"], {"name": "Bob"})
    await g.merge_node("carol", ["Person"], {"name": "Carol"})
    await g.merge_edge("alice", "KNOWS", "bob")
    await g.merge_edge("bob", "KNOWS", "carol")
    nb = await g.neighbors("alice")
    assert any(n["node"]["id"] == "bob" for n in nb)
    p = await g.path("alice", "carol")
    assert p == ["alice", "bob", "carol"]
    assert await g.path("alice", "zed") is None
    st = await g.stats()
    assert st["nodes"] == 3 and st["edges"] == 2


# --------------------------------------------------------------- unit: m6 ---
def test_livekit_token_shape():
    tok = livekit_token("room1", "identity1", api_key="devkey", api_secret="devsecret")
    h, p, s = tok.split(".")
    payload = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
    assert payload["video"]["room"] == "room1"
    assert payload["iss"] == "devkey"


@pytest.mark.asyncio
async def test_hub_rooms_and_ratelimit():
    """Hub message flow via fake sockets."""
    class FakeWS:
        def __init__(self):
            self.sent = []

        async def send_text(self, t):
            self.sent.append(t)

        async def accept(self):
            pass

    h = Hub()
    a = Client(ws=FakeWS(), room="r", user="alice")
    b = Client(ws=FakeWS(), room="r", user="bob")
    await h.join(a)
    await h.join(b)
    await h.handle_message(a, json.dumps({"type": "chat", "text": "hi"}))
    outs = [json.loads(m) for m in b.ws.sent]
    assert any(o.get("type") == "chat" and o.get("text") == "hi" for o in outs)
    # flood control: 25/10s already used 1 → sender gets rate_limited errors
    for i in range(30):
        await h.handle_message(a, json.dumps({"type": "chat", "text": f"m{i}"}))
    outs_a = [json.loads(m) for m in a.ws.sent]
    assert any(o.get("type") == "error" and o.get("error") == "rate_limited" for o in outs_a)


# --------------------------------------------------- integration: full API ---
@pytest_asyncio.fixture
async def client():
    # run the real lifespan so db/cache/graph connect (ASGITransport doesn't)
    from app.main import app

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            yield ac


@pytest.mark.asyncio
class TestAPI:
    async def test_health_all_modules(self, client):
        r = await client.get("/api/v1/health")
        assert r.status_code == 200
        h = r.json()
        assert h["status"] == "ok"
        assert h["db"]["ok"] and h["cache"]["ok"] and h["graph"]["ok"]
        assert h["db"]["mode"] in ("embedded-sqlite", "postgres+pgvector")
        assert h["cache"]["mode"] in ("embedded-memory", "redis")
        assert h["graph"]["mode"] in ("embedded-graph", "neo4j")

    async def test_archive_flow(self, client):
        # create
        r = await client.post("/api/v1/archive/documents", json={
            "title": "Vector Databases 101",
            "content": "pgvector brings vector similarity search to PostgreSQL with HNSW and IVFFlat indexes.",
            "source": "test", "tags": ["db"],
        })
        assert r.status_code == 200
        doc_id = r.json()["id"]
        # search finds it
        r = await client.get("/api/v1/archive/search", params={"q": "pgvector similarity"})
        assert r.status_code == 200
        hits = r.json()["results"]
        assert any(h["doc_id"] == doc_id for h in hits)
        # get
        r = await client.get(f"/api/v1/archive/documents/{doc_id}")
        assert r.json()["title"] == "Vector Databases 101"
        # delete
        r = await client.delete(f"/api/v1/archive/documents/{doc_id}")
        assert r.json()["deleted"] is True

    async def test_vault_flow_and_cross_library_rag(self, client):
        uid = "vaultuser1"
        pw = "super-secret-pw"
        # create + unlock
        r = await client.post("/api/v1/vault/create", json={"user_id": uid, "password": pw})
        assert r.status_code == 200
        r = await client.post("/api/v1/vault/unlock", json={"user_id": uid, "password": pw})
        assert r.status_code == 200
        token = r.json()["session_token"]
        # seal a doc
        r = await client.post("/api/v1/vault/documents", json={
            "user_id": uid, "session_token": token,
            "title": "Private API Keys", "content": "My secret key is sk-silvestar-9527",
        })
        assert r.status_code == 200
        vid = r.json()["id"]
        assert r.json()["encrypted"] is True
        # listing shows title only — never content
        r = await client.get("/api/v1/vault/documents", params={"user_id": uid, "session_token": token})
        assert r.status_code == 200
        assert r.json()["documents"][0]["id"] == vid
        # global search WITHOUT unlock → vault hit identity-only
        r = await client.get("/api/v1/archive/search", params={
            "q": "secret key", "user_id": uid, "vault_session_token": "",
        })
        locked_hits = [h for h in r.json()["results"] if h["library"] == "vault"]
        assert all("[locked" in h["snippet"] for h in locked_hits)
        # WITH unlock → decrypted snippet
        r = await client.get("/api/v1/archive/search", params={
            "q": "secret key", "user_id": uid, "vault_session_token": token,
        })
        unlocked_hits = [h for h in r.json()["results"] if h["library"] == "vault"]
        assert any("sk-silvestar-9527" in h["snippet"] for h in unlocked_hits)
        # cross-library RAG context includes both libraries
        r = await client.post("/api/v1/rag/query", json={
            "question": "what is my secret key", "user_id": uid, "vault_session_token": token,
        })
        ctx = r.json()
        assert any(c["library"] == "vault" for c in ctx["citations"])
        # wrong password rejected
        r = await client.post("/api/v1/vault/unlock", json={"user_id": uid, "password": "wrong-wrong"})
        assert r.status_code == 401
        # lock → session invalid
        r = await client.post("/api/v1/vault/lock", json={"user_id": uid, "session_token": token})
        assert r.json()["locked"] is True
        r = await client.post("/api/v1/rag/query", json={
            "question": "secret", "user_id": uid, "vault_session_token": token,
        })
        assert r.json()["vault_unlocked"] is False
        # cleanup
        await client.delete(f"/api/v1/archive/documents/{vid}")

    async def test_graph_flow(self, client):
        r = await client.post("/api/v1/graph/nodes", json={"id": "Neo4j", "labels": ["Tech"], "props": {"kind": "graphdb"}})
        assert r.status_code == 200
        r = await client.post("/api/v1/graph/edges", json={"src": "pgvector", "rel": "COMPETES_WITH", "dst": "Neo4j"})
        assert r.status_code == 200
        r = await client.get("/api/v1/graph/path", params={"src": "pgvector", "dst": "Neo4j"})
        assert r.json()["path"] == ["pgvector", "Neo4j"]
        r = await client.get("/api/v1/graph/query", params={"q": "graphdb"})
        assert any(n["id"] == "Neo4j" for n in r.json()["results"])
        r = await client.get("/api/v1/graph/stats")
        assert r.json()["nodes"] >= 2

    async def test_ask_endpoint(self, client):
        # ensure some archive content exists
        await client.post("/api/v1/archive/documents", json={
            "title": "Silvestar Missions", "content": "Silvestar builds AI platforms with archives and vaults.",
        })
        r = await client.post("/api/v1/ask", json={"question": "What does Silvestar build?", "user_id": "anon"})
        assert r.status_code == 200
        body = r.json()
        assert body["answer"]
        assert body["engine"] in ("openai-compatible", "pollinations-get", "puter-proxy", "local-extractive")
        assert isinstance(body["citations"], list)

    async def test_rooms_endpoint(self, client):
        r = await client.get("/api/v1/rooms")
        assert r.status_code == 200
        r = await client.get("/api/v1/rooms/lounge/token", params={"identity": "tester"})
        assert r.status_code == 200
        assert "mode" in r.json()
