"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { LockScene } from "./LockScene";

type Mode = "pin" | "unlock" | "create";

export function LockScreen({
  userId,
  pinMode = false,
  onUnlock,
  onSignOut,
}: {
  userId: string;
  /** pin mode: a 4+ digit code (verified server-side) unlocks without the vault password */
  pinMode?: boolean;
  onUnlock: (token: string) => void;
  onSignOut?: () => void;
}) {
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [mode, setMode] = useState<Mode>(pinMode ? "pin" : "unlock");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);

  const fail = (m: string) => {
    setError(m);
    setShake(true);
    setTimeout(() => setShake(false), 500);
  };

  const submitPin = async () => {
    if (busy || pin.length < 4) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`${(process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "")}/api/v1/auth/unlock?pin=${encodeURIComponent(pin)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("sv-session") || ""}` },
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.detail || "Wrong PIN");
      onUnlock("");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); setPin(""); }
  };

  const submit = async () => {
    if (busy || password.length < 8) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "create") {
        await api.vaultCreate(userId, password);
        const r = await api.vaultUnlock(userId, password);
        onUnlock(r.session_token);
        return;
      }
      const r = await api.vaultUnlock(userId, password);
      onUnlock(r.session_token);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(m.includes("no vault") ? "No vault yet — switch to Create." : m);
      setShake(true);
      setTimeout(() => setShake(false), 500);
    } finally {
      setBusy(false);
      setPassword("");
    }
  };

  return (
    <div className="lockwrap">
      <LockScene />
      <div className={`lockcard ${shake ? "shake" : ""}`}>
        <div className="lockbrand">
          <div className="locklogo">⭐</div>
          <h1>Silvestar</h1>
          <p>{mode === "pin" ? "Enter your PIN to unlock." : "The platform is locked. Your vault password unlocks everything."}</p>
        </div>

        {mode === "pin" ? (
          <>
            <input
              className="lockinput"
              type="password"
              inputMode="numeric"
              placeholder="PIN (min 4 digits)"
              value={pin}
              autoFocus
              maxLength={12}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && submitPin()}
            />
            <button className="lockbtn" onClick={submitPin} disabled={busy || pin.length < 4}>
              {busy ? "Checking…" : "Unlock"}
            </button>
          </>
        ) : (
          <>
            <input
              className="lockinput"
              type="password"
              placeholder="Vault password (min 8 chars)"
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <button className="lockbtn" onClick={submit} disabled={busy || password.length < 8}>
              {busy ? "Unlocking…" : mode === "create" ? "Create & Unlock" : "Unlock"}
            </button>
          </>
        )}

        {error && <div className="lockerror">{error}</div>}

        <div className="lockrow">
          {mode !== "pin" ? (
            <>
              <button
                className="linkish"
                onClick={() => {
                  setMode(mode === "unlock" ? "create" : "unlock");
                  setError("");
                }}
              >
                {mode === "unlock" ? "No vault yet? Create one →" : "← Have a vault? Unlock"}
              </button>
              {onSignOut && (
                <button className="linkish dim" onClick={onSignOut}>
                  Sign out
                </button>
              )}
            </>
          ) : (
            <button className="linkish" onClick={() => { setMode("unlock"); setError(""); }}>
              Use vault password instead
            </button>
          )}
        </div>

        <div className="lockhint">
          {mode === "pin" ? "PIN unlock · set it in Settings → Security" : "AES-256-GCM · PBKDF2-SHA256 · vault doubles as your login"}
        </div>
      </div>
    </div>
  );
}
