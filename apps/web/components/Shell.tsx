"use client";

/** App shell — desktop: fixed dark sidebar with icon+label nav (per the
 *  dashboard references); mobile: compact top header + bottom tab bar. */
import { useEffect, useState } from "react";
import { useTheme } from "@/lib/kit";

export type NavTab = { id: string; label: string; icon: string; admin?: boolean };

export function Shell({ tabs, active, onNavigate, headerExtra, children }: {
  tabs: NavTab[]; active: string; onNavigate: (id: string) => void;
  headerExtra?: React.ReactNode; children: React.ReactNode;
}) {
  const { theme, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  // close drawer on navigation (mobile)
  useEffect(() => { setMobileOpen(false); }, [active]);

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
          <span className="mtitle">Silvestar</span>
          <div className="mhead-extra">{headerExtra}</div>
        </header>
        <div className="shell-content">{children}</div>
      </div>
    </div>
  );
}
