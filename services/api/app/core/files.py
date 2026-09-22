"""Module 14 — File Library: real file storage on GitHub.

Any file type (pdf, docx, xlsx, pptx, images, audio, video, zip...) is stored
in the private GitHub data repo via the Contents API (base64, ≤ ~40MB per
file hard limit; practical sweet spot ≤ 20MB). Files live under `files/`,
metadata as documents in the DB layer (library `files:{user_id}`), folders as
plain strings on the metadata — so folders, rename, and move need no extra
infrastructure.

Layout in the data repo:
    files/<user_id>/<folder-path>/<name>   raw bytes
    (metadata rows in db: library `files:{user_id}`, id `f-<hash>`)
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import mimetypes
import time
import urllib.parse
from typing import Any, Optional

import httpx

from ..config import settings

API = "https://api.github.com"
MAX_BYTES = 40 * 1024 * 1024  # GitHub Contents API hard cap
_INDEX = "library-index"      # special library holding per-user folder/file index


def _fdoc_id(user_id: str, path: str) -> str:
    return "f-" + hashlib.sha256(f"{user_id}:{path}".encode()).hexdigest()[:16]


def _safe_segment(seg: str) -> str:
    seg = seg.strip().strip("/")
    return seg.replace("\\", "_").replace("..", "_")


class FileStore:
    """Async file storage on GitHub + metadata in the DB layer."""

    def __init__(self) -> None:
        self._repo: str = settings.github_data_repo
        self._client: Optional[httpx.AsyncClient] = None

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=API,
                headers={
                    "Authorization": f"Bearer {settings.github_token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                timeout=60,
            )
        return self._client

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    # ---------------------------------------------------------- low level --
    async def _put_bytes(self, path: str, data: bytes, msg: str) -> dict:
        c = self._ensure_client()
        body: dict[str, Any] = {
            "message": msg,
            "content": base64.b64encode(data).decode(),
        }
        # fetch existing sha (overwrite support)
        r = await c.get(f"/repos/{self._repo}/contents/{urllib.parse.quote(path)}")
        if r.status_code == 200:
            body["sha"] = r.json()["sha"]
        r = await c.put(f"/repos/{self._repo}/contents/{urllib.parse.quote(path)}", json=body)
        if r.status_code in (409, 422):
            r2 = await c.get(f"/repos/{self._repo}/contents/{urllib.parse.quote(path)}")
            if r2.status_code == 200:
                body["sha"] = r2.json()["sha"]
                r = await c.put(f"/repos/{self._repo}/contents/{urllib.parse.quote(path)}", json=body)
        r.raise_for_status()
        return r.json().get("content", {}) or {}

    async def _get_bytes(self, path: str) -> Optional[bytes]:
        c = self._ensure_client()
        r = await c.get(
            f"/repos/{self._repo}/contents/{urllib.parse.quote(path)}",
            headers={"Accept": "application/vnd.github.raw"},
        )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.content

    async def _delete_path(self, path: str) -> bool:
        c = self._ensure_client()
        r = await c.get(f"/repos/{self._repo}/contents/{urllib.parse.quote(path)}")
        if r.status_code == 404:
            return False
        sha = r.json()["sha"]
        r = await c.request("DELETE", f"/repos/{self._repo}/contents/{urllib.parse.quote(path)}",
                            json={"message": "silvestar: delete file", "sha": sha})
        return r.status_code == 200

    async def _kv_get(self, key: str) -> Optional[dict]:
        from .cache import cache
        raw = await cache.get(f"files-idx:{key}")
        if raw:
            try:
                import json as _j
                return _j.loads(raw)
            except Exception:
                return None
        return None

    async def _kv_set(self, key: str, val: dict) -> None:
        from .cache import cache
        import json as _j
        await cache.set(f"files-idx:{key}", _j.dumps(val), ttl=None)

    # ------------------------------------------------------------ index ----
    async def _user_index(self, user_id: str) -> dict:
        """Persistent per-user index of files: {files: {path: meta}, folders: [..]}."""
        from .db import db
        doc = await db.fetch(_fdoc_id(user_id, "__index__"))
        if doc and isinstance(doc.get("content"), str):
            try:
                import json as _j
                return _j.loads(doc["content"])
            except Exception:
                pass
        return {"files": {}, "folders": []}

    async def _save_index(self, user_id: str, idx: dict) -> None:
        from .db import db
        import json as _j
        await db.upsert_document(
            _fdoc_id(user_id, "__index__"), f"files:{user_id}",
            "__index__", _j.dumps(idx), meta={"kind": "file-index"},
        )

    # ------------------------------------------------------------ upload ---
    async def upload(self, user_id: str, filename: str, data: bytes,
                     folder: str = "", note: str = "") -> dict:
        if len(data) > MAX_BYTES:
            raise ValueError(f"file too large ({len(data)//1048576}MB) — limit is 40MB")
        if not settings.github_token:
            raise RuntimeError("GITHUB_TOKEN not configured for file storage")

        fname = _safe_segment(filename)
        folder_clean = "/".join(_safe_segment(s) for s in folder.split("/") if s.strip())
        path = "files/" + _safe_segment(user_id) + (f"/{folder_clean}" if folder_clean else "") + f"/{fname}"
        path = path.replace("//", "/")

        gh = await self._put_bytes(path, data, f"silvestar: upload {user_id}/{folder_clean}/{fname}")
        mime = mimetypes.guess_type(fname)[0] or "application/octet-stream"

        # extract text for RAG (pdf/docx/txt/md/csv)
        text = await asyncio.to_thread(_extract_text, fname, mime, data)

        idx = await self._user_index(user_id)
        meta = {
            "path": path,
            "folder": folder_clean,
            "size": len(data),
            "mime": mime,
            "sha": gh.get("sha", ""),
            "note": note[:500],
            "uploaded": int(time.time()),
            "indexed": bool(text),
        }
        idx["files"][path] = meta
        if folder_clean and folder_clean not in idx["folders"]:
            idx["folders"].append(folder_clean)
        await self._save_index(user_id, idx)

        # RAG: index extracted text so AI can cite this document
        if text:
            from .db import db
            doc_id = "d-" + _fdoc_id(user_id, path)[2:]
            await db.upsert_document(
                doc_id, f"files:{user_id}",
                fname, text[:150_000],
                meta={"kind": "file", "path": path, "mime": mime, "folder": folder_clean},
            )

        return {"id": _fdoc_id(user_id, path), "name": fname, "path": path,
                "folder": folder_clean, **meta}

    async def bulk_upload(self, user_id: str, items: list[dict], folder: str = "") -> dict:
        """items: [{filename, data}] — uploads concurrently (bounded)."""
        results, errors = [], []
        sem = asyncio.Semaphore(3)
        async def one(item: dict):
            async with sem:
                try:
                    results.append(await self.upload(user_id, item["filename"], item["data"], folder))
                except Exception as e:
                    errors.append({"filename": item.get("filename", "?"), "error": str(e)[:160]})
        await asyncio.gather(*[one(i) for i in items])
        return {"uploaded": len(results), "failed": len(errors), "files": results, "errors": errors}

    # ------------------------------------------------------------ listing --
    async def list_files(self, user_id: str, folder: str = "", prefix: str = "") -> dict:
        idx = await self._user_index(user_id)
        rows = []
        for path, m in idx["files"].items():
            if folder and m.get("folder", "") != folder:
                continue
            if prefix and prefix.lower() not in m.get("path", "").lower():
                continue
            rows.append({"id": _fdoc_id(user_id, path), "name": path.rsplit("/", 1)[-1],
                         **m})
        rows.sort(key=lambda r: -r.get("uploaded", 0))
        folders = sorted({f for f in idx.get("folders", []) if (not folder or f.startswith(folder))})
        return {"files": rows, "folders": folders, "total": len(rows)}

    # ---------------------------------------------------------- download ---
    async def download(self, user_id: str, path: str) -> Optional[tuple[bytes, str]]:
        """Returns (bytes, mime) or None."""
        idx = await self._user_index(user_id)
        meta = idx["files"].get(path)
        data = await self._get_bytes(path)
        if data is None:
            return None
        mime = (meta or {}).get("mime") or mimetypes.guess_type(path)[0] or "application/octet-stream"
        return data, mime

    # ------------------------------------------------- rename / move / del --
    async def rename(self, user_id: str, path: str, new_name: str) -> dict:
        return await self.move(user_id, path,
                               (path.rsplit("/", 1)[0] if "/" in path else ""),
                               new_name)

    async def move(self, user_id: str, path: str, new_folder: str, new_name: str = "") -> dict:
        idx = await self._user_index(user_id)
        meta = idx["files"].get(path)
        if not meta:
            raise FileNotFoundError("file not found")
        data = await self._get_bytes(path)
        if data is None:
            raise FileNotFoundError("file bytes missing from storage")

        old_name = path.rsplit("/", 1)[-1]
        fname = _safe_segment(new_name or old_name)
        folder_clean = "/".join(_safe_segment(s) for s in (new_folder or "").split("/") if s.strip())
        new_path = "files/" + _safe_segment(user_id) + (f"/{folder_clean}" if folder_clean else "") + f"/{fname}"
        new_path = new_path.replace("//", "/")

        await self._put_bytes(new_path, data, f"silvestar: move {path} -> {new_path}")
        await self._delete_path(path)

        new_meta = {**meta, "path": new_path, "folder": folder_clean}
        idx["files"].pop(path, None)
        idx["files"][new_path] = new_meta
        if folder_clean and folder_clean not in idx["folders"]:
            idx["folders"].append(folder_clean)
        await self._save_index(user_id, idx)
        return {"id": _fdoc_id(user_id, new_path), **new_meta}

    async def delete_file(self, user_id: str, path: str) -> dict:
        idx = await self._user_index(user_id)
        meta = idx["files"].get(path)
        ok = await self._delete_path(path)
        idx["files"].pop(path, None)
        await self._save_index(user_id, idx)
        # remove RAG doc too
        from .db import db
        await db.delete("d-" + _fdoc_id(user_id, path)[2:])
        return {"deleted": ok, "was_indexed": bool(meta and meta.get("indexed"))}

    async def create_folder(self, user_id: str, folder: str) -> dict:
        folder_clean = "/".join(_safe_segment(s) for s in folder.split("/") if s.strip())
        idx = await self._user_index(user_id)
        if folder_clean and folder_clean not in idx["folders"]:
            idx["folders"].append(folder_clean)
            await self._save_index(user_id, idx)
        return {"folder": folder_clean, "folders": sorted(idx["folders"])}

    async def stats(self, user_id: str) -> dict:
        idx = await self._user_index(user_id)
        files = idx["files"].values()
        return {
            "files": len(files),
            "folders": len(idx.get("folders", [])),
            "bytes": sum(f.get("size", 0) for f in files),
            "indexed": sum(1 for f in files if f.get("indexed")),
        }


# ------------------------------------------------------- text extraction --
def _extract_text(filename: str, mime: str, data: bytes) -> str:
    """Best-effort text extraction for RAG indexing (runs in a thread)."""
    low = filename.lower()
    try:
        if low.endswith((".txt", ".md", ".csv", ".json", ".log", ".srt", ".html", ".xml")):
            return data.decode("utf-8", errors="ignore")
        if low.endswith(".pdf"):
            return _pdf_text(data)
        if low.endswith((".docx",)):
            return _docx_text(data)
        if low.endswith((".pptx",)):
            return _pptx_text(data)
        if low.endswith((".xlsx", ".xls")):
            return _xlsx_text(data)
    except Exception:
        pass
    return ""


def _pdf_text(data: bytes) -> str:
    """Minimal PDF text extractor: decompress streams, pull (text) Tj/TJ ops.
    Handles the majority of text-based PDFs without external deps."""
    import re
    import zlib

    out: list[str] = []
    for m in re.finditer(rb"stream\r?\n(.*?)endstream", data, re.S):
        raw = m.group(1)
        try:
            if b"FlateDecode" in data[max(0, m.start() - 300):m.start()]:
                raw = zlib.decompress(raw)
        except Exception:
            continue
        for tm in re.finditer(rb"\(((?:\\.|[^\\()])*)\)\s*(Tj|TJ|'|\")", raw):
            s = tm.group(1)
            s = s.replace(b"\\(", b"(").replace(b"\\)", b")").replace(b"\\\\", b"\\")
            try:
                out.append(s.decode("latin-1"))
            except Exception:
                pass
    return " ".join(out)


def _ooxml_text(data: bytes, pattern: str) -> str:
    import re
    import zipfile
    import io
    z = zipfile.ZipFile(io.BytesIO(data))
    chunks = []
    for name in z.namelist():
        if pattern in name:
            xml = z.read(name).decode("utf-8", errors="ignore")
            # paragraph & break boundaries
            xml = re.sub(r"</w:p>|</a:p>|</a:t>", "\n", xml)
            texts = re.findall(r"<(?:w|a):t[^>]*>([^<]*)</(?:w|a):t>", xml)
            if texts:
                chunks.append("".join(texts))
    return "\n".join(chunks)


def _docx_text(data: bytes) -> str:
    return _ooxml_text(data, "word/document")


def _pptx_text(data: bytes) -> str:
    return _ooxml_text(data, "ppt/slides/slide")


def _xlsx_text(data: bytes) -> str:
    import re
    import zipfile
    import io
    z = zipfile.ZipFile(io.BytesIO(data))
    chunks = []
    for name in z.namelist():
        if name.startswith("xl/sharedStrings") or name.startswith("xl/worksheets/sheet"):
            xml = z.read(name).decode("utf-8", errors="ignore")
            texts = re.findall(r"<t[^>]*>([^<]*)</t>", xml)
            if texts:
                chunks.append(" ".join(texts))
    return "\n".join(chunks)


files = FileStore()
