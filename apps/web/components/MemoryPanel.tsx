"use client";

/** Memory Core panel — "What Silvestar knows about me": inspect, teach,
 * delete, forget-all. Plus the 📻 Morning Briefing card with spoken audio. */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/kit";

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type Mem = { id: string; text: string; kind: string; created: number };
type Briefing = { greeting: string; script: string; audio_text: string; facts: string[]; date: string };

export function MemoryPanel({ authToken }: { authToken: string }) {
  const [mems, setMems] = useState<Mem[]>([]);
  const [teach, setTeach] = useState("");
  const [show, setShow] = useState(false);
  const h = (): Record<string, string> => (authToken ? { Authorization: `Bearer ${authToken}` } : {});

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/v1/memory`, { headers: h() });
      if (r.ok) setMems(((await r.json()).memories || []) as Mem[]);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const t = teach.trim();
    if (!t) return;
    const r = await fetch(`${API}/api/v1/memory`, {
      method: "POST", headers: { "Content-Type": "application/json", ...h() },
      body: JSON.stringify({ text: t }),
    });
    if (r.ok) { setTeach(""); toast("Remembered ✓", "ok"); load(); }
    else toast("Could not store that", "err");
  };

  const del = async (id: string) => {
    await fetch(`${API}/api/v1/memory/${encodeURIComponent(id)}`, { method: "DELETE", headers: h() });
    load();
  };

  const clearAll = async () => {
    if (!confirm("Forget EVERYTHING Silvestar knows about you?")) return;
    await fetch(`${API}/api/v1/memory`, { method: "DELETE", headers: h() });
    toast("All memories forgotten", "ok");
    load();
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>🧠 What Silvestar knows about me ({mems.length})</b>
        <button className="mini ghost" onClick={() => setShow(!show)}>{show ? "Hide" : "Inspect"}</button>
      </div>
      <div className="hint">Silvestar quietly learns facts from your conversations to give personal answers. You see everything here — and can delete any of it.</div>
      {show && (
        <>
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}>
            <input value={teach} placeholder="Teach: “Remember that my bakery is called Flour & Frame”"
              onChange={(e) => setTeach(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()} style={{ flex: 1, minWidth: 220 }} />
            <button className="btn primary" disabled={!teach.trim()} onClick={add}>🧠 Teach</button>
            {mems.length > 0 && <button className="btn danger" onClick={clearAll}>Forget all</button>}
          </div>
          <div style={{ marginTop: 8 }}>
            {mems.length === 0 ? (
              <div className="muted small">Nothing learned yet — chat with Silvestar and it will start remembering.</div>
            ) : mems.map((m) => (
              <div key={m.id} className="hit" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <div className="t">{m.text}</div>
                  <div className="muted small">{m.kind === "taught" ? "📌 taught by you" : "🧠 learned"} · {new Date(m.created * 1000).toLocaleDateString()}</div>
                </div>
                <button className="mini ghost" onClick={() => del(m.id)} title="Forget this">✕</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function BriefingCard({ authToken, userName }: { authToken: string; userName?: string }) {
  const [b, setB] = useState<Briefing | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/briefing`, { headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} });
      if (r.ok) setB(await r.json());
    } catch {}
    setBusy(false);
  }, [authToken]);

  const play = () => {
    if (!b) return;
    try {
      speechSynthesis?.cancel();
      stopRef.current = false;
      const u = new SpeechSynthesisUtterance(b.audio_text || b.script);
      u.rate = 1.02;
      const vs = speechSynthesis?.getVoices?.() || [];
      const v = vs.find((x) => /en/i.test(x.lang) && /female|samantha|zira|google/i.test(x.name)) || vs[0];
      if (v) u.voice = v;
      u.onstart = () => setPlaying(true);
      u.onend = () => setPlaying(false);
      u.onerror = () => setPlaying(false);
      speechSynthesis?.speak(u);
    } catch { setPlaying(false); }
  };

  const stop = () => { stopRef.current = true; try { speechSynthesis?.cancel(); } catch {} setPlaying(false); };

  return (
    <div className="card" style={{ marginBottom: 14, background: "linear-gradient(135deg, rgba(138,5,255,.10), rgba(34,211,238,.08))" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>📻 Morning Briefing</b>
        <span className="muted small">{b?.date || "today"}</span>
      </div>
      {!b ? (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={busy} onClick={load}>{busy ? "⏳ Writing…" : "✨ Write my briefing"}</button>
        </div>
      ) : (
        <>
          <p style={{ lineHeight: 1.6, margin: "10px 0" }}>{b.script}</p>
          <div className="row" style={{ gap: 8 }}>
            {!playing
              ? <button className="btn primary" onClick={play}>▶ Listen</button>
              : <button className="btn danger" onClick={stop}>⏹ Stop</button>}
            <button className="btn ghost" disabled={busy} onClick={load}>{busy ? "⏳" : "🔄 Refresh"}</button>
          </div>
          {b.facts.length > 0 && (
            <div className="hint" style={{ marginTop: 8 }}>Today: {b.facts.slice(0, 4).join(" · ")}</div>
          )}
        </>
      )}
    </div>
  );
}
