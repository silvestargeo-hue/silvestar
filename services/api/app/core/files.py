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
TRASH_TTL = 30 * 86400         # soft-deleted files are recoverable for 30 days
ZIP_MAX_FILES = 100            # max entries extracted per ZIP import
ZIP_MAX_TOTAL = 200 * 1024 * 1024  # total extracted-bytes cap per ZIP


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
        self._commit_lock: Optional[asyncio.Lock] = None

    def _lock(self) -> asyncio.Lock:
        """GitHub Contents API rejects concurrent commits (409) — serialize them."""
        if self._commit_lock is None:
            self._commit_lock = asyncio.Lock()
        return self._commit_lock

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
        async with self._lock():
            r: Optional[httpx.Response] = None
            for attempt in range(4):
                # fetch existing sha (overwrite support)
                r = await c.get(f"/repos/{self._repo}/contents/{urllib.parse.quote(path)}")
                if r.status_code == 200:
                    body["sha"] = r.json()["sha"]
                else:
                    body.pop("sha", None)
                r = await c.put(f"/repos/{self._repo}/contents/{urllib.parse.quote(path)}", json=body)
                if r.status_code not in (409, 422) or attempt == 3:
                    break
                await asyncio.sleep(1.0 + attempt)  # concurrent commit — back off
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
        async with self._lock():
            for attempt in range(4):
                r = await c.get(f"/repos/{self._repo}/contents/{urllib.parse.quote(path)}")
                if r.status_code == 404:
                    return False
                sha = r.json()["sha"]
                rr = await c.request("DELETE", f"/repos/{self._repo}/contents/{urllib.parse.quote(path)}",
                                     json={"message": "silvestar: delete file", "sha": sha})
                if rr.status_code == 200:
                    return True
                if rr.status_code not in (409, 422) or attempt == 3:
                    return False
                await asyncio.sleep(1.0 + attempt)  # concurrent commit — back off
        return False

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

    # ------------------------------------------------------- versions ------
    async def list_versions(self, user_id: str, path: str) -> dict:
        idx = await self._user_index(user_id)
        meta = idx["files"].get(path)
        if not meta:
            raise FileNotFoundError("file not found")
        return {"path": path, "versions": meta.get("versions") or []}

    async def restore_version(self, user_id: str, path: str, ts: int) -> dict:
        idx = await self._user_index(user_id)
        meta = idx["files"].get(path)
        if not meta:
            raise FileNotFoundError("file not found")
        ver = next((v for v in (meta.get("versions") or []) if int(v.get("ts", 0)) == int(ts)), None)
        if not ver:
            raise FileNotFoundError("version not found")
        data = await self._get_bytes(ver["vpath"])
        if data is None:
            raise FileNotFoundError("version bytes missing")
        name = path.rsplit("/", 1)[-1]
        # re-upload: current bytes get stashed as a new version automatically
        return await self.upload(user_id, name, data, folder=meta.get("folder", ""))

    # --------------------------------------------------------- share links --
    async def create_share(self, user_id: str, path: str, password: str = "") -> dict:
        """Create a revocable (optionally password-protected) public share token."""
        import secrets as _s
        idx = await self._user_index(user_id)
        if path not in idx["files"]:
            raise FileNotFoundError("file not found")
        meta = idx["files"][path]
        tok = "sh" + _s.token_urlsafe(18)
        rec = {"path": path, "user_id": user_id, "mime": meta.get("mime", ""),
               "name": path.rsplit("/", 1)[-1], "created": int(time.time())}
        if password:
            rec["ph"] = hashlib.sha256((settings.secret_key + password).encode()).hexdigest()
        await self._kv_set("share:" + tok, rec)
        await self._remember_share(user_id, tok, rec)
        return {"token": tok, "path": path, "name": rec["name"], "protected": bool(password)}

    async def revoke_share(self, user_id: str, token: str) -> dict:
        rec = await self._kv_get("share:" + token)
        if not rec or rec.get("user_id") != user_id:
            raise FileNotFoundError("share not found")
        from .cache import cache
        await cache.delete("files-idx:share:" + token)
        await self._forget_share(user_id, token)
        return {"revoked": True}

    async def list_shares(self, user_id: str) -> dict:
        """List active shares for a user from the per-user index doc."""
        from .db import db
        import json as _j
        idx_doc = await db.fetch("f-shareidx-" + user_id)
        shares = {}
        if idx_doc and isinstance(idx_doc.get("content"), str):
            try:
                shares = _j.loads(idx_doc["content"])
            except Exception:
                shares = {}
        return {"shares": shares}

    async def _remember_share(self, user_id: str, token: str, rec: dict) -> None:
        from .db import db
        import json as _j
        doc_id = "f-shareidx-" + user_id
        doc = await db.fetch(doc_id)
        shares = {}
        if doc and isinstance(doc.get("content"), str):
            try:
                shares = _j.loads(doc["content"])
            except Exception:
                shares = {}
        shares[token] = rec
        await db.upsert_document(doc_id, f"files:{user_id}", "share index", _j.dumps(shares), meta={"kind": "shareidx"})

    async def _forget_share(self, user_id: str, token: str) -> None:
        from .db import db
        import json as _j
        doc_id = "f-shareidx-" + user_id
        doc = await db.fetch(doc_id)
        if doc and isinstance(doc.get("content"), str):
            try:
                shares = _j.loads(doc["content"])
                shares.pop(token, None)
                await db.upsert_document(doc_id, f"files:{user_id}", "share index", _j.dumps(shares), meta={"kind": "shareidx"})
            except Exception:
                pass

    async def resolve_share(self, token: str, password: str = "") -> Optional[tuple[bytes, str, str]]:
        """Return (bytes, mime, name) for a valid share token + password, else None."""
        rec = await self._kv_get("share:" + token)
        if not rec or not rec.get("path"):
            return None
        if rec.get("ph"):
            if hashlib.sha256((settings.secret_key + password).encode()).hexdigest() != rec["ph"]:
                return None
        data = await self._get_bytes(rec["path"])
        if data is None:
            return None
        mime = rec.get("mime") or mimetypes.guess_type(rec["path"])[0] or "application/octet-stream"
        return data, mime, rec.get("name", "file")

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

        idx = await self._user_index(user_id)

        # version history: stash the previous bytes (keep last 3) on overwrite
        versions: list[dict] = []
        old_meta = idx["files"].get(path)
        if old_meta:
            try:
                old = await self._get_bytes(path)
                if old is not None:
                    old_ts = int(old_meta.get("uploaded", time.time()))
                    vdir = hashlib.sha1(path.encode()).hexdigest()[:12]
                    vpath = f"versions/{_safe_segment(user_id)}/{vdir}/{old_ts}-{fname}"
                    await self._put_bytes(vpath, old, f"silvestar: version snapshot {path}@{old_ts}")
                    versions = list(old_meta.get("versions") or [])
                    versions.insert(0, {"ts": old_ts, "size": old_meta.get("size", 0), "vpath": vpath})
                    # prune beyond 3
                    for gone in versions[3:]:
                        try:
                            await self._delete_path(gone.get("vpath", ""))
                        except Exception:
                            pass
                    versions = versions[:3]
            except Exception:
                versions = list(old_meta.get("versions") or [])

        # extract text for RAG (pdf/docx/txt/md/csv)
        text = await asyncio.to_thread(_extract_text, fname, mime, data)

        meta = {
            "path": path,
            "folder": folder_clean,
            "size": len(data),
            "mime": mime,
            "sha": gh.get("sha", ""),
            "note": note[:500],
            "uploaded": int(time.time()),
            "indexed": bool(text),
            "versions": versions,
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

    # ---------------------------------------------------------- zip import --
    async def import_zip(self, user_id: str, filename: str, data: bytes, folder: str = "") -> dict:
        """Extract a ZIP into the Library, preserving subfolders.
        Guards: zip-slip, ≤100 entries, ≤40MB each, ≤200MB total, dotfiles skipped."""
        import io as _io
        import zipfile as _zf
        try:
            zf = _zf.ZipFile(_io.BytesIO(data))
        except Exception:
            raise ValueError("not a valid ZIP file")
        entries: list[tuple[Any, list[str]]] = []
        for zi in zf.infolist():
            if zi.is_dir():
                continue
            parts = [p for p in zi.filename.replace("\\", "/").split("/")
                     if p not in ("", ".", "__MACOSX") and not p.startswith(".")]
            if not parts or any(p == ".." for p in parts):
                continue  # zip-slip / hidden guard
            if len(entries) >= ZIP_MAX_FILES:
                break
            entries.append((zi, parts))
        if not entries:
            zf.close()
            return {"uploaded": 0, "failed": 0, "files": [],
                    "errors": [{"filename": filename, "error": "no extractable entries"}]}
        results, errors = [], []
        total = {"bytes": 0}
        sem = asyncio.Semaphore(3)
        base = "/".join(s for s in (folder or "").split("/") if s.strip())

        async def one(zi, parts):
            async with sem:
                sub = "/".join(parts[:-1])
                target = "/".join(x for x in (base, sub) if x)
                try:
                    b = zf.read(zi)
                    if len(b) > MAX_BYTES:
                        raise ValueError("entry exceeds 40MB")
                    total["bytes"] += len(b)
                    if total["bytes"] > ZIP_MAX_TOTAL:
                        raise ValueError("zip exceeds 200MB extract limit")
                    results.append(await self.upload(user_id, parts[-1], b, target))
                except Exception as e:
                    errors.append({"filename": zi.filename, "error": str(e)[:160]})

        await asyncio.gather(*[one(zi, parts) for zi, parts in entries])
        zf.close()
        return {"uploaded": len(results), "failed": len(errors),
                "files": results, "errors": errors}

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
        # `path` is the FULL stored path (files/<uid>/<folder>/<name>); move()
        # expects a USER-RELATIVE folder, so strip the files/<uid>/ prefix first.
        prefix = f"files/{_safe_segment(user_id)}/"
        rel = path[len(prefix):] if path.startswith(prefix) else path
        folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
        return await self.move(user_id, path, folder, new_name)

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
        self._prune_folders(idx, keep={folder_clean})
        await self._save_index(user_id, idx)
        # keep the RAG index in sync with the new path
        if meta.get("indexed"):
            from .db import db
            old_doc = await db.fetch("d-" + _fdoc_id(user_id, path)[2:])
            if old_doc:
                await db.upsert_document(
                    "d-" + _fdoc_id(user_id, new_path)[2:], f"files:{user_id}",
                    fname, old_doc.get("content", ""),
                    meta={"kind": "file", "path": new_path, "mime": new_meta.get("mime", ""), "folder": folder_clean},
                )
                await db.delete("d-" + _fdoc_id(user_id, path)[2:])
        return {"id": _fdoc_id(user_id, new_path), **new_meta}

    async def delete_file(self, user_id: str, path: str, hard: bool = False) -> dict:
        """Soft-delete to Trash (30-day restore) by default; hard=True removes bytes now."""
        idx = await self._user_index(user_id)
        meta = idx["files"].get(path)
        if hard:
            ok = await self._delete_path(path)
        elif meta is not None:
            ok = True
            idx.setdefault("trash", {})[path] = {**meta, "deleted": int(time.time())}
        else:
            ok = False  # unknown path — nothing to trash
        idx["files"].pop(path, None)
        self._prune_folders(idx)
        await self._save_index(user_id, idx)
        # remove RAG doc too
        from .db import db
        await db.delete("d-" + _fdoc_id(user_id, path)[2:])
        return {"deleted": ok, "was_indexed": bool(meta and meta.get("indexed")), "trashed": not hard}

    # -------------------------------------------------------------- trash --
    async def list_trash(self, user_id: str) -> dict:
        """Trash contents; lazily hard-deletes entries older than 30 days."""
        idx = await self._user_index(user_id)
        trash = idx.setdefault("trash", {})
        now = int(time.time())
        expired = [p for p, m in trash.items()
                   if now - int(m.get("deleted", now)) > TRASH_TTL]
        for p in expired:
            try:
                await self._delete_path(p)
            except Exception:
                pass
            trash.pop(p, None)
        if expired:
            await self._save_index(user_id, idx)
        items = []
        for p, m in trash.items():
            age = now - int(m.get("deleted", now))
            items.append({"name": p.rsplit("/", 1)[-1], "path": p,
                          "folder": m.get("folder", ""), "size": m.get("size", 0),
                          "mime": m.get("mime", ""), "deleted": m.get("deleted", 0),
                          "expires_in_days": max(0, (TRASH_TTL - age) // 86400)})
        items.sort(key=lambda r: -r.get("deleted", 0))
        return {"files": items, "total": len(items)}

    async def restore_file(self, user_id: str, path: str) -> dict:
        """Put a trashed file back (re-indexes it for RAG)."""
        idx = await self._user_index(user_id)
        trash = idx.get("trash", {})
        meta = trash.get(path)
        if not meta:
            raise FileNotFoundError("not in trash")
        if path in idx["files"]:
            return {"ok": False, "reason": "a file already exists at this path"}
        data = await self._get_bytes(path)
        if data is None:
            trash.pop(path, None)
            await self._save_index(user_id, idx)
            raise FileNotFoundError("file bytes expired")
        trash.pop(path, None)
        idx["files"][path] = meta
        if meta.get("folder") and meta["folder"] not in idx["folders"]:
            idx["folders"].append(meta["folder"])
        await self._save_index(user_id, idx)
        text = await asyncio.to_thread(_extract_text, path.rsplit("/", 1)[-1],
                                       meta.get("mime", ""), data)
        if text:
            from .db import db
            await db.upsert_document(
                "d-" + _fdoc_id(user_id, path)[2:], f"files:{user_id}",
                path.rsplit("/", 1)[-1], text[:150_000],
                meta={"kind": "file", "path": path, "mime": meta.get("mime", ""),
                      "folder": meta.get("folder", "")},
            )
        return {"ok": True, "path": path, "name": path.rsplit("/", 1)[-1]}

    async def purge_file(self, user_id: str, path: str) -> dict:
        """Permanently delete one trashed file (bytes + entry)."""
        idx = await self._user_index(user_id)
        trash = idx.get("trash", {})
        if path not in trash:
            raise FileNotFoundError("not in trash")
        ok = await self._delete_path(path)
        trash.pop(path, None)
        await self._save_index(user_id, idx)
        return {"purged": ok}

    async def empty_trash(self, user_id: str) -> dict:
        idx = await self._user_index(user_id)
        trash = idx.get("trash", {})
        n = 0
        for p in list(trash.keys()):
            try:
                if await self._delete_path(p):
                    n += 1
            except Exception:
                pass
            trash.pop(p, None)
        await self._save_index(user_id, idx)
        return {"purged": n}

    @staticmethod
    def _prune_folders(idx: dict, keep: str | set[str] = "") -> None:
        """Drop folder entries that no longer contain any file."""
        keep_set = {keep} if isinstance(keep, str) else set(keep)
        used = {f.get("folder", "") for f in idx["files"].values()} | keep_set
        idx["folders"] = [f for f in idx.get("folders", []) if f in used]

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

    # -------------------------------------------------------- duplicates ---
    async def duplicates(self, user_id: str) -> dict:
        """Group library files by identical content (git blob sha)."""
        idx = await self._user_index(user_id)
        groups: dict[str, list] = {}
        for p, m in idx["files"].items():
            sha = m.get("sha", "")
            if sha:
                groups.setdefault(sha, []).append({
                    "name": p.rsplit("/", 1)[-1], "path": p,
                    "folder": m.get("folder", ""), "size": m.get("size", 0),
                    "uploaded": m.get("uploaded", 0)})
        dups = [sorted(g, key=lambda r: r["uploaded"]) for g in groups.values() if len(g) > 1]
        waste = sum(sum(f["size"] for f in g[1:]) for g in dups)
        return {"groups": dups, "wasted_bytes": waste}

    async def batch_rename(self, user_id: str, paths: list[str], pattern: str, start: int = 1) -> dict:
        """Rename many files by pattern. Tokens: {n} number, {date} YYYY-MM-DD,
        {name} old stem, {ext} extension. Empty segments are skipped."""
        import re as _re
        idx = await self._user_index(user_id)
        date = time.strftime("%Y-%m-%d")
        results, errors = [], []
        n = max(1, int(start))
        used: set[str] = set()
        for p in paths[:50]:
            meta = idx["files"].get(p)
            if not meta:
                errors.append({"path": p, "error": "not found"})
                continue
            old_name = p.rsplit("/", 1)[-1]
            stem, dot, ext = old_name.rpartition(".")
            if not dot:
                stem, ext = old_name, ""
            prefix = f"files/{_safe_segment(user_id)}/"
            rel = p[len(prefix):] if p.startswith(prefix) else p
            folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
            new_name = (pattern.replace("{n}", str(n))
                               .replace("{date}", date)
                               .replace("{name}", _safe_segment(stem)[:40])
                               .replace("{ext}", ext))
            new_name = _safe_segment(new_name.strip(".") or old_name)
            if not new_name or new_name == old_name:
                n += 1
                continue
            new_path = ("files/" + _safe_segment(user_id) +
                        (f"/{folder}" if folder else "") + f"/{new_name}").replace("//", "/")
            if new_path in used or (new_path in idx["files"] and new_path != p):
                errors.append({"path": p, "error": f"target exists: {new_name}"})
                continue
            try:
                await self.rename(user_id, p, new_name)
                idx = await self._user_index(user_id)  # rename() rewrote the index
                used.add(new_path)
                results.append({"old": p, "new": new_path})
                n += 1
            except Exception as e:
                errors.append({"path": p, "error": str(e)[:140]})
        return {"renamed": len(results), "results": results, "errors": errors}

    async def dedupe(self, user_id: str, keep: str = "oldest") -> dict:
        """Trash every duplicate copy, keeping the oldest (or newest) per group."""
        d = await self.duplicates(user_id)
        removed = 0
        for g in d["groups"]:
            keeper = g[0] if keep == "oldest" else g[-1]
            for f in g:
                if f["path"] != keeper["path"]:
                    await self.delete_file(user_id, f["path"])  # soft → recoverable
                    removed += 1
        return {"removed": removed, "groups": len(d["groups"])}


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
