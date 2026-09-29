"use client";

import { useEffect, useRef } from "react";

/** Landing — public marketing page shown before sign-in: hero, features,
 *  "free forever" promise, and CTAs into auth. */

const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: "🤖", title: "Real AI assistant", text: "Fast answers grounded in your own documents — powered by Groq's LPU, with 6 backup engines so it never goes down." },
  { icon: "🗂", title: "File Library", text: "Upload PDFs, Word docs, images — anything up to 40 MB. Organize in folders, view online, share public links." },
  { icon: "🔒", title: "Encrypted Vault", text: "AES-256-GCM private documents. The AI can only read them while YOU keep the vault unlocked." },
  { icon: "📚", title: "Knowledge Archive", text: "Search everything instantly. Export your data anytime — it's yours." },
  { icon: "🕸", title: "Knowledge Graph", text: "Connect ideas and see relationships between your documents and thoughts." },
  { icon: "🎙", title: "Live Rooms", text: "Realtime voice & chat rooms — zero setup, share a name and you're in." },
];

export function Landing({ onEnter, onSignup }: { onEnter: () => void; onSignup: () => void }) {
  const starsRef = useRef<HTMLCanvasElement>(null);

  // gentle drifting starfield
  useEffect(() => {
    const cv = starsRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const stars = Array.from({ length: 90 }, () => ({
      x: Math.random(), y: Math.random(),
      r: Math.random() * 1.3 + 0.3,
      s: Math.random() * 0.00016 + 0.00004,
      tw: Math.random() * Math.PI * 2,
    }));
    const resize = () => { cv.width = innerWidth; cv.height = innerHeight; };
    resize();
    addEventListener("resize", resize);
    const tick = (t: number) => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent") || "#7c5cff";
      for (const st of stars) {
        st.y += st.s; if (st.y > 1) st.y = 0;
        const a = 0.35 + 0.4 * Math.abs(Math.sin(t * 0.001 + st.tw));
        ctx.beginPath();
        ctx.arc(st.x * cv.width, st.y * cv.height, st.r, 0, Math.PI * 2);
        ctx.fillStyle = accent.trim();
        ctx.globalAlpha = a;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); removeEventListener("resize", resize); };
  }, []);

  return (
    <div className="landing">
      <canvas ref={starsRef} className="landing-stars" aria-hidden="true" />

      <header className="land-nav">
        <span className="land-logo">⭐ Silvestar</span>
        <button className="btn primary" onClick={onEnter}>Sign in</button>
      </header>

      <section className="land-hero">
        <h1>
          Your files, docs and AI<br />
          <span className="land-grad">in one private platform</span>
        </h1>
        <p>
          Silvestar is a personal knowledge OS: a file library that the AI can actually read,
          an encrypted vault for secrets, and answers with citations — free forever, no card.
        </p>
        <div className="land-cta">
          <button className="btn primary big" onClick={onSignup}>Create free account</button>
          <button className="btn ghost big" onClick={onEnter}>I already have one</button>
        </div>
        <div className="land-badges">
          <span>✓ No credit card</span>
          <span>✓ Nothing expires</span>
          <span>✓ Your data, exportable</span>
          <span>✓ Works offline (PWA)</span>
        </div>
      </section>

      <section className="land-grid">
        {FEATURES.map((f) => (
          <div className="land-card" key={f.title}>
            <div className="land-ic">{f.icon}</div>
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </div>
        ))}
      </section>

      <section className="land-foot">
        <span>⭐ Silvestar — free-for-life personal AI platform</span>
        <a href="https://silvestargeo-hue.github.io/jarvis-os/" target="_blank" rel="noopener noreferrer">
          🛰 Try JARVIS OS, the companion desktop →
        </a>
      </section>
    </div>
  );
}
