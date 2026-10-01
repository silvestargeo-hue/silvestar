"""Module 28 — Contradiction Radar.

Reads the user's Library (up to 12 text-ish files) with a single AI pass and
flags what no other tool does: contradictory statements between files, stale
facts (old dates/prices), and coverage gaps. Produces a 0-100 health score,
findings list, and an actionable markdown report filed in Library → Radar/.
"""
from __future__ import annotations

import json
import re
import time

from .ai import ai
from .db import db

TEXT_MIME = ("text/", "application/json", "application/xml", "text/markdown")
MAX_FILES = 12
MAX_CHARS_EACH = 6000


def _health_score(findings: list[dict]) -> int:
    score = 100
    for f in findings:
        sev = f.get("severity", "low")
        score -= {"high": 12, "medium": 6, "low": 2}.get(sev, 2)
    return max(5, min(100, score))


async def scan(user_id: str) -> dict:
    from .files import files as file_store
    rows = (await file_store.list_files(user_id)).get("files", [])
    docs: list[dict] = []
    for r in rows:
        mime = (r.get("mime") or "")
        if not any(mime.startswith(p) for p in TEXT_MIME) and not r["name"].endswith((".md", ".txt", ".csv", ".json")):
            continue
        got = await file_store.download(user_id, r.get("path", ""))
        if not got:
            continue
        text = got[0].decode("utf-8", "ignore")[:MAX_CHARS_EACH]
        if len(text.strip()) < 80:
            continue
        docs.append({"name": r["name"], "folder": r.get("folder", ""), "text": text})
        if len(docs) >= MAX_FILES:
            break
    if len(docs) < 2:
        return {"findings": [], "score": 100, "docs_scanned": len(docs),
                "note": "Need at least 2 text files in the Library to scan."}
    corpus = "\n\n".join(
        f"===== FILE: {d['name']} (folder: {d['folder'] or '/'}) =====\n{d['text']}"
        for d in docs)
    res = await ai.summarize(
        "You are a knowledge-base auditor. Compare the FILES below and find real "
        "problems only:\n"
        "1. CONTRADICTIONS — two files stating incompatible facts (names, numbers, dates, claims).\n"
        "2. STALE FACTS — statements that look outdated (old years, expired offers, superseded versions).\n"
        "3. GAPS — important topics mentioned without any supporting file.\n"
        "Return ONLY lines in this strict format:\n"
        "<high|medium|low> :: <contradiction|stale|gap> :: <one-line finding> :: <which files, comma-separated>\n"
        "Max 8 lines, most severe first. If nothing found, return exactly: CLEAN",
        corpus[:90000],
    )
    out_raw = (res.get("summary") or "").strip()
    findings: list[dict] = []
    if out_raw and not out_raw.upper().startswith("CLEAN"):
        for line in out_raw.splitlines()[:8]:
            parts = [p.strip() for p in line.split("::")]
            if len(parts) < 3:
                continue
            sev = parts[0].lower()
            if sev not in ("high", "medium", "low"):
                continue
            kind = parts[1].lower() if len(parts) > 1 else "note"
            findings.append({
                "severity": sev, "kind": kind if kind in ("contradiction", "stale", "gap") else "note",
                "finding": parts[2][:300],
                "files": (parts[3] if len(parts) > 3 else "")[:200],
            })
    score = _health_score(findings)
    ts = int(time.time())
    report = [
        f"# 🩺 Library health report",
        "",
        f"_Scan of {len(docs)} files · health score **{score}/100** · {time.strftime('%Y-%m-%d %H:%M', time.gmtime(ts))} UTC_",
        "",
    ]
    if not findings:
        report.append("✅ No contradictions, stale facts or obvious gaps found. Clean library!")
    for f in findings:
        icon = {"contradiction": "⚔️", "stale": "🕒", "gap": "🧩", "note": "•"}.get(f["kind"], "•")
        report.append(f"## {icon} {f['kind'].title()} — {f['severity'].upper()}")
        report.append(f"{f['finding']}")
        if f["files"]:
            report.append(f"_Files: {f['files']}_")
        report.append("")
    report_md = "\n".join(report)
    try:
        fname = f"radar-{time.strftime('%Y%m%d-%H%M%S', time.gmtime(ts))}.md"
        await file_store.upload(user_id, fname, report_md.encode(), folder="Radar")
    except Exception:
        fname = ""
    return {"findings": findings, "score": score, "docs_scanned": len(docs), "report_file": fname}
