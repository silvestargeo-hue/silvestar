"""Module 30 — Persona Studio.

Users create custom AI personas: a name, emoji, tagline, standing
instructions and a voice pitch (for spoken answers). Personas are selectable
in Ask and VoiceGlass; the AI answers fully in character. Built-ins are
provided and user personas live in `personas:{user_id}` (kind=persona).
"""
from __future__ import annotations

import hashlib
import json
import time

from .db import db

BUILTIN = [
    {"id": "builtin:silvestar", "name": "Silvestar", "emoji": "⭐",
     "tagline": "Your platform assistant", "instructions": "", "pitch": 1.0, "builtin": True},
    {"id": "builtin:editor", "name": "Sharp Editor", "emoji": "✂️",
     "tagline": "Cuts fluff, fixes structure",
     "instructions": "You are a mercilessly clear editor. Tighten wording, fix structure, remove filler. Show improved text first, then a 2-bullet explanation of what you changed and why.", "pitch": 0.9, "builtin": True},
    {"id": "builtin:tutor", "name": "Patient Tutor", "emoji": "🎓",
     "tagline": "Explains until it clicks",
     "instructions": "You are a patient tutor. Explain step by step with a simple analogy, then one tiny practice question. Never dump everything at once.", "pitch": 1.1, "builtin": True},
    {"id": "builtin:researcher", "name": "Deep Researcher", "emoji": "🔍",
     "tagline": "Thorough, sourced, skeptical",
     "instructions": "You are a rigorous research analyst. Structure answers as: bottom line first, then key evidence, then what is uncertain or contested. Flag speculation clearly.", "pitch": 0.95, "builtin": True},
    {"id": "builtin:coach", "name": "Motivating Coach", "emoji": "🔥",
     "tagline": "Energy + accountability",
     "instructions": "You are an energetic coach. Be warm but demanding: acknowledge progress, then push one concrete next action. End with a short rallying line.", "pitch": 1.15, "builtin": True},
]


def _pid(user_id: str, name: str) -> str:
    return "per-" + hashlib.sha1(f"{user_id}|{name.lower()}".encode()).hexdigest()[:14]


async def list_personas(user_id: str) -> dict:
    hits = await db.search(f"personas:{user_id}", " ", limit=60)
    mine = []
    for h in hits:
        if (h.get("meta") or {}).get("kind") != "persona":
            continue
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        rec["id"] = h["id"]
        rec["builtin"] = False
        mine.append(rec)
    mine.sort(key=lambda p: -int(p.get("created", 0)))
    return {"personas": mine + BUILTIN, "total": len(mine) + len(BUILTIN)}


async def upsert_persona(user_id: str, name: str, tagline: str = "",
                         instructions: str = "", emoji: str = "🎭",
                         pitch: float = 1.0, persona_id: str = "") -> dict:
    name = (name or "").strip()[:40]
    if not name:
        raise ValueError("name required")
    pid = persona_id or _pid(user_id, name)
    rec = {"name": name, "tagline": (tagline or "").strip()[:120],
           "instructions": (instructions or "").strip()[:2000],
           "emoji": (emoji or "🎭")[:4], "pitch": max(0.5, min(float(pitch), 2.0)),
           "created": int(time.time())}
    await db.upsert_document(pid, f"personas:{user_id}", name, json.dumps(rec),
                             meta={"kind": "persona"})
    rec["id"] = pid
    rec["builtin"] = False
    return rec


async def delete_persona(user_id: str, persona_id: str) -> bool:
    if persona_id.startswith("builtin:"):
        return False
    doc = await db.fetch(persona_id)
    if not doc or doc.get("library") != f"personas:{user_id}":
        return False
    await db.delete(persona_id)
    return True


async def persona_block(user_id: str, persona_id: str) -> tuple[str, float]:
    """Returns (system-prompt block, voice pitch) for the persona; ('', 1.0)
    when unknown."""
    if not persona_id or persona_id == "builtin:silvestar":
        return "", 1.0
    pitch = 1.0
    if persona_id.startswith("builtin:"):
        for p in BUILTIN:
            if p["id"] == persona_id:
                block = (f"You are {p['name']} {p['emoji']} — {p['tagline']}, a persona the user "
                         f"chose inside Silvestar. Stay fully in character.\n{p['instructions']}").strip()
                return block, float(p.get("pitch", 1.0))
        return "", pitch
    doc = await db.fetch(persona_id)
    if not doc or doc.get("library") != f"personas:{user_id}":
        return "", pitch
    try:
        rec = json.loads(doc.get("content") or "{}")
    except Exception:
        return "", pitch
    pitch = float(rec.get("pitch", 1.0))
    block = (f"You are {rec.get('name', 'a persona')} {rec.get('emoji', '')} — "
             f"{rec.get('tagline', 'a custom persona')} the user created in Silvestar. "
             "Stay fully in character for the whole reply.").strip()
    ins = (rec.get("instructions") or "").strip()
    if ins:
        block += "\n" + ins
    return block, pitch
