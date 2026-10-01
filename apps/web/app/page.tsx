"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AuthUser } from "@/lib/api";
import { AuthScreen } from "@/components/AuthScreen";
import { ArchiveView } from "@/components/ArchiveView";
import { VaultView } from "@/components/VaultView";
import { AskView } from "@/components/AskView";
import { RoomsView } from "@/components/RoomsView";
import { GraphView } from "@/components/GraphView";
import { LibraryView } from "@/components/LibraryView";
import { SkillsView } from "@/components/SkillsView";
import { CrewView } from "@/components/CrewView";
import { StudioView } from "@/components/StudioView";
import { StudyView } from "@/components/StudyView";
import { UniversalSearch } from "@/components/UniversalSearch";
import { SettingsView } from "@/components/SettingsView";
import { GuideView } from "@/components/GuideView";
import { LockScreen } from "@/components/LockScreen";
import { VoiceGlass } from "@/components/VoiceGlass";
import { MemoryPanel, BriefingCard } from "@/components/MemoryPanel";
import { Landing } from "@/components/Landing";
import { UserPanel } from "@/components/UserPanel";
import { AdminPanel } from "@/components/AdminPanel";
import { Shell, type NavTab } from "@/components/Shell";
import { CommandPalette, type Cmd } from "@/components/CommandPalette";
import { decryptBytes } from "@/lib/e2ee";
import { initOfflineSync, queueSize } from "@/lib/offline";
import { renderMarkdown } from "@/lib/kit";
import { NotificationCenter, useNotificationCount } from "@/components/NotificationCenter";
import { ShortcutsOverlay } from "@/components/ShortcutsOverlay";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useOnline, useTheme, toast, Modal } from "@/lib/kit";
import "./lock.css";
import "./voiceglass.css";

type Tab = "panel" | "ask" | "library" | "archive" | "vault" | "rooms" | "graph" | "skills" | "crew" | "studio" | "study" | "settings" | "guide" | "admin";

const TABS: NavTab[] = [
  { id: "panel", label: "Home", icon: "🏠", group: "Workspace" },
  { id: "ask", label: "Ask Silvestar", icon: "🤖", group: "Workspace" },
  { id: "library", label: "Library", icon: "🗂", group: "Workspace" },
  { id: "crew", label: "Crew", icon: "👥", group: "Workspace" },
  { id: "archive", label: "Archive", icon: "📚", group: "Knowledge" },
  { id: "vault", label: "Vault", icon: "🔒", group: "Knowledge" },
  { id: "graph", label: "Graph", icon: "🕸", group: "Knowledge" },
  { id: "studio", label: "Studio", icon: "🎨", group: "Workspace" },
  { id: "study", label: "Study", icon: "🃏", group: "Knowledge" },
  { id: "skills", label: "Skills", icon: "🧩", group: "System" },
  { id: "rooms", label: "Rooms", icon: "🎙", group: "System" },
  { id: "settings", label: "Settings", icon: "⚙️", group: "System" },
  { id: "guide", label: "Guide", icon: "📖", group: "System" },
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

/** PWA install prompt capture (Chrome/Edge desktop + Android) */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferredInstall: InstallEvent | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e as InstallEvent;
  });
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
  const [usOpen, setUsOpen] = useState(false); // universal search
  const [locked, setLocked] = useState(false); // optional lock screen
  const [pinMode, setPinMode] = useState(false); // lock screen in PIN mode
  const [lockOn, setLockOn] = useState(false); // setting: lock on start
  const [voiceOpen, setVoiceOpen] = useState(false); // VoiceGlass overlay
  const [vaultSession, setVaultSession] = useState<string>(""); // vault unlock (separate from login)
  const [chatFile, setChatFile] = useState<{ path: string; name: string } | null>(null); // chat-with-one-file
  const [memCount, setMemCount] = useState(-1); // Memory Core count (-1 = unknown)
  useEffect(() => {
    (async () => {
      if (!user || !authToken) { setMemCount(-1); return; }
      try {
        const r = await fetch(`${(process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "")}/api/v1/memory`, { headers: { Authorization: `Bearer ${authToken}` } });
        if (r.ok) setMemCount((await r.json()).total ?? 0);
      } catch { setMemCount(-1); }
    })();
  }, [user, authToken, tab]);
  const [chatFiles, setChatFiles] = useState<{ path: string; name: string }[] | null>(null); // chat-with-selected-files
  const [adminFlag, setAdminFlag] = useState(false); // legacy admin-key login
  const [showLanding, setShowLanding] = useState(true); // landing before sign-in
  const [landingSignup, setLandingSignup] = useState(false); // CTA target mode
  const { theme, toggle: toggleTheme } = useTheme();
  const online = useOnline();
  const [pendingSync, setPendingSync] = useState(0);
  useEffect(() => {
    initOfflineSync((n) => { if (n > 0) toast(`🌐 Back online — synced ${n} queued change${n > 1 ? "s" : ""}`, "ok"); });
    setPendingSync(queueSize());
    const t = setInterval(() => setPendingSync(queueSize()), 5000); // badge refresh
    return () => clearInterval(t);
  }, []);
  const { count: notifCount, refresh: refreshNotifs } = useNotificationCount(user?.user_id || "anon");
  const [canInstall, setCanInstall] = useState(false);
  const [e2eeDoc, setE2eeDoc] = useState<{ name: string; text: string } | null>(null);
  useEffect(() => {
    const t = setInterval(() => setCanInstall(!!deferredInstall), 1500);
    setTimeout(() => clearInterval(t), 20000);
    return () => clearInterval(t);
  }, []);
  const installApp = async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try {
      const choice = await deferredInstall.userChoice;
      toast(choice.outcome === "accepted" ? "Installing Silvestar… 🎉" : "Install dismissed", choice.outcome === "accepted" ? "ok" : "err");
    } catch { /* ignore */ }
    deferredInstall = null;
    setCanInstall(false);
  };
  const [remCount, setRemCount] = useState(0);
  useEffect(() => {
    (async () => {
      if (!user || !authToken) { setRemCount(0); return; }
      try {
        const r = await api.reminders(authToken);
        setRemCount((r.reminders || []).filter((x) => !x.fired).length);
      } catch { /* keep previous */ }
    })();
  }, [user, authToken, notifCount]);

  // PWA shortcuts / deep links land on /?tab=ask etc.
  // Web clipper: /?import=<encoded text>&title=…&url=… → prefills Library import
  const importPayload = useRef<{ title: string; text: string; url: string } | null>(null);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get("tab") as Tab | null;
    if (t && ["panel", "ask", "library", "archive", "vault", "rooms", "graph", "skills", "crew", "studio", "study", "settings", "guide", "admin"].includes(t)) {
      setTab(t);
    }
    // zero-knowledge share: /?e2ee=<token>#<key> — key never hits the server
    const e2eeTok = sp.get("e2ee");
    if (e2eeTok) {
      const fragKey = window.location.hash.replace(/^#/, "");
      window.history.replaceState({}, "", window.location.pathname);
      (async () => {
        try {
          const APIB = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
          const m = await fetch(`${APIB}/api/v1/files/e2ee/${encodeURIComponent(e2eeTok)}`);
          if (!m.ok) throw new Error("link not found");
          const meta = await m.json();
          if (!fragKey) throw new Error("missing key in link fragment");
          const b = await fetch(`${APIB}/api/v1/files/e2ee/${encodeURIComponent(e2eeTok)}/blob`);
          if (!b.ok) throw new Error("blob not found");
          const bj = await b.json();
          const pt = await decryptBytes(fragKey, bj.blob_b64);
          const text = new TextDecoder().decode(pt);
          setE2eeDoc({ name: meta.name || "shared file", text });
        } catch (e) {
          toast(`🔒 Encrypted link: ${e instanceof Error ? e.message : "failed"}`, "err");
        }
      })();
    }
    // web clipper deep link: /?import=<text>&title=…&url=… (bookmarklet / mobile share)
    const imp = sp.get("import");
    if (imp) {
      importPayload.current = { title: sp.get("title") || "Web clip", text: imp, url: sp.get("url") || "" };
      try { localStorage.setItem("sv-import", JSON.stringify(importPayload.current)); } catch {}
      setTab("library");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

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
    setShowLanding(true);
    setLandingSignup(false);
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

  // ---- PIN auto-lock: idle timeout + fetch the preference ----
  useEffect(() => {
    if (!user || !authToken) return;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let minutes = 10;
    let armed = false;
    const arm = async () => {
      try {
        const r = await fetch(`${(process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "")}/api/v1/me/autolock`, { headers: { Authorization: `Bearer ${authToken}` } });
        if (r.ok) {
          const j = await r.json();
          armed = !!j.enabled; minutes = j.timeout_minutes || 10;
        }
      } catch {}
    };
    arm();
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (armed && !locked) {
        idleTimer = setTimeout(() => {
          (async () => {
            try {
              const r = await fetch(`${(process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "")}/api/v1/me/autolock`, { headers: { Authorization: `Bearer ${authToken}` } });
              const j = r.ok ? await r.json() : { has_pin: false };
              setPinMode(!!j.has_pin);
            } catch { setPinMode(false); }
            setLocked(true);
          })();
        }, minutes * 60_000);
      }
    };
    const evs = ["mousemove", "keydown", "click", "scroll", "touchstart"] as const;
    evs.forEach((e) => window.addEventListener(e, resetIdle, { passive: true }));
    resetIdle();
    const pref = setInterval(arm, 5 * 60_000);
    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearInterval(pref);
      evs.forEach((e) => window.removeEventListener(e, resetIdle));
    };
  }, [user, authToken, locked]);

  const commands: Cmd[] = [
    ...visibleTabs.map((t) => ({ id: "go-" + t.id, icon: t.icon, label: "Go to " + t.label, run: () => setTab(t.id as Tab) })),
    { id: "notif", icon: "🔔", label: "Open notifications", run: () => setNotifOpen(true) },
    { id: "usearch", icon: "🔍", label: "Universal search", run: () => setUsOpen(true) },
    { id: "help", icon: "⌨", label: "Keyboard shortcuts", run: () => setHelpOpen(true) },
    { id: "settings", icon: "⚙️", label: "Open settings", run: goSettings },
    { id: "theme", icon: "🌓", label: "Toggle theme", run: toggleTheme },
    ...(canInstall ? [{ id: "install", icon: "⬇", label: "Install Silvestar as an app", run: installApp }] : []),
    { id: "lock", icon: "🔒", label: "Lock screen now", run: () => { if (lockOn) setLocked(true); else { toast("Enable the lock screen in Settings first"); setTab("settings"); } } },
    { id: "signout", icon: "🚪", label: "Sign out", run: signOut },
  ];

  // ---- auth gate ----
  if (!booted) return <div className="app"><div className="skel" style={{ height: "60vh" }} /></div>;
  if (!user) {
    return showLanding ? (
      <Landing
        onEnter={() => { setLandingSignup(false); setShowLanding(false); }}
        onSignup={() => { setLandingSignup(true); setShowLanding(false); }}
      />
    ) : (
      <AuthScreen onAuthed={persist} initialMode={landingSignup ? "signup" : "signin"} />
    );
  }

  // ---- optional lock screen gate ----
  if (locked) {
    return (
      <LockScreen
        userId={user.user_id}
        pinMode={pinMode}
        onUnlock={() => { setLocked(false); setPinMode(false); toast("Welcome back ✨", "ok"); }}
        onSignOut={signOut}
      />
    );
  }

  return (
    <div>
      {!online && <div className="offbanner">⚠ You are offline — showing cached content</div>}
      {voiceOpen && (
        <VoiceGlass userId={user.user_id} sessionToken={vaultSession} onClose={() => setVoiceOpen(false)} />
      )}

      <Shell
        tabs={visibleTabs}
        active={tab}
        onNavigate={(id) => setTab(id as Tab)}
        headerExtra={
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button className="mini ghost bell" onClick={() => setNotifOpen(true)} aria-label={`Notifications (${notifCount}) · due reminders (${remCount})`}>
              🔔{notifCount > 0 && <span className="dot">{notifCount}</span>}{remCount > 0 && <span className="dot" style={{ background: "var(--warn, #d97706)" }}>{remCount}⏰</span>}{pendingSync > 0 && <span className="dot" style={{ background: "var(--accent2, #22d3ee)" }}>{pendingSync}⇅</span>}
            </button>
            <button className="mini ghost" onClick={() => setVoiceOpen(true)} aria-label="Voice assistant">🎙</button>
            <button className="mini ghost" onClick={() => setUsOpen(true)} aria-label="Universal search">🔍</button>
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
            <div>
              <BriefingCard authToken={authToken} userName={user.display_name || user.email.split("@")[0]} />
              <MemoryPanel authToken={authToken} />
              <UserPanel
                userId={user.user_id}
                authToken={authToken}
                sessionToken={vaultSession}
                userName={user.display_name || user.email.split("@")[0]}
                onNavigate={(id) => setTab(id as Tab)}
              />
            </div>
          </ErrorBoundary>
        )}
        {tab === "ask" && (
          <ErrorBoundary>
            <AskView
              userId={user.user_id}
              sessionToken={vaultSession}
              authToken={authToken}
              chatFile={chatFile}
              chatFiles={chatFiles}
              onClearChatFile={() => setChatFile(null)}
              onClearChatFiles={() => setChatFiles(null)}
            />
          </ErrorBoundary>
        )}
        {tab === "library" && (
          <ErrorBoundary>
            <LibraryView
              userId={user.user_id}
              sessionToken={authToken}
              onChatWithFile={(f) => { setChatFiles(null); setChatFile(f); setTab("ask"); }}
              onChatWithFiles={(fs) => { setChatFile(null); setChatFiles(fs); setTab("ask"); }}
            />
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
        {tab === "skills" && (
          <ErrorBoundary>
            <SkillsView authToken={authToken} userId={user.user_id} />
          </ErrorBoundary>
        )}
        {tab === "crew" && (
          <ErrorBoundary>
            <CrewView userId={user.user_id} sessionToken={vaultSession} authToken={authToken} offline={!online} pendingSync={pendingSync} />
          </ErrorBoundary>
        )}
        {tab === "studio" && (
          <ErrorBoundary>
            <StudioView authToken={authToken} userId={user.user_id} />
          </ErrorBoundary>
        )}
        {tab === "study" && (
          <ErrorBoundary>
            <StudyView authToken={authToken} userId={user.user_id} offline={!online} pendingSync={pendingSync} />
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
        {tab === "guide" && <ErrorBoundary><GuideView onNavigate={(id) => setTab(id as Tab)} /></ErrorBoundary>}
        {tab === "admin" && isAdmin && <ErrorBoundary><AdminPanel /></ErrorBoundary>}
      </Shell>

      {e2eeDoc && (
        <Modal title={`🔒 ${e2eeDoc.name} — decrypted in your browser`} onClose={() => setE2eeDoc(null)}>
          <div className="muted small" style={{ marginBottom: 8 }}>
            Decrypted locally with the key from the link fragment. The server only ever stored ciphertext.
          </div>
          <div style={{ maxHeight: "60vh", overflow: "auto" }}>{renderMarkdown(e2eeDoc.text)}</div>
          <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
            <button className="btn ghost" onClick={() => { navigator.clipboard?.writeText(e2eeDoc.text); toast("Copied", "ok"); }}>📋 Copy</button>
            <button className="btn primary" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([e2eeDoc.text], { type: "text/markdown" })); a.download = e2eeDoc.name; a.click(); }}>⬇ Download</button>
          </div>
        </Modal>
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <NotificationCenter userId={user.user_id} open={notifOpen} onClose={() => setNotifOpen(false)} onChanged={() => refreshNotifs()} />
      <ShortcutsOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      {usOpen && (
        <UniversalSearch authToken={authToken} userId={user.user_id} onClose={() => setUsOpen(false)} />
      )}
    </div>
  );
}
