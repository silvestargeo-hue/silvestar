"""Module 32 — Personal Webhooks.

Every user gets a secret webhook token. Anything that can make an HTTP POST
(Android Shortcuts, Tasker, IFTTT, cron, a laptop curl, Termux) can push
into Silvestar: create notes/files, set reminders, ask the AI. All actions
are rate-limited and audited in `hooks:{user_id}` (kind=hook-log).
"""
from __future__ import annotations

import hashlib
import json
import secrets
import time

from .db import db

MAX_LOG = 50
MAX_NOTES_PER_HOUR = 30


def _token_id(user_id: str) -> str:
    return "hooktok-" + hashlib.sha1(f"hook|{user_id}".encode()).hexdigest()[:14]


async def get_or_create_token(user_id: str) -> dict:
    doc = await db.fetch(_token_id(user_id))
    if doc:
        try:
            return json.loads(doc.get("content") or "{}")
        except Exception:
            pass
    tok = "svh_" + secrets.token_hex(20)
    rec = {"token": tok, "created": int(time.time()), "calls": 0}
    await db.upsert_document(_token_id(user_id), f"hooks:{user_id}", "webhook token",
                             json.dumps(rec), meta={"kind": "hook-token"})
    return rec


async def rotate_token(user_id: str) -> dict:
    tok = "svh_" + secrets.token_hex(20)
    rec = {"token": tok, "created": int(time.time()), "calls": 0, "rotated": True}
    await db.upsert_document(_token_id(user_id), f"hooks:{user_id}", "webhook token",
                             json.dumps(rec), meta={"kind": "hook-token"})
    return rec


def _log_id(user_id: str, ts: int) -> str:
    return "hooklog-" + hashlib.sha1(f"{user_id}|{ts}|{secrets.token_hex(4)}".encode()).hexdigest()[:16]


async def audit(user_id: str, action: str, detail: str, ok: bool) -> None:
    try:
        await db.upsert_document(
            _log_id(user_id, int(time.time())), f"hooks:{user_id}", action[:40],
            json.dumps({"action": action[:40], "detail": detail[:200],
                        "ok": ok, "ts": int(time.time())}),
            meta={"kind": "hook-log"})
    except Exception:
        pass


async def recent_calls(user_id: str, limit: int = MAX_LOG) -> list[dict]:
    hits = await db.search(f"hooks:{user_id}", " ", limit=limit)
    out = []
    for h in hits:
        if (h.get("meta") or {}).get("kind") != "hook-log":
            continue
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        rec["id"] = h["id"]
        out.append(rec)
    out.sort(key=lambda r: -int(r.get("ts", 0)))
    return out[:limit]


async def rate_ok(user_id: str) -> bool:
    """Simple hourly throttle on logged actions."""
    calls = await recent_calls(user_id, 60)
    hour_ago = int(time.time()) - 3600
    return sum(1 for c in calls if int(c.get("ts", 0)) >= hour_ago) < MAX_NOTES_PER_HOUR
