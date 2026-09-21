"use client";

/** Admin Panel — platform control center: overview stats, document manager,
 *  cache control, runtime AI model switching. Guarded by the admin key. */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatTile, Chip } from "./Stat";
import { toast, timeAgo, downloadFile } from "@/lib/kit";

type Overview = {
  archive_documents: number;
  vault: { sessions_active: string | number; cipher: string; kdf: string };
  realtime: Record<string, unknown>;
  graph: { nodes: number; edges: number };
  ai: { assistant: string; primary_reachable: boolean; model_override: string | null; configured_model: string };
  modes: { db: string; cache: string };
  uptime_s: number;
};

const MODEL_PRESETS = [
  "nex-agi/nex-n2.5-mini:free",
  "nvidia/nemotron-3.5-lightning:free",
  "z-ai/glm-5.2:free",
];

export function AdminPanel() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [audit, setAudit] = useState<{ action: string; detail: string }[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [metrics, setMetrics] = useState<Record<string, any> | null>(null);

  const load = useCallback(async () => {
    try {
      setOv((await api.adminOverview()) as Overview);
      setErr("");
      api.metrics().then(setMetrics).catch(() => {});
    } catch (e: any) {
      setErr(String(e.message || e));
      setOv(null);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const guard = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, "ok");
      await load();
    } catch (e: any) {
      toast(String(e.message || e), "err");
    } finally {
      setBusy(false);
    }
  };

  if (err) {
    return (
      <div className="card">
        <h2>🛡 Admin Panel</h2>
        <div className="hint">{err}</div>
        <button
          onClick={() => {
            const k = prompt("Admin key:");
            if (k) { localStorage.setItem("sv-admin-key", k); setErr(""); load(); }
          }}
        >
          Set admin key
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="tile-grid">
        <StatTile icon="📚" label="Archive docs" value={ov?.archive_documents ?? "—"} sub="public library" accent="var(--accent2)" />
        <StatTile icon="🕸" label="Graph" value={ov ? `${ov.graph?.nodes ?? 0}n / ${ov.graph?.edges ?? 0}e` : "—"} sub="nodes / edges" accent="var(--accent)" />
        <StatTile icon="🗄" label="DB mode" value={ov?.modes.db ?? "—"} sub={`cache: ${ov?.modes.cache ?? "—"}`} accent="var(--ok)" />
        <StatTile icon="⏱" label="Uptime" value={ov ? `${Math.floor(ov.uptime_s / 60)}m` : "—"} sub={`cipher: ${ov?.vault.cipher ?? ""}`} />
      </div>

      <div className="grid2">
        <div className="card">
          <h2>🤖 AI engine control</h2>
          <div className="hint">
            Active: <b>{ov?.ai.model_override || ov?.ai.configured_model || "default"}</b>
            {" "}(<Chip ok={!!ov?.ai.primary_reachable}>{ov?.ai.primary_reachable ? "reachable" : "unreachable"}</Chip>)
          </div>
          <div className="chips" style={{ margin: "10px 0" }}>
            {MODEL_PRESETS.map((m) => (
              <span
                key={m}
                className={`chip ${ov?.ai.model_override === m ? "on" : ""}`}
                onClick={() => !busy && guard(() => api.adminSetModel(m), `Model → ${m}`)}
              >
                {m.split("/")[1]}
              </span>
            ))}
          </div>
          <div className="row">
            <input placeholder="custom model id…" value={customModel} onChange={(e) => setCustomModel(e.target.value)} />
            <button disabled={busy} onClick={() => customModel && guard(() => api.adminSetModel(customModel), `Model → ${customModel}`)}>Apply</button>
            <button className="ghost" disabled={busy} onClick={() => guard(() => api.adminSetModel(""), "Model reset to default")}>Reset</button>
          </div>
        </div>

        <div className="card">
          <h2>⚙ Platform controls</h2>
          <div className="row">
            <button className="danger" disabled={busy} onClick={() => guard(() => api.adminCacheClear(), "Cache cleared")}>
              🧹 Clear cache
            </button>
            <button className="ghost" onClick={load}>🔄 Refresh overview</button>
            <button className="ghost" onClick={async () => {
              try {
                const a = await api.adminAudit();
                setAudit(a.entries);
                setShowAudit(true);
              } catch (e) { toast(String(e), "err"); }
            }}>📜 Audit trail</button>
            <button className="ghost" onClick={async () => {
              try {
                const b = await api.adminBackup();
                downloadFile(`silvestar-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(b, null, 2));
                toast("Backup downloaded ✓", "ok");
              } catch (e) { toast(String(e), "err"); }
            }}>⬇ Backup</button>
          </div>
          <div className="kv" style={{ marginTop: 12 }}>
            <span className="k">vault cipher</span><span>{ov?.vault.cipher}</span>
            <span className="k">kdf</span><span>{ov?.vault.kdf}</span>
            <span className="k">sessions</span><span>{String(ov?.vault.sessions_active)}</span>
            <span className="k">requests</span><span>{metrics?.requests_total ?? "—"}</span>
            <span className="k">ai asks</span><span>{metrics?.ai_asks_total ?? "—"}</span>
            <span className="k">searches</span><span>{metrics?.searches_total ?? "—"}</span>
          </div>
          {showAudit && (
            <div style={{ marginTop: 10 }}>
              <div className="hint">Audit trail (latest {audit.length})</div>
              {audit.map((a, i) => (
                <div key={i} className="hit">
                  <div className="t">{a.action}</div>
                  <div className="s">{a.detail}</div>
                </div>
              ))}
              {audit.length === 0 && <div className="hint">No admin actions logged yet.</div>}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h2>📄 Publish to Archive (admin)</h2>
        <div className="row">
          <input placeholder="document title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <textarea placeholder="content…" value={content} onChange={(e) => setContent(e.target.value)} />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            disabled={busy || !title || !content}
            onClick={() =>
              guard(async () => {
                await api.adminAddDoc(title, content);
                setTitle(""); setContent("");
              }, "Document published")
            }
          >
            ⬆ Publish
          </button>
        </div>
      </div>
    </div>
  );
}
