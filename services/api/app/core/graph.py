"""Module 7 — Knowledge graph layer.

Production: Neo4j (official driver). Fallback: embedded property-graph engine
with Cypher-inspired node/edge operations.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Optional

from ..config import settings


class EmbeddedGraph:
    """In-memory property graph: nodes with labels/props, edges with types."""

    def __init__(self) -> None:
        self._nodes: dict[str, dict] = {}
        self._edges: list[dict] = []
        self._adj: dict[str, list[int]] = defaultdict(list)

    async def merge_node(self, node_id: str, labels: list[str], props: dict) -> dict:
        node = self._nodes.get(node_id) or {"id": node_id, "labels": [], "props": {}}
        node["labels"] = sorted(set(node["labels"]) | set(labels))
        node["props"].update(props)
        self._nodes[node_id] = node
        return dict(node)

    async def merge_edge(self, src: str, rel: str, dst: str, props: dict | None = None) -> dict:
        for e in self._edges:
            if e["src"] == src and e["rel"] == rel and e["dst"] == dst:
                e["props"].update(props or {})
                return dict(e)
        e = {"src": src, "rel": rel, "dst": dst, "props": props or {}}
        self._edges.append(e)
        self._adj[src].append(len(self._edges) - 1)
        return dict(e)

    async def neighbors(self, node_id: str, rel: str | None = None, direction: str = "out") -> list[dict]:
        out = []
        if direction in ("out", "both"):
            for i in self._adj.get(node_id, []):
                e = self._edges[i]
                if rel is None or e["rel"] == rel:
                    n = self._nodes.get(e["dst"])
                    if n:
                        out.append({"edge": e["rel"], "node": n})
        if direction in ("in", "both"):
            for e in self._edges:
                if e["dst"] == node_id and (rel is None or e["rel"] == rel):
                    n = self._nodes.get(e["src"])
                    if n:
                        out.append({"edge": e["rel"], "node": n})
        return out

    async def path(self, src: str, dst: str, max_depth: int = 4) -> Optional[list[str]]:
        """BFS shortest path returning node ids."""
        if src == dst and src in self._nodes:
            return [src]
        seen = {src}
        frontier: list[list[str]] = [[src]]
        for _ in range(max_depth):
            nxt: list[list[str]] = []
            for path in frontier:
                for i in self._adj.get(path[-1], []):
                    e = self._edges[i]
                    if e["dst"] in seen:
                        continue
                    new = path + [e["dst"]]
                    if e["dst"] == dst:
                        return new
                    seen.add(e["dst"])
                    nxt.append(new)
            if not nxt:
                return None
            frontier = nxt
        return None

    async def query(self, cypher_like: str) -> list[dict]:
        """Minimal text query over labels/props (embedded stand-in for Cypher)."""
        q = cypher_like.lower()
        hits = []
        for n in self._nodes.values():
            hay = " ".join(n["labels"] + [str(v) for v in n["props"].values()]).lower()
            if all(t in hay for t in q.split()):
                hits.append(n)
        return hits[:50]

    async def stats(self) -> dict:
        rel_counts: dict[str, int] = {}
        for e in self._edges:
            rel_counts[e["rel"]] = rel_counts.get(e["rel"], 0) + 1
        return {"nodes": len(self._nodes), "edges": len(self._edges), "relationships": rel_counts}

    async def health(self) -> dict:
        return {"mode": "embedded-graph", "ok": True}


class Neo4jGraph:
    def __init__(self) -> None:
        from neo4j import AsyncGraphDatabase  # type: ignore

        self._drv = AsyncGraphDatabase.driver(
            settings.neo4j_url, auth=(settings.neo4j_user, settings.neo4j_password)
        )

    async def merge_node(self, node_id: str, labels: list[str], props: dict) -> dict:
        label = "".join(":" + l for l in labels) or ""
        async with self._drv.session() as s:
            rec = await (await s.run(
                f"MERGE (n{label} {{id: $id}}) SET n += $props RETURN n",
                id=node_id, props=props,
            )).single()
        return {"id": node_id, "labels": labels, "props": props}

    async def merge_edge(self, src: str, rel: str, dst: str, props: dict | None = None) -> dict:
        async with self._drv.session() as s:
            await s.run(
                f"MATCH (a {{id: $src}}), (b {{id: $dst}}) MERGE (a)-[r:{rel}]->(b) SET r += $props",
                src=src, dst=dst, props=props or {},
            )
        return {"src": src, "rel": rel, "dst": dst, "props": props or {}}

    async def neighbors(self, node_id: str, rel: str | None = None, direction: str = "out") -> list[dict]:
        arrow = f"-[r{'`' + rel + '`' if rel else ''}]->" if direction == "out" else f"<-[r{'`' + rel + '`' if rel else ''}]-"
        async with self._drv.session() as s:
            res = await s.run(
                f"MATCH (n {{id: $id}}){arrow}(m) RETURN m, type(r) AS rel", id=node_id
            )
            return [{"edge": rec["rel"], "node": dict(rec["m"])} async for rec in res]

    async def path(self, src: str, dst: str, max_depth: int = 4) -> Optional[list[str]]:
        async with self._drv.session() as s:
            res = await s.run(
                "MATCH p = shortestPath((a {id: $src})-[*..%d]-(b {id: $dst})) RETURN [n IN nodes(p) | n.id] AS ids" % max_depth,
                src=src, dst=dst,
            )
            rec = await res.single()
        return rec["ids"] if rec else None

    async def query(self, cypher_like: str) -> list[dict]:
        async with self._drv.session() as s:
            res = await s.run(cypher_like)
            return [dict(rec) async for rec in res]

    async def stats(self) -> dict:
        async with self._drv.session() as s:
            rec = await (await s.run("MATCH (n) WITH count(n) AS nodes OPTIONAL MATCH ()-[r]->() RETURN nodes AS nodes, count(r) AS edges")).single()
        return {"nodes": rec["nodes"], "edges": rec["edges"], "relationships": {}}

    async def health(self) -> dict:
        async with self._drv.session() as s:
            await s.run("RETURN 1")
        return {"mode": "neo4j", "ok": True}

    async def close(self) -> None:
        await self._drv.close()


class Graph:
    def __init__(self) -> None:
        self._impl: Any = None

    async def connect(self) -> None:
        if settings.has_neo4j:
            try:
                self._impl = Neo4jGraph()
                await self._impl.health()
                return
            except Exception:
                self._impl = None
        self._impl = EmbeddedGraph()

    async def merge_node(self, node_id: str, labels: list[str], props: dict) -> dict:
        return await self._impl.merge_node(node_id, labels, props)

    async def merge_edge(self, src: str, rel: str, dst: str, props: dict | None = None) -> dict:
        return await self._impl.merge_edge(src, rel, dst, props)

    async def neighbors(self, node_id: str, rel: str | None = None, direction: str = "out") -> list[dict]:
        return await self._impl.neighbors(node_id, rel, direction)

    async def path(self, src: str, dst: str, max_depth: int = 4) -> Optional[list[str]]:
        return await self._impl.path(src, dst, max_depth)

    async def query(self, cypher_like: str) -> list[dict]:
        return await self._impl.query(cypher_like)

    async def stats(self) -> dict:
        return await self._impl.stats()

    async def health(self) -> dict:
        return await self._impl.health()

    async def close(self) -> None:
        try:
            await self._impl.close()  # type: ignore[attr-defined]
        except AttributeError:
            pass


graph = Graph()
