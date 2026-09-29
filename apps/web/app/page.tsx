"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type AuthUser } from "@/lib/api";
import { AuthScreen } from "@/components/AuthScreen";
import { ArchiveView } from "@/components/ArchiveView";
import { VaultView } from "@/components/VaultView";
import { AskView } from "@/components/AskView";
import { RoomsView } from "@/components/RoomsView";
import { GraphView } from "@/components/GraphView";
import { LibraryView } from "@/components/LibraryView";
import { SettingsView } from "@/components/SettingsView";
import { LockScreen } from "@/components/LockScreen";
import { UserPanel } from "@/components/UserPanel";
import { AdminPanel } from "@/components/AdminPanel";
import { Shell, type NavTab } from "@/components/Shell";
import { CommandPalette, type Cmd } from "@/components/CommandPalette";
import { NotificationCenter, useNotificationCount } from "@/components/NotificationCenter";
import { ShortcutsOverlay } from "@/components/ShortcutsOverlay";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useOnline, useTheme, toast } from "@/lib/kit";
import "./lock.css";

type Tab = "panel" | "ask" | "library" | "archive" | "vault" | "rooms" | "graph" | "settings" | "admin";

const TABS: NavTab[] = [
  { id: "panel", label: "Home", icon: "🏠", group: "Workspace" },
  { id: "ask", label: "Ask Silvestar", icon: "🤖", group: "Workspace" },
  { id: "library", label: "Library", icon: "🗂", group: "Workspace" },
  { id: "archive", label: "Archive", icon: "📚", group: "Knowledge" },
  { id: "vault", label: "Vault", icon: "🔒", group: "Knowledge" },
  { id: "graph", label: "Graph", icon: "🕸", group: "Knowledge" },
  { id: "rooms", label: "Rooms", icon: "🎙", group: "System" },
  { id: "settings", label: "Settings", icon: "⚙️", group: "System" },
  { id: "admin", label: "Admin", icon: "🛡", admin: true, group: "System" },
];

const SESSION_KEY = "sv-session";
const USER_KEY = "sv-user";

/** apply saved accent color early so there is no flash of the default */
function applySavedAccent() {
  try {
    const c = localStorage.getItem("sv-accent");
    if (c) document.documentElement.style.setProperty("--accent", c);
  } catch { /* ignore */ }
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("panel");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authToken, setAuthToken] = useState<string>("");
  const [booted, setBooted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [locked, setLocked] = useState(false); // optional lock screen
  const [lockOn, setLockOn] = useState(false); // setting: lock on start
  const [vaultSession, setVaultSession] = useState<string>(""); // vault unlock (separate from login)
  const [adminFlag, setAdminFlag] = useState(false); // legacy admin-key login
  const { theme, toggle: toggleTheme } = useTheme();
  const online = useOnline();
  const { count: notifCount, refresh: refreshNotifs } = useNotificationCount(user?.user_id || "anon");

  // ---- boot: restore a persisted session ----
  useEffect(() => {
    (async () => {
      applySavedAccent();
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
      const lockPref = localStorage.getItem("sv-lock-on") === "1";
      setLockOn(lockPref);
      if (lockPref && saved) setLocked(true);
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
    setLocked(false);
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

  const goSettings = () => { setMenuOpen(false); setTab("settings"); };

  const commands: Cmd[] = [
    ...visibleTabs.map((t) => ({ id: "go-" + t.id, icon: t.icon, label: "Go to " + t.label, run: () => setTab(t.id as Tab) })),
    { id: "notif", icon: "🔔", label: "Open notifications", run: () => setNotifOpen(true) },
    { id: "help", icon: "⌨", label: "Keyboard shortcuts", run: () => setHelpOpen(true) },
    { id: "settings", icon: "⚙️", label: "Open settings", run: goSettings },
    { id: "theme", icon: "🌓", label: "Toggle theme", run: toggleTheme },
    { id: "lock", icon: "🔒", label: "Lock screen now", run: () => { if (lockOn) setLocked(true); else { toast("Enable the lock screen in Settings first"); setTab("settings"); } } },
    { id: "signout", icon: "🚪", label: "Sign out", run: signOut },
  ];

  // ---- auth gate ----
  if (!booted) return <div className="app"><div className="skel" style={{ height: "60vh" }} /></div>;
  if (!user) return <AuthScreen onAuthed={persist} />;

  // ---- optional lock screen gate ----
  if (locked) {
    return (
      <LockScreen
        userId={user.user_id}
        onUnlock={() => { setLocked(false); toast("Welcome back ✨", "ok"); }}
        onSignOut={signOut}
      />
    );
  }

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
                <>
                <div className="pm-overlay" onClick={() => setMenuOpen(false)} />
                <div className="profile-menu">
                  <div className="pm-head">
                    <div className="pm-name">{user.display_name || user.email.split("@")[0]}</div>
                    <div className="pm-mail">{user.email}</div>
                    <div className="pm-role">{user.role === "admin" ? "🛡 Administrator" : "Member"} · {user.status}</div>
                  </div>
                  <button className="side-link" onClick={goSettings}><span className="si">⚙️</span> Settings</button>
                  <button className="side-link" onClick={() => { setMenuOpen(false); if (lockOn) setLocked(true); else { toast("Enable the lock screen in Settings first"); setTab("settings"); } }}>
                    <span className="si">🔒</span> Lock screen
                  </button>
                  <button className="side-link" onClick={() => { toggleTheme(); setMenuOpen(false); }}><span className="si">{theme === "dark" ? "☀️" : "🌙"}</span> Toggle theme</button>
                  {user.role === "admin" && (
                    <button className="side-link" onClick={() => { setTab("admin"); setMenuOpen(false); }}><span className="si">🛡</span> Admin panel</button>
                  )}
                  <button className="side-link pm-out" onClick={signOut}><span className="si">🚪</span> Sign out</button>
                </div>
                </>
              )}
            </div>
          </span>
        }
        footer={<span>· {online ? "connected" : "offline mode"}</span>}
      >
        {tab === "panel" && (
          <ErrorBoundary>
            <UserPanel
              userId={user.user_id}
              sessionToken={vaultSession}
              userName={user.display_name || user.email.split("@")[0]}
              onNavigate={(id) => setTab(id as Tab)}
            />
          </ErrorBoundary>
        )}
        {tab === "ask" && (
          <ErrorBoundary>
            <AskView userId={user.user_id} sessionToken={vaultSession} />
          </ErrorBoundary>
        )}
        {tab === "library" && (
          <ErrorBoundary>
            <LibraryView userId={user.user_id} sessionToken={authToken} />
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
        {tab === "settings" && (
          <ErrorBoundary>
            <SettingsView
              user={user}
              authToken={authToken}
              onUserUpdate={(u, newToken) => persist(newToken || authToken, u)}
              lockOn={lockOn}
              onToggleLock={(on) => { setLockOn(on); localStorage.setItem("sv-lock-on", on ? "1" : "0"); }}
              onLockNow={() => setLocked(true)}
            />
          </ErrorBoundary>
        )}
        {tab === "admin" && isAdmin && <ErrorBoundary><AdminPanel /></ErrorBoundary>}
      </Shell>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <NotificationCenter userId={user.user_id} open={notifOpen} onClose={() => setNotifOpen(false)} onChanged={() => refreshNotifs()} />
      <ShortcutsOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
