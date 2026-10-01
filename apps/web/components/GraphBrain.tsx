"use client";

/** GraphBrain — per-user knowledge graph: harvest entities from files,
 * interactive map (click a node to see its connections), and
 * "how are X and Y connected?" queries. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/kit";

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type KgNode = { id: string; name: string; deg: number };
type KgLink = { source: string; target: string; rel: string; file?: string };
type MapRes = { nodes: KgNode[]; links: KgLink[] };

export function GraphBrain({ authToken }: { authToken: string }) {
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<MapRes | null>(null);
  const [sel, setSel] = useState<string>("");
  const [aName, setAName] = useState("");
  const [bName, setBName] = useState("");
  const [chain, setChain] = useState<{ found: boolean; chain?: string; explanation?: string; reason?: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const h = (): Record<string, string> => (authToken ? { Authorization: `Bearer ${authToken}` } : {});

  const loadMap = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/v1/kg/map`, { headers: h() });
      if (r.ok) setData(await r.json());
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  useEffect(() => { loadMap(); }, [loadMap]);

  const harvest = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/kg/harvest`, { method: "POST", headers: h() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      toast(`🕸 Scanned ${j.scanned} file(s) — ${j.edges_added} connections added`, "ok");
      await loadMap();
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setBusy(false); }
  };

  const connect = async () => {
    if (!aName.trim() || !bName.trim()) return;
    setChain(null);
    try {
      const r = await fetch(`${API}/api/v1/kg/connect`, {
        method: "POST", headers: { "Content-Type": "application/json", ...h() },
        body: JSON.stringify({ source: aName.trim(), target: bName.trim() }),
      });
      const j = await r.json();
      setChain(j);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    }
  };

  // simple deterministic force-ish layout: circle placement by index
  const laid = useMemo(() => {
    if (!data || !data.nodes.length) return [];
    const n = data.nodes.length;
    const R = Math.min(240, 90 + n * 6);
    return data.nodes.map((nd, i) => {
      const ang = (i / n) * Math.PI * 2;
      return { ...nd, x: 300 + R * Math.cos(ang), y: 260 + R * Math.sin(ang) * 0.8 };
    });
  }, [data]);

  const posOf = (name: string) => laid.find((n) => n.name === name);
  const selLinks = useMemo(
    () => (data && sel ? data.links.filter((l) => l.source === sel || l.target === sel) : []),
    [data, sel]);

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <b>🧠 Knowledge Graph Brain</b>
        <button className="btn primary" disabled={busy} onClick={harvest}>
          {busy ? "⏳ Reading your files…" : "🕸 Harvest from Library"}
        </button>
      </div>
      <div className="hint">Extracts people, places, projects and their relationships from your files into a personal graph — then answers &ldquo;how are X and Y connected?&rdquo;</div>

      <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        <input value={aName} placeholder="First thing (e.g. my bakery)" onChange={(e) => setAName(e.target.value)} style={{ maxWidth: 180 }} />
        <span className="muted">→ ? →</span>
        <input value={bName} placeholder="Second thing (e.g. Kochi)" onChange={(e) => setBName(e.target.value)} style={{ maxWidth: 180 }} />
        <button className="btn ghost" onClick={connect} disabled={!aName.trim() || !bName.trim()}>🔗 Connect</button>
      </div>
      {chain && (
        <div className="hint" style={{ marginTop: 8 }}>
          {chain.found
            ? <>🔗 <b>{chain.chain}</b><br />{chain.explanation}</>
            : <>🚫 {chain.reason}</>}
        </div>
      )}

      {data && data.nodes.length > 0 && (
        <div ref={wrapRef} style={{ marginTop: 10, overflowX: "auto" }}>
          <svg width="100%" viewBox="0 0 600 520" style={{ minWidth: 480 }}>
            {data.links.map((l, i) => {
              const p1 = posOf(l.source); const p2 = posOf(l.target);
              if (!p1 || !p2) return null;
              const on = !sel || sel === l.source || sel === l.target;
              return (
                <line key={i} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                  stroke={on ? "rgba(138,5,255,.45)" : "rgba(128,128,128,.12)"} strokeWidth={on ? 1.6 : 1} />
              );
            })}
            {laid.map((n) => {
              const on = !sel || sel === n.name || selLinks.some((l) => l.source === n.name || l.target === n.name);
              return (
                <g key={n.id} onClick={() => setSel(sel === n.name ? "" : n.name)} style={{ cursor: "pointer" }} opacity={on ? 1 : 0.25}>
                  <circle cx={n.x} cy={n.y} r={10 + Math.min(n.deg * 2, 10)} fill={sel === n.name ? "#22d3ee" : "#8a05ff"} />
                  <text x={n.x} y={n.y + 26} textAnchor="middle" fontSize="11" fill="currentColor">{n.name.slice(0, 18)}</text>
                </g>
              );
            })}
          </svg>
          <div className="muted small">{data.nodes.length} entities · {data.links.length} connections{sel ? ` · selected: ${sel}` : " · click a node to focus"}</div>
          {sel && selLinks.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {selLinks.map((l, i) => (
                <div key={i} className="muted small">• {l.source} —[{l.rel}]→ {l.target}{l.file ? ` (${l.file})` : ""}</div>
              ))}
            </div>
          )}
        </div>
      )}
      {data && data.nodes.length === 0 && (
        <div className="muted small" style={{ marginTop: 8 }}>No entities yet — hit Harvest (needs ≥1 text file in your Library).</div>
      )}
    </div>
  );
}
