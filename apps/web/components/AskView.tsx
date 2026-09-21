"use client";

import { useState } from "react";
import { api, type AskResult } from "@/lib/api";

export function AskView({ userId, sessionToken }: { userId: string; sessionToken: string }) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [history, setHistory] = useState<{ role: string; content: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.ask(q, userId, sessionToken, history);
      setResult(r);
      setHistory((h) => [...h.slice(-6), { role: "user", content: q }, { role: "assistant", content: r.answer }]);
      setQuestion("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>🤖 Ask Silvestar</h2>
        <div className="hint">
          Cross-library RAG: searches the public Archive AND your Personal Vault (vault answers only when
          unlocked). Citations [n] map to the sources below.
        </div>
        <div className="row">
          <input
            value={question}
            placeholder="Ask anything — grounded in your libraries…"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
          />
          <button onClick={ask} disabled={busy}>{busy ? "Thinking…" : "Ask"}</button>
        </div>
        {error && <div className="hint" style={{ color: "var(--err)" }}>{error}</div>}
      </div>

      {result && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>
              <span className="tag">engine: {result.engine}</span>{" "}
              <span className="tag">{result.latency_ms} ms</span>{" "}
              {result.vault_unlocked ? <span className="tag vault">vault included</span> : null}
            </span>
          </div>
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{result.answer}</p>
          {result.citations.length > 0 && (
            <>
              <div className="hint">Sources</div>
              {result.citations.map((c) => (
                <span key={c.i} className="cite">
                  [{c.i}] {c.library === "vault" ? "🔒" : "📚"} {c.title} · {c.score}
                </span>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
