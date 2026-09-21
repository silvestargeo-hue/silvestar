"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { passwordStrength, downloadFile, toast } from "@/lib/kit";

export function VaultView({
  userId,
  sessionToken,
  onUnlock,
}: {
  userId: string;
  sessionToken: string;
  onUnlock: (token: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [docs, setDocs] = useState<{ id: string; title: string }[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);

  const unlocked = Boolean(sessionToken);
  const strength = passwordStrength(password);

  // session countdown (30-minute TTL)
  useEffect(() => {
    if (!unlocked) { setExpiresAt(null); return; }
    setExpiresAt(Date.now() / 1000 + 30 * 60);
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [unlocked]);

  const remaining = expiresAt ? Math.max(0, Math.floor(expiresAt - now)) : null;
  const mmss = remaining !== null ? `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}` : "";

  const refresh = async (token: string) => {
    try {
      const r = await api.vaultList(userId, token);
      setDocs(r.documents);
    } catch {
      onUnlock("");
      setDocs([]);
    }
  };

  useEffect(() => {
    if (sessionToken) refresh(sessionToken);
    else setDocs([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  const create = async () => {
    setBusy(true);
    setMsg("");
    try {
      await api.vaultCreate(userId, password);
      setMsg("Vault created — now unlock it.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPassword("");
    }
  };

  const unlock = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.vaultUnlock(userId, password);
      onUnlock(r.session_token);
      setMsg("Vault unlocked ✓");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPassword("");
    }
  };

  const lock = async () => {
    if (sessionToken) await api.vaultLock(userId, sessionToken);
    onUnlock("");
    setMsg("Vault locked.");
  };

  const add = async () => {
    if (!title.trim() || !content.trim()) return;
    const r = await api.vaultAdd(userId, sessionToken, title.trim(), content.trim());
    toast(`Sealed ✓ fingerprint ${r.fingerprint.slice(0, 12)}…`, "ok");
    setTitle("");
    setContent("");
    await refresh(sessionToken);
  };

  const remove = async (id: string) => {
    await api.vaultDelete(id, userId, sessionToken);
    toast("Shredded", "ok");
    await refresh(sessionToken);
  };

  const backupTitles = () => {
    downloadFile(`vault-manifest-${userId}.json`, JSON.stringify({ user_id: userId, exported: new Date().toISOString(), documents: docs }, null, 2));
    toast("Manifest exported (titles only — never plaintext)", "ok");
  };

  return (
    <div className="grid2">
      <div className="card">
        <h2>🔒 Personal Vault {unlocked ? "— UNLOCKED" : "— LOCKED"}</h2>
        <div className="hint">
          AES-256-GCM encryption, PBKDF2-derived per-user key.
          Content is sealed at rest — the API never returns plaintext listings.
        </div>

        {unlocked && remaining !== null && (
          <div className={`badge ${remaining < 300 ? "err" : "ok"}`} style={{ marginBottom: 10, display: "inline-block" }}>
            ⏳ session expires in {mmss}
          </div>
        )}

        {!unlocked ? (
          <>
            <div className="row" style={{ marginBottom: 4 }}>
              <input
                type="password"
                value={password}
                placeholder="Vault password (min 8 chars)"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && unlock()}
              />
            </div>
            {password && (
              <div>
                <div className="meter"><div style={{ width: `${(strength.score / 5) * 100}%`, background: strength.color }} /></div>
                <div className="hint">strength: {strength.label}</div>
              </div>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={create} disabled={busy || password.length < 8}>Create vault</button>
              <button className="ghost" onClick={unlock} disabled={busy || password.length < 8}>Unlock</button>
            </div>
          </>
        ) : (
          <div className="row">
            <button className="danger" onClick={lock}>Lock vault</button>
            <button className="ghost" onClick={backupTitles}>⬇ Export manifest</button>
          </div>
        )}
        {msg && <div className="hint">{msg}</div>}
      </div>

      <div>
        <div className="card" style={{ opacity: unlocked ? 1 : 0.5, pointerEvents: unlocked ? "auto" : "none" }}>
          <h2>Seal a private document</h2>
          <div className="row" style={{ marginBottom: 8 }}>
            <input value={title} placeholder="Title" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <textarea value={content} placeholder="Secret content…" onChange={(e) => setContent(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={add}>Seal it</button>
          </div>
        </div>

        <div className="card" style={{ opacity: unlocked ? 1 : 0.5 }}>
          <h2>Sealed documents ({docs.length})</h2>
          {docs.map((d) => (
            <div key={d.id} className="hit">
              <div className="t">
                🔒 {d.title}
                <button
                  className="danger"
                  style={{ marginLeft: "auto", padding: "2px 8px", fontSize: 12 }}
                  onClick={() => remove(d.id)}
                >
                  shred
                </button>
              </div>
            </div>
          ))}
          {unlocked && docs.length === 0 && <div className="hint">Nothing sealed yet.</div>}
          {!unlocked && <div className="hint">Unlock to view titles.</div>}
        </div>
      </div>
    </div>
  );
}
