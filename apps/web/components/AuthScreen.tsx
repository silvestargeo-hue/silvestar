"use client";

/** AuthScreen — Sign in / Create account / Forgot password (OTP) on the scenic
 *  glass design. Uses real <form> + autoComplete attributes so browsers offer
 *  to save credentials. */
import { useState } from "react";
import { api, type AuthUser } from "@/lib/api";
import { LockScene } from "./LockScene";
import { passwordStrength } from "@/lib/kit";

type Mode = "signin" | "signup" | "forgot" | "otp";

export function AuthScreen({ onAuthed }: {
  onAuthed: (sessionToken: string, user: AuthUser) => void;
}) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const strength = passwordStrength(password);

  const swap = (m: Mode) => { setMode(m); setError(""); setNotice(""); };

  const submitSignin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await api.authLogin(email.trim(), password);
      onAuthed(r.session_token, r.user);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err).replace(/^\d+:\s*/, ""));
    } finally { setBusy(false); }
  };

  const submitSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await api.authRegister(email.trim(), password, name);
      onAuthed(r.session_token, r.user);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err).replace(/^\d+:\s*/, ""));
    } finally { setBusy(false); }
  };

  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await api.authForgot(email.trim());
      if (r.dev_code) {
        setNotice(`Dev mode: your reset code is ${r.dev_code}`);
        setMode("otp");
      } else {
        setNotice("If that email is registered, a 6-digit code is on its way (check spam too).");
        setMode("otp");
      }
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err).replace(/^\d+:\s*/, ""));
    } finally { setBusy(false); }
  };

  const submitOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await api.authReset(email.trim(), code.trim(), password);
      const r = await api.authLogin(email.trim(), password);
      onAuthed(r.session_token, r.user);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err).replace(/^\d+:\s*/, ""));
    } finally { setBusy(false); }
  };

  return (
    <div className="lockwrap">
      <LockScene />
      <div className="lockcard">
        <div className="lockbrand">
          <div className="locklogo">⭐</div>
          <h1>Silvestar</h1>
          {mode === "signin" && <p>Sign in to your profile.</p>}
          {mode === "signup" && <p>Create your unique profile{""} — the first account becomes the admin.</p>}
          {mode === "forgot" && <p>Enter your account email — we'll send a 6-digit reset code.</p>}
          {mode === "otp" && <p>Enter the 6-digit code and your new password.</p>}
        </div>

        {mode === "signin" && (
          <form onSubmit={submitSignin}>
            <input className="lockinput" type="email" name="email" autoComplete="email"
              placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input className="lockinput" type="password" name="password" autoComplete="current-password"
              placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button className="lockbtn" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
        )}

        {mode === "signup" && (
          <form onSubmit={submitSignup}>
            <input className="lockinput" type="text" name="name" autoComplete="name"
              placeholder="Display name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="lockinput" type="email" name="email" autoComplete="email"
              placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input className="lockinput" type="password" name="new-password" autoComplete="new-password"
              placeholder="Password (min 8 chars)" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {password && (
              <div style={{ textAlign: "left" }}>
                <div className="meter"><div style={{ width: `${(strength.score / 5) * 100}%`, background: strength.color }} /></div>
                <div className="lockhint" style={{ borderTop: "none", marginTop: 0 }}>strength: {strength.label}</div>
              </div>
            )}
            <button className="lockbtn" type="submit" disabled={busy || password.length < 8}>
              {busy ? "Creating…" : "Create account"}
            </button>
          </form>
        )}

        {mode === "forgot" && (
          <form onSubmit={submitForgot}>
            <input className="lockinput" type="email" name="email" autoComplete="email"
              placeholder="Account email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <button className="lockbtn" type="submit" disabled={busy}>{busy ? "Sending…" : "Send reset code"}</button>
          </form>
        )}

        {mode === "otp" && (
          <form onSubmit={submitOtp}>
            <input className="lockinput" type="text" inputMode="numeric" maxLength={6}
              placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
            <input className="lockinput" type="password" name="new-password" autoComplete="new-password"
              placeholder="New password (min 8 chars)" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button className="lockbtn" type="submit" disabled={busy || password.length < 8}>
              {busy ? "Resetting…" : "Reset & sign in"}
            </button>
          </form>
        )}

        {error && <div className="lockerror">{error}</div>}
        {notice && <div className="locknotice">{notice}</div>}

        <div className="lockrow">
          {mode === "signin" && (
            <>
              <button className="linkish" onClick={() => swap("signup")}>Create account →</button>
              <button className="linkish" onClick={() => swap("forgot")}>Forgot password?</button>
            </>
          )}
          {(mode === "signup" || mode === "forgot" || mode === "otp") && (
            <button className="linkish" onClick={() => swap("signin")}>← Back to sign in</button>
          )}
          {(mode === "signup" || mode === "forgot") && (
            <button className="linkish dim" onClick={() => swap("otp")}>Have a code already?</button>
          )}
        </div>

        <div className="lockhint">AES-256-GCM vault · PBKDF2 sessions · OTP recovery</div>
      </div>
    </div>
  );
}
