"""Module 14 — File Library REST endpoints.

Upload (single + bulk), list, folders, download, rename, move, delete.
Storage: GitHub data repo (free, any file type ≤ 40MB). Extracted text is
indexed for RAG so the AI can answer questions about your files.
"""
from __future__ import annotations

import urllib.parse

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, Response, UploadFile
from pydantic import BaseModel, Field

import zipfile
import io

from .files import files
from . import spaces as spaces_mod

router = APIRouter(prefix="/api/v1/files", tags=["files"])


async def _uid_async(request: Request) -> str:
    """Resolve the requesting user STRICTLY from a valid Bearer session.
    The x-silvestar-user header is client-controlled and must never grant
    access to another user's files (spoofing vulnerability, fixed)."""
    authz = request.headers.get("authorization", "")
    if authz.startswith("Bearer "):
        try:
            from .auth import auth as auth_svc

            user = await auth_svc.validate_session(authz[7:])
            if user and user.get("user_id"):
                return str(user["user_id"])
            if user and user.get("email"):
                return str(user["email"])
        except Exception:
            pass
    return "anon"


async def _session_async(request: Request) -> dict:
    """{'uid': …, 'email': …} from a valid Bearer session; anon otherwise."""
    authz = request.headers.get("authorization", "")
    if authz.startswith("Bearer "):
        try:
            from .auth import auth as auth_svc

            user = await auth_svc.validate_session(authz[7:])
            if user:
                return {"uid": str(user.get("user_id") or user.get("email") or "anon"),
                        "email": str(user.get("email") or "")}
        except Exception:
            pass
    return {"uid": "anon", "email": ""}


async def _space_list_uid(request: Request, uid: str, folder: str) -> str:
    """Shared-space listing: members may list `Space/<x>` from the owner's index.
    Non-members with no access get 403 instead of a silent empty list."""
    if not folder.startswith("Space/"):
        return uid
    s = await _session_async(request)
    if not s["email"]:
        raise HTTPException(401, "sign in to access shared spaces")
    owner = await spaces_mod.space_owner_uid(s["email"], folder)
    if not owner:
        raise HTTPException(403, "no access to this space")
    return owner


async def _read_uid_for(request: Request, uid: str, path: str) -> str:
    """Shared-space reads: `path` is a FULL stored path files/<owner>/Space/<x>/….
    A verified member (or the owner) reads from the owner's subtree; anyone else
    touching another user's path gets an explicit 403."""
    parts = path.split("/")
    if len(parts) >= 4 and parts[0] == "files" and parts[2] == "Space":
        if parts[1] == uid:
            return uid
        s = await _session_async(request)
        owner = (await spaces_mod.space_owner_uid(s["email"], f"Space/{parts[3]}")
                 if s["email"] else None)
        if owner and owner == parts[1]:
            return owner
        raise HTTPException(403, "no access to this file")
    return uid


@router.get("")
async def list_files(request: Request, folder: str = "", prefix: str = ""):
    uid = await _uid_async(request)
    uid = await _space_list_uid(request, uid, folder)
    return await files.list_files(uid, folder=folder, prefix=prefix)


@router.get("/stats")
async def stats(request: Request):
    uid = await _uid_async(request)
    return await files.stats(uid)


@router.post("/upload")
async def upload(request: Request,
                 file: UploadFile = File(...),
                 folder: str = Form(""),
                 note: str = Form("")):
    uid = await _uid_async(request)
    data = await file.read()
    try:
        return await files.upload(uid, file.filename or "file", data, folder=folder, note=note)
    except ValueError as e:
        raise HTTPException(413, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.post("/upload-bulk")
async def upload_bulk(request: Request,
                      files_in: list[UploadFile] = File(..., alias="files"),
                      folder: str = Form("")):
    uid = await _uid_async(request)
    items = []
    for f in files_in:
        items.append({"filename": f.filename or "file", "data": await f.read()})
    try:
        return await files.bulk_upload(uid, items, folder=folder)
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.get("/download")
async def download(request: Request, path: str = Query(...)):
    uid = await _uid_async(request)
    got = await files.download(await _read_uid_for(request, uid, path), path)
    if not got:
        raise HTTPException(404, "file not found")
    data, mime = got
    name = urllib.parse.quote(path.rsplit("/", 1)[-1])
    return Response(
        content=data,
        media_type=mime,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{name}"},
    )


@router.get("/view")
async def view(request: Request, path: str = Query(...)):
    """Inline view (browser PDF/image/text viewer) — same as download but inline."""
    uid = await _uid_async(request)
    got = await files.download(await _read_uid_for(request, uid, path), path)
    if not got:
        raise HTTPException(404, "file not found")
    data, mime = got
    name = urllib.parse.quote(path.rsplit("/", 1)[-1])
    return Response(
        content=data,
        media_type=mime,
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{name}"},
    )


class RenameIn(BaseModel):
    path: str
    new_name: str


class MoveIn(BaseModel):
    path: str
    new_folder: str
    new_name: str = ""


class DeleteIn(BaseModel):
    path: str


class FolderIn(BaseModel):
    folder: str


class ShareIn(BaseModel):
    path: str
    password: str = ""


class ShareRevokeIn(BaseModel):
    token: str


class RestoreIn(BaseModel):
    path: str
    ts: int


class BulkIn(BaseModel):
    paths: list[str]
    folder: str = ""


@router.post("/rename")
async def rename(request: Request, body: RenameIn):
    uid = await _uid_async(request)
    try:
        return await files.rename(uid, body.path, body.new_name)
    except FileNotFoundError:
        raise HTTPException(404, "file not found")


@router.post("/move")
async def move(request: Request, body: MoveIn):
    uid = await _uid_async(request)
    try:
        return await files.move(uid, body.path, body.new_folder, body.new_name)
    except FileNotFoundError:
        raise HTTPException(404, "file not found")


@router.post("/folders")
async def create_folder(request: Request, body: FolderIn):
    uid = await _uid_async(request)
    return await files.create_folder(uid, body.folder)


@router.post("/delete")
async def delete_file(request: Request, body: DeleteIn):
    uid = await _uid_async(request)
    return await files.delete_file(uid, body.path)


# -------------------------------------------------------------- trash ------
@router.get("/trash")
async def trash_list(request: Request):
    uid = await _uid_async(request)
    return await files.list_trash(uid)


class TrashPathIn(BaseModel):
    path: str


@router.post("/trash/restore")
async def trash_restore(request: Request, body: TrashPathIn):
    uid = await _uid_async(request)
    try:
        return await files.restore_file(uid, body.path)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e) or "not in trash")


@router.post("/trash/purge")
async def trash_purge(request: Request, body: TrashPathIn):
    uid = await _uid_async(request)
    try:
        return await files.purge_file(uid, body.path)
    except FileNotFoundError:
        raise HTTPException(404, "not in trash")


@router.post("/trash/empty")
async def trash_empty(request: Request):
    uid = await _uid_async(request)
    return await files.empty_trash(uid)


# ------------------------------------------------------- zip import --------
class DedupeIn(BaseModel):
    keep: str = "oldest"  # "oldest" | "newest"


@router.post("/upload-zip")
async def upload_zip(request: Request, file: UploadFile = File(...), folder: str = Form("")):
    """Upload a ZIP: every entry is extracted into the Library (subfolders kept)."""
    uid = await _uid_async(request)
    data = await file.read()
    if len(data) > 120 * 1024 * 1024:
        raise HTTPException(413, "zip too large (120MB limit)")
    try:
        return await files.import_zip(uid, file.filename or "upload.zip", data, folder=folder)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/duplicates")
async def dup_list(request: Request):
    uid = await _uid_async(request)
    return await files.duplicates(uid)


class RenameBatchIn(BaseModel):
    paths: list[str]
    pattern: str = Field(min_length=1, max_length=80)
    start: int = 1


@router.post("/batch-rename")
async def batch_rename(request: Request, body: RenameBatchIn):
    uid = await _uid_async(request)
    if not body.paths:
        raise HTTPException(422, "no files selected")
    return await files.batch_rename(uid, body.paths, body.pattern, body.start)


@router.post("/dedupe")
async def dedupe(request: Request, body: DedupeIn):
    uid = await _uid_async(request)
    if body.keep not in ("oldest", "newest"):
        raise HTTPException(422, "keep must be 'oldest' or 'newest'")
    return await files.dedupe(uid, body.keep)


# ---------------------------------------------------------------- zip ------
@router.get("/zip")
async def zip_folder(request: Request, folder: str = Query("")):
    """Download all files in a folder (or the whole library) as one ZIP."""
    uid = await _uid_async(request)
    listing = await files.list_files(uid, folder=folder)
    if not listing["files"]:
        raise HTTPException(404, "nothing to zip")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in listing["files"]:
            got = await files.download(uid, f["path"])
            if not got:
                continue
            data, _mime = got
            name = f.get("name") or f["path"].rsplit("/", 1)[-1]
            # keep folder structure relative to the zipped folder
            rel = f["path"]
            prefix = f"files/{uid}/{folder}".rstrip("/")
            if rel.startswith(prefix + "/"):
                rel = rel[len(prefix) + 1:]
            z.writestr(rel or name, data)
    buf.seek(0)
    zname = (folder.replace("/", "-") if folder else "library") + ".zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={zname}"},
    )


# ------------------------------------------------------------ bulk actions --
@router.post("/bulk-delete")
async def bulk_delete(request: Request, body: BulkIn):
    uid = await _uid_async(request)
    results = []
    for p in body.paths[:100]:
        try:
            await files.delete_file(uid, p)
            results.append({"path": p, "ok": True})
        except Exception as e:
            results.append({"path": p, "ok": False, "error": str(e)[:120]})
    return {"results": results, "deleted": sum(1 for r in results if r["ok"]), "failed": sum(1 for r in results if not r["ok"]) }


@router.post("/bulk-move")
async def bulk_move(request: Request, body: BulkIn):
    uid = await _uid_async(request)
    results = []
    for p in body.paths[:100]:
        try:
            await files.move(uid, p, body.folder)
            results.append({"path": p, "ok": True})
        except Exception as e:
            results.append({"path": p, "ok": False, "error": str(e)[:120]})
    return {"results": results, "moved": sum(1 for r in results if r["ok"]), "failed": sum(1 for r in results if not r["ok"]) }


# --------------------------------------------------------------- versions --
@router.get("/versions")
async def versions(request: Request, path: str = Query(...)):
    uid = await _uid_async(request)
    try:
        return await files.list_versions(uid, path)
    except FileNotFoundError:
        raise HTTPException(404, "file not found")


@router.post("/versions/restore")
async def restore_version(request: Request, body: RestoreIn):
    uid = await _uid_async(request)
    try:
        return await files.restore_version(uid, body.path, body.ts)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


# ------------------------------------------------------------ share links --
@router.post("/share")
async def share_file(request: Request, body: ShareIn):
    """body.path = file path, optional body.password → public share link."""
    uid = await _uid_async(request)
    if uid == "anon":
        raise HTTPException(401, "sign in to share files")
    try:
        r = await files.create_share(uid, body.path, body.password or "")
    except FileNotFoundError:
        raise HTTPException(404, "file not found")
    base = str(request.base_url).rstrip("/")
    return {**r, "url": f"{base}/api/v1/files/public/{r['token']}"}


@router.get("/shares")
async def shares(request: Request):
    uid = await _uid_async(request)
    if uid == "anon":
        raise HTTPException(401, "sign in to manage shares")
    return await files.list_shares(uid)


@router.post("/share/revoke")
async def revoke_share(request: Request, body: ShareRevokeIn):
    uid = await _uid_async(request)
    if uid == "anon":
        raise HTTPException(401, "sign in to manage shares")
    try:
        return await files.revoke_share(uid, body.token)
    except FileNotFoundError:
        raise HTTPException(404, "share not found")


@router.get("/public/{token}")
async def public_download(request: Request, token: str, password: str = Query("")):
    """No-auth public access for a valid, unrevoked share token (+ password if set)."""
    got = await files.resolve_share(token, password)
    if not got:
        raise HTTPException(404, "link expired, revoked, or wrong password")
    data, mime, name = got
    safe = urllib.parse.quote(name)
    return Response(
        content=data,
        media_type=mime,
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{safe}"},
    )


# ------------------------------------------------------------ share links --
@router.post("/share")
async def share_file(request: Request, body: DeleteIn):
    """body.path = file path → returns {token, url} for a public share link."""
    uid = await _uid_async(request)
    if uid == "anon":
        raise HTTPException(401, "sign in to share files")
    try:
        r = await files.create_share(uid, body.path)
    except FileNotFoundError:
        raise HTTPException(404, "file not found")
    base = str(request.base_url).rstrip("/")
    return {**r, "url": f"{base}/api/v1/files/public/{r['token']}"}


@router.get("/shares")
async def shares(request: Request):
    uid = await _uid_async(request)
    if uid == "anon":
        raise HTTPException(401, "sign in to manage shares")
    return await files.list_shares(uid)


@router.post("/share/revoke")
async def revoke_share(request: Request, body: ShareRevokeIn):
    uid = await _uid_async(request)
    if uid == "anon":
        raise HTTPException(401, "sign in to manage shares")
    try:
        return await files.revoke_share(uid, body.token)
    except FileNotFoundError:
        raise HTTPException(404, "share not found")


@router.get("/public/{token}")
async def public_download(request: Request, token: str):
    """No-auth public access for a valid, unrevoked share token."""
    got = await files.resolve_share(token)
    if not got:
        raise HTTPException(404, "link expired or revoked")
    data, mime, name = got
    safe = urllib.parse.quote(name)
    return Response(
        content=data,
        media_type=mime,
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{safe}"},
    )
