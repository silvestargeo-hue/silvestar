"use client";

/** Tiny SVG sparkline + stat tiles — the dashboard visual language. */
export function Spark({ data, color = "var(--accent2)", w = 90, h = 28 }: {
  data: number[]; color?: string; w?: number; h?: number;
}) {
  if (!data.length) data = [0, 0];
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) =>
    `${(i / (data.length - 1 || 1)) * w},${h - 3 - ((v - min) / range) * (h - 6)}`
  ).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden style={{ flexShrink: 0 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts.split(" ").slice(-1)[0].split(",")[0]} cy={pts.split(" ").slice(-1)[0].split(",")[1]} r="2.5" fill={color} />
    </svg>
  );
}

export function StatTile({ icon, label, value, sub, trend, accent }: {
  icon: string; label: string; value: string | number;
  sub?: string; trend?: number[]; accent?: string;
}) {
  return (
    <div className="tile" style={accent ? { ["--tile-accent" as any]: accent } : undefined}>
      <div className="tile-top">
        <span className="tile-icon">{icon}</span>
        <span className="tile-label">{label}</span>
        {trend && <Spark data={trend} />}
      </div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

export function Chip({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={`badge ${ok ? "ok" : "err"}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: ok ? "var(--ok)" : "var(--err)", display: "inline-block" }} />
      {children}
    </span>
  );
}
