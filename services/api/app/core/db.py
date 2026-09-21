"""Module 3/4 — Persistence layer.

Production: PostgreSQL + pgvector (asyncpg). Fallback: embedded SQLite with a
native Python vector index. Both expose the same async API so every caller is
storage-agnostic.
"""
from __future__ import annotations

import json
import math
import struct
from typing import Any, Optional

from ..config import settings


# ---------------------------------------------------------------- embedding --
def embed_text(text: str, dim: int | None = None) -> list[float]:
    """Deterministic local embedding (hashed bag-of-words, L2-normalized).

    Same contract as the pgvector column: float[dim]. In production this can be
    swapped for a model served next to the API without touching callers.
    """
    d = dim or settings.embedding_dim
    v = [0.0] * d
    for token in text.lower().split():
        token = "".join(c for c in token if c.isalnum())
        if not token:
            continue
        h = 2166136261
        for ch in token:
            h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
        i1 = h % d
        i2 = (h >> 8) % d
        v[i1] += 1.0
        if i2 != i1:
            v[i2] += 0.5
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def vec_to_pg(vec: list[float]) -> str:
    """Serialize a vector for pgvector: '[1,2,3]' literal."""
    return "[" + ",".join(f"{x:.6f}" for x in vec) + "]"


def vec_to_blob(vec: list[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def blob_to_vec(blob: bytes | str | None) -> list[float]:
    if blob is None:
        return []
    if isinstance(blob, str):
        blob = blob.encode()
    return list(struct.unpack(f"<{len(blob) // 4}f", blob))


# ------------------------------------------------------------------- layer ---
class Database:
    """Async DB facade: PostgreSQL+pgvector when DATABASE_URL is set, else SQLite."""

    def __init__(self) -> None:
        self._pg_pool: Any = None
        self._sqlite: Any = None
        self.mode: str = "embedded"

    async def connect(self) -> None:
        if settings.has_postgres and settings.embedded_fallbacks is not None:
            try:
                import asyncpg  # type: ignore

                self._pg_pool = await asyncpg.create_pool(
                    settings.database_url, min_size=1, max_size=8, command_timeout=30
                )
                await self._pg_init_schema()
                self.mode = "postgres+pgvector"
                return
            except Exception:
                self._pg_pool = None
        await self._sqlite_init()
        self.mode = "embedded-sqlite"

    async def close(self) -> None:
        if self._pg_pool:
            await self._pg_pool.close()
        if self._sqlite:
            await self._sqlite.close()

    # ------------------------------------------------------------- postgres --
    async def _pg_init_schema(self) -> None:
        assert self._pg_pool
        async with self._pg_pool.acquire() as conn:
            await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    library TEXT NOT NULL,              -- 'archive' | 'vault:<user>'
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    meta JSONB DEFAULT '{}'::jsonb,
                    embedding vector(%s),
                    created_at TIMESTAMPTZ DEFAULT now()
                )
                """.replace("%s", str(settings.embedding_dim))
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_documents_lib ON documents(library)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_documents_emb ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
            )

    async def pg_upsert_document(self, doc_id: str, library: str, title: str, content: str, meta: dict, embedding: list[float]) -> None:
        assert self._pg_pool
        async with self._pg_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO documents (id, library, title, content, meta, embedding)
                VALUES ($1, $2, $3, $4, $5::jsonb, $6)
                ON CONFLICT (id) DO UPDATE SET
                    title = EXCLUDED.title, content = EXCLUDED.content,
                    meta = EXCLUDED.meta, embedding = EXCLUDED.embedding
                """,
                doc_id, library, title, content, json.dumps(meta), vec_to_pg(embedding),
            )

    async def pg_search(self, library: str, embedding: list[float], limit: int, query_text: str) -> list[dict]:
        assert self._pg_pool
        like = f"%{query_text}%"
        async with self._pg_pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, library, title, content, meta,
                       (1 - (embedding <=> $2::vector)) AS score
                FROM documents
                WHERE library = $1
                ORDER BY embedding <=> $2::vector
                LIMIT $3
                """,
                library, vec_to_pg(embedding), limit,
            )
        # hybrid: boost lexical matches (like the embedded engine)
        out = []
        for r in rows:
            score = float(r["score"])
            if query_text and query_text.lower() in r["content"].lower():
                score = min(1.0, score + 0.05)
            out.append({"id": r["id"], "library": r["library"], "title": r["title"],
                        "content": r["content"], "meta": json.loads(r["meta"] or "{}"), "score": round(score, 4)})
        return out

    async def pg_fetch(self, doc_id: str) -> Optional[dict]:
        assert self._pg_pool
        async with self._pg_pool.acquire() as conn:
            r = await conn.fetchrow("SELECT id, library, title, content, meta FROM documents WHERE id = $1", doc_id)
        if not r:
            return None
        return {"id": r["id"], "library": r["library"], "title": r["title"],
                "content": r["content"], "meta": json.loads(r["meta"] or "{}")}

    async def pg_list(self, library: str, limit: int, offset: int) -> tuple[list[dict], int]:
        assert self._pg_pool
        async with self._pg_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT id, title, left(content, 280) AS snippet, created_at FROM documents WHERE library = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
                library, limit, offset,
            )
            total = await conn.fetchval("SELECT count(*) FROM documents WHERE library = $1", library)
        return ([{"id": r["id"], "title": r["title"], "snippet": r["snippet"]} for r in rows], int(total or 0))

    async def pg_delete(self, doc_id: str) -> bool:
        assert self._pg_pool
        async with self._pg_pool.acquire() as conn:
            tag = await conn.execute("DELETE FROM documents WHERE id = $1", doc_id)
        return tag.endswith("1")

    # -------------------------------------------------------------- sqlite --
    async def _sqlite_init(self) -> None:
        import aiosqlite

        self._sqlite = await aiosqlite.connect(":memory:")
        self._sqlite.row_factory = aiosqlite.Row
        await self._sqlite.execute(
            """CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY, library TEXT NOT NULL, title TEXT NOT NULL,
                content TEXT NOT NULL, meta TEXT DEFAULT '{}', embedding BLOB)"""
        )
        await self._sqlite.commit()

    async def sqlite_upsert(self, doc_id: str, library: str, title: str, content: str, meta: dict, embedding: list[float]) -> None:
        assert self._sqlite
        await self._sqlite.execute(
            "INSERT OR REPLACE INTO documents (id, library, title, content, meta, embedding) VALUES (?,?,?,?,?,?)",
            (doc_id, library, title, content, json.dumps(meta), vec_to_blob(embedding)),
        )
        await self._sqlite.commit()

    async def sqlite_search(self, library: str, embedding: list[float], limit: int, query_text: str) -> list[dict]:
        assert self._sqlite
        cur = await self._sqlite.execute(
            "SELECT id, library, title, content, meta, embedding FROM documents WHERE library = ?", (library,)
        )
        rows = await cur.fetchall()
        scored = []
        for r in rows:
            vec = blob_to_vec(r["embedding"])
            score = _cosine(embedding, vec)
            if query_text:
                ql = query_text.lower()
                if ql in r["content"].lower():
                    score = min(1.0, score + 0.05)
                # bigram phrase bonus: consecutive query terms count extra
                terms = [t for t in ql.split() if t]
                for a, b in zip(terms, terms[1:]):
                    if a in r["content"].lower() and b in r["content"].lower():
                        score = min(1.0, score + 0.02)
            scored.append({"id": r["id"], "library": r["library"], "title": r["title"],
                           "content": r["content"], "meta": json.loads(r["meta"] or "{}"),
                           "score": round(score, 4)})
        scored.sort(key=lambda d: d["score"], reverse=True)
        return scored[:limit]

    async def sqlite_fetch(self, doc_id: str) -> Optional[dict]:
        assert self._sqlite
        cur = await self._sqlite.execute(
            "SELECT id, library, title, content, meta FROM documents WHERE id = ?", (doc_id,)
        )
        r = await cur.fetchone()
        if not r:
            return None
        return {"id": r["id"], "library": r["library"], "title": r["title"],
                "content": r["content"], "meta": json.loads(r["meta"] or "{}")}

    async def sqlite_list(self, library: str, limit: int, offset: int) -> tuple[list[dict], int]:
        assert self._sqlite
        cur = await self._sqlite.execute(
            "SELECT id, title, substr(content,1,280) AS snippet FROM documents WHERE library = ? ORDER BY rowid DESC LIMIT ? OFFSET ?",
            (library, limit, offset),
        )
        rows = [dict(r) for r in await cur.fetchall()]
        cur = await self._sqlite.execute("SELECT COUNT(*) c FROM documents WHERE library = ?", (library,))
        total = (await cur.fetchone())["c"]
        return rows, total

    async def sqlite_delete(self, doc_id: str) -> bool:
        assert self._sqlite
        cur = await self._sqlite.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        await self._sqlite.commit()
        return cur.rowcount > 0

    # ------------------------------------------------- uniform public API --
    async def upsert_document(self, doc_id: str, library: str, title: str, content: str, meta: dict | None = None) -> dict:
        meta = meta or {}
        emb = embed_text(f"{title}\n{content}")
        if self.mode == "postgres+pgvector":
            await self.pg_upsert_document(doc_id, library, title, content, meta, emb)
        else:
            await self.sqlite_upsert(doc_id, library, title, content, meta, emb)
        return {"id": doc_id, "library": library, "title": title, "dim": len(emb)}

    async def search(self, library: str, query: str, limit: int = 8) -> list[dict]:
        emb = embed_text(query)
        if self.mode == "postgres+pgvector":
            return await self.pg_search(library, emb, limit, query)
        return await self.sqlite_search(library, emb, limit, query)

    async def fetch(self, doc_id: str) -> Optional[dict]:
        if self.mode == "postgres+pgvector":
            return await self.pg_fetch(doc_id)
        return await self.sqlite_fetch(doc_id)

    async def list(self, library: str, limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
        if self.mode == "postgres+pgvector":
            return await self.pg_list(library, limit, offset)
        return await self.sqlite_list(library, limit, offset)

    async def delete(self, doc_id: str) -> bool:
        if self.mode == "postgres+pgvector":
            return await self.pg_delete(doc_id)
        return await self.sqlite_delete(doc_id)

    async def health(self) -> dict:
        return {"mode": self.mode, "ok": self._pg_pool is not None or self._sqlite is not None}


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    return max(0.0, min(1.0, dot))  # both are unit vectors


db = Database()
