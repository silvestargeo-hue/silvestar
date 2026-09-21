"use client";

import { Modal } from "@/lib/kit";

const SHORTCUTS: [string, string][] = [
  ["Ctrl / ⌘ + K", "Open command palette"],
  ["?", "Show this shortcuts help"],
  ["Enter", "Submit search / ask"],
  ["Esc", "Close dialogs and palette"],
  ["↑ / ↓", "Navigate palette results"],
];

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null; // never render when closed (this was the stuck-overlay bug)
  return (
    <Modal title="⌨ Keyboard shortcuts" onClose={onClose}>
      <div className="kv">
        {SHORTCUTS.map(([k, d]) => (
          <div key={k} style={{ display: "contents" }}>
            <span className="k" style={{ fontWeight: 700 }}>{k}</span>
            <span>{d}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn primary" onClick={onClose}>Got it</button>
      </div>
    </Modal>
  );
}
