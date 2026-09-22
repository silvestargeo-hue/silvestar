"""Module 14 — File Library REST endpoints.

Upload (single + bulk), list, folders, download, rename, move, delete.
Storage: GitHub data repo (free, any file type ≤ 40MB). Extracted text is
indexed for RAG so the AI can answer questions about your files.
"""
from __future__ import annotations

import urllib.parse

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, Response, UploadFile
from pydantic import BaseModel

from .files import files

router = APIRouter(prefix="/api/v1/files", tags=["files"])


def _uid(request: Request) -> str:
    """Resolve the requesting user: Bearer session (preferred) else explicit header."""
    authz = request.headers.get("authorization", "")
    if authz.startswith("Bearer "):
        try:
            from .auth import auth as auth_svc

            user = None
            # validate_session is async; call inline below in handler instead
        except Exception:
            pass
    return (request.headers.get("x-silvestar-user") or "anon").strip() or "anon"


async def _uid_async(request: Request) -> str:
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
    return (request.headers.get("x-silvestar-user") or "anon").strip() or "anon"


@router.get("")
async def list_files(request: Request, folder: str = "", prefix: str = ""):
    uid = await _uid_async(request)
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
    got = await files.download(uid, path)
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
    got = await files.download(uid, path)
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
