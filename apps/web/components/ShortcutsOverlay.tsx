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
    </Modal>
  );
}
