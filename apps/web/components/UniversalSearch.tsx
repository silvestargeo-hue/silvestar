"use client";

/** Universal search — one box over Library files, Archive and Omniverse web. */
import { useEffect, useRef, useState } from "react";
import { Modal } from "@/lib/kit";
import { useI18n } from "@/lib/i18n";

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type UResult = { kind: string; title: string; id: string; score: number; folder: string; snippet: string };

export function UniversalSearch({ authToken, userId, onClose, onOpenFile }: {
  authToken: string;
  userId: string;
  onClose: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<UResult[]>([]);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const run = async () => {
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/search/universal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ q: query, limit: 5 }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      setResults(j.results || []);
      setSearched(true);
    } catch {
      setResults([]);
    } finally { setBusy(false); }
  };

  const icon = (kind: string) => (kind === "file" ? "📁" : kind === "archive" ? "📚" : "🌐");

  return (
    <Modal title="🔍 Universal Search" onClose={onClose}>
      <div className="row">
        <input ref={inputRef} value={q} placeholder={t("usPlaceholder")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()} />
        <button onClick={run} disabled={busy || !q.trim()}>{busy ? "…" : t("aiSearchBtn")}</button>
      </div>
      {results.map((r, i) => (
        <div key={`${r.kind}-${r.id}-${i}`} className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", marginTop: 10 }}>
          <span>
            <b>{icon(r.kind)} {r.title}</b>
            <span className="muted small"> · {r.kind}{r.folder ? ` · ${r.folder}` : ""} · {r.score}</span>
            <div className="muted small">{r.snippet}</div>
          </span>
          {r.kind === "file" && onOpenFile && (
            <button className="btn tiny" onClick={() => { onOpenFile(r.folder && r.id ? r.id : r.id); onClose(); }}>
              {t("open")}
            </button>
          )}
        </div>
      ))}
      {searched && !busy && results.length === 0 && (
        <div className="muted small" style={{ marginTop: 8 }}>{t("usEmpty")}</div>
      )}
      {!searched && !busy && <div className="muted small" style={{ marginTop: 8 }}>{t("usHint")}</div>}
    </Modal>
  );
}
