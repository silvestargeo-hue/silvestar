"""Module 18 — Shared Spaces: family/team folders with member roles.

A Space is a Library folder convention: `Space/<name>/…`. Members (invited by
email) get read access to every file inside that folder tree. Roles: owner /
member. Membership rows live in the `spaces` library as kind=member docs so
any device can resolve access without extra services. Free.
"""
from __future__ import annotations

import json
import re
import time

from .db import db


def _space_id(name: str) -> str:
    return "sp-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30]


def space_folder(name: str) -> str:
    return f"Space/{_space_id(name)[3:]}"


def _member_id(space: str, email: str) -> str:
    import hashlib
    return "sm-" + hashlib.sha1(f"{space}|{email.lower()}".encode()).hexdigest()[:14]


async def create_space(owner_uid: str, owner_email: str, name: str) -> dict:
    sid = _space_id(name)
    now = int(time.time())
    await db.upsert_document(sid, "spaces", name, json.dumps({
        "name": name[:40], "owner": owner_uid, "owner_email": owner_email,
        "created": now,
    }), meta={"kind": "space"})
    # owner membership
    await db.upsert_document(_member_id(name, owner_email), "spaces", name,
                             json.dumps({"space": name[:40], "email": owner_email.lower(),
                                         "user_id": owner_uid, "role": "owner", "created": now}),
                             meta={"kind": "member", "space": name[:40]})
    return {"id": sid, "name": name[:40], "folder": space_folder(name), "role": "owner"}


async def invite(space: str, email: str, inviter_uid: str) -> dict:
    doc = await db.fetch(_space_id(space))
    if not doc or (json.loads(doc.get("content") or "{}")).get("owner") != inviter_uid:
        return {"ok": False, "reason": "only the owner can invite"}
    # resolve invitee's uid (if registered) so file access can map by uid too
    invitee_uid = ""
    rows, _t = await db.list("accounts", limit=500)
    for r in rows:
        if r["id"].endswith("::" + email.lower()):
            invitee_uid = (r.get("meta") or {}).get("user_id", "")
            break
    await db.upsert_document(_member_id(space, email), "spaces", space,
                             json.dumps({"space": space[:40], "email": email.lower(),
                                         "user_id": invitee_uid, "role": "member",
                                         "created": int(time.time())}),
                             meta={"kind": "member", "space": space[:40]})
    return {"ok": True, "space": space[:40], "member": email.lower()}


async def remove_member(space: str, email: str, remover_uid: str) -> dict:
    doc = await db.fetch(_space_id(space))
    if not doc or (json.loads(doc.get("content") or "{}")).get("owner") != remover_uid:
        return {"ok": False, "reason": "only the owner can remove"}
    mid = _member_id(space, email)
    m = await db.fetch(mid)
    if not m:
        return {"ok": False, "reason": "not a member"}
    if (json.loads(m.get("content") or "{}")).get("role") == "owner":
        return {"ok": False, "reason": "cannot remove the owner"}
    await db.delete(mid)
    return {"ok": True}


async def my_spaces(uid: str, email: str) -> dict:
    """Spaces the user owns or is a member of."""
    rows, _t = await db.list("spaces", limit=200)
    spaces: dict[str, dict] = {}
    for r in rows:
        m = r.get("meta") or {}
        try:
            content = json.loads(r.get("content") or "{}")
        except Exception:
            continue
        if m.get("kind") == "space" and content.get("owner") == uid:
            spaces[content["name"]] = {"name": content["name"], "role": "owner",
                                       "folder": space_folder(content["name"])}
        elif m.get("kind") == "member" and content.get("email") == email.lower():
            spaces.setdefault(content["space"], {"name": content["space"], "role": "member",
                                                 "folder": space_folder(content["space"])})
    return {"spaces": sorted(spaces.values(), key=lambda s: s["name"])}


async def can_read_folder(uid: str, email: str, folder: str) -> bool:
    """True when folder is Space/<x>/… and the user is a member of Space x."""
    parts = folder.strip("/").split("/")
    if len(parts) < 2 or parts[0] != "Space":
        return False
    space_name = None
    rows, _t = await db.list("spaces", limit=200)
    for r in rows:
        if (r.get("meta") or {}).get("kind") == "space" and r["id"] == "sp-" + parts[1]:
            space_name = r.get("title")
            break
    if not space_name:
        return False
    for r in rows:
        m = r.get("meta") or {}
        if m.get("kind") != "member":
            continue
        try:
            content = json.loads(r.get("content") or "{}")
        except Exception:
            continue
        if content.get("space") == space_name and (
            content.get("user_id") == uid or content.get("email") == email.lower()
        ):
            return True
    return False
