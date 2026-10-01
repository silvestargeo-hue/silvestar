"""Module 23 — Memory Core.

Silvestar quietly learns durable facts about each user from Ask conversations
(projects, preferences, people, deadlines) and recalls them in later chats so
answers feel personal. Users can inspect ("What Silvestar knows about me") and
delete any memory. Free: extraction + recall run on the existing AI chain.

Memories live in `memory:<user_id>` as kind=memory docs with JSON content:
{"text": str, "kind": str, "created": int}. Hard caps keep the store tidy.
"""
from __future__ import annotations

import json
import time

from .ai import ai
from .db import db

MAX_MEMORIES = 300

# very small heuristic pre-filter: skip obvious chatter before spending AI calls
_SKIP = ("hi", "hello", "hey", "thanks", "thank you", "ok", "okay", "cool",
         "nice", "good morning", "good evening", "bye")


def _mem_id(user_id: str, text: str) -> str:
    import hashlib
    return "mem-" + hashlib.sha1(f"{user_id}|{text.lower()}".encode()).hexdigest()[:16]


async def remember_fact(user_id: str, text: str, kind: str = "fact") -> bool:
    """Store one durable memory (deduped by text). Returns True if stored."""
    text = (text or "").strip()
    if not text or len(text) < 8:
        return False
    low = text.lower()
    if low in _SKIP:
        return False
    existing = await db.fetch(_mem_id(user_id, text))
    if existing:
        return False
    # cap: drop nothing automatically (memories are precious); cap is soft
    await db.upsert_document(
        _mem_id(user_id, text), f"memory:{user_id}", text[:80], json.dumps({
            "text": text[:400], "kind": kind, "created": int(time.time()),
        }),
        meta={"kind": "memory"},
    )
    return True


async def extract_from_exchange(user_id: str, question: str, answer: str) -> int:
    """After an Ask exchange, ask the AI to pull durable facts worth remembering.
    Cheap: one small prompt; silently skips on any failure. Returns stored count."""
    q = (question or "").strip()
    a = (answer or "").strip()
    if len(q) < 15 or len(a) < 30:
        return 0
    try:
        res = await ai.summarize(
            "From this conversation, extract 0-3 durable facts worth remembering "
            "about the USER long-term: their projects, goals, preferences, tools "
            "they use, people/deadlines they mention, or stable personal context. "
            "Do NOT include transient questions or the assistant's knowledge. "
            "Return ONLY the facts, one per line (max 12 words each). If nothing "
            "is worth remembering, return exactly: NONE",
            f"USER SAID: {q[:800]}\n\nASSISTANT ANSWERED: {a[:1500]}",
        )
        out = (res.get("summary") or "").strip()
        if not out or out.upper().startswith("NONE"):
            return 0
        n = 0
        for line in out.splitlines()[:3]:
            line = line.strip().lstrip("-•*").strip()
            import re as _re
            line = _re.sub(r"^\d+[.)]\s*", "", line)
            if line and len(line) > 8 and await remember_fact(user_id, line, "auto"):
                n += 1
        return n
    except Exception:
        return 0


async def recall_block(user_id: str, question: str, limit: int = 8) -> str:
    """Memories relevant to the question, formatted for the system prompt."""
    try:
        hits = await db.search(f"memory:{user_id}", question[:200], limit=limit * 2)
    except Exception:
        return ""
    now = int(time.time())
    lines, seen = [], set()
    for h in hits:
        if (h.get("meta") or {}).get("kind") != "memory":
            continue
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        t = (rec.get("text") or "").strip()
        key = t.lower()
        if not t or key in seen:
            continue
        seen.add(key)
        age_days = max(0, (now - int(rec.get("created", now))) // 86400)
        lines.append(f"- {t} (learned {age_days}d ago)")
        if len(lines) >= limit:
            break
    if not lines:
        return ""
    return ("\n\nLong-term memory about this user (use quietly when relevant, "
            "never list it back verbatim):\n" + "\n".join(lines))


async def list_memories(user_id: str) -> dict:
    hits = await db.search(f"memory:{user_id}", " ", limit=MAX_MEMORIES)
    out = []
    for h in hits:
        if (h.get("meta") or {}).get("kind") != "memory":
            continue
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        rec["id"] = h["id"]
        out.append(rec)
    out.sort(key=lambda r: int(r.get("created", 0)), reverse=True)
    return {"memories": out, "total": len(out)}


async def delete_memory(user_id: str, mem_id: str) -> bool:
    doc = await db.fetch(mem_id)
    if not doc or doc.get("library") != f"memory:{user_id}":
        return False
    await db.delete(mem_id)
    return True


async def clear_all(user_id: str) -> int:
    hits = await db.search(f"memory:{user_id}", " ", limit=MAX_MEMORIES)
    n = 0
    for h in hits:
        if (h.get("meta") or {}).get("kind") == "memory":
            await db.delete(h["id"])
            n += 1
    return n
