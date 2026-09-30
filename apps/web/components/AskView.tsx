"use client";

import { useEffect, useState } from "react";
import { api, type AskResult } from "@/lib/api";
import { speak, useSpeechInput, useTypewriter, copyText, toast } from "@/lib/kit";
import { useI18n } from "@/lib/i18n";

const AI_LANGS = [
  { id: "", label: "🌐 Auto" },
  { id: "en", label: "English" },
  { id: "hi", label: "हिन्दी" },
  { id: "ne", label: "नेपाली" },
];

export function AskView({ userId, sessionToken, authToken }: { userId: string; sessionToken: string; authToken?: string }) {
  const { t } = useI18n();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [history, setHistory] = useState<{ role: string; content: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tts, setTts] = useState(false);
  const [lang, setLang] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [scope, setScope] = useState("");   // "" = all sources, else folder name
  const { listening, start, supported: sttSupported } = useSpeechInput((t) => {
    setQuestion(t);
  });

  // folder list for per-folder RAG scoping (same endpoint the Library uses)
  useEffect(() => {
    const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
    const h: Record<string, string> = {};
    if (authToken) h["Authorization"] = `Bearer ${authToken}`;
    if (userId) h["x-silvestar-user"] = userId;
    fetch(`${API}/api/v1/files`, { headers: h })
      .then((r) => (r.ok ? r.json() : { folders: [] }))
      .then((d) => setFolders(d.folders || []))
      .catch(() => setFolders([]));
  }, [authToken, userId]);

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.ask(q, userId, sessionToken, history, { lang: lang || undefined, folder: scope || undefined });
      setResult(r);
      setHistory((h) => [...h.slice(-6), { role: "user", content: q }, { role: "assistant", content: r.answer }]);
      setQuestion("");
      if (tts) speak(r.answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const displayed = useTypewriter(result?.answer ?? "", 12);

  return (
    <div>
      <div className="card">
        <h2>🤖 {t("ask")}</h2>
        <div className="hint">
          Cross-library RAG: searches the public Archive AND your Personal Vault (vault answers only when
          unlocked). Citations [n] map to the sources below.
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="hint" style={{ margin: 0 }}>{t("answerLang")}</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label={t("answerLang")}>
              {AI_LANGS.map((l) => (
                <option key={l.id} value={l.id}>{l.id === "" ? t("answerLangAuto") : l.label}</option>
              ))}
            </select>
          </label>
          {folders.length > 0 && (
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="hint" style={{ margin: 0 }}>{t("chatScope")}</span>
              <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label={t("chatScope")}>
                <option value="">📁 {t("scopeAll")}</option>
                {folders.map((f) => (
                  <option key={f} value={f}>📁 {f}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="row">
          <input
            value={question}
            placeholder={listening ? "Listening…" : t("askPlaceholder")}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
          />
          {sttSupported && (
            <button className="ghost" onClick={start} title="Voice input" disabled={busy}>
              {listening ? <span className="spin">🎙</span> : "🎙"}
            </button>
          )}
          <button onClick={ask} disabled={busy}>{busy ? t("thinking") : t("askBtn")}</button>
        </div>
        {error && <div className="hint" style={{ color: "var(--err)" }}>{error}</div>}
      </div>

      {result && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span className="tag">engine: {result.engine}</span>{" "}
              <span className="tag">{result.latency_ms} ms</span>{" "}
              {result.vault_unlocked ? <span className="tag vault">vault included</span> : null}
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              <button className="mini" onClick={() => { copyText(result.answer); toast("Answer copied", "ok"); }}>
                📋 Copy
              </button>
              <button className="mini" onClick={() => { setTts(!tts); speak(result.answer, !tts); }}>
                {tts ? "🔇 Mute" : "🔊 Speak"}
              </button>
            </span>
          </div>
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{displayed}</p>
          {result.citations.length > 0 && (
            <>
              <div className="hint">Sources</div>
              {result.citations.map((c) => (
                <span key={c.i} className="cite">
                  [{c.i}] {c.library === "vault" ? "🔒" : c.library === "files" ? "📁" : "📚"} {c.title} · {c.score}
                </span>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
