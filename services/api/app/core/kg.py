"""Module 31 — Knowledge Graph Brain.

Harvests entities (people, organizations, places, projects, topics) and their
relationships out of the user's indexed Library files with one AI pass per
file, merging them into the platform graph under a per-user namespace
(node ids prefixed `u|<uid>|`). Powers the interactive map and connection
queries like "how are X and Y connected?".
"""
from __future__ import annotations

import json

from .ai import ai
from .db import db

MAX_FILES = 10
MAX_CHARS_EACH = 5000
VALID_LABELS = {"person", "org", "place", "project", "topic", "event", "product", "other"}


class KgNode(dict):
    pass


class KgLink(dict):
    pass


def _ns(uid: str, name: str) -> str:
    return f"u|{uid}|{name.strip().lower()[:60]}"


async def harvest(user_id: str, max_files: int = MAX_FILES) -> dict:
    """Scan the newest text files and merge extracted entities + relations
    into the graph. Free, one Groq call per file."""
    from .files import files as file_store
    from .graph import graph

    rows = (await file_store.list_files(user_id)).get("files", [])
    scanned = merged_nodes = merged_edges = 0
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
            "in the strict format: SUBJECT :: RELATION (uppercase snake case) :: OBJECT\n"
            "Label entities simply (e.g. 'Maya', 'Kochi', 'Bakery Project'). Max 12 lines, "
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
            await graph.merge_node(_ns(user_id, s), ["Entity"], {"name": s, "user": user_id})
            await graph.merge_node(_ns(user_id, o), ["Entity"], {"name": o, "user": user_id})
            await graph.merge_edge(_ns(user_id, s), rel, _ns(user_id, o), {"file": r["name"][:60]})
            merged_edges += 1
    return {"scanned": scanned, "edges_added": merged_edges,
            "files_total": len(rows), "note": "entities merged under your namespace"}


async def map_data(user_id: str) -> dict:
    """Nodes + links under this user's namespace, for the interactive map."""
    from .graph import graph
    prefix = f"u|{user_id}|"
    nodes: dict[str, KgNode] = {}
    links: list[KgLink] = []
    try:
        rows = await graph.query(f"user: {user_id}")
        for r in rows:
            nid = str(r.get("id", ""))
            if not nid.startswith(prefix):
                continue
            name = str((r.get("props") or {}).get("name") or nid.split("|")[-1])
            nodes[nid] = {"id": nid, "name": name, "deg": 0}
    except Exception:
        pass
    # edges: neighbors() per node (embedded engine keeps a global edge list)
    for nid in list(nodes):
        try:
            for nb in await graph.neighbors(nid):
                edge = nb.get("edge", "")
                target = (nb.get("node") or {}).get("id", "")
                if target in nodes:
                    links.append({"source": nodes[nid]["name"], "target": nodes[target]["name"],
                                  "rel": edge})
                    nodes[nid]["deg"] += 1
                    nodes[target]["deg"] += 1
        except Exception:
            continue
    return {"nodes": list(nodes.values()), "links": links}


async def connect(user_id: str, source: str, target: str) -> dict:
    """Find the shortest relationship path between two entities in the user's
    namespace and explain it in plain language."""
    from .graph import graph
    src = _ns(user_id, source)
    dst = _ns(user_id, target)
    node_ids = await _all_nodes(user_id)
    if src not in node_ids or dst not in node_ids:
        return {"found": False,
                "reason": "one or both entities are not in your graph yet — run a harvest first",
                "known_sample": [n.split("|")[-1] for n in node_ids[:12]]}
    path = await graph.path(src, dst, max_depth=5)
    if not path:
        return {"found": False, "reason": "no connection path found between these entities"}
    names = [p.split("|")[-1] for p in path]
    chain = " → ".join(names)
    expl = await ai.summarize(
        "Explain this knowledge-graph connection chain in 2-3 friendly sentences "
        "for the user. The names come from their own notes. Do not invent facts "
        "beyond restating the chain and its obvious meaning.",
        f"ENTITY CHAIN: {chain}",
    )
    return {"found": True, "path": names, "chain": chain,
            "explanation": (expl.get("summary") or "").strip()[:600]}


async def _all_nodes(user_id: str) -> list[str]:
    """All node ids in this user's namespace (embedded query over props)."""
    from .graph import graph
    try:
        rows = await graph.query(f"user: {user_id}")
        return [r.get("id", "") for r in rows
                if str(r.get("id", "")).startswith(f"u|{user_id}|")]
    except Exception:
        return []

