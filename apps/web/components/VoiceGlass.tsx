"use client";

/** VoiceGlass — full-screen voice-first assistant with a glassmorphism orb.
 * Tap the orb (or hold Space) and speak; answers stream back with live
 * waveform, captions and auto-speak. Free: Web Speech API + the platform's
 * own AI chain. */
import { useEffect, useRef, useState } from "react";
import { api, type AskResult } from "@/lib/api";
import { toast } from "@/lib/kit";
import { useSpeechInput } from "@/lib/kit";

type Turn = { who: "you" | "sv"; text: string };

const SUGGESTIONS = [
  "What's due today?",
  "Summarize my newest file",
  "What do you remember about me?",
  "Give me today's briefing",
];

export function VoiceGlass({
  userId,
  sessionToken,
  onClose,
}: {
  userId: string;
  sessionToken: string;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [caption, setCaption] = useState("");
  const [level, setLevel] = useState(0); // fake but lively waveform level
  const [result, setResult] = useState<AskResult | null>(null);
  const levelRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { listening: sttListening, start, stop, supported } = useSpeechInput((text) => {
    setCaption(text);
    if (text.trim()) {
      setListening(false);
      ask(text.trim());
    }
  });

  useEffect(() => {
    if (sttListening) setListening(true);
  }, [sttListening]);

  // lively orb animation while listening/speaking
  useEffect(() => {
    const t = setInterval(() => {
      const active = listening || speaking || thinking;
      const target = active ? 0.4 + Math.random() * 0.6 : 0.08;
      levelRef.current += (target - levelRef.current) * 0.35;
      setLevel(levelRef.current);
    }, 90);
    return () => clearInterval(t);
  }, [listening, speaking, thinking]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 9e9, behavior: "smooth" });
  }, [turns.length, caption]);

  useEffect(() => {
    return () => { try { speechSynthesis?.cancel(); } catch {} };
  }, []);

  const speak = (text: string) => {
    try {
      speechSynthesis?.cancel();
      const u = new SpeechSynthesisUtterance(text.slice(0, 600));
      u.rate = 1.04; u.pitch = 1.0;
      const vs = speechSynthesis?.getVoices?.() || [];
      const v = vs.find((x) => /en/i.test(x.lang) && /female|samantha|zira|google/i.test(x.name)) || vs[0];
      if (v) u.voice = v;
      u.onstart = () => setSpeaking(true);
      u.onend = () => { setSpeaking(false); if (supported) setTimeout(() => start(), 500); };
      u.onerror = () => setSpeaking(false);
      speechSynthesis?.speak(u);
    } catch { setSpeaking(false); }
  };

  const ask = async (q: string) => {
    setTurns((t) => [...t, { who: "you", text: q }]);
    setCaption("");
    setThinking(true);
    try {
      const r = await api.ask(q, userId, sessionToken, []);
      setResult(r);
      const ans = r.answer || "";
      setTurns((t) => [...t, { who: "sv", text: ans }]);
      setThinking(false);
      speak(ans);
    } catch (e) {
      setThinking(false);
      toast(String(e instanceof Error ? e.message : e), "err");
    }
  };

  const orbScale = 1 + level * 0.25;

  return (
    <div className="vg-wrap" role="dialog" aria-label="Voice assistant">
      <div className="vg-aurora a1" />
      <div className="vg-aurora a2" />
      <div className="vg-aurora a3" />

      <button className="vg-close" onClick={() => { try { speechSynthesis?.cancel(); } catch {} ; onClose(); }} aria-label="Close voice mode">✕</button>

      <div className="vg-head">
        <div className="vg-logo">◆</div>
        <div>
          <b>Silvestar Voice</b>
          <div className="vg-sub">{thinking ? "thinking…" : speaking ? "speaking…" : listening ? "listening…" : supported ? "tap the orb and speak" : "voice input not supported — type below"}</div>
        </div>
      </div>

      <div className="vg-orb-zone">
        <div className="vg-rings">
          <span style={{ transform: `scale(${orbScale + 0.25})` }} />
          <span style={{ transform: `scale(${orbScale + 0.55})` }} />
        </div>
        <button
          className={`vg-orb ${listening ? "rec" : ""} ${speaking ? "talk" : ""}`}
          onClick={() => { if (listening) { stop(); setListening(false); } else if (!thinking) start(); }}
          aria-label={listening ? "Stop listening" : "Start listening"}
        >
          <span className="vg-orb-core" style={{ transform: `scale(${1 + level * 0.4})` }} />
        </button>
        <div className="vg-wave" aria-hidden>
          {Array.from({ length: 24 }).map((_, i) => (
            <i key={i} style={{ height: `${8 + Math.abs(Math.sin(i * 0.9 + Date.now() / 300)) * level * 46}px` }} />
          ))}
        </div>
      </div>

      <div className="vg-caption" aria-live="polite">
        {caption || (thinking ? "Silvestar is thinking…" : listening ? "…" : "")}
      </div>

      <div className="vg-log" ref={scrollRef}>
        {turns.map((t, i) => (
          <div key={i} className={`vg-turn ${t.who}`}>
            <span className="vg-who">{t.who === "you" ? "🧑" : "✦"}</span>
            <p>{t.text}</p>
          </div>
        ))}
        {result && result.citations?.length > 0 && (
          <div className="vg-cites">
            {result.citations.slice(0, 4).map((c) => (
              <span key={c.i} className="tag">[{c.i}] {c.title.slice(0, 40)}</span>
            ))}
          </div>
        )}
      </div>

      {!listening && !thinking && turns.length === 0 && (
        <div className="vg-suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="vg-chip" onClick={() => ask(s)}>{s}</button>
          ))}
        </div>
      )}

      <form
        className="vg-input"
        onSubmit={(e) => {
          e.preventDefault();
          const v = (new FormData(e.currentTarget).get("q") as string || "").trim();
          if (v) { e.currentTarget.reset(); ask(v); }
        }}
      >
        <input name="q" placeholder="…or type a message" autoComplete="off" />
        <button className="vg-send" aria-label="Send">➤</button>
      </form>
    </div>
  );
}
