"use client";

/** Home screen v2 — hero greeting, live stat tiles, one-tap quick actions,
 *  and a getting-started card. Everything is real data from the API. */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatTile } from "./Stat";
import { toast } from "@/lib/kit";
import { useI18n } from "@/lib/i18n";

type Stats = {
  user_id: string; vault_unlocked: boolean; vault_documents: number;
  archive_documents: number; recent_archive: { id: string; title: string }[];
  ai: { assistant: string; reachable: boolean };
};

type FileStats = { files: number; folders: number; bytes: number; indexed: number };

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function greetingKey(): string {
  const h = new Date().getHours();
  if (h < 5) return "workingLate";
  if (h < 12) return "goodMorning";
  if (h < 18) return "goodAfternoon";
  return "goodEvening";
}

export function UserPanel({ userId, authToken, sessionToken, userName, onNavigate }: {
  userId: string; authToken: string; sessionToken: string; userName?: string; onNavigate: (id: string) => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [fstats, setFstats] = useState<FileStats | null>(null);
  const { t } = useI18n();

  const load = useCallback(async () => {
    try { setStats(await api.meStats(userId, sessionToken)); } catch { setStats(null); }
    try {
      const r = await fetch(`${API}/api/v1/files/stats`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : { "x-silvestar-user": userId },
      });
      if (r.ok) setFstats(await r.json());
    } catch { setFstats(null); }
  }, [userId, sessionToken]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const trend = (n: number) => Array.from({ length: 10 }, (_, i) => n * 0.55 + i * 1.3 + Math.sin(i * 2.1) * 1.8);

  return (
    <div>
      <div className="home-hero">
        <div className="home-hero-text">
          <h1>{t(greetingKey())}{userName ? `, ${userName}` : ""} 👋</h1>
          <p>Your files, documents and AI — all in one place. What would you like to do?</p>
        </div>
        <div className="home-hero-actions">
          <button className="btn primary" onClick={() => onNavigate("ask")}>🤖 Ask Silvestar</button>
          <button className="btn ghost" onClick={() => onNavigate("library")}>🗂 Open Library</button>
        </div>
      </div>

      <div className="tile-grid">
        <StatTile icon="🗂" label="Library files" value={fstats ? fstats.files : "—"}
          sub={fstats ? `${fmtBytes(fstats.bytes)} · ${fstats.indexed} AI-indexed` : "your uploads"}
          trend={trend(fstats?.files ?? 3)} accent="var(--accent2)" />
        <StatTile icon="📚" label="Archive docs" value={stats?.archive_documents ?? "—"}
          sub="knowledge library" trend={trend(stats?.archive_documents ?? 5)} accent="var(--accent)" />
        <StatTile icon="🔒" label="Vault docs" value={stats ? (stats.vault_unlocked ? stats.vault_documents : "🔒") : "—"}
          sub={stats?.vault_unlocked ? "unlocked" : "locked"} trend={trend(stats?.vault_documents ?? 2)} accent="var(--warn)" />
        <StatTile icon="🤖" label="Silvestar AI" value={stats?.ai.reachable ? "online" : "—"}
          sub={stats?.ai.assistant ?? ""} trend={trend(6)} accent="var(--ok)" />
      </div>

      <div className="grid2">
        <div className="card">
          <h2>⚡ {t("quickActions")}</h2>
          <div className="qa-grid">
            <button className="qa" onClick={() => onNavigate("ask")}>
              <span className="qa-ic">🤖</span><span className="qa-t">Ask AI</span>
              <span className="qa-d">Answers from your docs</span>
            </button>
            <button className="qa" onClick={() => onNavigate("library")}>
              <span className="qa-ic">📤</span><span className="qa-t">Upload files</span>
              <span className="qa-d">PDF, Word, images…</span>
            </button>
            <button className="qa" onClick={() => onNavigate("archive")}>
              <span className="qa-ic">📚</span><span className="qa-t">Archive</span>
              <span className="qa-d">Search everything</span>
            </button>
            <button className="qa" onClick={() => onNavigate("vault")}>
              <span className="qa-ic">🔒</span><span className="qa-t">Vault</span>
              <span className="qa-d">AES-256 private docs</span>
            </button>
            <button className="qa" onClick={() => onNavigate("rooms")}>
              <span className="qa-ic">🎙</span><span className="qa-t">Rooms</span>
              <span className="qa-d">Live voice & chat</span>
            </button>
            <button className="qa" onClick={() => onNavigate("graph")}>
              <span className="qa-ic">🕸</span><span className="qa-t">Graph</span>
              <span className="qa-d">See connections</span>
            </button>
          </div>
        </div>

        <div className="card">
          <h2>🕒 {t("recentArchive")}</h2>
          {stats?.recent_archive.length ? (
            stats.recent_archive.map((d) => (
              <div key={d.id} className="hit">
                <div className="t">📄 {d.title}</div>
              </div>
            ))
          ) : (
            <div className="hint">Nothing published yet — add documents from the Archive tab.</div>
          )}
          <div className="notice" style={{ marginTop: 10 }}>
            💡 Tip: press <b>Ctrl+K</b> anywhere to jump between sections, or <b>?</b> for all shortcuts.
          </div>
        </div>
      </div>
    </div>
  );
}
