"use client";

/** Crew — multi-agent cowork: manager → researcher → writer → reviewer.
 *  Free, runs on the platform's own AI chain. */
import { useState } from "react";
import { copyText, toast, useSpeechInput } from "@/lib/kit";
import { useI18n } from "@/lib/i18n";

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type CrewResult = {
  task: string; plan: string; research: string; draft: string; final: string;
  agents: string[]; tools_used: string[];
  citations: { i: number; library: string; title: string; score: number }[];
  latency_ms: number;
};

export function CrewView({ userId, sessionToken }: { userId: string; sessionToken: string }) {
  const { t } = useI18n();
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<CrewResult | null>(null);
  const [err, setErr] = useState("");
  const { listening, start, supported: sttSupported } = useSpeechInput((v) => setTask(v));

  const run = async () => {
    const q = task.trim();
    if (!q || busy) return;
    setBusy(true); setErr(""); setRes(null);
    try {
      const out = await fetchCrew(q);
      setRes(out);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const fetchCrew = async (q: string): Promise<CrewResult> => {
    const r = await fetch(`${API}/api/v1/crew/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, user_id: userId, vault_session_token: sessionToken }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || `${r.status}`);
    return j;
  };

  const Badge = ({ children }: { children: React.ReactNode }) => (
    <span className="tag">{children}</span>
  );

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h2>👥 {t("crew")}</h2>
          <p className="muted">{t("crewHint")}</p>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <input value={task} placeholder={t("crewPlaceholder")}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()} disabled={busy} />
          {sttSupported && (
            <button className="ghost" onClick={start} disabled={busy}>
              {listening ? <span className="spin">🎙</span> : "🎙"}
            </button>
          )}
          <button onClick={run} disabled={busy || !task.trim()}>
            {busy ? "⏳ " + t("crewRunning") : "▶ " + t("crewRun")}
          </button>
        </div>
        {err && <div className="hint" style={{ color: "var(--err)" }}>{err}</div>}
      </div>

      {res && (
        <>
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {res.agents.map((a) => <Badge key={a}>🤖 {a}</Badge>)}
                {res.tools_used.map((tl) => <Badge key={tl}>🔧 {tl}</Badge>)}
                <Badge>{res.latency_ms} ms</Badge>
              </span>
              <button className="mini" onClick={() => { copyText(res.final); toast("Final copied", "ok"); }}>📋 Copy</button>
            </div>
          </div>

          <details className="card" open>
            <summary><b>✅ {t("crewFinal")}</b></summary>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{res.final}</p>
          </details>
          <details className="card">
            <summary><b>🧭 {t("crewPlan")}</b></summary>
            <p style={{ whiteSpace: "pre-wrap" }}>{res.plan}</p>
          </details>
          <details className="card">
            <summary><b>🔍 {t("crewResearch")}</b></summary>
            <p style={{ whiteSpace: "pre-wrap" }}>{res.research}</p>
          </details>
          <details className="card">
            <summary><b>✍️ {t("crewDraft")}</b></summary>
            <p style={{ whiteSpace: "pre-wrap" }}>{res.draft}</p>
          </details>
          {res.citations.length > 0 && (
            <div className="card">
              <div className="hint">{t("sources") || "Sources"}</div>
              {res.citations.map((c) => (
                <span key={c.i} className="cite">[{c.i}] {c.library === "files" ? "📁" : c.library === "vault" ? "🔒" : "📚"} {c.title} · {c.score}</span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
