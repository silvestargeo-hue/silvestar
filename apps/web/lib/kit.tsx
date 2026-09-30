"use client";

/** Shared feature toolkit — toasts, modal, meters, typewriter, TTS/voice,
 *  clipboard, file download, search highlighting, theme, online status. */
import React, { useCallback, useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ toasts */
type Toast = { id: number; msg: string; kind: "ok" | "err" | "" };
let toastSeq = 1;
const toastListeners = new Set<(t: Toast) => void>();

export function toast(msg: string, kind: Toast["kind"] = "") {
  const t = { id: toastSeq++, msg, kind };
  toastListeners.forEach((l) => l(t));
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const l = (t: Toast) => {
      setItems((p) => [...p, t]);
      setTimeout(() => setItems((p) => p.filter((x) => x.id !== t.id)), 3500);
    };
    toastListeners.add(l);
    return () => { toastListeners.delete(l); };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------- modal (confirm) */
export function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <button className="modal-x" onClick={onClose} aria-label="Close dialog">✕</button>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- clipboard */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
      return true;
    } catch { return false; }
  }
}

/* ---------------------------------------------------------- file download */
export function downloadFile(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------------------------------------------------------- TTS/STT */
export function speak(text: string, on = true) {
  if (!on || typeof speechSynthesis === "undefined") { speechSynthesis?.cancel(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 1200));
  u.rate = 1.02; speechSynthesis.speak(u);
}

export function useSpeechInput(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const start = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { toast("Voice input not supported on this browser", "err"); return; }
    const rec = new SR();
    rec.lang = "en-US"; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e: any) => { const t = e.results[0][0].transcript; setListening(false); onResult(t); };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec; rec.start(); setListening(true);
  }, [onResult]);
  const stop = useCallback(() => { recRef.current?.stop(); setListening(false); }, []);
  return { listening, start, stop, supported: typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) };
}

/* ---------------------------------------------------------- mini markdown */
/** Render a small subset of markdown (headings, bold, italics, code, lists,
 *  links, hr) to React elements — no dependency, XSS-safe (no raw HTML). */
export function renderMarkdown(src: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = (src || "").split(/\r?\n/);
  let list: string[] = [];
  let key = 0;
  const inline = (s: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
    let last = 0, m: RegExpExecArray | null, k = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      if (m[1]) parts.push(<b key={k++}>{m[1]}</b>);
      else if (m[2]) parts.push(<i key={k++}>{m[2]}</i>);
      else if (m[3]) parts.push(<code key={k++} style={{ background: "rgba(138,5,255,.12)", padding: "1px 5px", borderRadius: 5 }}>{m[3]}</code>);
      else if (m[4] && m[5]) parts.push(<a key={k++} href={m[5]} target="_blank" rel="noreferrer">{m[4]}</a>);
      last = re.lastIndex;
    }
    if (last < s.length) parts.push(s.slice(last));
    return parts;
  };
  const flushList = () => {
    if (list.length) {
      out.push(<ul key={key++} style={{ margin: "6px 0", paddingLeft: 20 }}>{list.map((li, i) => <li key={i}>{inline(li)}</li>)}</ul>);
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*[-*•]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const lvl = h[1].length;
      out.push(lvl <= 2
        ? <h3 key={key++} style={{ margin: "10px 0 4px" }}>{inline(h[2])}</h3>
        : <h4 key={key++} style={{ margin: "8px 0 3px" }}>{inline(h[2])}</h4>);
    } else if (li || num) {
      list.push((li ? li[1] : num![1]));
    } else if (/^---+$/.test(line)) {
      flushList();
      out.push(<hr key={key++} style={{ border: 0, borderTop: "1px solid rgba(128,128,128,.3)", margin: "10px 0" }} />);
    } else if (!line.trim()) {
      flushList();
    } else {
      flushList();
      out.push(<p key={key++} style={{ margin: "5px 0" }}>{inline(line)}</p>);
    }
  }
  flushList();
  return out;
}

/* ------------------------------------------------------------- highlight */
export function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)); }

export function highlight(text: string, query: string): string {
  const safe = esc(text);
  const terms = query.trim().split(/\s+/).filter((t) => t.length > 1).map(esc);
  if (!terms.length) return safe;
  const rx = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return safe.replace(rx, "<mark>$1</mark>");
}

/* ------------------------------------------------------------ typewriter */
export function useTypewriter(full: string, speed = 12) {
  const [out, setOut] = useState(full);
  const doneRef = useRef("");
  useEffect(() => {
    if (full === doneRef.current) return;
    doneRef.current = full;
    if (full.length < 80) { setOut(full); return; } // short answers appear at once
    let i = 0; setOut("");
    const step = Math.max(1, Math.round(full.length / 220));
    const id = setInterval(() => {
      i += step;
      if (i >= full.length) { setOut(full); clearInterval(id); } else { setOut(full.slice(0, i)); }
    }, speed);
    return () => clearInterval(id);
  }, [full, speed]);
  return out;
}

/* ---------------------------------------------------------------- theme */
export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const saved = localStorage.getItem("sv-theme");
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("sv-theme", theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

/* --------------------------------------------------------- online status */
export function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

/* --------------------------------------------------------------- helpers */
export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function passwordStrength(pw: string): { score: number; label: string; color: string } {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const labels = ["very weak", "weak", "fair", "good", "strong", "excellent"];
  const colors = ["var(--err)", "var(--err)", "var(--warn)", "var(--warn)", "var(--ok)", "var(--ok)"];
  return { score: s, label: labels[s], color: colors[s] };
}

export function timeAgo(ts: number): string {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
