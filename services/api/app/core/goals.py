"""Module 27 — Autonomous Goals.

Give Silvestar a standing goal ("track my sales CSV and alert me on big
drops"). A planner agent decomposes it once into small recurring subtasks
(JSON list). The daily tick executes each due subtask on the free AI chain,
files deliverables into Library → Goals/<Goal>/, and can raise alerts via
notification. Subtasks repeat (daily/weekly) or are one-shot.
"""
from __future__ import annotations

import hashlib
import json
import time

from .ai import ai
from .db import db

DAY = 86400
REPEATS = ("", "daily", "weekly")


def _goal_id(user_id: str, title: str) -> str:
    return "goal-" + hashlib.sha1(f"{user_id}|{title.lower()}".encode()).hexdigest()[:14]


def _sub_id(gid: str, title: str) -> str:
    return "sub-" + hashlib.sha1(f"{gid}|{title.lower()}".encode()).hexdigest()[:14]


async def create_goal(user_id: str, title: str, details: str = "",
                      interval_hours: int = 24) -> dict:
    """Plan the goal once with the AI, store goal + subtasks. Free chain."""
    interval_hours = max(1, min(int(interval_hours), 168))
    res = await ai.summarize(
        "Break this standing goal into 2-4 small, recurring, SELF-CONTAINED "
        "subtasks an AI agent can do alone using only its knowledge (no web, "
        "no user input). Return ONLY lines, each: <title> :: <daily|weekly|once> "
        "— max 10 words per title. Example: 'summarize progress toward the goal :: daily'.",
        f"GOAL: {title}\nDETAILS: {details[:800] or '(none)'}",
    )
    subs = []
    for line in (res.get("summary") or "").splitlines()[:4]:
        line = line.strip().lstrip("-•*").strip()
        if "::" not in line:
            continue
        t, rep = line.split("::", 1)
        t = t.strip()[:100]
        rep = rep.strip().lower()
        if rep not in REPEATS:
            rep = "daily"
        if t:
            subs.append({"title": t, "repeat": rep})
    if not subs:
        subs = [{"title": "Work toward the goal and write a short progress note", "repeat": "daily"}]
    now = int(time.time())
    gid = _goal_id(user_id, title)
    await db.upsert_document(
        gid, f"goals:{user_id}", title[:80], json.dumps({
            "title": title[:120], "details": details[:800],
            "interval_hours": interval_hours, "status": "active",
            "created": now, "runs": 0, "last_run": 0,
        }), meta={"kind": "goal"},
    )
    for s in subs:
        sid = _sub_id(gid, s["title"])
        await db.upsert_document(
            sid, f"goals:{user_id}", s["title"][:80], json.dumps({
                "goal_id": gid, "goal": title[:120], "title": s["title"],
                "repeat": s["repeat"], "last_run": 0, "runs": 0, "status": "active",
            }), meta={"kind": "goal-subtask", "goal_id": gid},
        )
    return {"id": gid, "title": title[:120], "subtasks": subs}


async def list_goals(user_id: str) -> dict:
    hits = await db.search(f"goals:{user_id}", " ", limit=100)
    goals: dict[str, dict] = {}
    for h in hits:
        kind = (h.get("meta") or {}).get("kind")
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        if kind == "goal":
            rec["id"] = h["id"]
            rec["subtasks"] = []
            goals[h["id"]] = rec
        elif kind == "goal-subtask":
            g = goals.get(rec.get("goal_id", ""))
            if g is not None:
                g["subtasks"].append({
                    "id": h["id"], "title": rec.get("title", ""),
                    "repeat": rec.get("repeat", "daily"),
                    "runs": rec.get("runs", 0), "last_run": rec.get("last_run", 0),
                })
    out = list(goals.values())
    out.sort(key=lambda g: -int(g.get("created", 0)))
    return {"goals": out, "total": len(out)}


async def delete_goal(user_id: str, goal_id: str) -> bool:
    doc = await db.fetch(goal_id)
    if not doc or doc.get("library") != f"goals:{user_id}":
        return False
    hits = await db.search(f"goals:{user_id}", " ", limit=100)
    for h in hits:
        if (h.get("meta") or {}).get("kind") != "goal-subtask":
            continue
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        if rec.get("goal_id") == goal_id:
            await db.delete(h["id"])
    await db.delete(goal_id)
    return True


def _goal_filename(goal: str, suffix: str, ts: int) -> str:
    safe = __import__("re").sub(r"[^A-Za-z0-9]+", "-", goal[:30]).strip("-") or "goal"
    stamp = time.strftime("%Y%m%d", time.gmtime(ts))
    return f"{safe[:30]}-{suffix}-{stamp}.md"


async def tick_goals(user_id: str | None = None) -> dict:
    """Run every due goal's due subtasks; file deliverables. Called by cron."""
    from .files import files as file_store
    now = int(time.time())
    ran: list[dict] = []
    if user_id:
        libs = [f"goals:{user_id}"]
    else:
        reg, _r = await db.list("goals-registry", limit=200, offset=0)
        libs = []
        for d in reg:
            lib = (d.get("snippet") or "").strip()
            if lib.startswith("goals:"):
                libs.append(lib)
    for lib in libs:
        owner = lib.split(":", 1)[1]
        hits = await db.search(lib, " ", limit=100)
        subtasks = [h for h in hits if (h.get("meta") or {}).get("kind") == "goal-subtask"]
        for h in subtasks:
            try:
                rec = json.loads(h.get("content") or "{}")
            except Exception:
                continue
            repeat = rec.get("repeat", "daily")
            gap = 0 if repeat == "once" else (DAY if repeat == "daily" else 7 * DAY)
            if gap and now - int(rec.get("last_run") or 0) < gap:
                continue
            goal_title = rec.get("goal", "goal")
            sub_title = rec.get("title", "")
            try:
                res = await ai.summarize(
                    "You are an autonomous agent working on the user's standing goal. "
                    "Do EXACTLY this subtask now, using only your own knowledge. "
                    "Write the concrete deliverable (not a plan about doing it) in "
                    "markdown, max 250 words. No preamble.",
                    f"GOAL: {goal_title}\nSUBTASK: {sub_title}",
                )
                body = (res.get("summary") or "").strip()
                if not body:
                    raise RuntimeError("empty deliverable")
                fname = _goal_filename(goal_title, __import__("re").sub(r"[^A-Za-z0-9]+", "-", sub_title[:24]).strip("-").lower() or "task", now)
                folder = f"Goals/{goal_title[:40]}"
                md = (f"# ⭐ {sub_title}\n\n_Goal: {goal_title} · run #{int(rec.get('runs', 0)) + 1} · "
                      f"{time.strftime('%Y-%m-%d %H:%M', time.gmtime(now))} UTC_\n\n{body}\n")
                await file_store.upload(owner, fname, md.encode(), folder=folder)
                rec["last_run"] = now
                rec["runs"] = int(rec.get("runs", 0)) + 1
                if repeat == "once":
                    rec["status"] = "done"
                await db.upsert_document(h["id"], lib, rec.get("title", "")[:80],
                                         json.dumps(rec), meta=h.get("meta") or {"kind": "goal-subtask"})
                gdoc = await db.fetch(rec.get("goal_id", ""))
                if gdoc:
                    try:
                        g = json.loads(gdoc.get("content") or "{}")
                        g["runs"] = int(g.get("runs", 0)) + 1
                        g["last_run"] = now
                        await db.upsert_document(gdoc["id"], gdoc.get("library", lib),
                                                 gdoc.get("title", ""), json.dumps(g),
                                                 meta=gdoc.get("meta") or {"kind": "goal"})
                    except Exception:
                        pass
                ran.append({"owner": owner, "goal": goal_title[:60], "subtask": sub_title[:60], "file": fname})
            except Exception as e:
                ran.append({"owner": owner, "goal": goal_title[:60], "error": str(e)[:100]})
        if ran and any(r.get("owner") == owner for r in ran):
            try:
                from .file_routes import _notify  # circular-safe: late import
            except Exception:
                pass
    return {"ran": ran, "count": len(ran)}
