"use client";

/** Settings — appearance (theme + accent), profile, security & lock screen,
 *  live system status, and about. All changes apply instantly and persist. */
import { useEffect, useState } from "react";
import { api, type AuthUser } from "@/lib/api";
import { toast, Modal, useOnline, useTheme } from "@/lib/kit";
import { LANGS, useI18n, setLang, type Lang } from "@/lib/i18n";
import { GraphBrain } from "./GraphBrain";
import { HooksPanel } from "./HooksPanel";

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

const ACCENTS: { name: string; color: string }[] = [
  { name: "Violet", color: "#7c5cff" },
  { name: "Cyan", color: "#00d4ff" },
  { name: "Emerald", color: "#3ddc97" },
  { name: "Rose", color: "#ff5c8a" },
  { name: "Amber", color: "#ffb020" },
  { name: "Azure", color: "#4f8cff" },
  { name: "Magenta", color: "#e33bff" },
  { name: "Lime", color: "#a3e635" },
  { name: "Coral", color: "#ff7f50" },
  { name: "Gold", color: "#d4af37" },
  { name: "Teal", color: "#14b8a6" },
  { name: "Crimson", color: "#dc2626" },
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

function PinCard({ authToken, onLockNow }: { authToken: string; onLockNow: () => void }) {
  const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
  const [pin, setPin] = useState("");
  const [timeout_, setTimeout_] = useState(10);
  const [hasPin, setHasPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);

  const load = async () => {
    try {
      const r = await fetch(`${API}/api/v1/me/autolock`, { headers: { Authorization: `Bearer ${authToken}` } });
      if (r.ok) {
        const j = await r.json();
        setHasPin(!!j.has_pin); setEnabled(!!j.enabled); setTimeout_(j.timeout_minutes || 10);
      }
    } catch {}
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [authToken]);

  const save = async (on: boolean) => {
    if (on && !hasPin && pin.trim().length < 4) { toast("Enter a PIN of 4+ digits first", "err"); return; }
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/me/autolock`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ enabled: on, pin: pin.trim(), timeout_minutes: timeout_ }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      setEnabled(on); if (pin.trim()) setHasPin(true); setPin("");
      toast(on ? "Auto-lock armed 🔒" : "Auto-lock off", "ok");
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <b>🔢 PIN auto-lock</b>
      <div className="hint">Locks the app after {timeout_} min idle (or on start). Unlock with a quick PIN instead of your vault password.</div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        <input value={pin} type="password" inputMode="numeric" maxLength={12}
          placeholder={hasPin ? "PIN set — type to change" : "New PIN (4+ digits)"}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: 180 }} />
        <select value={timeout_} onChange={(e) => setTimeout_(Number(e.target.value))} aria-label="Idle timeout">
          <option value={1}>after 1 min</option>
          <option value={5}>after 5 min</option>
          <option value={10}>after 10 min</option>
          <option value={30}>after 30 min</option>
        </select>
        {enabled
          ? <button className="btn ghost" disabled={busy} onClick={() => save(false)}>Disable</button>
          : <button className="btn primary" disabled={busy} onClick={() => save(true)}>Arm auto-lock</button>}
        <button className="btn ghost" onClick={onLockNow}>🔒 Lock now</button>
      </div>
    </div>
  );
}

function TwoFACard({ authToken, email }: { authToken: string; email: string }) {
  const [status, setStatus] = useState<{ enabled: boolean; pending: boolean } | null>(null);
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch(`${API}/api/v1/auth/2fa/status?session_token=${encodeURIComponent(authToken)}`)
      .then((r) => r.json())
      .then(setStatus).catch(() => {});
  };
  useEffect(load, [authToken]);

  const post = async (path: string, code2: string) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/auth/2fa/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_token: authToken, code: code2 }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || "failed");
      return j;
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e).replace(/^\d+:\s*/, ""), "err");
      return null;
    } finally { setBusy(false); }
  };

  const start = async () => {
    const j = await post("setup", "");
    if (j) { setSecret(j.secret); setUri(j.otpauth_uri); }
  };

  const confirm = async () => {
    const j = await post("confirm", code.trim());
    if (j) { toast("2FA enabled ✓", "ok"); setSecret(""); setUri(""); setCode(""); load(); }
  };

  const disable = async () => {
    const j = await post("disable", code.trim());
    if (j) { toast("2FA disabled", "ok"); setCode(""); load(); }
  };

  if (!status) return null;
  return (
    <div className="set-row">
      <div>
        <div className="set-t">Two-factor app codes (TOTP)</div>
        <div className="set-d">
          {status.enabled ? "Enabled — login asks for a 6-digit code from your authenticator." :
           status.pending ? "Setup started — scan the key, then enter a code to confirm." :
           "Add an extra layer: after password, enter a rotating 6-digit code."}
        </div>
        {uri && (
          <div className="notice" style={{ marginTop: 8, wordBreak: "break-all" }}>
            <div><b>Secret key:</b> <code>{secret}</code></div>
            <div style={{ marginTop: 4 }}>
              Add it in Google Authenticator / Authy / Aegis via “enter setup key”, then confirm below.
            </div>
            <input className="input" readOnly value={uri} onFocus={(e) => e.currentTarget.select()} style={{ marginTop: 6 }} />
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {status.enabled ? (
          <>
            <input className="input" placeholder="Current 6-digit code" value={code}
              onChange={(e) => setCode(e.target.value)} style={{ width: 170 }} />
            <button className="btn danger" disabled={busy || code.trim().length !== 6} onClick={disable}>Disable 2FA</button>
          </>
        ) : (
          <>
            {!uri && <button className="btn ghost" disabled={busy} onClick={start}>Enable 2FA</button>}
            {uri && (
              <>
                <input className="input" placeholder="6-digit code" value={code}
                  onChange={(e) => setCode(e.target.value)} style={{ width: 170 }} />
                <button className="btn primary" disabled={busy || code.trim().length !== 6} onClick={confirm}>Confirm & enable</button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
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
            <div className="set-d">English · हिन्दी · नेपाली · Español · العربية · Français</div>
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
        <h2>🔐 Security & 2FA</h2>
        <TwoFACard authToken={authToken} email={user.email} />
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
        <PinCard authToken={authToken} onLockNow={onLockNow} />
        <GraphBrain authToken={authToken} />
        <HooksPanel authToken={authToken} />
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
