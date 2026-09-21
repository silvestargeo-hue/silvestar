"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface NodeRow {
  id: string;
  labels?: string[];
  props?: Record<string, unknown>;
}

export function GraphView() {
  const [stats, setStats] = useState<{ nodes: number; edges: number; relationships: Record<string, number> } | null>(null);
  const [nId, setNId] = useState("");
  const [nLabel, setNLabel] = useState("Concept");
  const [eSrc, setESrc] = useState("");
  const [eRel, setERel] = useState("RELATES_TO");
  const [eDst, setEDst] = useState("");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<NodeRow[]>([]);
  const [path, setPath] = useState<string[]>([]);
  const [msg, setMsg] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStats(await api.graphStats());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addNode = async () => {
    if (!nId.trim()) return;
    await api.graphNode(nId.trim(), [nLabel.trim() || "Concept"], { name: nId.trim() });
    setNId("");
    setMsg("Node added ✓");
    await refresh();
  };

  const addEdge = async () => {
    if (!eSrc.trim() || !eDst.trim()) return;
    await api.graphEdge(eSrc.trim(), eRel.trim() || "RELATES_TO", eDst.trim());
    setMsg("Edge added ✓");
    await refresh();
  };

  const search = async () => {
    const r = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/v1/graph/query?q=${encodeURIComponent(q)}`
    ).then((x) => x.json());
    setResults(r.results || []);
  };

  const findPath = async () => {
    try {
      const r = await api.graphPath(eSrc.trim(), eDst.trim());
      setPath(r.path);
    } catch (err) {
      setPath([]);
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="grid2">
      <div className="card">
        <h2>🕸 Knowledge graph {stats ? `— ${stats.nodes} nodes · ${stats.edges} edges` : ""}</h2>
        <div className="hint">Neo4j in production; embedded property-graph engine otherwise. Auto-creates dangling endpoints.</div>
        <div className="row" style={{ marginBottom: 6 }}>
          <input value={nId} placeholder="Node id / name" onChange={(e) => setNId(e.target.value)} />
          <input value={nLabel} placeholder="Label" onChange={(e) => setNLabel(e.target.value)} />
          <button onClick={addNode}>Add node</button>
        </div>
        <div className="row" style={{ marginBottom: 6 }}>
          <input value={eSrc} placeholder="src" onChange={(e) => setESrc(e.target.value)} />
          <input value={eRel} placeholder="RELATES_TO" onChange={(e) => setERel(e.target.value)} />
          <input value={eDst} placeholder="dst" onChange={(e) => setEDst(e.target.value)} />
          <button onClick={addEdge}>Add edge</button>
        </div>
        <div className="row">
          <input value={q} placeholder="Text query over nodes…" onChange={(e) => setQ(e.target.value)} />
          <button className="ghost" onClick={search}>Query</button>
          <button className="ghost" onClick={findPath} disabled={!eSrc || !eDst}>Path src→dst</button>
        </div>
        {msg && <div className="hint">{msg}</div>}
        {path.length > 0 && (
          <div className="hit"><div className="t">shortest path</div><div className="s">{path.join(" → ")}</div></div>
        )}
      </div>

      <div className="card">
        <h2>Query results</h2>
        {results.map((n) => (
          <div key={n.id} className="hit">
            <div className="t">{n.id}</div>
            <div className="s">{(n.labels || []).join(", ")} · {JSON.stringify(n.props || {})}</div>
          </div>
        ))}
        {results.length === 0 && <div className="hint">Run a query or add nodes/edges.</div>}
        {stats && Object.keys(stats.relationships || {}).length > 0 && (
          <>
            <div className="hint" style={{ marginTop: 12 }}>Relationships</div>
            {Object.entries(stats.relationships).map(([rel, n]) => (
              <span key={rel} className="tag" style={{ marginRight: 6 }}>{rel}: {n}</span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
