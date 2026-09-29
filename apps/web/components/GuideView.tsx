"use client";

/** Guide — built-in user manual: what each module does, shortcuts,
 *  where your data lives, and tips to get the most out of Silvestar. */

const MODULES: { icon: string; name: string; what: string; how: string }[] = [
  {
    icon: "🏠", name: "Home",
    what: "Your dashboard — live stats for files, docs and AI.",
    how: "Use the quick-action tiles to jump anywhere. Stats refresh every minute.",
  },
  {
    icon: "🤖", name: "Ask Silvestar",
    what: "Real AI (Groq, ultra-fast) that answers using your documents.",
    how: "Ask anything. Answers cite sources — [n] maps to the list below the answer. Toggle 🔊 to hear it, 🎙 to dictate.",
  },
  {
    icon: "🗂", name: "Library",
    what: "Your files: PDF, Word, Excel, images, audio — any type up to 40 MB.",
    how: "Drag & drop to upload (multiple at once). Organize in folders, view inline, rename/move/delete. Text inside files becomes AI-searchable automatically.",
  },
  {
    icon: "📚", name: "Archive",
    what: "Your knowledge library — documents you create or import.",
    how: "Search everything instantly, export a backup anytime.",
  },
  {
    icon: "🔒", name: "Vault",
    what: "AES-256-GCM encrypted private documents.",
    how: "Create a vault password (separate from login). Documents only appear to the AI while the vault is unlocked. Lock it when done.",
  },
  {
    icon: "🕸", name: "Graph",
    what: "Visual map of how your ideas connect.",
    how: "Create nodes and relate them; query the graph to find connections.",
  },
  {
    icon: "🎙", name: "Rooms",
    what: "Live voice & chat rooms.",
    how: "Create a room, share the name — realtime, no setup.",
  },
  {
    icon: "⚙️", name: "Settings",
    what: "Theme, accent colors, profile, lock screen, system status.",
    how: "Enable the Lock Screen to require your vault password on return. Accent color applies instantly.",
  },
];

const SHORTCUTS = [
  ["Ctrl / ⌘ + K", "Command palette — jump anywhere"],
  ["?", "All keyboard shortcuts"],
  ["Enter", "Send / confirm in any field"],
];

export function GuideView({ onNavigate }: { onNavigate: (id: string) => void }) {
  return (
    <div className="settings">
      <div className="card">
        <h2>👋 Welcome to Silvestar</h2>
        <div className="set-d" style={{ maxWidth: "none" }}>
          Everything here runs on free, no-expiry infrastructure — AI, storage, database,
          hosting. No card, no metering, no trials. Start with three quick steps:
        </div>
        <div className="set-row"><div><div className="set-t">1 · Personalize</div><div className="set-d">Pick your accent color and enable the Lock Screen in Settings.</div></div><button className="btn ghost" onClick={() => onNavigate("settings")}>Open</button></div>
        <div className="set-row"><div><div className="set-t">2 · Add files</div><div className="set-d">Drop PDFs or docs into your Library — the AI can read them.</div></div><button className="btn ghost" onClick={() => onNavigate("library")}>Open</button></div>
        <div className="set-row"><div><div className="set-t">3 · Ask</div><div className="set-d">Ask Silvestar anything — it answers using what you've added.</div></div><button className="btn primary" onClick={() => onNavigate("ask")}>Open</button></div>
      </div>

      <div className="card">
        <h2>🧭 Modules</h2>
        {MODULES.map((m) => (
          <div className="set-row" key={m.name}>
            <div>
              <div className="set-t">{m.icon} {m.name}</div>
              <div className="set-d">{m.what} {m.how}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>⌨ Shortcuts</h2>
        {SHORTCUTS.map(([k, v]) => (
          <div className="set-row" key={k}>
            <div><div className="set-t">{k}</div><div className="set-d">{v}</div></div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>🛰 JARVIS OS</h2>
        <div className="set-row">
          <div>
            <div className="set-t">Your AI operating system</div>
            <div className="set-d">Companion desktop in the browser — AI chat, image lab, terminal, notes, themes. Silvestar is built in as an app.</div>
          </div>
          <button className="btn ghost" onClick={() => window.open("https://silvestargeo-hue.github.io/jarvis-os/", "_blank", "noopener")}>Open ↗</button>
        </div>
      </div>

      <div className="card">
        <h2>🗄 Where your data lives</h2>
        <div className="set-row"><div><div className="set-t">Files</div><div className="set-d">Stored in your GitHub data repository — private, free, no size metering beyond the 40 MB per-file limit.</div></div></div>
        <div className="set-row"><div><div className="set-t">Documents & accounts</div><div className="set-d">Postgres database (Neon free tier) — never expires.</div></div></div>
        <div className="set-row"><div><div className="set-t">Vault</div><div className="set-d">Encrypted on the server with AES-256-GCM; your password never leaves your device unhashed.</div></div></div>
      </div>
    </div>
  );
}
