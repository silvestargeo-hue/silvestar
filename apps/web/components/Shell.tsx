"use client";

/** App shell v2 — desktop: grouped sidebar + top bar with live system status;
 *  mobile: compact header + bottom tab bar. Footer shows platform + storage. */
import { useEffect, useState } from "react";
import { useTheme } from "@/lib/kit";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export type NavTab = { id: string; label: string; icon: string; admin?: boolean; group?: string };

const GROUP_ORDER = ["Workspace", "Knowledge", "System"];

function groupLabel(tab: NavTab): string {
  if (tab.group) return tab.group;
  if (["panel", "ask", "library", "rooms"].includes(tab.id)) return "Workspace";
  if (["archive", "vault", "graph"].includes(tab.id)) return "Knowledge";
  return "System";
}

function useSysHealth() {
  const [health, setHealth] = useState<{ ok: boolean; db: string; ai: string }>({
    ok: true, db: "…", ai: "…",
  });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await api.health();
        if (!alive) return;
        setHealth({
          ok: h?.status === "ok",
          db: h?.db?.mode || "db",
          ai: h?.ai?.primary_reachable ? "online" : "offline",
        });
      } catch {
        if (alive) setHealth((p) => ({ ...p, ok: false, ai: "offline" }));
      }
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return health;
}

export function Shell({ tabs, active, onNavigate, headerExtra, footer, children }: {
  tabs: NavTab[]; active: string; onNavigate: (id: string) => void;
  headerExtra?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode;
}) {
  const { theme, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const health = useSysHealth();
  const i18n = useI18n();
  const i18nT = (id: string, fallback: string) => i18n.t(id) === id ? fallback : i18n.t(id);

  // close drawer on navigation (mobile)
  useEffect(() => { setMobileOpen(false); }, [active]);

  // group tabs
  const groups: { label: string; items: NavTab[] }[] = [];
  for (const g of GROUP_ORDER) {
    const items = tabs.filter((t) => groupLabel(t) === g);
    if (items.length) groups.push({ label: g, items });
  }
  const rest = tabs.filter((t) => !GROUP_ORDER.includes(groupLabel(t)));
  if (rest.length) groups.push({ label: "More", items: rest });
  const activeTab = tabs.find((t) => t.id === active);

  return (
    <div className="shell">
      {/* desktop sidebar */}
      <aside className="sidebar">
        <div className="side-brand" onClick={() => onNavigate("panel")}>
          <span className="logo">⭐</span>
          <div>
            <div className="brand-name">Silvestar</div>
            <div className="brand-sub">knowledge platform</div>
          </div>
        </div>
        <nav className="side-nav">
          {groups.map((g) => (
            <div key={g.label} className="side-group">
              <div className="side-group-label">{i18nT(g.label.toLowerCase(), g.label)}</div>
              {g.items.map((t) => (
                <button
                  key={t.id}
                  className={`side-link ${active === t.id ? "active" : ""}`}
                  onClick={() => onNavigate(t.id)}
                  aria-current={active === t.id ? "page" : undefined}
                >
                  <span className="si">{t.icon}</span>
                  <span>{i18nT(t.id, t.label)}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <button className="side-link" onClick={toggle}>
            <span className="si">{theme === "dark" ? "☀️" : "🌙"}</span>
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
        </div>
      </aside>

      {/* mobile drawer */}
      {mobileOpen && (
        <div className="drawer-back" onClick={() => setMobileOpen(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            {tabs.map((t) => (
              <button
                key={t.id}
                className={`side-link ${active === t.id ? "active" : ""}`}
                onClick={() => onNavigate(t.id)}
              >
                <span className="si">{t.icon}</span>
                <span>{t.label}</span>
              </button>
            ))}
            <button className="side-link" onClick={toggle}>
              <span className="si">{theme === "dark" ? "☀️" : "🌙"}</span>
              <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
            </button>
          </div>
        </div>
      )}

      <div className="shell-main">
        <header className="mhead">
          <button className="burger" onClick={() => setMobileOpen(true)} aria-label="Open menu">☰</button>
          <span className="mtitle">{activeTab ? `${activeTab.icon} ${i18nT(activeTab.id, activeTab.label)}` : "Silvestar"}</span>
          <span className={`sys-pill ${health.ok ? "" : "bad"}`} title={`System ${health.ok ? "healthy" : "degraded"} · AI ${health.ai}`}>
            <span className="sys-dot" /> {health.ok ? "System OK" : "Degraded"}
          </span>
          <div className="mhead-extra">{headerExtra}</div>
        </header>

        {/* desktop top strip: page title + live status */}
        <header className="dhead">
          <div className="dhead-title">
            <span className="dhead-icon">{activeTab?.icon ?? "⭐"}</span>
            <span>{activeTab ? i18nT(activeTab.id, activeTab.label) : "Silvestar"}</span>
          </div>
          <div className="dhead-status">
            <span className={`sys-pill ${health.ok ? "" : "bad"}`} title="API + database reachability">
              <span className="sys-dot" /> {health.ok ? "System OK" : "Degraded"}
            </span>
            <span className="sys-chip" title="Database engine">🗄 {health.db}</span>
            <span className={`sys-chip ${health.ai === "online" ? "ok" : "bad"}`} title="AI assistant">🤖 AI {health.ai}</span>
            <span className="sys-chip hide-sm" title="Cache">⚡ Cache live</span>
            {headerExtra}
          </div>
        </header>

        <div className="shell-content">{children}</div>

        <footer className="shell-foot">
          <span>⭐ Silvestar v1.1</span>
          <span className="hide-sm">· GitHub-backed file storage</span>
          <span>· {health.ok ? "All systems operational" : "Some systems degraded"}</span>
          {footer}
        </footer>
      </div>
    </div>
  );
}
