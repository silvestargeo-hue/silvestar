"use client";

/** Ask Silvestar — streaming AI chat grounded in the libraries.
 *  Modes: all sources · one Library folder · ONE Library file (chatWithFile).
 *  Answer language lock (en/hi/ne/es/ar/fr) via the Answer-language picker. */
import { useEffect, useRef, useState } from "react";
import { api, type AskResult } from "@/lib/api";
import { speak, useSpeechInput, copyText, toast } from "@/lib/kit";
import { useI18n } from "@/lib/i18n";

const AI_LANGS = [
  { id: "", label: "🌐 Auto" },
  { id: "en", label: "English" },
  { id: "hi", label: "हिन्दी" },
  { id: "ne", label: "नेपाली" },
  { id: "es", label: "Español" },
  { id: "ar", label: "العربية" },
  { id: "fr", label: "Français" },
];

type Cite = { i: number; library: string; title: string; score: number; doc_id: string };

export function AskView({ userId, sessionToken, authToken, chatFile, onClearChatFile }: {
  userId: string;
  sessionToken: string;
  authToken?: string;
  chatFile?: { path: string; name: string } | null;
  onClearChatFile?: () => void;
}) {
  const { t } = useI18n();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [history, setHistory] = useState<{ role: string; content: string }[]>([]);
  const [error, setError] = useState("");
  const [tts, setTts] = useState(false);
  const [lang, setLang] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [scope, setScope] = useState("");   // "" = all sources, else folder name
  const abortRef = useRef<AbortController | null>(null);
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

  const fileScope = chatFile?.path || "";
  const effectiveScope = fileScope ? "" : scope;

  const ask = async () => {
    const q = question.trim();
    if (!q || streaming) return;
    setStreaming(true);
    setError("");
    setAnswer("");
    setResult(null);
    const ac = new AbortController();
    abortRef.current = ac;
    let full = "";
    let final: AskResult | null = null;
    try {
      for await (const ev of api.askStream(
        q, userId, sessionToken, history,
        { lang: lang || undefined, folder: effectiveScope || undefined, file_path: fileScope || undefined },
        ac.signal,
      )) {
        if (ev.type === "meta") {
          final = {
            answer: "", engine: "…", citations: ev.citations || [],
            vault_unlocked: !!ev.vault_unlocked, latency_ms: 0,
          };
          setResult(final);
        } else if (ev.type === "delta") {
          full += ev.text || "";
          setAnswer(full);
        } else if (ev.type === "done") {
          full = ev.answer || full;
          setAnswer(full);
          setResult({
            answer: full, engine: ev.engine || "ai",
            citations: ev.citations || [], vault_unlocked: !!ev.vault_unlocked,
            latency_ms: ev.latency_ms || 0,
          });
        } else if (ev.type === "error") {
          throw new Error(ev.detail || "stream error");
        }
      }
      setHistory((h) => [...h.slice(-6), { role: "user", content: q }, { role: "assistant", content: full }]);
      setQuestion("");
      if (tts && full) speak(full);
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
      abortRef.current = null;
      if (ac.signal.aborted && full) setAnswer(full);
    }
  };

  const stop = () => abortRef.current?.abort();

  const citations: Cite[] = result?.citations || [];

  return (
    <div>
      <div className="card">
        <h2>🤖 {t("ask")}</h2>
        {fileScope ? (
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <span className="tag vault">📄 {chatFile?.name} — {t("chatWithFile")}</span>
            <button className="mini ghost" onClick={() => onClearChatFile?.()}>✕</button>
          </div>
        ) : null}
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
          {!fileScope && folders.length > 0 && (
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
            disabled={streaming}
          />
          {sttSupported && (
            <button className="ghost" onClick={start} title="Voice input" disabled={streaming}>
              {listening ? <span className="spin">🎙</span> : "🎙"}
            </button>
          )}
          {streaming ? (
            <button onClick={stop} className="ghost">⏹ {t("stop")}</button>
          ) : (
            <button onClick={ask}>{t("askBtn")}</button>
          )}
        </div>
        {error && <div className="hint" style={{ color: "var(--err)" }}>{error}</div>}
      </div>

      {(streaming || answer) && (
        <div className="card">
          {result && !streaming && (
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className="tag">engine: {result.engine}</span>{" "}
                <span className="tag">{result.latency_ms} ms</span>{" "}
                {result.vault_unlocked ? <span className="tag vault">vault included</span> : null}
              </span>
              <span style={{ display: "flex", gap: 6 }}>
                <button className="mini" onClick={() => { copyText(answer); toast("Answer copied", "ok"); }}>
                  📋 Copy
                </button>
                <button className="mini" onClick={() => { setTts(!tts); speak(answer, !tts); }}>
                  {tts ? "🔇 Mute" : "🔊 Speak"}
                </button>
              </span>
            </div>
          )}
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, minHeight: 24 }}>
            {answer}{streaming ? <span className="spin">▍</span> : null}
          </p>
          {citations.length > 0 && !streaming && (
            <>
              <div className="hint">Sources</div>
              {citations.map((c) => (
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
