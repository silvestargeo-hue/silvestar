"""Module 31 — Knowledge Graph Brain.

Harvests entities (people, orgs, places, projects, topics) and their
relationships out of the user's indexed Library files with one AI pass per
file. Triples persist as docs in `kg:{user_id}` (kind=triple) — serverless
safe — and power the interactive map and connection queries
("how are X and Y connected?").
"""
from __future__ import annotations

import hashlib
import json
from collections import deque

from .ai import ai
from .db import db

MAX_FILES = 10
MAX_CHARS_EACH = 5000
MAX_TRIPLES = 400


def _triple_id(user_id: str, s: str, r: str, o: str) -> str:
    return "tri-" + hashlib.sha1(f"{user_id}|{s.lower()}|{r}|{o.lower()}".encode()).hexdigest()[:16]


async def harvest(user_id: str, max_files: int = MAX_FILES) -> dict:
    """Scan the newest text files and merge extracted triples. One AI call per
    file; dedupe by (subject, relation, object)."""
    from .files import files as file_store

    existing, _t = await db.list(f"kg:{user_id}", limit=MAX_TRIPLES)
    have = {(r.get("meta") or {}).get("s", "").lower() for r in existing}
    have_set: set[tuple[str, str, str]] = set()
    for r in existing:
        m = r.get("meta") or {}
        have_set.add((str(m.get("s", "")).lower(), str(m.get("r", "")), str(m.get("o", "")).lower()))

    rows = (await file_store.list_files(user_id)).get("files", [])
    scanned = added = 0
    for r in rows[:max_files]:
        mime = (r.get("mime") or "")
        if not any(mime.startswith(p) for p in ("text/", "application/json")) \
                and not r["name"].endswith((".md", ".txt", ".csv", ".json")):
            continue
        got = await file_store.download(user_id, r.get("path", ""))
        if not got:
            continue
        text = got[0].decode("utf-8", "ignore")[:MAX_CHARS_EACH]
        if len(text.strip()) < 60:
            continue
        res = await ai.summarize(
            "Extract knowledge-graph triples from this document. Return ONLY lines "
            "in the strict format: SUBJECT :: RELATION (UPPER_SNAKE) :: OBJECT\n"
            "Label entities simply ('Maya', 'Kochi', 'Bakery Project'). Max 12 lines, "
            "only real relations stated in the text. If nothing meaningful, return exactly: NONE",
            text,
        )
        scanned += 1
        for line in (res.get("summary") or "").splitlines()[:12]:
            parts = [p.strip() for p in line.split("::")]
            if len(parts) != 3:
                continue
            s, rel, o = parts
            if not s or not o or len(s) > 60 or len(o) > 60 or len(rel) > 30:
                continue
            rel = rel.upper().replace(" ", "_")[:30]
            key = (s.lower(), rel, o.lower())
            if key in have_set:
                continue
            have_set.add(key)
            await db.upsert_document(
                _triple_id(user_id, s, rel, o), f"kg:{user_id}", f"{s} {rel} {o}"[:80],
                json.dumps({"s": s[:60], "r": rel, "o": o[:60], "file": r["name"][:60]}),
                meta={"kind": "triple", "s": s[:60], "r": rel, "o": o[:60]})
            added += 1
            if len(have_set) >= MAX_TRIPLES:
                break
    return {"scanned": scanned, "edges_added": added, "files_total": len(rows)}


async def map_data(user_id: str) -> dict:
    """Nodes + links for the interactive map."""
    rows, _t = await db.list(f"kg:{user_id}", limit=MAX_TRIPLES)
    nodes: dict[str, dict] = {}
    links: list[dict] = []
    for r in rows:
        if (r.get("meta") or {}).get("kind") != "triple":
            continue
        try:
            t = json.loads(r.get("content") or "{}")
        except Exception:
            continue
        s, rel, o = str(t.get("s", "")), str(t.get("r", "")), str(t.get("o", ""))
        if not s or not o:
            continue
        nodes.setdefault(s, {"id": s, "name": s, "deg": 0})
        nodes.setdefault(o, {"id": o, "name": o, "deg": 0})
        links.append({"source": s, "target": o, "rel": rel,
                      "file": str(t.get("file", ""))[:40]})
        nodes[s]["deg"] += 1
        nodes[o]["deg"] += 1
    return {"nodes": list(nodes.values()), "links": links}


async def _load_triples_async(user_id: str) -> list[tuple[str, str, str]]:
    rows, _t = await db.list(f"kg:{user_id}", limit=MAX_TRIPLES)
    out = []
    for r in rows:
        if (r.get("meta") or {}).get("kind") != "triple":
            continue
        m = r.get("meta") or {}
        out.append((str(m.get("s", "")), str(m.get("r", "")), str(m.get("o", ""))))
    return out


async def connect(user_id: str, source: str, target: str) -> dict:
    """BFS shortest chain between two entities + AI explanation."""
    src, dst = source.strip().lower(), target.strip().lower()
    triples = await _load_triples_async(user_id)
    adj: dict[str, list[tuple[str, str, str]]] = {}
    names: dict[str, str] = {}
    for s, r, o in triples:
        adj.setdefault(s.lower(), []).append((s, r, o))
        adj.setdefault(o.lower(), []).append((o, r, s))  # undirected
        names[s.lower()] = s
        names[o.lower()] = o
    def resolve(q: str) -> str | None:
        q = q.strip().lower()
        if q in names:
            return q
        qn = q.replace("_", " ")
        if qn in names:
            return qn
        for k in names:
            if qn in k or k.replace("_", " ") in qn:
                return k
        return None

    src_r, dst_r = resolve(src), resolve(dst)
    if not src_r or not dst_r:
        return {"found": False,
                "reason": "one or both entities are not in your graph yet — run a harvest first",
                "known_sample": sorted(names.values())[:12]}
    src, dst = src_r, dst_r
    # BFS
    q: deque[tuple[str, list[str], list[str]]] = deque([(src, [src], [])])
    seen = {src}
    chain_nodes: list[str] = []
    chain_rels: list[str] = []
    while q:
        cur, path, rels = q.popleft()
        if cur == dst:
            chain_nodes, chain_rels = path, rels
            break
        for (s_name, r, o_name) in adj.get(cur, []):
            nxt = o_name.lower()
            if nxt not in seen:
                seen.add(nxt)
                q.append((nxt, path + [nxt], rels + [r]))
    if not chain_nodes:
        return {"found": False, "reason": "no connection path found between these entities"}
    names_path = [names[p] for p in chain_nodes]
    pretty = []
    for i, nm in enumerate(names_path):
        pretty.append(nm)
        if i < len(chain_rels):
            pretty.append(f"--[{chain_rels[i]}]-->")
    chain = " ".join(pretty)
    expl = await ai.summarize(
        "Explain this knowledge-graph connection chain in 2-3 friendly sentences "
        "for the user. The names come from their own notes. Do not invent facts "
        "beyond restating the chain and its obvious meaning.",
        f"ENTITY CHAIN: {chain}",
    )
    return {"found": True, "path": names_path, "chain": chain,
            "explanation": (expl.get("summary") or "").strip()[:600]}


# ---------------------------------------------------------------- cleanup ---
async def forget(user_id: str) -> int:
    rows, _t = await db.list(f"kg:{user_id}", limit=MAX_TRIPLES)
    n = 0
    for r in rows:
        if (r.get("meta") or {}).get("kind") == "triple":
            await db.delete(r["id"])
            n += 1
    return n
