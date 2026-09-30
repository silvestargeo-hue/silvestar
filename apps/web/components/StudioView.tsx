"use client";

/** Studio — AI media workspace, free:
 *  🖼 Text → image (keyless), saved to Library/AI-Images
 *  🎙 Audio upload → Whisper transcript + AI meeting notes
 *  📊 CSV → auto charts (pure SVG) + AI insights
 */
import { useRef, useState } from "react";
import { toast, renderMarkdown } from "@/lib/kit";
import { useI18n } from "@/lib/i18n";

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type ChartSpec = { title: string; kind: "bar" | "line" | "pie"; labels: string[]; values: number[] };

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  return { headers: split(lines[0]), rows: lines.slice(1).map(split) };
}

function toNumber(v: string): number | null {
  const n = parseFloat(String(v).replace(/[, ]/g, ""));
  return isFinite(n) ? n : null;
}

/** Heuristics: pick a label column (first text column) and numeric columns. */
function buildCharts(headers: string[], rows: string[][]): ChartSpec[] {
  const numCols: number[] = [];
  headers.forEach((h, i) => {
    const sample = rows.slice(0, 12).map((r) => r[i]).filter((v) => v !== undefined && v !== "");
    if (sample.length >= 3 && sample.every((v) => toNumber(v) !== null)) numCols.push(i);
  });
  if (!numCols.length || !rows.length) return [];
  let labelCol = headers.findIndex((_, i) => !numCols.includes(i));
  if (labelCol < 0) labelCol = 0;
  const charts: ChartSpec[] = [];
  const label = (r: string[]) => String(r[labelCol] ?? "").slice(0, 14);
  // first numeric column: bar chart by label (top 8)
  const c0 = numCols[0];
  charts.push({
    title: headers[c0],
    kind: "bar",
    labels: rows.slice(0, 8).map(label),
    values: rows.slice(0, 8).map((r) => toNumber(r[c0]) || 0),
  });
  // second numeric column: line over row order
  if (numCols[1] !== undefined) {
    charts.push({
      title: headers[numCols[1]],
      kind: "line",
      labels: rows.slice(0, 12).map(label),
      values: rows.slice(0, 12).map((r) => toNumber(r[numCols[1]]) || 0),
    });
  }
  // last numeric column: pie of first 5 rows' share
  const cl = numCols[numCols.length - 1];
  const top = rows.slice(0, 5);
  const total = top.reduce((s, r) => s + (toNumber(r[cl]) || 0), 0);
  if (total > 0) {
    charts.push({
      title: `${headers[cl]} share`,
      kind: "pie",
      labels: top.map(label),
      values: top.map((r) => toNumber(r[cl]) || 0),
    });
  }
  return charts;
}

function Chart({ spec, color }: { spec: ChartSpec; color: string }) {
  const W = 300, H = 170, P = 26;
  const max = Math.max(...spec.values, 1);
  if (spec.kind === "bar") {
    const bw = (W - P * 2) / spec.values.length;
    return (
      <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
        {spec.values.map((v, i) => {
          const h = ((H - P * 2) * v) / max;
          return (
            <g key={i}>
              <rect x={P + i * bw + 2} y={H - P - h} width={bw - 4} height={h} rx={3} fill={color} opacity={0.85} />
              <text x={P + i * bw + bw / 2} y={H - P + 12} textAnchor="middle" fontSize="8" fill="currentColor" opacity="0.7">{spec.labels[i]}</text>
              <text x={P + i * bw + bw / 2} y={H - P - h - 3} textAnchor="middle" fontSize="8" fill="currentColor" opacity="0.8">{v}</text>
            </g>
          );
        })}
      </svg>
    );
  }
  if (spec.kind === "line") {
    const pts = spec.values.map((v, i) => {
      const x = P + ((W - P * 2) * i) / Math.max(spec.values.length - 1, 1);
      const y = H - P - ((H - P * 2) * v) / max;
      return `${x},${y}`;
    }).join(" ");
    return (
      <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
        <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" />
        {spec.values.map((v, i) => {
          const x = P + ((W - P * 2) * i) / Math.max(spec.values.length - 1, 1);
          const y = H - P - ((H - P * 2) * v) / max;
          return <circle key={i} cx={x} cy={y} r="3" fill={color} />;
        })}
        {spec.labels.map((l, i) => (i % Math.ceil(spec.labels.length / 6) === 0 ? (
          <text key={i} x={P + ((W - P * 2) * i) / Math.max(spec.values.length - 1, 1)} y={H - P + 12} textAnchor="middle" fontSize="8" fill="currentColor" opacity="0.7">{l}</text>
        ) : null))}
      </svg>
    );
  }
  // pie
  let a0 = 0;
  const cx = H / 2, cy = H / 2, r = H / 2 - 14;
  const hues = [0, 60, 140, 200, 280, 330];
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
      {spec.values.map((v, i) => {
        const frac = v / (spec.values.reduce((s, x) => s + x, 0) || 1);
        const a1 = a0 + frac * Math.PI * 2;
        const large = frac > 0.5 ? 1 : 0;
        const d = `M ${cx} ${cy} L ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} Z`;
        const fill = `hsl(${(268 + hues[i % hues.length]) % 360} 70% 55%)`;
        a0 = a1;
        return <path key={i} d={d} fill={fill} opacity="0.9" />;
      })}
      {spec.labels.map((l, i) => (
        <text key={i} x={W - P - 4} y={P + i * 13} textAnchor="end" fontSize="9" fill="currentColor" opacity="0.8">{l} ({spec.values[i]})</text>
      ))}
    </svg>
  );
}

export function StudioView({ authToken, userId }: { authToken: string; userId: string }) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState("");
  const [imgBusy, setImgBusy] = useState(false);
  const [imgSrc, setImgSrc] = useState("");
  const [imgName, setImgName] = useState("");

  const [audBusy, setAudBusy] = useState(false);
  const [audResult, setAudResult] = useState("");
  const audRef = useRef<HTMLInputElement>(null);

  const [csvInfo, setCsvInfo] = useState("");
  const [charts, setCharts] = useState<ChartSpec[]>([]);
  const [insights, setInsights] = useState("");
  const [csvBusy, setCsvBusy] = useState(false);
  const csvRef = useRef<HTMLInputElement>(null);

  const authHeaders = (): Record<string, string> => (authToken ? { Authorization: `Bearer ${authToken}` } : {});

  const genImage = async () => {
    const p = prompt.trim();
    if (!p || imgBusy) return;
    setImgBusy(true); setImgSrc(""); setImgName("");
    try {
      const r = await fetch(`${API}/api/v1/media/image?prompt=${encodeURIComponent(p)}`, {
        method: "POST", headers: authHeaders(),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      const src = `${API}/api/v1/files/view?path=${encodeURIComponent(j.path)}`;
      setImgSrc(src); setImgName(j.name);
      toast(t("imgDone"), "ok");
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setImgBusy(false); }
  };

  const handleAudio = async (f: File | null) => {
    if (!f || audBusy) return;
    setAudBusy(true); setAudResult("");
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`${API}/api/v1/media/transcribe`, { method: "POST", headers: authHeaders(), body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      setAudResult(`**${j.transcript_file}** (${j.chars} chars)` + (j.notes_file ? `\n\n📝 **${j.notes_file}**\n\n${j.notes}` : ""));
      toast(t("audioDone"), "ok");
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setAudBusy(false); }
  };

  const handleCSV = async (f: File | null) => {
    if (!f || csvBusy) return;
    setCsvBusy(true); setCharts([]); setInsights(""); setCsvInfo("");
    try {
      const text = await f.text();
      const { headers, rows } = parseCSV(text);
      const specs = buildCharts(headers, rows);
      setCharts(specs);
      setCsvInfo(`${rows.length} rows · ${headers.length} columns`);
      if (!specs.length) { toast(t("csvNoNums"), "err"); return; }
      const r = await fetch(`${API}/api/v1/ask`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: `Analyze this CSV data ("${f.name}", columns: ${headers.join(", ")}). ` +
            `Key numbers: ${specs.map((s) => `${s.title}: last=${s.values[s.values.length - 1]}, max=${Math.max(...s.values)}`).join("; ")}. ` +
            `Give 3 short data insights.`,
          user_id: userId,
        }),
      });
      const j = await r.json();
      setInsights(j.answer || "");
      toast(t("csvDone"), "ok");
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setCsvBusy(false); }
  };

  const card = { marginBottom: 14 };

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h2>🎨 {t("studio")}</h2>
          <p className="muted">{t("studioHint")}</p>
        </div>
      </div>

      {/* images */}
      <div className="card" style={card}>
        <b>🖼 {t("imgTitle")}</b>
        <div className="hint">{t("imgHint")}</div>
        <div className="row">
          <input value={prompt} placeholder={t("imgPlaceholder")}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && genImage()} disabled={imgBusy} />
          <button onClick={genImage} disabled={imgBusy || !prompt.trim()}>
            {imgBusy ? "⏳" : "🎨 " + t("imgBtn")}
          </button>
        </div>
        {imgSrc && (
          <div style={{ marginTop: 10 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imgSrc} alt={imgName} style={{ maxWidth: "100%", borderRadius: 10, border: "1px solid rgba(128,128,128,.3)" }} />
            <div className="muted small">📁 Library/AI-Images/{imgName}</div>
          </div>
        )}
      </div>

      {/* audio */}
      <div className="card" style={card}>
        <b>🎙 {t("audioTitle")}</b>
        <div className="hint">{t("audioHint")}</div>
        <button className="btn primary" disabled={audBusy} onClick={() => audRef.current?.click()}>
          {audBusy ? "⏳ Transcribing…" : "⬆ " + t("audioBtn")}
        </button>
        <input ref={audRef} type="file" accept="audio/*,video/mp4,.mp3,.m4a,.wav,.ogg,.webm" hidden
          onChange={(e) => { handleAudio(e.target.files?.[0] || null); e.target.value = ""; }} />
        {audResult && <div style={{ marginTop: 8 }}>{renderMarkdown(audResult)}</div>}
      </div>

      {/* csv */}
      <div className="card" style={card}>
        <b>📊 {t("csvTitle")}</b>
        <div className="hint">{t("csvHint")}</div>
        <button className="btn primary" disabled={csvBusy} onClick={() => csvRef.current?.click()}>
          {csvBusy ? "⏳" : "⬆ " + t("csvBtn")}
        </button>
        <input ref={csvRef} type="file" accept=".csv,text/csv" hidden
          onChange={(e) => { handleCSV(e.target.files?.[0] || null); e.target.value = ""; }} />
        {csvInfo && <div className="muted small" style={{ marginTop: 6 }}>{csvInfo}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10, marginTop: 8 }}>
          {charts.map((s) => (
            <div key={s.title} style={{ border: "1px solid rgba(128,128,128,.25)", borderRadius: 10, padding: 8 }}>
              <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{s.title}</div>
              <Chart spec={s} color="#8a05ff" />
            </div>
          ))}
        </div>
        {insights && (
          <div style={{ marginTop: 10 }}>{renderMarkdown(insights)}</div>
        )}
      </div>
    </div>
  );
}
