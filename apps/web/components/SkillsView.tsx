"use client";

/** Skills — unlimited AI plugins. Add any skill (name + instructions); the AI
 *  auto-applies relevant skills to every question. Gallery = built-in skills
 *  harvested daily from top GitHub repos (free, automatic). */
import { useCallback, useEffect, useState } from "react";
import { toast } from "@/lib/kit";
import { useI18n } from "@/lib/i18n";

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type Skill = {
  id: string; name: string; instructions: string;
  triggers?: string[]; builtin?: boolean; owner?: string;
};

export function SkillsView({ authToken, userId }: { authToken: string; userId: string }) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installInfo, setInstallInfo] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/v1/skills`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      const j = await r.json();
      setSkills(j.skills || []);
    } catch {
      toast("Failed to load skills", "err");
    }
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!name.trim() || !instructions.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ name: name.trim(), instructions: instructions.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      toast(`Skill "${j.name}" added — the AI will use it automatically ✓`, "ok");
      setName(""); setInstructions("");
      await load();
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setBusy(false); }
  };

  const remove = async (s: Skill) => {
    if (!confirm(`Delete skill "${s.name}"?`)) return;
    try {
      const r = await fetch(`${API}/api/v1/skills/${encodeURIComponent(s.id)}`, {
        method: "DELETE", headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (!r.ok) throw new Error(`${r.status}`);
      toast("Skill deleted", "ok");
      await load();
    } catch { toast("Delete failed", "err"); }
  };

  const autoInstall = async () => {
    if (installing) return;
    setInstalling(true); setInstallInfo("");
    try {
      const r = await fetch(`${API}/api/v1/skills/auto-install`, {
        method: "POST", headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      setInstallInfo(`+${j.added} skills installed from GitHub (scanned ${j.scanned})`);
      toast("GitHub skills installed ✓", "ok");
      await load();
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setInstalling(false); }
  };

  const mine = skills.filter((s) => !s.builtin);
  const gallery = skills.filter((s) => s.builtin);
  const q = query.toLowerCase();
  const filt = (arr: Skill[]) => (q ? arr.filter((s) => (s.name + " " + s.instructions).toLowerCase().includes(q)) : arr);

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h2>🧩 {t("skills")}</h2>
          <p className="muted">{t("skillsHint")}</p>
        </div>
        <div className="row gap">
          <input className="input" placeholder={t("searchFiles")} value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 150 }} />
          <button className="btn ghost" disabled={installing} onClick={autoInstall} title="Install a fresh batch of free AI skills from top GitHub repos">
            {installing ? "⏳" : "🐙"} {t("installFromGithub")}
          </button>
        </div>
      </div>
      {installInfo && <div className="hint">{installInfo}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <b>➕ {t("addSkill")}</b>
        <div className="row" style={{ marginTop: 8 }}>
          <input value={name} placeholder={t("skillName")} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 220 }} />
        </div>
        <textarea value={instructions} placeholder={t("skillInstructions")}
          onChange={(e) => setInstructions(e.target.value)}
          style={{ width: "100%", minHeight: 90, marginTop: 8, background: "transparent", color: "inherit", border: "1px solid var(--border, #444)", borderRadius: 8, padding: 8 }} />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={busy || !name.trim() || !instructions.trim()} onClick={add}>
            {busy ? "…" : t("addSkill")}
          </button>
          <span className="muted small">{t("skillsAutoHint")}</span>
        </div>
      </div>

      <h3>🧠 {t("mySkills")} ({mine.length})</h3>
      {filt(mine).length === 0 ? (
        <div className="muted small" style={{ marginBottom: 10 }}>—</div>
      ) : (
        filt(mine).map((s) => (
          <div key={s.id} className="card" style={{ marginBottom: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>{s.name}</b>
              <button className="btn tiny danger" onClick={() => remove(s)}>🗑</button>
            </div>
            <div className="muted small" style={{ whiteSpace: "pre-wrap" }}>{s.instructions}</div>
          </div>
        ))
      )}

      <h3>🌟 {t("builtinSkills")} ({gallery.length})</h3>
      <div className="muted small" style={{ marginBottom: 8 }}>{t("galleryHint")}</div>
      {filt(gallery).slice(0, 60).map((s) => (
        <div key={s.id} className="card" style={{ marginBottom: 8 }}>
          <b>{s.name}</b>
          <div className="muted small" style={{ whiteSpace: "pre-wrap" }}>{s.instructions.slice(0, 240)}{s.instructions.length > 240 ? "…" : ""}</div>
        </div>
      ))}
      {gallery.length > 60 && <div className="muted small">+ {gallery.length - 60} more…</div>}
    </div>
  );
}
