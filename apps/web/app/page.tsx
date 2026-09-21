"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type Health } from "@/lib/api";
import { LockScreen } from "@/components/LockScreen";
import { ArchiveView } from "@/components/ArchiveView";
import { VaultView } from "@/components/VaultView";
import { AskView } from "@/components/AskView";
import { RoomsView } from "@/components/RoomsView";
import { GraphView } from "@/components/GraphView";
import "./lock.css";

type Tab = "ask" | "archive" | "vault" | "rooms" | "graph";

const TABS: { id: Tab; label: string }[] = [
  { id: "ask", label: "🤖 Ask Silvestar" },
  { id: "archive", label: "📚 Archive" },
  { id: "vault", label: "🔒 Vault" },
  { id: "rooms", label: "🎙 Rooms" },
  { id: "graph", label: "🕸 Graph" },
];

export default function Home() {
  const [tab, setTab] = useState<Tab>("ask");
  const [health, setHealth] = useState<Health | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null); // null = locked
  const [checked, setChecked] = useState(false);
  const [userId] = useState(() => "u-" + Math.random().toString(36).slice(2, 9));

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.health());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    const t = setInterval(refreshHealth, 30000);
    const c = setTimeout(() => setChecked(true), 600); // let health probe settle
    return () => {
      clearInterval(t);
      clearTimeout(c);
    };
  }, [refreshHealth]);

  const unlocked = sessionToken !== null;

  const modeBadge = (label: string, mode: string | undefined, ok: boolean | undefined) => (
    <span className={`badge ${ok ? "ok" : "err"}`} title={`mode: ${mode ?? "n/a"}`}>
      {label}: {mode ?? "offline"}
    </span>
  );

  return (
    <div className="app">
      {!unlocked && checked && (
        <LockScreen
          userId={userId}
          onUnlock={(t) => setSessionToken(t || "")} // "" = guest mode
        />
      )}

      <header className="top">
        <div style={{ flex: "1 1 100%" }}>
          <h1>⭐ Silvestar Platform</h1>
          <div className="sub">
            Archive Library · Personal Vault · cross-library RAG · realtime rooms · knowledge graph · Silvestar AI
          </div>
        </div>
        <div className="row" style={{ flex: "1 1 100%" }}>
          {health ? (
            <>
              {modeBadge("db", health.db?.mode, health.db?.ok)}
              {modeBadge("cache", health.cache?.mode, health.cache?.ok)}
              {modeBadge("graph", health.graph?.mode, health.graph?.ok)}
              <span className={`badge ${health.ai?.primary_reachable ? "ok" : ""}`}>
                ai: {health.ai?.assistant ?? "—"}
              </span>
              <span className={`badge ${health.livekit?.enabled ? "ok" : ""}`}>
                livekit: {health.livekit?.enabled ? "on" : "p2p"}
              </span>
              {sessionToken ? (
                <span className="badge ok">vault: unlocked</span>
              ) : (
                <span className="badge">vault: guest</span>
              )}
            </>
          ) : (
            <span className="badge err">api: offline</span>
          )}
        </div>
      </header>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <main style={{ filter: unlocked ? undefined : "blur(6px)", pointerEvents: unlocked ? undefined : "none" }}>
        {tab === "ask" && <AskView userId={userId} sessionToken={sessionToken ?? ""} />}
        {tab === "archive" && <ArchiveView userId={userId} sessionToken={sessionToken ?? ""} />}
        {tab === "vault" && (
          <VaultView userId={userId} sessionToken={sessionToken ?? ""} onUnlock={setSessionToken} />
        )}
        {tab === "rooms" && <RoomsView userId={userId} />}
        {tab === "graph" && <GraphView />}
      </main>

      <footer className="pf">
        Silvestar Platform · cross-library RAG · AES-256-GCM vault · WebSockets
        {health?.livekit?.enabled ? " + LiveKit" : " (P2P signaling)"} · graph
      </footer>
    </div>
  );
}
