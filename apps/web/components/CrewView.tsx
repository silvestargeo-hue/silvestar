"use client";

/** Crew — multi-agent cowork: manager → researcher → writer → reviewer.
 *  Free, runs on the platform's own AI chain. */
import { useEffect, useState } from "react";
import { copyText, toast, useSpeechInput, renderMarkdown } from "@/lib/kit";
import { useI18n } from "@/lib/i18n";
import { isOffline, enqueue } from "@/lib/offline";

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type CrewResult = {
  task: string; plan: string; research: string; draft: string; final: string;
  agents: string[]; tools_used: string[]; skills_applied?: string[];
  citations: { i: number; library: string; title: string; score: number }[];
  latency_ms: number;
};

type Job = { id: string; task: string; interval_hours: number; runs: number; last_run: number };
type ResearchJob = { id: string; topic: string; interval_days: number; runs: number; last_run: number };

export function CrewView({ userId, sessionToken, authToken, offline = false, pendingSync = 0 }: {
  userId: string; sessionToken: string; authToken?: string; offline?: boolean; pendingSync?: number;
}) {
  const { t } = useI18n();
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<CrewResult | null>(null);
  const [err, setErr] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobSaved, setJobSaved] = useState(false);
  const [rjobs, setRjobs] = useState<ResearchJob[]>([]);
  const [rtopic, setRtopic] = useState("");
  const [rbusy, setRbusy] = useState(false);
  const { listening, start, supported: sttSupported } = useSpeechInput((v) => setTask(v));

  const loadJobs = () => {
    fetch(`${API}/api/v1/crew/jobs`, { headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} })
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((d) => setJobs(d.jobs || []))
      .catch(() => setJobs([]));
    // weekly research agent jobs
    fetch(`${API}/api/v1/research/jobs`, { headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} })
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((d) => setRjobs(d.jobs || []))
      .catch(() => setRjobs([]));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadJobs, []);

  const scheduleJob = async () => {
    const q = task.trim();
    if (!q) return;
    if (offline) {
      enqueue(`${API}/api/v1/crew/jobs`, { task: q, interval_hours: 24 }, authToken ? { Authorization: `Bearer ${authToken}` } : {});
      setJobSaved(true);
      toast(`Offline — job saved on device, will sync (queue: ${pendingSync + 1})`, "ok");
      return;
    }
    try {
      const r = await fetch(`${API}/api/v1/crew/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ task: q, interval_hours: 24 }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      setJobSaved(true);
      toast(t("jobAdded"), "ok");
      loadJobs();
    } catch (e) { toast(String(e instanceof Error ? e.message : e), "err"); }
  };

  const deleteJob = async (id: string) => {
    try {
      await fetch(`${API}/api/v1/crew/jobs/${encodeURIComponent(id)}`, { method: "DELETE", headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} });
      loadJobs();
    } catch {}
  };

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

  // ------------------------------------------- weekly research agent ------
  const addResearchJob = async () => {
    const topic = rtopic.trim();
    if (topic.length < 4 || rbusy) return;
    setRbusy(true);
    try {
      const r = await fetch(`${API}/api/v1/research/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ topic, interval_days: 7 }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      setRtopic("");
      toast("🔬 Research agent scheduled — a fresh report lands in Library → Research every week", "ok");
      loadJobs();
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setRbusy(false); }
  };

  const deleteResearchJob = async (id: string) => {
    try {
      await fetch(`${API}/api/v1/research/jobs/${encodeURIComponent(id)}`, {
        method: "DELETE", headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      loadJobs();
    } catch {}
  };

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
          <button className="ghost" onClick={scheduleJob} disabled={!task.trim()} title={t("jobAdded")}>
            🗓 {t("addJob")}
          </button>
        </div>
        {err && <div className="hint" style={{ color: "var(--err)" }}>{err}</div>}
      </div>

      {/* scheduled jobs */}
      <div className="card">
        <b>🗓 {t("jobs")} ({jobs.length})</b>
        {jobSaved && <div className="hint">{t("jobAdded")}</div>}
        {jobs.length === 0 ? (
          <div className="muted small">—</div>
        ) : jobs.map((j) => (
          <div key={j.id} className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
            <span>
              <b>{j.task.slice(0, 60)}{j.task.length > 60 ? "…" : ""}</b>
              <span className="muted small"> · {t("jobDueIn")}: {j.interval_hours}h · runs: {j.runs}</span>
            </span>
            <button className="btn tiny danger" onClick={() => deleteJob(j.id)}>🗑</button>
          </div>
        ))}
      </div>

      {/* weekly AI research agent */}
      <div className="card">
        <b>🔬 AI research agent</b>
        <div className="hint">Give a topic — the agent researches it every week on the free AI chain and files a fresh report in Library → Research (with 🔔 + email).</div>
        <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}>
          <input value={rtopic} placeholder="e.g. AI agents in education"
            onChange={(e) => setRtopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addResearchJob()} disabled={rbusy} style={{ flex: 1, minWidth: 200 }} />
          <button className="btn primary" disabled={rbusy || rtopic.trim().length < 4} onClick={addResearchJob}>
            {rbusy ? "⏳" : "🗓 Schedule weekly"}
          </button>
        </div>
        {rjobs.length === 0 ? (
          <div className="muted small" style={{ marginTop: 6 }}>—</div>
        ) : rjobs.map((j) => (
          <div key={j.id} className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
            <span>
              <b>🔬 {j.topic.slice(0, 60)}{j.topic.length > 60 ? "…" : ""}</b>
              <span className="muted small"> · every {j.interval_days}d · runs: {j.runs}{j.last_run ? ` · last: ${new Date(j.last_run * 1000).toLocaleDateString()}` : ""}</span>
            </span>
            <button className="btn tiny danger" onClick={() => deleteResearchJob(j.id)}>🗑</button>
          </div>
        ))}
      </div>

      {res && (
        <>
          {/* pipeline progress bar: every agent that ran */}
          <div className="card">
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {res.agents.map((a, i) => (
                <div key={a} style={{
                  flex: 1, height: 6, borderRadius: 4,
                  background: i === 0 ? "#8a05ff55" : i === res.agents.length - 1 ? "#8a05ff" : "#8a05ff88",
                }} title={a} />
              ))}
            </div>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {res.agents.map((a) => <Badge key={a}>🤖 {a}</Badge>)}
                {res.tools_used.map((tl) => <Badge key={tl}>🔧 {tl}</Badge>)}
                {(res.skills_applied || []).map((s) => <Badge key={s}>🧩 {s}</Badge>)}
                <Badge>{res.latency_ms} ms</Badge>
              </span>
              <button className="mini" onClick={() => { copyText(res.final); toast("Final copied", "ok"); }}>📋 Copy</button>
            </div>
          </div>

          <details className="card" open>
            <summary><b>✅ {t("crewFinal")}</b></summary>
            <div style={{ lineHeight: 1.55 }}>{renderMarkdown(res.final)}</div>
          </details>
          <details className="card">
            <summary><b>🧭 {t("crewPlan")}</b></summary>
            <div style={{ lineHeight: 1.5 }}>{renderMarkdown(res.plan)}</div>
          </details>
          <details className="card">
            <summary><b>🔍 {t("crewResearch")}</b></summary>
            <div style={{ lineHeight: 1.5 }}>{renderMarkdown(res.research)}</div>
          </details>
          <details className="card">
            <summary><b>✍️ {t("crewDraft")}</b></summary>
            <div style={{ lineHeight: 1.5 }}>{renderMarkdown(res.draft)}</div>
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
