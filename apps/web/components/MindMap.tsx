"use client";

/** 🕸 AI Mind-map — concepts of a folder as an interactive SVG graph.
 *  Nodes are placed on a circle, edges show AI-extracted relations.
 *  Pure SVG, zero dependencies, free (Groq). */
import { useEffect, useState } from "react";
import { Modal, toast } from "@/lib/kit";

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type Node = { id: string; label: string };
type Res = { folder: string; nodes: Node[]; edges: [string, string, string][]; engine: string };

export function MindMap({ authToken, userId, folder, onClose }: {
  authToken: string; userId: string; folder: string; onClose: () => void;
}) {
  const [data, setData] = useState<Res | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/api/v1/files/mindmap`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ folder }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail || `${r.status}`);
        setData(j);
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e));
      } finally { setBusy(false); }
    })();
  }, [authToken, folder]);

  // circular layout
  const W = 560, H = 420, CX = W / 2, CY = H / 2, R = Math.min(W, H) / 2 - 60;
  const pos = new Map<string, { x: number; y: number }>();
  if (data) {
    data.nodes.forEach((n, i) => {
      const a = (2 * Math.PI * i) / Math.max(data.nodes.length, 1) - Math.PI / 2;
      pos.set(n.id, { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) });
    });
  }

  return (
    <Modal title={`🕸 AI Mind-map${folder ? ` — ${folder}` : ""}`} onClose={onClose}>
      {busy && <div className="hint">⏳ Reading the folder and extracting concepts…</div>}
      {err && <div className="hint" style={{ color: "#ef4444" }}>⚠ {err}</div>}
      {data && (
        <>
          <div style={{ border: "1px solid rgba(128,128,128,.25)", borderRadius: 12, overflow: "auto" }}>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 420 }}>
              {data.edges.map(([a, b, label], i) => {
                const pa = pos.get(a), pb = pos.get(b);
                if (!pa || !pb) return null;
                return (
                  <g key={i}>
                    <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="currentColor" strokeOpacity={0.3} strokeWidth={1.5} />
                    <text x={(pa.x + pb.x) / 2} y={(pa.y + pb.y) / 2 - 3} textAnchor="middle" fontSize={8} fill="currentColor" opacity={0.55}>{label}</text>
                  </g>
                );
              })}
              {data.nodes.map((n) => {
                const p = pos.get(n.id)!;
                const w = Math.max(46, n.label.length * 6.4 + 14);
                return (
                  <g key={n.id}>
                    <rect x={p.x - w / 2} y={p.y - 13} width={w} height={26} rx={13}
                      fill="var(--accent)" opacity={0.9} />
                    <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={10.5} fontWeight={600}
                      fill="#fff">{n.label}</text>
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
            <span className="muted small">{data.nodes.length} concepts · {data.edges.length} links · engine: {data.engine}</span>
            <button className="btn ghost" onClick={() => {
              try {
                localStorage.setItem("sv-mindmap", JSON.stringify(data));
                toast("Snapshot saved — paste it anywhere", "ok");
              } catch { toast("Could not save", "err"); }
            }}>💾 Save snapshot</button>
          </div>
        </>
      )}
    </Modal>
  );
}
