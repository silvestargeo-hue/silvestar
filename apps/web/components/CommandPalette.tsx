"use client";

/** ⌘K / Ctrl+K command palette — keyboard-first navigation and actions. */
import { useEffect, useMemo, useRef, useState } from "react";

export type Cmd = { id: string; label: string; icon: string; run: () => void; hint?: string };

export function CommandPalette({ open, onClose, commands }: {
  open: boolean; onClose: () => void; commands: Cmd[];
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(s));
  }, [q, commands]);

  useEffect(() => {
    if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  useEffect(() => { setSel(0); }, [q]);

  if (!open) return null;

  const runSel = (i: number) => {
    const c = filtered[i];
    if (!c) return;
    onClose(); c.run();
  };

  return (
    <div className="cpal-back" onClick={onClose}>
      <div className="cpal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder="Type a command or search…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === "Enter") runSel(sel);
            else if (e.key === "Escape") onClose();
          }}
          aria-label="Command palette"
        />
        <div className="items">
          {filtered.length === 0 && <div className="item" style={{ color: "var(--muted)" }}>No matching commands</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`item ${i === sel ? "sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => runSel(i)}
            >
              <span>{c.icon}</span>
              <span>{c.label}</span>
              {c.hint && <span className="k">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
