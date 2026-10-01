"""Module 17 — Study Mode: AI flashcards + spaced repetition (SM-2 lite).

Decks are generated from any Library document (or pasted text). Cards live in
`study:<user_id>` as kind=card docs; review scheduling follows an SM-2-style
ease/interval per card. Free: generation runs on the existing AI chain.
"""
from __future__ import annotations

import json
import time

from .ai import ai
from .db import db

DAY = 86400


def _card_id(user_id: str, deck: str, front: str) -> str:
    import hashlib
    return "fc-" + hashlib.sha1(f"{user_id}|{deck}|{front}".encode()).hexdigest()[:14]


async def generate_deck(user_id: str, source_title: str, source_text: str,
                        count: int = 10) -> dict:
    """AI generates Q/A flashcards from a document; returns deck summary.
    Parsing is tolerant ( '::' | ' | ' | 'Q:/A:' ) with a deterministic
    sentence-cloze fallback so a deck is ALWAYS produced."""
    count = max(3, min(int(count), 25))
    res = await ai.summarize(
        f"Create exactly {count} flashcards from the document. "
        "Return ONLY lines, one per card, each in the strict format: "
        "question :: answer (front = short question, back = concise answer). "
        "No numbering, no markdown, no extra words.",
        source_text[:12000],
    )
    cards = []
    for line in (res.get("summary") or "").splitlines():
        line = line.strip().lstrip("-•*").strip()
        line = __import__("re").sub(r"^\d+[.)]\s*", "", line)
        sep = "::" if "::" in line else ("|" if "|" in line else "")
        if not sep:
            continue
        front, back = line.split(sep, 1)
        front, back = front.strip().lstrip("-•* ").strip(), back.strip()
        if front and back and len(front) > 3:
            cards.append({"front": front[:200], "back": back[:500]})
        if len(cards) >= count:
            break
    if not cards:
        # deterministic fallback: cloze cards from sentences
        import re as _re
        sentences = [s.strip() for s in _re.split(r"(?<=[.!?])\s+", source_text) if len(s.strip()) > 25]
        for s in sentences[:count]:
            words = s.rstrip(".").split()
            if len(words) < 5:
                continue
            key = " ".join(words[-3:])
            cards.append({"front": f"Complete: {s.rstrip('.')[:140]}…",
                          "back": key or s[:120]})
            if len(cards) >= count:
                break
    if not cards:
        return {"deck": source_title[:60], "added": 0, "cards": []}
    now = int(time.time())
    for c in cards:
        rec = {
            "deck": source_title[:60], "front": c["front"], "back": c["back"],
            "ease": 2.5, "interval_days": 0, "reps": 0,
            "due": now, "created": now,
        }
        await db.upsert_document(
            _card_id(user_id, source_title, c["front"]),
            f"study:{user_id}", source_title[:60], json.dumps(rec),
            meta={"kind": "card", "deck": source_title[:60]},
        )
    return {"deck": source_title[:60], "added": len(cards)}


async def list_decks(user_id: str) -> dict:
    hits = await db.search(f"study:{user_id}", " ", limit=200)
    decks: dict[str, dict] = {}
    now = int(time.time())
    for h in hits:
        if (h.get("meta") or {}).get("kind") != "card":
            continue
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        d = decks.setdefault(rec.get("deck", "default"), {"cards": 0, "due": 0})
        d["cards"] += 1
        if int(rec.get("due", 0)) <= now:
            d["due"] += 1
    return {"decks": [{"name": k, **v} for k, v in sorted(decks.items())]}


async def get_due(user_id: str, deck: str, limit: int = 15) -> dict:
    hits = await db.search(f"study:{user_id}", " ", limit=200)
    now = int(time.time())
    out = []
    for h in hits:
        if (h.get("meta") or {}).get("kind") != "card":
            continue
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        if rec.get("deck") != deck or int(rec.get("due", 0)) > now:
            continue
        out.append({"id": h["id"], "front": rec.get("front", ""), "back": rec.get("back", ""),
                    "reps": rec.get("reps", 0)})
        if len(out) >= limit:
            break
    return {"deck": deck, "cards": out}


async def review(user_id: str, card_id: str, grade: int) -> dict:
    """grade: 0=again, 1=hard, 2=good, 3=easy (SM-2 lite)."""
    doc = await db.fetch(card_id)
    if not doc or doc.get("library") != f"study:{user_id}":
        return {"ok": False, "reason": "card not found"}
    try:
        rec = json.loads(doc.get("content") or "{}")
    except Exception:
        return {"ok": False, "reason": "corrupt card"}
    ease = float(rec.get("ease", 2.5))
    interval = float(rec.get("interval_days", 0))
    grade = max(0, min(3, int(grade)))
    if grade == 0:
        ease = max(1.3, ease - 0.2)
        interval = 0  # relearn today
    else:
        ease += {1: -0.15, 2: 0.0, 3: 0.1}[grade]
        ease = max(1.3, min(2.8, ease))
        interval = 1 if interval < 1 else min(interval * ease, 365)
    rec["ease"] = round(ease, 2)
    rec["interval_days"] = interval
    rec["reps"] = int(rec.get("reps", 0)) + 1
    rec["due"] = int(time.time()) + int(interval * DAY)
    rec["last_grade"] = grade
    await db.upsert_document(card_id, f"study:{user_id}", doc.get("title", ""),
                             json.dumps(rec), meta=doc.get("meta") or {})
    return {"ok": True, "next_due_in_days": interval, "ease": rec["ease"]}


async def delete_deck(user_id: str, deck: str) -> dict:
    hits = await db.search(f"study:{user_id}", " ", limit=200)
    n = 0
    for h in hits:
        if (h.get("meta") or {}).get("kind") != "card":
            continue
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        if rec.get("deck") == deck:
            await db.delete(h["id"])
            n += 1
    return {"deleted_cards": n}


# ------------------------------------------------------- deck exchange ------
async def export_deck(user_id: str, deck: str) -> dict:
    """Export one deck as a portable JSON payload (shareable, re-importable)."""
    hits = await db.search(f"study:{user_id}", " ", limit=200)
    cards = []
    for h in hits:
        if (h.get("meta") or {}).get("kind") != "card":
            continue
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        if rec.get("deck") != deck:
            continue
        cards.append({"front": rec.get("front", ""), "back": rec.get("back", "")})
    return {
        "format": "silvestar-deck", "version": 1,
        "deck": deck, "cards": cards,
        "exported": int(time.time()),
    }


def _plain_frontmatter(cards_text: str) -> list[dict]:
    """Parse 'front :: back' lines (also ' | ' and 'Q:/A:')."""
    out = []
    for line in cards_text.splitlines():
        line = line.strip().lstrip("-•*").strip()
        line = __import__("re").sub(r"^\d+[.)]\s*", "", line)
        if not line:
            continue
        sep = "::" if "::" in line else ("|" if "|" in line else "")
        if not sep:
            continue
        front, back = line.split(sep, 1)
        front, back = front.strip(), back.strip()
        if front and back and len(front) > 2:
            out.append({"front": front[:200], "back": back[:500]})
    return out


async def import_deck(user_id: str, deck: str, payload: dict) -> dict:
    """Import a deck from a silvestar-deck JSON payload or a plain dict with
    {cards:[{front,back}]}. Skips exact duplicates by (deck, front)."""
    if not deck or not deck.strip():
        return {"deck": deck, "added": 0, "skipped": 0}
    deck = deck.strip()[:60]
    raw_cards = payload.get("cards") if isinstance(payload, dict) else None
    cards: list[dict] = []
    if isinstance(raw_cards, list):
        for c in raw_cards:
            if isinstance(c, dict):
                front = str(c.get("front") or c.get("q") or "").strip()
                back = str(c.get("back") or c.get("a") or "").strip()
                if front and back:
                    cards.append({"front": front[:200], "back": back[:500]})
    if not cards and isinstance(payload.get("text") or "", str):
        cards = _plain_frontmatter(payload["text"])
    if not cards:
        return {"deck": deck, "added": 0, "skipped": 0}
    # duplicate guard: fetch existing fronts for this deck
    hits = await db.search(f"study:{user_id}", " ", limit=300)
    existing = set()
    for h in hits:
        if (h.get("meta") or {}).get("kind") != "card":
            continue
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        if rec.get("deck") == deck:
            existing.add((rec.get("front") or "").strip().lower())
    now = int(time.time())
    added = skipped = 0
    for c in cards[:200]:
        key = c["front"].strip().lower()
        if key in existing:
            skipped += 1
            continue
        existing.add(key)
        rec = {"deck": deck, "front": c["front"], "back": c["back"],
               "ease": 2.5, "interval_days": 0, "reps": 0,
               "due": now, "created": now, "imported": True}
        await db.upsert_document(
            _card_id(user_id, deck, c["front"]),
            f"study:{user_id}", deck, json.dumps(rec),
            meta={"kind": "card", "deck": deck},
        )
        added += 1
    return {"deck": deck, "added": added, "skipped": skipped}
