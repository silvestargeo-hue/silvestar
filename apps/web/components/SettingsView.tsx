"use client";

/** Settings — appearance (theme + accent), profile, security & lock screen,
 *  live system status, and about. All changes apply instantly and persist. */
import { useEffect, useState } from "react";
import { api, type AuthUser } from "@/lib/api";
import { toast, Modal, useOnline, useTheme } from "@/lib/kit";
import { LANGS, useI18n, setLang, type Lang } from "@/lib/i18n";

const ACCENTS: { name: string; color: string }[] = [
  { name: "Violet", color: "#7c5cff" },
  { name: "Cyan", color: "#00d4ff" },
  { name: "Emerald", color: "#3ddc97" },
  { name: "Rose", color: "#ff5c8a" },
  { name: "Amber", color: "#ffb020" },
  { name: "Azure", color: "#4f8cff" },
];

type Health = {
  status: string; version: string; uptime_s: number;
  db: { mode: string; ok: boolean };
  cache: { mode: string; ok: boolean };
  graph: { mode: string; ok: boolean };
  ai: { assistant: string; primary_reachable: boolean };
};

function useAccent() {
  const [accent, setAccent] = useState("");
  useEffect(() => {
    const saved = localStorage.getItem("sv-accent") || ACCENTS[0].color;
    setAccent(saved);
  }, []);
  const apply = (c: string) => {
    setAccent(c);
    localStorage.setItem("sv-accent", c);
    document.documentElement.style.setProperty("--accent", c);
  };
  return { accent, apply };
}

export function SettingsView({ user, authToken, onUserUpdate, lockOn, onToggleLock, onLockNow }: {
  user: AuthUser; authToken: string; onUserUpdate: (u: AuthUser, newToken?: string) => void;
  lockOn: boolean; onToggleLock: (on: boolean) => void; onLockNow: () => void;
}) {
  const { theme, toggle: toggleTheme } = useTheme();
  const { accent, apply: applyAccent } = useAccent();
  const { t, lang } = useI18n();
  const online = useOnline();
  const [health, setHealth] = useState<Health | null>(null);
  const [dialog, setDialog] = useState<null | { kind: "name" } | { kind: "pass" }>(null);
  const [dv1, setDv1] = useState("");
  const [dv2, setDv2] = useState("");
  const [dErr, setDErr] = useState("");

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  const submitRename = async () => {
    if (!dv1.trim()) { setDErr("Name can't be empty"); return; }
    try {
      const r = await api.authProfile(authToken, dv1.trim());
      onUserUpdate(r.user);
      toast("Profile updated ✓", "ok");
      setDialog(null);
    } catch (e) {
      setDErr(String(e instanceof Error ? e.message : e).replace(/^\d+:\s*/, ""));
    }
  };

  const submitPass = async () => {
    if (dv2.length < 8) { setDErr("New password must be at least 8 characters"); return; }
    try {
      const r = await api.authPassword(authToken, dv1, dv2);
      // token rotates on password change — swap in the fresh session
      onUserUpdate(r.user, r.session_token);
      toast("Password changed — other sessions signed out", "ok");
      setDialog(null);
    } catch (e) {
      setDErr(String(e instanceof Error ? e.message : e).replace(/^\d+:\s*/, ""));
    }
  };

  const upSec = health ? Math.floor(health.uptime_s / 60) : 0;

  return (
    <div className="settings">
      {/* ------------------------------------------------------ appearance */}
      <div className="card">
        <h2>🎨 {t("appearance")}</h2>
        <div className="set-row">
          <div>
            <div className="set-t">{t("theme")}</div>
            <div className="set-d">Dark for night owls, light for daylight.</div>
          </div>
          <button className="btn ghost" onClick={toggleTheme}>
            {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
          </button>
        </div>
        <div className="set-row">
          <div>
            <div className="set-t">{t("langLabel")}</div>
            <div className="set-d">English · हिन्दी · नेपाली</div>
          </div>
          <select className="input" value={lang} onChange={(e) => setLang(e.target.value as Lang)} style={{ width: 140 }}>
            {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
        <div className="set-row">
          <div>
            <div className="set-t">Accent color</div>
            <div className="set-d">Used for buttons, links and highlights.</div>
          </div>
          <div className="accent-row">
            {ACCENTS.map((a) => (
              <button
                key={a.color}
                className={`accent-swatch ${accent === a.color ? "sel" : ""}`}
                style={{ background: a.color }}
                onClick={() => applyAccent(a.color)}
                aria-label={`Accent ${a.name}`}
                title={a.name}
              />
            ))}
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- profile */}
      <div className="card">
        <h2>👤 Profile</h2>
        <div className="set-row">
          <div>
            <div className="set-t">Display name</div>
            <div className="set-d">{user.display_name || "Not set"}</div>
          </div>
          <button className="btn ghost" onClick={() => { setDv1(user.display_name || ""); setDv2(""); setDErr(""); setDialog({ kind: "name" }); }}>Edit</button>
        </div>
        <div className="set-row">
          <div>
            <div className="set-t">Email</div>
            <div className="set-d">{user.email} {user.verified ? "· ✅ verified" : "· ⚠ unverified"}</div>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="set-t">Password</div>
            <div className="set-d">Changing it signs out all other devices.</div>
          </div>
          <button className="btn ghost" onClick={() => { setDv1(""); setDv2(""); setDErr(""); setDialog({ kind: "pass" }); }}>Change</button>
        </div>
      </div>

      {/* -------------------------------------------------------- security */}
      <div className="card">
        <h2>🔐 Security & Lock</h2>
        <div className="set-row">
          <div>
            <div className="set-t">Lock screen on start</div>
            <div className="set-d">Require your vault password before the app opens.</div>
          </div>
          <button
            className={`btn ${lockOn ? "primary" : "ghost"}`}
            onClick={() => { onToggleLock(!lockOn); toast(lockOn ? "Lock screen disabled" : "Lock screen enabled — locks on next reload", lockOn ? "" : "ok"); }}
          >
            {lockOn ? "✅ Enabled" : "Disabled"}
          </button>
        </div>
        <div className="set-row">
          <div>
            <div className="set-t">Lock now</div>
            <div className="set-d">Immediately lock this device.</div>
          </div>
          <button className="btn ghost" onClick={onLockNow}>🔒 Lock</button>
        </div>
        <div className="set-row">
          <div>
            <div className="set-t">Vault</div>
            <div className="set-d">Documents are encrypted with AES-256-GCM. Manage them in the Vault tab.</div>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------- system */}
      <div className="card">
        <h2>🖥 System</h2>
        <div className="set-row">
          <div><div className="set-t">Connection</div><div className="set-d">{online ? "Online" : "Offline — showing cached content"}</div></div>
          <span className={`badge ${online ? "ok" : ""}`}>{online ? "● live" : "○ offline"}</span>
        </div>
        <div className="set-row">
          <div><div className="set-t">API status</div><div className="set-d">{health ? `${health.status} · v${health.version} · up ${upSec} min` : "checking…"}</div></div>
          <span className={`badge ${health?.status === "ok" ? "ok" : ""}`}>{health?.status ?? "…"}</span>
        </div>
        <div className="set-row">
          <div><div className="set-t">Database</div><div className="set-d">{health?.db.mode ?? "—"}</div></div>
          <span className={`badge ${health?.db.ok ? "ok" : ""}`}>{health?.db.ok ? "ok" : "—"}</span>
        </div>
        <div className="set-row">
          <div><div className="set-t">AI assistant</div><div className="set-d">{health?.ai.assistant ?? "Silvestar"}</div></div>
          <span className={`badge ${health?.ai.primary_reachable ? "ok" : ""}`}>{health?.ai.primary_reachable ? "online" : "…"}</span>
        </div>
      </div>

      {/* ----------------------------------------------------------- about */}
      <div className="card">
        <h2>⭐ About</h2>
        <div className="set-row">
          <div>
            <div className="set-t">Silvestar Platform</div>
            <div className="set-d">v1.1 — AI answers, file Library, encrypted Vault, Archive, Rooms and Graph. Files are stored free on GitHub; AI runs on free providers. No credit card, ever.</div>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="set-t">Shortcuts</div>
            <div className="set-d"><b>Ctrl+K</b> command palette · <b>?</b> all shortcuts</div>
          </div>
        </div>
      </div>

      {dialog?.kind === "name" && (
        <Modal title="👤 Edit profile" onClose={() => setDialog(null)}>
          <input value={dv1} onChange={(e) => setDv1(e.target.value)} placeholder="Display name"
            maxLength={60} style={{ width: "100%" }} aria-label="Display name" />
          {dErr && <div className="notice err" style={{ marginTop: 8 }}>{dErr}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <button className="ghost" onClick={() => setDialog(null)}>Cancel</button>
            <button className="btn primary" onClick={submitRename}>Save</button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "pass" && (
        <Modal title="🔑 Change password" onClose={() => setDialog(null)}>
          <input type="password" value={dv1} onChange={(e) => setDv1(e.target.value)}
            placeholder="Current password" autoComplete="current-password" style={{ width: "100%", marginBottom: 10 }} aria-label="Current password" />
          <input type="password" value={dv2} onChange={(e) => setDv2(e.target.value)}
            placeholder="New password (min 8 chars)" autoComplete="new-password" style={{ width: "100%" }} aria-label="New password" />
          {dErr && <div className="notice err" style={{ marginTop: 8 }}>{dErr}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <button className="ghost" onClick={() => setDialog(null)}>Cancel</button>
            <button className="btn primary" onClick={submitPass}>Update password</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
