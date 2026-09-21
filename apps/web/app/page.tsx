"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type Health } from "@/lib/api";
import { LockScreen } from "@/components/LockScreen";
import { ArchiveView } from "@/components/ArchiveView";
import { VaultView } from "@/components/VaultView";
import { AskView } from "@/components/AskView";
import { RoomsView } from "@/components/RoomsView";
import { GraphView } from "@/components/GraphView";
import { UserPanel } from "@/components/UserPanel";
import { AdminPanel } from "@/components/AdminPanel";
import { Shell, type NavTab } from "@/components/Shell";
import { CommandPalette, type Cmd } from "@/components/CommandPalette";
import { useOnline } from "@/lib/kit";
import "./lock.css";

type Tab = "panel" | "ask" | "archive" | "vault" | "rooms" | "graph" | "admin";

const TABS: NavTab[] = [
  { id: "panel", label: "Dashboard", icon: "🏠" },
  { id: "ask", label: "Ask Silvestar", icon: "🤖" },
  { id: "archive", label: "Archive", icon: "📚" },
  { id: "vault", label: "Vault", icon: "🔒" },
  { id: "rooms", label: "Rooms", icon: "🎙" },
  { id: "graph", label: "Graph", icon: "🕸" },
  { id: "admin", label: "Admin", icon: "🛡" },
];

export default function Home() {
  const [tab, setTab] = useState<Tab>("panel");
  const [health, setHealth] = useState<Health | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null); // null = locked
  const [checked, setChecked] = useState(false);
  const [adminEnabled, setAdminEnabled] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [userId] = useState(() => "u-" + Math.random().toString(36).slice(2, 9));
  const online = useOnline();

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
    const c = setTimeout(() => setChecked(true), 600);
    setAdminEnabled(!!localStorage.getItem("sv-admin-key"));
    return () => {
      clearInterval(t);
      clearTimeout(c);
    };
  }, [refreshHealth]);

  // global shortcuts: Ctrl+K palette, g+tab quick nav
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const unlock = (t: string) => {
    setSessionToken(t || ""); // "" = guest mode
  };

  const enableAdmin = () => {
    const k = prompt("Admin key:");
    if (k === null) return;
    if (k) {
      localStorage.setItem("sv-admin-key", k);
      setAdminEnabled(true);
      setTab("admin");
    } else {
      localStorage.removeItem("sv-admin-key");
      setAdminEnabled(false);
    }
  };

  const commands: Cmd[] = [
    ...TABS.filter((t) => t.id !== "admin" || adminEnabled).map((t) => ({
      id: "go-" + t.id,
      icon: t.icon,
      label: "Go to " + t.label,
      run: () => setTab(t.id as Tab),
    })),
    {
      id: "admin-toggle",
      icon: "🛡",
      label: adminEnabled ? "Disable admin mode" : "Enable admin mode",
      run: enableAdmin,
    },
    {
      id: "lock-vault",
      icon: "🔒",
      label: "Lock vault session",
      run: async () => {
        if (sessionToken) {
          try {
            await api.vaultLock(userId, sessionToken);
          } catch { /* token may be stateless-expired */ }
          setSessionToken("");
        }
      },
    },
    {
      id: "copy-api",
      icon: "🔗",
      label: "Copy API base URL",
      run: () => navigator.clipboard.writeText(process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"),
    },
  ];

  const visibleTabs = TABS.filter((t) => t.id !== "admin" || adminEnabled);

  return (
    <div>
      {!online && <div className="offbanner">⚠ You are offline — showing cached content</div>}

      {!sessionToken && checked && (
        <LockScreen userId={userId} onUnlock={unlock} />
      )}

      <div style={{ filter: sessionToken !== null ? undefined : "blur(6px)", pointerEvents: sessionToken !== null ? undefined : "none", minHeight: "100vh" }}>
        <Shell
          tabs={visibleTabs}
          active={tab}
          onNavigate={(id) => setTab(id as Tab)}
          headerExtra={
            health ? (
              <span className={`badge ${health.ai?.primary_reachable ? "ok" : "err"}`}>
                ● {health.ai?.assistant ?? "AI"} {health.ai?.primary_reachable ? "online" : "offline"}
              </span>
            ) : (
              <span className="badge err">● api offline</span>
            )
          }
        >
          {tab === "panel" && (
            <UserPanel
              userId={userId}
              sessionToken={sessionToken ?? ""}
              onNavigate={(id) => setTab(id as Tab)}
            />
          )}
          {tab === "ask" && <AskView userId={userId} sessionToken={sessionToken ?? ""} />}
          {tab === "archive" && <ArchiveView userId={userId} sessionToken={sessionToken ?? ""} />}
          {tab === "vault" && (
            <VaultView userId={userId} sessionToken={sessionToken ?? ""} onUnlock={setSessionToken} />
          )}
          {tab === "rooms" && <RoomsView userId={userId} />}
          {tab === "graph" && <GraphView />}
          {tab === "admin" && adminEnabled && <AdminPanel />}
        </Shell>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  );
}
