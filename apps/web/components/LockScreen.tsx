"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { LockScene } from "./LockScene";

export function LockScreen({
  userId,
  onUnlock,
}: {
  userId: string;
  onUnlock: (token: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"unlock" | "create">("unlock");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);

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
          <p>The platform is locked. Your vault password unlocks everything.</p>
        </div>

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

        {error && <div className="lockerror">{error}</div>}

        <div className="lockrow">
          <button
            className="linkish"
            onClick={() => {
              setMode(mode === "unlock" ? "create" : "unlock");
              setError("");
            }}
          >
            {mode === "unlock" ? "No vault yet? Create one →" : "← Have a vault? Unlock"}
          </button>
          <button className="linkish dim" onClick={() => onUnlock("")}>
            Continue as guest
          </button>
        </div>

        <div className="lockhint">
          AES-256-GCM · PBKDF2-SHA256 · vault doubles as your login
        </div>
      </div>
    </div>
  );
}
