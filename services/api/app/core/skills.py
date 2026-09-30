"""Module 14 — AI Skills (unlimited user plugins) + builtin auto-tools.

Users can add unlimited skills (name + instructions + trigger words). The AI
automatically applies every relevant skill to every question — no toggles.
Builtin tools run automatically when the task needs them:
  read_url     — fetches a web page when the question contains a link
  math         — exact arithmetic for math expressions
  datetime     — current date/time questions
  omniverse    — world knowledge from free keyless sources (Wikipedia REST +
                 DuckDuckGo Instant Answer) when the question is about the
                 outside world rather than the user's libraries

Everything is free: skills live in the existing DB layer, tools use keyless
public endpoints. No configuration, no cost, always on.
"""
from __future__ import annotations

import json
import re
import time
import urllib.request
from urllib.parse import quote
from typing import Any

import httpx

from ..config import settings
from .db import db

SKILLS_LIB = "skills"          # public skill gallery (kind=gallery)
_SKILL_LIB_CACHE: float = 0.0
_SKILL_LIB: list[dict] = []

URL_RE = re.compile(r"https?://[^\s<>\)\"']+")
MATH_RE = re.compile(r"^[\d\s\+\-\*\/\(\)\.%\^]+$")
OMNI_RE = re.compile(
    r"\b(who|what|where|when|which|why|how)\s+(is|are|was|were|do|does|did|can|did)\b"
    r"|\b(capital|population|president|prime minister|ceo|founder|born|height|weather|"
    r"temperature|population of|currency of|meaning of|define|wikipedia|latest|news|"
    r"current|today|stock|price of|distance between|tallest|largest|smallest|fastest)\b",
    re.I,
)


# ------------------------------------------------------------------ storage --
async def _user_skills(user_id: str) -> list[dict]:
    """All skills for a user: personal + built-in gallery skills (always on)."""
    out: list[dict] = []
    # gallery/builtin skills are visible (and auto-applied) to everyone
    global _SKILL_LIB, _SKILL_LIB_CACHE
    if time.time() - _SKILL_LIB_CACHE > 300 or not _SKILL_LIB:
        docs, _total = await db.list(SKILLS_LIB, limit=60, offset=0)
        lib = []
        for d in docs:
            try:
                # db.list returns truncated content — fetch the full doc
                full = await db.fetch(d.get("id", ""))
                content = (full or {}).get("content") or d.get("snippet") or ""
                rec = None
                if isinstance(content, str) and content.startswith("{"):
                    try:
                        rec = json.loads(content)
                    except Exception:
                        rec = None
                if not rec:
                    rec = {"name": d.get("title", ""), "instructions": content}
                rec["id"] = d.get("id", "")
                rec["builtin"] = True
                if rec.get("name") and rec.get("instructions"):
                    lib.append(rec)
            except Exception:
                continue
        _SKILL_LIB, _SKILL_LIB_CACHE = lib, time.time()
    out.extend(_SKILL_LIB)
    # personal skills
    hits = await db.search(f"skills:{user_id}", " ", limit=100)
    for h in hits:
        m = h.get("meta") or {}
        if m.get("kind") != "skill":
            continue
        try:
            rec = json.loads(h.get("content") or "{}")
        except Exception:
            continue
        rec["id"] = h.get("id", "")
        rec["builtin"] = False
        out.append(rec)
    return out


def parse_skill(text: str, *, user_id: str = "", builtin: bool = False) -> dict | None:
    """Extract a skill spec from free text (name, instructions, optional triggers)."""
    lines = [l.strip() for l in text.strip().splitlines() if l.strip()]
    if not lines:
        return None
    name = lines[0].lstrip("#-• ").strip()[:60]
    body = "\n".join(lines[1:]).strip() or name
    triggers = [w.lower() for w in re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", name + " " + body)][:12]
    return {"name": name, "instructions": body[:4000], "triggers": triggers}


async def add_skill(user_id: str, name: str, instructions: str,
                    triggers: list[str] | None = None, gallery: bool = False) -> dict:
    rec = {
        "name": (name or "skill")[:60],
        "instructions": (instructions or "")[:4000],
        "triggers": [t.lower() for t in (triggers or [])][:20],
        "owner": user_id,
        "created": int(time.time()),
    }
    if gallery:
        doc_id = "sk-g-" + re.sub(r"[^a-z0-9]+", "-", rec["name"].lower()).strip("-")[:30]
        await db.upsert_document(doc_id, SKILLS_LIB, rec["name"],
                                 json.dumps(rec), meta={"kind": "gallery"})
        global _SKILL_LIB_CACHE
        _SKILL_LIB_CACHE = 0.0
        return {"id": doc_id, **rec, "builtin": True}
    doc_id = "sk-u-" + re.sub(r"[^a-z0-9]+", "-", (user_id + "-" + rec["name"]).lower()).strip("-")[:50]
    await db.upsert_document(doc_id, f"skills:{user_id}", rec["name"],
                             json.dumps(rec), meta={"kind": "skill"})
    return {"id": doc_id, **rec, "builtin": False}


async def delete_skill(user_id: str, skill_id: str) -> dict:
    doc = await db.fetch(skill_id)
    if not doc:
        return {"deleted": False, "reason": "not found"}
    m = doc.get("meta") or {}
    if m.get("kind") == "gallery":
        await db.delete(skill_id)
        global _SKILL_LIB_CACHE
        _SKILL_LIB_CACHE = 0.0
        return {"deleted": True}
    if m.get("kind") == "skill" and f"skills:{user_id}" == doc.get("library"):
        await db.delete(skill_id)
        return {"deleted": True}
    return {"deleted": False, "reason": "not yours"}


async def list_skills(user_id: str) -> dict:
    return {"skills": await _user_skills(user_id)}


# --------------------------------------------------------- relevance matching --
_SKILL_STOP = {
    "the", "and", "for", "with", "you", "your", "are", "not", "but", "his",
    "her", "him", "she", "that", "this", "from", "into", "onto", "over",
    "skill", "plugin", "assistant", "expert", "act", "professional", "master",
    "generator", "creator", "maker", "helper", "agent", "prompt", "prompts",
    "system", "user", "new", "old", "top", "best", "free", "like", "a", "an",
    "in", "on", "of", "to", "as", "at", "by", "or", "is", "it", "be",
}


def relevant_skills(skills: list[dict], question: str) -> list[dict]:
    """Skills whose meaningful name/trigger words appear in the question.
    Generic words (the/and/for…) never count; capped at 3 to keep prompts tight.
    A personal skill with explicitly empty triggers always applies (opt-in)."""
    q = question.lower()
    q_words = set(re.findall(r"[a-z0-9_-]{3,}", q))
    picked = []
    for s in skills:
        trig = [t for t in (s.get("triggers") or []) if t not in _SKILL_STOP]
        name_words = [w for w in re.findall(r"[a-z0-9_-]{3,}", (s.get("name") or "").lower())
                      if w not in _SKILL_STOP]
        hit = any(t in q_words for t in trig) or any(w in q_words for w in name_words)
        if hit or (not s.get("builtin") and s.get("triggers") is not None and len(s.get("triggers") or []) == 0):
            picked.append(s)
        if len(picked) >= 3:
            break
    return picked


def skills_system_block(skills: list[dict]) -> str:
    if not skills:
        return ""
    parts = ["\n\nACTIVE SKILLS (apply these rules to your answer):"]
    for s in skills:
        parts.append(f"- {s.get('name','skill')}: {s.get('instructions','')}")
    return "\n".join(parts)


# ------------------------------------------------------------------- tools --
def _fetch(url: str, timeout: int = 12) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Silvestar/1.2 (free AI platform)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


async def tool_read_url(url: str) -> dict:
    """Fetch a page and return readable text (first ~3000 chars)."""
    try:
        html = await httpx.AsyncClient(timeout=15, follow_redirects=True).get(url)
        if html.status_code != 200:
            return {"ok": False, "error": f"HTTP {html.status_code}"}
        text = html.text
        text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", text)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return {"ok": True, "url": url, "text": text[:3000]}
    except Exception as e:
        return {"ok": False, "error": str(e)[:120]}


def tool_math(expr: str) -> dict:
    try:
        expr = expr.replace("^", "**")
        if not MATH_RE.match(expr.replace("**", "")):
            return {"ok": False, "error": "not a safe arithmetic expression"}
        val = eval(expr, {"__builtins__": {}}, {})  # noqa: S307 — sandboxed by regex above
        return {"ok": True, "expr": expr, "result": val}
    except Exception as e:
        return {"ok": False, "error": str(e)[:120]}


def tool_datetime(tz_hint: str = "UTC") -> dict:
    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc)
    return {"ok": True, "utc_iso": now.isoformat(),
            "weekday": now.strftime("%A"), "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M:%S"), "tz": "UTC"}


async def tool_omniverse(question: str) -> dict:
    """Free world-knowledge lookup: Wikipedia REST summary + DuckDuckGo IA.

    Returns {'ok', 'omniverse', 'sources'} — no API keys, zero cost."""
    # search terms = content words, minus question words
    stop = {"who", "what", "where", "when", "which", "why", "how", "is", "are",
            "was", "were", "the", "a", "an", "of", "in", "on", "do", "does",
            "did", "tell", "me", "about", "current", "latest"}
    terms = [w for w in re.findall(r"[a-zA-Z][a-zA-Z0-9'-]{2,}", question)
             if w.lower() not in stop][:8]
    q = " ".join(terms) or question[:80]
    sources: list[str] = []
    snippets: list[str] = []

    ua = {"User-Agent": "Silvestar/1.2 (free personal AI platform; +https://silvestar-web.vercel.app)"}
    # 1) Wikipedia REST summary (no key, generous limits)
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True, headers=ua) as client:
            r = await client.get(
                "https://en.wikipedia.org/api/rest_v1/page/summary/" + quote(q.replace(" ", "_"))
            )
            if r.status_code == 200:
                j = r.json()
                if j.get("extract"):
                    snippets.append(f"Wikipedia — {j.get('title','')}: {j['extract'][:1200]}")
                    sources.append(j.get("content_urls", {}).get("desktop", {}).get("page", "wikipedia"))
    except Exception:
        pass

    # 2) Wikipedia opensearch if the direct summary missed
    if not snippets:
        try:
            async with httpx.AsyncClient(timeout=10, headers=ua) as client:
                r = await client.get("https://en.wikipedia.org/w/api.php", params={
                    "action": "opensearch", "search": q, "limit": 3, "format": "json"})
                if r.status_code == 200:
                    arr = r.json()
                    for title in (arr[1] if len(arr) > 1 else [])[:2]:
                        r2 = await client.get(
                            "https://en.wikipedia.org/api/rest_v1/page/summary/" + quote(str(title).replace(" ", "_")))
                        if r2.status_code == 200:
                            j2 = r2.json()
                            if j2.get("extract"):
                                snippets.append(f"Wikipedia — {j2.get('title','')}: {j2['extract'][:1000]}")
                                break
        except Exception:
            pass

    # 3) DuckDuckGo Instant Answer (no key)
    try:
        async with httpx.AsyncClient(timeout=10, headers=ua) as client:
            r = await client.get("https://api.duckduckgo.com/", params={
                "q": q, "format": "json", "no_html": 1, "skip_disambig": 1})
            if r.status_code == 200:
                j = r.json()
                if j.get("AbstractText"):
                    snippets.append(f"DuckDuckGo — {j.get('Heading','')}: {j['AbstractText'][:800]}")
                    if j.get("AbstractURL"):
                        sources.append(j["AbstractURL"])
                for topic in (j.get("RelatedTopics") or [])[:3]:
                    txt = topic.get("Text") if isinstance(topic, dict) else None
                    if txt:
                        snippets.append(f"DDG related: {txt[:300]}")
                        break
    except Exception:
        pass

    if not snippets:
        return {"ok": False, "omniverse": "", "sources": []}
    return {"ok": True, "omniverse": "\n\n".join(snippets[:6])[:4000], "sources": sources[:4]}


def wants_tools(question: str) -> dict:
    """Decide which builtin tools the question needs (auto, no user toggles)."""
    need: dict[str, bool] = {"omniverse": False, "math": False, "datetime": False, "read_url": False}
    if URL_RE.search(question):
        need["read_url"] = True
    if MATH_RE.match(question.strip().rstrip("?").strip()) and any(c in question for c in "+-*/^"):
        need["math"] = True
    if re.search(r"\b(what|current)?\s*(time|date|day)\b.*\b(now|today|current)\b|\btime now\b|\btoday's date\b|\bwhat day\b", question, re.I):
        need["datetime"] = True
    if OMNI_RE.search(question) and not need["read_url"]:
        need["omniverse"] = True
    return {k: v for k, v in need.items() if v}


async def run_tools(question: str) -> tuple[str, list[str]]:
    """Run every tool the question needs; returns (context_block, tool_names)."""
    needs = wants_tools(question)
    blocks: list[str] = []
    used: list[str] = []
    for url in URL_RE.findall(question)[:2]:
        res = await tool_read_url(url)
        if res.get("ok"):
            blocks.append(f"[web:{url}] {res['text'][:2500]}")
            used.append("read_url")
    if needs.get("math"):
        expr = question.strip().rstrip("?").strip()
        res = tool_math(expr)
        if res.get("ok"):
            blocks.append(f"[math] {res['expr']} = {res['result']}")
            used.append("math")
    if needs.get("datetime"):
        res = tool_datetime()
        blocks.append(f"[datetime] {res['weekday']} {res['date']} {res['time']} UTC")
        used.append("datetime")
    if needs.get("omniverse"):
        res = await tool_omniverse(question)
        if res.get("ok"):
            blocks.append("[omniverse]\n" + res["omniverse"])
            used.append("omniverse")
    return ("\n\n".join(blocks), used) if blocks else ("", used)


# ------------------------------------------------- github skill auto-install --
GITHUB_SOURCES = [
    # (raw-url template, kind) — top free AI prompt/skill collections
    ("https://raw.githubusercontent.com/f/awesome-chatgpt-prompts/main/prompts.csv", "prompts_csv"),
]


def _gh_headers() -> dict:
    h = {"User-Agent": "Silvestar-skill-updater", "Accept": "application/vnd.github+json"}
    if settings.github_token:
        h["Authorization"] = f"Bearer {settings.github_token}"
    return h


def _parse_prompts_csv(csv_text: str) -> list[dict]:
    """Parse awesome-chatgpt-prompts CSV (act,prompt) into skill dicts."""
    import csv as _csv
    import io as _io
    try:
        _csv.field_size_limit(10 * 1024 * 1024)  # prompts.csv has huge fields
    except Exception:
        pass
    out = []
    try:
        rows = list(_csv.DictReader(_io.StringIO(csv_text)))
    except Exception:
        return out
    for r in rows:
        act = (r.get("act") or r.get("Act") or "").strip()
        prompt = (r.get("prompt") or r.get("Prompt") or "").strip()
        if not act or not prompt:
            continue
        triggers = [w.lower() for w in re.findall(r"[A-Za-z][A-Za-z]{2,}", act)][:8]
        out.append({"name": act[:60], "instructions": prompt[:2000], "triggers": triggers})
    return out


async def auto_install_skills(batch: int = 60) -> dict:
    """Daily GitHub skill harvest: download the top free AI-skill collections
    with the platform's GitHub token and upsert a rotating batch as gallery
    skills. Idempotent; safe to run from cron or an admin button."""
    import datetime as _dt
    day_index = _dt.datetime.now(_dt.timezone.utc).timetuple().tm_yday
    added = 0
    scanned = 0
    source_report = []
    for url, kind in GITHUB_SOURCES:
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
                r = await client.get(url, headers=_gh_headers())
            if r.status_code != 200:
                source_report.append({"url": url, "ok": False, "status": r.status_code})
                continue
            skills = _parse_prompts_csv(r.text) if kind == "prompts_csv" else []
            scanned += len(skills)
            # rotating window so each day installs a different slice
            start = (day_index * batch) % max(len(skills), 1)
            window = skills[start:start + batch] if skills else []
            if len(window) < batch and skills:
                window += skills[:batch - len(window)]
            for s in window:
                await add_skill("system", s["name"], s["instructions"], s["triggers"], gallery=True)
                added += 1
            source_report.append({"url": url, "ok": True, "installed": len(window)})
        except Exception as e:
            source_report.append({"url": url, "ok": False, "error": str(e)[:120]})
    return {"added": added, "scanned": scanned, "day_index": day_index,
            "sources": source_report}
