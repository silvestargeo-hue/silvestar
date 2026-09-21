"use client";

/** User Panel — personal dashboard: stats, recent documents, quick actions. */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatTile } from "./Stat";
import { toast } from "@/lib/kit";

type Stats = {
  user_id: string; vault_unlocked: boolean; vault_documents: number;
  archive_documents: number; recent_archive: { id: string; title: string }[];
  ai: { assistant: string; reachable: boolean };
};

export function UserPanel({ userId, sessionToken, onNavigate }: {
  userId: string; sessionToken: string; onNavigate: (id: string) => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);

  const load = useCallback(async () => {
    try {
      setStats(await api.meStats(userId, sessionToken));
    } catch {
      setStats(null);
    }
  }, [userId, sessionToken]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const trend = (n: number) => Array.from({ length: 10 }, (_, i) => n * 0.55 + i * 1.3 + Math.sin(i * 2.1) * 1.8);

  return (
    <div>
      <div className="tile-grid">
        <StatTile icon="📚" label="Archive docs" value={stats?.archive_documents ?? "—"}
          sub="public library" trend={trend(stats?.archive_documents ?? 5)} accent="var(--accent2)" />
        <StatTile icon="🔒" label="Vault docs" value={stats ? (stats.vault_unlocked ? stats.vault_documents : "🔒") : "—"}
          sub={stats?.vault_unlocked ? "unlocked" : "locked"} trend={trend(stats?.vault_documents ?? 2)} accent="var(--warn)" />
        <StatTile icon="🤖" label="Silvestar AI" value={stats?.ai.reachable ? "online" : "—"}
          sub={stats?.ai.assistant ?? ""} trend={trend(6)} accent="var(--ok)" />
        <StatTile icon="⚡" label="Platform" value="1.0.0" sub="all 9 modules" trend={trend(9)} />
      </div>

      <div className="grid2">
        <div className="card">
          <h2>🕒 Recent in Archive</h2>
          {stats?.recent_archive.length ? (
            stats.recent_archive.map((d) => (
              <div key={d.id} className="hit">
                <div className="t">📄 {d.title}</div>
              </div>
            ))
          ) : (
            <div className="hint">Nothing published yet — add documents from the Archive tab.</div>
          )}
        </div>

        <div className="card">
          <h2>⚡ Quick actions</h2>
          <div className="row">
            <button onClick={() => onNavigate("ask")}>🤖 Ask AI</button>
            <button className="ghost" onClick={() => onNavigate("archive")}>📚 Archive</button>
            <button className="ghost" onClick={() => onNavigate("vault")}>🔒 Vault</button>
            <button className="ghost" onClick={() => onNavigate("rooms")}>🎙 Rooms</button>
            <button className="ghost" onClick={() => onNavigate("graph")}>🕸 Graph</button>
          </div>
        </div>
      </div>
    </div>
  );
}
