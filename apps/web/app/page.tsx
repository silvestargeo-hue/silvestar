"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type AuthUser } from "@/lib/api";
import { AuthScreen } from "@/components/AuthScreen";
import { ArchiveView } from "@/components/ArchiveView";
import { VaultView } from "@/components/VaultView";
import { AskView } from "@/components/AskView";
import { RoomsView } from "@/components/RoomsView";
import { GraphView } from "@/components/GraphView";
import { UserPanel } from "@/components/UserPanel";
import { AdminPanel } from "@/components/AdminPanel";
import { Shell, type NavTab } from "@/components/Shell";
import { CommandPalette, type Cmd } from "@/components/CommandPalette";
import { NotificationCenter, useNotificationCount } from "@/components/NotificationCenter";
import { ShortcutsOverlay } from "@/components/ShortcutsOverlay";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useOnline, useTheme, toast } from "@/lib/kit";
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

const SESSION_KEY = "sv-session";
const USER_KEY = "sv-user";

export default function Home() {
  const [tab, setTab] = useState<Tab>("panel");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authToken, setAuthToken] = useState<string>("");
  const [booted, setBooted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [vaultSession, setVaultSession] = useState<string>(""); // vault unlock (separate from login)
  const [adminFlag, setAdminFlag] = useState(false); // legacy admin-key login
  const { theme, toggle: toggleTheme } = useTheme();
  const online = useOnline();
  const { count: notifCount, refresh: refreshNotifs } = useNotificationCount(user?.user_id || "anon");

  // ---- boot: restore a persisted session ----
  useEffect(() => {
    (async () => {
      const saved = localStorage.getItem(SESSION_KEY);
      if (saved) {
        try {
          const r = await api.authSession(saved);
          setUser(r.user);
          setAuthToken(saved);
        } catch {
          localStorage.removeItem(SESSION_KEY);
          localStorage.removeItem(USER_KEY);
        }
      }
      setAdminFlag(!!localStorage.getItem("sv-admin-key"));
      setBooted(true);
    })();
  }, []);

  const persist = (token: string, u: AuthUser) => {
    localStorage.setItem(SESSION_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    setAuthToken(token);
    setUser(u);
  };

  const signOut = () => {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem("sv-admin-key");
    setAdminFlag(false);
    setAuthToken("");
    setUser(null);
    setVaultSession("");
    setTab("panel");
  };

  const isAdmin = user?.role === "admin" || adminFlag;
  const visibleTabs = TABS.filter((t) => t.id !== "admin" || isAdmin);

  // global shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "?" && !/input|textarea/i.test((e.target as HTMLElement)?.tagName || "")) {
        setHelpOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const changePassword = async () => {
    const oldPw = prompt("Current password:");
    if (!oldPw) return;
    const newPw = prompt("New password (min 8 chars):");
    if (!newPw || newPw.length < 8) return;
    try {
      const r = await api.authPassword(authToken, oldPw, newPw);
      persist(r.session_token, r.user); // fresh token replaces the dead one
      toast("Password changed — other sessions signed out", "ok");
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e).replace(/^\d+:\s*/, ""), "err");
    }
  };

  const renameProfile = async () => {
    const name = prompt("Display name:", user?.display_name || "");
    if (!name?.trim()) return;
    try {
      const r = await api.authProfile(authToken, name.trim());
      persist(authToken, r.user);
      toast("Profile updated ✓", "ok");
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e).replace(/^\d+:\s*/, ""), "err");
    }
  };

  const commands: Cmd[] = [
    ...visibleTabs.map((t) => ({ id: "go-" + t.id, icon: t.icon, label: "Go to " + t.label, run: () => setTab(t.id as Tab) })),
    { id: "notif", icon: "🔔", label: "Open notifications", run: () => setNotifOpen(true) },
    { id: "help", icon: "⌨", label: "Keyboard shortcuts", run: () => setHelpOpen(true) },
    { id: "rename", icon: "👤", label: "Edit profile name", run: renameProfile },
    { id: "pass", icon: "🔑", label: "Change password", run: changePassword },
    { id: "theme", icon: "🌓", label: "Toggle theme", run: toggleTheme },
    { id: "signout", icon: "🚪", label: "Sign out", run: signOut },
  ];

  // ---- auth gate ----
  if (!booted) return <div className="app"><div className="skel" style={{ height: "60vh" }} /></div>;
  if (!user) return <AuthScreen onAuthed={persist} />;

  return (
    <div>
      {!online && <div className="offbanner">⚠ You are offline — showing cached content</div>}

      <Shell
        tabs={visibleTabs}
        active={tab}
        onNavigate={(id) => setTab(id as Tab)}
        headerExtra={
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button className="mini ghost bell" onClick={() => setNotifOpen(true)} aria-label="Notifications">
              🔔{notifCount > 0 && <span className="dot">{notifCount}</span>}
            </button>
            <button className="mini ghost" onClick={() => setHelpOpen(true)} aria-label="Keyboard shortcuts">⌨</button>
            <div style={{ position: "relative" }}>
              <button className="mini ghost" onClick={() => setMenuOpen((o) => !o)}>
                👤 {user.display_name || user.email.split("@")[0]}
                {user.role === "admin" ? " 🛡" : ""}
              </button>
              {menuOpen && (
                <div className="profile-menu" onMouseLeave={() => setMenuOpen(false)}>
                  <div className="pm-head">
                    <div className="pm-name">{user.display_name || user.email.split("@")[0]}</div>
                    <div className="pm-mail">{user.email}</div>
                    <div className="pm-role">{user.role === "admin" ? "🛡 Administrator" : "Member"} · {user.status}</div>
                  </div>
                  <button className="side-link" onClick={() => { renameProfile(); setMenuOpen(false); }}><span className="si">👤</span> Edit profile</button>
                  <button className="side-link" onClick={() => { changePassword(); setMenuOpen(false); }}><span className="si">🔑</span> Change password</button>
                  <button className="side-link" onClick={() => { toggleTheme(); setMenuOpen(false); }}><span className="si">{theme === "dark" ? "☀️" : "🌙"}</span> Toggle theme</button>
                  {user.role === "admin" && (
                    <button className="side-link" onClick={() => { setTab("admin"); setMenuOpen(false); }}><span className="si">🛡</span> Admin panel</button>
                  )}
                  <button className="side-link pm-out" onClick={signOut}><span className="si">🚪</span> Sign out</button>
                </div>
              )}
            </div>
          </span>
        }
      >
        {tab === "panel" && (
          <ErrorBoundary>
            <UserPanel userId={user.user_id} sessionToken={vaultSession} onNavigate={(id) => setTab(id as Tab)} />
          </ErrorBoundary>
        )}
        {tab === "ask" && (
          <ErrorBoundary>
            <AskView userId={user.user_id} sessionToken={vaultSession} />
          </ErrorBoundary>
        )}
        {tab === "archive" && (
          <ErrorBoundary>
            <ArchiveView userId={user.user_id} sessionToken={vaultSession} />
          </ErrorBoundary>
        )}
        {tab === "vault" && (
          <ErrorBoundary>
            <VaultView userId={user.user_id} sessionToken={vaultSession} onUnlock={setVaultSession} />
          </ErrorBoundary>
        )}
        {tab === "rooms" && <ErrorBoundary><RoomsView userId={user.user_id} /></ErrorBoundary>}
        {tab === "graph" && <ErrorBoundary><GraphView /></ErrorBoundary>}
        {tab === "admin" && isAdmin && <ErrorBoundary><AdminPanel /></ErrorBoundary>}
      </Shell>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <NotificationCenter userId={user.user_id} open={notifOpen} onClose={() => setNotifOpen(false)} onChanged={() => refreshNotifs()} />
      <ShortcutsOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
