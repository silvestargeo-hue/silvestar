"use client";

/** Home screen v2 — hero greeting, live stat tiles, one-tap quick actions,
 *  customizable dashboard widgets (study due, shared spaces, crew reports),
 *  and a getting-started card. Everything is real data from the API. */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatTile } from "./Stat";
import { toast } from "@/lib/kit";
import { useI18n } from "@/lib/i18n";
import { initOfflineSync, isOffline, enqueue, queueSize } from "@/lib/offline";

type Stats = {
  user_id: string; vault_unlocked: boolean; vault_documents: number;
  archive_documents: number; recent_archive: { id: string; title: string }[];
  ai: { assistant: string; reachable: boolean };
};

type FileStats = { files: number; folders: number; bytes: number; indexed: number };
type DeckRow = { name: string; cards: number; due: number };
type SpaceRow = { name: string; role: string; folder: string };
type CrewFile = { name: string; path: string; uploaded: number };
type RemRow = { id: string; text: string; due: number; repeat: string; fired: boolean };
type StreakRes = { streak: number; best: number; active_days: number; cells: { day: number; count: number }[] };
type RecentFile = { name: string; path: string; folder: string; uploaded: number };

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

/** PWA install prompt capture (module-level; fires once per page load) */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let svInstallEvent: InstallEvent | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    svInstallEvent = e as InstallEvent;
  });
}

const WIDGETS = ["tiles", "quick", "recent", "study", "spaces", "crew", "rem"] as const;
type WidgetId = (typeof WIDGETS)[number];
const WIDGET_LABELS: Record<WidgetId, string> = {
  tiles: "📊 Stat tiles",
  quick: "⚡ Quick actions",
  recent: "🕒 Recent archive",
  study: "🃏 Study due",
  spaces: "👥 Shared spaces",
  crew: "👥 Crew reports",
  rem: "⏰ Reminders",
};
const DEFAULT_WIDGETS: WidgetId[] = ["tiles", "quick", "recent", "study", "spaces", "crew", "rem"];
const WKEY = "sv-widgets";

function loadWidgets(): WidgetId[] {
  try {
    const raw = localStorage.getItem(WKEY);
    if (!raw) return DEFAULT_WIDGETS;
    const arr = JSON.parse(raw) as string[];
    const clean = arr.filter((w): w is WidgetId => (WIDGETS as readonly string[]).includes(w));
    return clean.length ? clean : DEFAULT_WIDGETS;
  } catch { return DEFAULT_WIDGETS; }
}

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
  const [decks, setDecks] = useState<DeckRow[]>([]);
  const [spaces, setSpaces] = useState<SpaceRow[]>([]);
  const [crewFiles, setCrewFiles] = useState<CrewFile[]>([]);
  const [rems, setRems] = useState<RemRow[]>([]);
  const [remText, setRemText] = useState("");
  const [remWhen, setRemWhen] = useState("");
  const [remRep, setRemRep] = useState("");
  const [remBusy, setRemBusy] = useState(false);
  const [quote, setQuote] = useState<{ quote: string; author: string } | null>(null);
  const [streak, setStreak] = useState<StreakRes | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [canInstall, setCanInstall] = useState(!!svInstallEvent);
  const [offline, setOffline] = useState(isOffline());
  const [pending, setPending] = useState(0);
  // background sync: init once; refresh queue badge when connectivity changes
  useEffect(() => {
    initOfflineSync((n) => { if (n > 0) toast(`🌐 Back online — synced ${n} queued change${n > 1 ? "s" : ""}`, "ok"); });
    setPending(queueSize());
    const on = () => { setOffline(false); setPending(queueSize()); };
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const t = setInterval(() => setPending(queueSize()), 5000);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); clearInterval(t); };
  }, []);
  useEffect(() => {
    const t = setInterval(() => setCanInstall(!!svInstallEvent), 1500);
    const stop = setTimeout(() => clearInterval(t), 25000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, []);
  const installApp = async () => {
    if (!svInstallEvent) return;
    svInstallEvent.prompt();
    try {
      const choice = await svInstallEvent.userChoice;
      toast(choice.outcome === "accepted" ? "Installing Silvestar… 🎉" : "Install dismissed", choice.outcome === "accepted" ? "ok" : "err");
    } catch { /* ignore */ }
    svInstallEvent = null;
    setCanInstall(false);
  };
  const [widgets, setWidgets] = useState<WidgetId[]>(DEFAULT_WIDGETS);
  const [customize, setCustomize] = useState(false);
  const { t } = useI18n();

  useEffect(() => { setWidgets(loadWidgets()); }, []);

  const authHeaders = useCallback((): Record<string, string> => (
    authToken ? { Authorization: `Bearer ${authToken}` } : { "x-silvestar-user": userId }
  ), [authToken, userId]);

  const load = useCallback(async () => {
    try { setStats(await api.meStats(userId, sessionToken)); } catch { setStats(null); }
    try {
      const r = await fetch(`${API}/api/v1/files/stats`, { headers: authHeaders() });
      if (r.ok) setFstats(await r.json());
    } catch { setFstats(null); }
    try {
      const r = await fetch(`${API}/api/v1/study/decks`, { headers: authHeaders() });
      if (r.ok) setDecks(((await r.json()).decks || []) as DeckRow[]);
    } catch { setDecks([]); }
    try {
      const r = await fetch(`${API}/api/v1/spaces`, { headers: authHeaders() });
      if (r.ok) setSpaces(((await r.json()).spaces || []) as SpaceRow[]);
    } catch { setSpaces([]); }
    try {
      const r = await fetch(`${API}/api/v1/files?folder=Crew-Reports`, { headers: authHeaders() });
      if (r.ok) setCrewFiles(((await r.json()).files || []) as CrewFile[]);
    } catch { setCrewFiles([]); }
    try {
      const r = await fetch(`${API}/api/v1/reminders`, { headers: authHeaders() });
      if (r.ok) setRems(((await r.json()).reminders || []) as RemRow[]);
    } catch { setRems([]); }
    try {
      const r = await fetch(`${API}/api/v1/daily-quote`);
      if (r.ok) setQuote(await r.json());
    } catch { setQuote(null); }
    try {
      const r = await fetch(`${API}/api/v1/me/streak`, { headers: authHeaders() });
      if (r.ok) setStreak(await r.json());
    } catch { setStreak(null); }
    try {
      const r = await fetch(`${API}/api/v1/files`, { headers: authHeaders() });
      if (r.ok) {
        const fs = ((await r.json()).files || []) as RecentFile[];
        setRecentFiles(fs.filter((f) => f.uploaded > 0).slice(0, 5));
      }
    } catch { setRecentFiles([]); }
  }, [userId, sessionToken, authHeaders]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const addReminder = async () => {
    const txt = remText.trim();
    if (!txt || !remWhen || remBusy) return;
    const due = Math.floor(new Date(remWhen).getTime() / 1000);
    if (!due || due < Date.now() / 1000) { toast("Pick a future date & time", "err"); return; }
    if (isOffline()) {
      // offline: keep it on this device; background sync sends it later
      const n = enqueue(`${API}/api/v1/reminders`, { text: txt, due, repeat: remRep }, authHeaders());
      setRemText(""); setRemWhen("");
      setRems((prev) => [...prev, { id: `local-${Date.now()}`, text: txt, due, repeat: remRep, fired: false } as RemRow]);
      setPending(n);
      toast(`Offline — saved on device, syncs automatically (queue: ${n})`, "ok");
      return;
    }
    setRemBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/reminders`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ text: txt, due, repeat: remRep }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      setRemText(""); setRemWhen("");
      const rl = await fetch(`${API}/api/v1/reminders`, { headers: authHeaders() });
      if (rl.ok) setRems(((await rl.json()).reminders || []) as RemRow[]);
      toast("Reminder set ⏰", "ok");
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setRemBusy(false); }
  };

  const delReminder = async (id: string) => {
    try {
      await fetch(`${API}/api/v1/reminders/${encodeURIComponent(id)}`, {
        method: "DELETE", headers: authHeaders(),
      });
      setRems((rs) => rs.filter((x) => x.id !== id));
    } catch { /* ignore */ }
  };

  const toggleWidget = (w: WidgetId) => {
    const next = widgets.includes(w) ? widgets.filter((x) => x !== w) : [...widgets, w];
    setWidgets(next);
    try { localStorage.setItem(WKEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const trend = (n: number) => Array.from({ length: 10 }, (_, i) => n * 0.55 + i * 1.3 + Math.sin(i * 2.1) * 1.8);

  const dueDecks = decks.filter((d) => d.due > 0);

  const fmtIn = (due: number) => {
    const s = due - Date.now() / 1000;
    if (s <= 0) return "due now";
    if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
    if (s < 86400) return `in ${Math.round(s / 3600)} h`;
    return `in ${Math.round(s / 86400)} d`;
  };

  const heatColor = (n: number) =>
    n === 0 ? "rgba(128,128,128,.15)" : n < 3 ? "#8a05ff44" : n < 8 ? "#8a05ff88" : "#8a05ff";

  return (
    <div>
      {quote && (
        <div className="card" style={{ marginBottom: 14, borderLeft: "4px solid var(--accent)", padding: "12px 16px" }}>
          <div style={{ fontSize: 17, fontStyle: "italic" }}>“{quote.quote}”</div>
          <div className="muted small" style={{ marginTop: 4 }}>— {quote.author} · quote of the day</div>
        </div>
      )}

      <div className="home-hero">
        <div className="home-hero-text">
          <h1>{t(greetingKey())}{userName ? `, ${userName}` : ""} 👋</h1>
          <p>Your files, documents and AI — all in one place. What would you like to do?</p>
        </div>
        <div className="home-hero-actions">
          <button className="btn primary" onClick={() => onNavigate("ask")}>🤖 Ask Silvestar</button>
          <button className="btn ghost" onClick={() => onNavigate("library")}>🗂 Open Library</button>
          <button className="btn ghost" title="Show or hide dashboard widgets" onClick={() => setCustomize(!customize)}>
            {customize ? "✕" : "⚙"} Widgets
          </button>
          {canInstall && <button className="btn ghost" onClick={installApp} title="Add Silvestar to your home screen / desktop">⬇ Install app</button>}
        </div>
      </div>

      {customize && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>⚙ Dashboard widgets</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            {WIDGETS.map((w) => (
              <label key={w} style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={widgets.includes(w)} onChange={() => toggleWidget(w)} />
                {WIDGET_LABELS[w]}
              </label>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>Your choice is saved on this device.</div>
        </div>
      )}

      {widgets.includes("tiles") && (
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
      )}

      {(widgets.includes("study") || widgets.includes("spaces") || widgets.includes("crew")) && (
        <div className="grid2" style={{ marginBottom: 14 }}>
      {widgets.includes("tiles") && streak && (
        <div className="card" style={{ marginBottom: 14, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
          <div>
            <div style={{ fontSize: 30, fontWeight: 800, color: "var(--accent)" }}>
              {streak.streak > 0 ? `🔥 ${streak.streak}` : "🌱"}
            </div>
            <div className="muted small">day streak{streak.best > streak.streak ? ` · best ${streak.best}` : ""} · {streak.active_days} active days</div>
          </div>
          <div style={{ display: "grid", gridTemplateRows: "repeat(7, 12px)", gridAutoFlow: "column", gap: 3 }} title="Last 13 weeks of activity">
            {streak.cells.map((c) => (
              <span key={c.day} title={`${c.count} activity · ${new Date(c.day * 86400000).toLocaleDateString()}`}
                style={{ width: 12, height: 12, borderRadius: 3, background: heatColor(c.count) }} />
            ))}
          </div>
        </div>
      )}

      {(widgets.includes("study") || widgets.includes("spaces") || widgets.includes("crew")) && widgets.includes("study") && (
            <div className="card">
              <h2>🃏 Study due</h2>
              {dueDecks.length ? dueDecks.slice(0, 4).map((d) => (
                <div key={d.name} className="hit">
                  <div className="t">🃏 {d.name}</div>
                  <div className="muted small">{d.due} due · {d.cards} cards</div>
                </div>
              )) : (
                <div className="hint">Nothing due — {decks.length ? "all caught up!" : "no decks yet."}</div>
              )}
              <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => onNavigate("study")}>Open Study</button>
            </div>
          )}
          {widgets.includes("spaces") && (
            <div className="card">
              <h2>👥 Shared spaces</h2>
              {spaces.length ? spaces.slice(0, 4).map((s) => (
                <div key={s.folder} className="hit">
                  <div className="t">👥 {s.name}</div>
                  <div className="muted small">{s.role}</div>
                </div>
              )) : (
                <div className="hint">No spaces yet — create one in Library.</div>
              )}
              <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => onNavigate("library")}>Open Library</button>
            </div>
          )}
          {widgets.includes("crew") && (
            <div className="card">
              <h2>👥 Crew reports</h2>
              {crewFiles.length ? crewFiles.slice(0, 4).map((f) => (
                <div key={f.path} className="hit">
                  <div className="t">📄 {f.name}</div>
                  <div className="muted small">{f.uploaded ? new Date(f.uploaded * 1000).toLocaleDateString() : ""}</div>
                </div>
              )) : (
                <div className="hint">No reports yet — run the Crew.</div>
              )}
              <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => onNavigate("crew")}>Open Crew</button>
            </div>
          )}
        </div>
      )}

      {widgets.includes("rem") && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>⏰ Reminders</h2>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <input value={remText} placeholder="e.g. Call the bank" style={{ flex: 1, minWidth: 160 }}
              onChange={(e) => setRemText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addReminder()} disabled={remBusy} />
            <input type="datetime-local" value={remWhen} style={{ width: 200 }}
              onChange={(e) => setRemWhen(e.target.value)} disabled={remBusy} />
            <select value={remRep} onChange={(e) => setRemRep(e.target.value)} disabled={remBusy} aria-label="Repeat">
              <option value="">once</option>
              <option value="daily">daily</option>
              <option value="weekly">weekly</option>
              <option value="monthly">monthly</option>
            </select>
            <button className="btn primary" disabled={remBusy || !remText.trim() || !remWhen} onClick={addReminder}>
              {remBusy ? "⏳" : "➕ Set"}
            </button>
          </div>
          {rems.length === 0 ? (
            <div className="hint" style={{ marginTop: 8 }}>No reminders yet — due ones ring the 🔔 bell automatically.</div>
          ) : (
            <div style={{ marginTop: 8 }}>
              {rems.slice(0, 6).map((r) => (
                <div key={r.id} className="hit" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div>
                    <div className="t">{r.fired ? "🔔" : "⏰"} {r.text}{r.repeat ? ` (${r.repeat})` : ""}</div>
                    <div className="muted small">{new Date(r.due * 1000).toLocaleString()} · {!r.fired && <b style={{ color: "var(--accent)" }}>{fmtIn(r.due)}</b>}{r.fired ? " · notified" : ""}</div>
                  </div>
                  <button className="mini ghost" onClick={() => delReminder(r.id)} title="Delete reminder">✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <b>🌐 Offline status</b>
          <span className="muted small">queue: {pending}</span>
          <span className="tag">{offline ? "✈️ offline — changes are saved on device" : "✅ online"}</span>
        </div>
      </div>

      <div className="grid2">
        {widgets.includes("quick") && (
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
        )}

        {widgets.includes("recent") && (
          <div className="card">
            <h2>🕘 Timeline — what happened when</h2>
            {recentFiles.length ? recentFiles.map((f) => (
              <div key={f.path} className="hit" style={{ borderLeft: "3px solid var(--accent)", paddingLeft: 10, marginBottom: 6 }}>
                <div className="t">📄 {f.name} <span className="muted small">{f.folder ? `· ${f.folder}` : ""}</span></div>
                <div className="muted small">● {new Date(f.uploaded * 1000).toLocaleString()}</div>
              </div>
            )) : (
              <div className="hint">Upload files to build your timeline.</div>
            )}
            {stats?.recent_archive.length ? (
              <>
                <div className="muted small" style={{ marginTop: 8, fontWeight: 600 }}>Recent archive documents</div>
                {stats.recent_archive.slice(0, 3).map((d) => (
                  <div key={d.id} className="hit">
                    <div className="t">📚 {d.title}</div>
                  </div>
                ))}
              </>
            ) : null}
            <div className="notice" style={{ marginTop: 10 }}>
              💡 Tip: press <b>Ctrl+K</b> anywhere — it's also a calculator (try <code>45*12+7</code>).
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
