"""GitHub-backed persistent store.

Keeps documents and short-lived KV values as JSON files in a private GitHub
repository. Used when no Postgres/Redis is configured (e.g. Vercel serverless
where local SQLite/memory are ephemeral). Free, durable, and requires no
extra infrastructure.

Layout:
    docs/<sha256(doc_id)[:32]>.json   full document incl. embedding
    idx/<urlencoded library>.json     {"ids": [doc_id, ...]} per library
    kv/<urlencoded key>.json          {"v": value, "exp": epoch|None}
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import time
import urllib.parse
from typing import Any, Optional

import httpx

from ..config import settings

API = "https://api.github.com"
T_RETRIES = (0.4, 1.0)


def _doc_path(doc_id: str) -> str:
    return "docs/" + hashlib.sha256(doc_id.encode()).hexdigest()[:32] + ".json"


def _idx_path(library: str) -> str:
    return "idx/" + urllib.parse.quote(library, safe="") + ".json"


def _kv_path(key: str) -> str:
    return "kv/" + urllib.parse.quote(key, safe="") + ".json"


class GitHubStore:
    """Async document + KV store on top of the GitHub Contents API."""

    def __init__(self) -> None:
        self._repo: str = settings.github_data_repo
        self._client = httpx.AsyncClient(
            base_url=API,
            headers={
                "Authorization": f"Bearer {settings.github_token}",
                "Accept": "application/vnd.github.raw",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=20,
        )
        # instance-local read cache: path -> (json_value | None, expiry)
        self._rc: dict[str, tuple[Any, float]] = {}
        self._rc_ttl = 12.0

    async def close(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------ raw I/O --
    async def _get_raw(self, path: str, retry_404: bool = True) -> Optional[tuple[str, str]]:
        """Return (text, sha) or None when the file does not exist.

        GitHub's contents API can serve a stale 404 for paths created moments
        ago on another instance; a single delayed retry closes that gap.
        """
        hdrs = {"Accept": "application/vnd.github+json"}
        # unique query param => bypass GitHub's CDN cache of stale 404s
        bust = f"?ref=HEAD&_={time.time_ns()}"
        for attempt in range(2 if retry_404 else 1):
            r = await self._client.get(f"/repos/{self._repo}/contents/{path}{bust}", headers=hdrs)
            if r.status_code == 404:
                if attempt == 0 and retry_404:
                    await asyncio.sleep(T_RETRIES[1])
                    continue
                return None
            if r.status_code in (500, 502, 503, 409):
                await asyncio.sleep(T_RETRIES[0])
                continue
            r.raise_for_status()
            j = r.json()
            text = base64.b64decode(j.get("content") or "").decode()
            return text, j["sha"]
        return None

    async def _put_raw(self, path: str, text: str, sha: Optional[str], msg: str) -> None:
        body: dict[str, Any] = {
            "message": msg,
            "content": base64.b64encode(text.encode()).decode(),
        }
        if sha:
            body["sha"] = sha
        r = await self._client.put(f"/repos/{self._repo}/contents/{path}", json=body)
        if r.status_code in (409, 422):
            # Conflict: either a concurrent writer won, or the file already
            # exists and our caller didn't know its sha. Re-read and retry once.
            await asyncio.sleep(T_RETRIES[0])
            cur = await self._get_raw(path)
            if cur:
                body["sha"] = cur[1]
            else:
                body.pop("sha", None)
            r = await self._client.put(f"/repos/{self._repo}/contents/{path}", json=body)
        r.raise_for_status()

    async def _delete_raw(self, path: str) -> None:
        cur = await self._get_raw(path)
        if not cur:
            return
        _, sha = cur
        r = await self._client.request(
            "DELETE",
            f"/repos/{self._repo}/contents/{path}",
            json={"message": "silvestar: delete", "sha": sha},
        )
        if r.status_code == 409:
            await asyncio.sleep(T_RETRIES[0])
            cur = await self._get_raw(path)
            if cur:
                r = await self._client.request(
                    "DELETE",
                    f"/repos/{self._repo}/contents/{path}",
                    json={"message": "silvestar: delete", "sha": cur[1]},
                )
        r.raise_for_status()
        self._rc.pop(path, None)

    # ------------------------------------------------------- cached reads --
    async def _read_json(self, path: str) -> Optional[Any]:
        hit = self._rc.get(path)
        if hit and hit[1] > time.time():
            return hit[0]
        raw = await self._get_raw(path)
        val: Optional[Any] = None
        if raw:
            try:
                val = json.loads(raw[0])
            except Exception:
                val = None
        self._rc[path] = (val, time.time() + self._rc_ttl)
        return val

    def _bust(self, path: str, val: Any) -> None:
        self._rc[path] = (val, time.time() + self._rc_ttl)

    # ------------------------------------------------------------ library --
    async def _load_idx(self, library: str) -> tuple[list[str], Optional[str]]:
        path = _idx_path(library)
        raw = await self._get_raw(path)
        if not raw:
            return [], None
        try:
            ids = json.loads(raw[0]).get("ids", [])
        except Exception:
            ids = []
        return ids, raw[1]

    async def _save_idx(self, library: str, ids: list[str], sha: Optional[str]) -> None:
        path = _idx_path(library)
        await self._put_raw(path, json.dumps({"ids": ids}), sha, f"silvestar: idx {library}")

    # =========================================================== documents ==
    async def upsert_document(self, doc_id: str, library: str, title: str, content: str,
                              meta: dict, embedding: list[float]) -> None:
        doc = {
            "id": doc_id, "library": library, "title": title, "content": content,
            "meta": meta, "emb": [round(x, 6) for x in embedding],
            "updated": int(time.time()),
        }
        await self._put_raw(_doc_path(doc_id), json.dumps(doc), None, f"silvestar: doc {doc_id}")
        ids, sha = await self._load_idx(library)
        if doc_id not in ids:
            ids.insert(0, doc_id)
            await self._save_idx(library, ids, sha)
        self._bust(_doc_path(doc_id), doc)

    async def fetch(self, doc_id: str) -> Optional[dict]:
        doc = await self._read_json(_doc_path(doc_id))
        if not doc:
            return None
        return {"id": doc["id"], "library": doc["library"], "title": doc["title"],
                "content": doc["content"], "meta": doc.get("meta", {})}

    async def search(self, library: str, embedding: list[float], limit: int, query_text: str) -> list[dict]:
        ids, _ = await self._load_idx(library)
        if not ids:
            return []
        docs = await asyncio.gather(*[self._read_json(_doc_path(i)) for i in ids[:400]])
        ql = query_text.lower()
        terms = [t for t in ql.split() if t]
        scored: list[dict] = []
        for doc in docs:
            if not doc:
                continue
            score = _cosine(embedding, doc.get("emb") or [])
            content_l = (doc.get("content") or "").lower()
            if ql and ql in content_l:
                score = min(1.0, score + 0.05)
            for a, b in zip(terms, terms[1:]):
                if a in content_l and b in content_l:
                    score = min(1.0, score + 0.02)
            scored.append({"id": doc["id"], "library": doc["library"], "title": doc["title"],
                           "content": doc["content"], "meta": doc.get("meta", {}),
                           "score": round(score, 4)})
        scored.sort(key=lambda d: d["score"], reverse=True)
        return scored[:limit]

    async def list(self, library: str, limit: int, offset: int) -> tuple[list[dict], int]:
        ids, _ = await self._load_idx(library)
        total = len(ids)
        page = ids[offset: offset + limit]
        docs = await asyncio.gather(*[self._read_json(_doc_path(i)) for i in page])
        rows = []
        for d in docs:
            if not d:
                continue
            rows.append({"id": d["id"], "title": d["title"],
                         "snippet": (d.get("content") or "")[:280]})
        return rows, total

    async def delete(self, doc_id: str, library: str | None = None) -> bool:
        doc = await self._read_json(_doc_path(doc_id))
        if not doc:
            return False
        lib = library or doc.get("library", "")
        await self._delete_raw(_doc_path(doc_id))
        ids, sha = await self._load_idx(lib)
        if doc_id in ids:
            ids.remove(doc_id)
            await self._save_idx(lib, ids, sha)
        return True

    # ================================================================== KV ==
    async def kv_get(self, key: str) -> Optional[str]:
        v = await self._read_json(_kv_path(key))
        if not v:
            return None
        exp = v.get("exp")
        if exp and time.time() > exp:
            await self._delete_raw(_kv_path(key))
            return None
        return v.get("v")

    async def kv_set(self, key: str, value: str, ttl: int | None = None) -> None:
        body = {"v": value, "exp": (int(time.time()) + ttl) if ttl else None}
        await self._put_raw(_kv_path(key), json.dumps(body), None, f"silvestar: kv {key}")
        self._bust(_kv_path(key), body)

    async def kv_delete(self, key: str) -> None:
        await self._delete_raw(_kv_path(key))

    async def health(self) -> dict:
        try:
            r = await self._client.get(f"/repos/{self._repo}")
            r.raise_for_status()
            return {"mode": "github-persistent", "ok": True}
        except Exception as e:
            return {"mode": "github-persistent", "ok": False, "error": str(e)[:120]}


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    num = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5 or 1.0
    nb = sum(y * y for y in b) ** 0.5 or 1.0
    return num / (na * nb)
