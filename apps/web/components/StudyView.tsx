"use client";

/** Study Mode — AI flashcards from your documents + spaced repetition. */
import { useCallback, useEffect, useState } from "react";
import { toast } from "@/lib/kit";
import { useI18n } from "@/lib/i18n";

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type Deck = { name: string; cards: number; due: number };
type Card = { id: string; front: string; back: string; reps: number };

export function StudyView({ authToken, userId }: { authToken: string; userId: string }) {
  const { t } = useI18n();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [reviewing, setReviewing] = useState<{ deck: string; cards: Card[] } | null>(null);
  const [idx, setIdx] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [done, setDone] = useState(0);
  const authH = (): Record<string, string> => (authToken ? { Authorization: `Bearer ${authToken}` } : {});

  const loadDecks = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/v1/study/decks`, { headers: authH() });
      setDecks((await r.json()).decks || []);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  useEffect(() => { loadDecks(); }, [loadDecks]);

  const generate = async () => {
    if (!title.trim() || !text.trim() || genBusy) return;
    setGenBusy(true);
    try {
      const q = `title=${encodeURIComponent(title.trim())}&count=10`;
      const r = await fetch(`${API}/api/v1/study/generate?${q}`, {
        method: "POST", headers: { ...authH(), "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim().slice(0, 12000) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || `${r.status}`);
      toast(`${t("cardsMade")}: ${j.added}`, "ok");
      setTitle(""); setText("");
      loadDecks();
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "err");
    } finally { setGenBusy(false); }
  };

  const startReview = async (deck: string) => {
    try {
      const r = await fetch(`${API}/api/v1/study/due?deck=${encodeURIComponent(deck)}`, { headers: authH() });
      const j = await r.json();
      if (!j.cards?.length) { toast(t("nothingDue"), "ok"); return; }
      setReviewing({ deck, cards: j.cards }); setIdx(0); setShowBack(false); setDone(0);
    } catch { toast("Failed to load cards", "err"); }
  };

  const grade = async (g: number) => {
    if (!reviewing) return;
    const card = reviewing.cards[idx];
    try {
      await fetch(`${API}/api/v1/study/review?card_id=${encodeURIComponent(card.id)}&grade=${g}`, {
        method: "POST", headers: authH(),
      });
    } catch {}
    setDone((d) => d + 1);
    if (idx + 1 >= reviewing.cards.length) {
      toast(`${t("sessionDone")} (${done + 1})`, "ok");
      // 🎉 confetti burst on session complete
      try {
        const colors = ["#8a05ff", "#22c55e", "#f59e0b", "#ef4444", "#3b82f6"];
        for (let i = 0; i < 28; i++) {
          const c = document.createElement("span");
          c.textContent = "🎉";
          c.style.cssText = `position:fixed;z-index:99999;left:${45 + Math.random() * 10}vw;top:38vh;font-size:${12 + Math.random() * 14}px;pointer-events:none;transition:transform 1.1s cubic-bezier(.2,.7,.3,1),opacity 1.1s;opacity:1`;
          document.body.appendChild(c);
          requestAnimationFrame(() => {
            c.style.transform = `translate(${(Math.random() - 0.5) * 90}vw, ${20 + Math.random() * 45}vh) rotate(${(Math.random() - 0.5) * 720}deg)`;
            c.style.opacity = "0";
          });
          setTimeout(() => c.remove(), 1300);
        }
      } catch { /* decorative only */ }
      setReviewing(null);
      loadDecks();
    } else {
      setIdx(idx + 1); setShowBack(false);
    }
  };

  const deleteDeck = async (deck: string) => {
    if (!confirm(`Delete deck "${deck}"?`)) return;
    await fetch(`${API}/api/v1/study/decks/${encodeURIComponent(deck)}`, { method: "DELETE", headers: authH() });
    loadDecks();
  };

  // ------------------------------------------------------ review session --
  if (reviewing) {
    const card = reviewing.cards[idx];
    return (
      <div className="view">
        <div className="view-head"><div><h2>🃏 {reviewing.deck}</h2>
          <p className="muted">{idx + 1} / {reviewing.cards.length}</p></div></div>
        <div className="card" style={{ minHeight: 180, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{card.front}</div>
          {showBack && <div style={{ marginTop: 14, borderTop: "1px solid rgba(128,128,128,.3)", paddingTop: 12 }}>{card.back}</div>}
        </div>
        {!showBack ? (
          <button className="btn primary" onClick={() => setShowBack(true)}>{t("showAnswer")}</button>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn danger" onClick={() => grade(0)}>😐 {t("gAgain")}</button>
            <button className="btn ghost" onClick={() => grade(1)}>😣 {t("gHard")}</button>
            <button className="btn primary" onClick={() => grade(2)}>🙂 {t("gGood")}</button>
            <button className="btn ghost" onClick={() => grade(3)}>😎 {t("gEasy")}</button>
          </div>
        )}
      </div>
    );
  }

  // ------------------------------------------------------------ deck list --
  return (
    <div className="view">
      <div className="view-head"><div><h2>🃏 {t("study")}</h2>
        <p className="muted">{t("studyHint")}</p></div></div>

      <div className="card" style={{ marginBottom: 14 }}>
        <b>✨ {t("makeDeck")}</b>
        <div className="row" style={{ marginTop: 8 }}>
          <input value={title} placeholder={t("deckName")} onChange={(e) => setTitle(e.target.value)} style={{ maxWidth: 200 }} />
        </div>
        <textarea value={text} placeholder={t("deckSource")}
          onChange={(e) => setText(e.target.value)}
          style={{ width: "100%", minHeight: 90, marginTop: 8, background: "transparent", color: "inherit", border: "1px solid var(--border,#444)", borderRadius: 8, padding: 8 }} />
        <button className="btn primary" style={{ marginTop: 8 }} disabled={genBusy || !title.trim() || !text.trim()} onClick={generate}>
          {genBusy ? "⏳" : "🃏 " + t("makeDeck")}
        </button>
      </div>

      {decks.length === 0 ? (
        <div className="empty"><div className="big">🃏</div><p>{t("noDecks")}</p></div>
      ) : decks.map((d) => (
        <div key={d.name} className="card" style={{ marginBottom: 8 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>
              <b>{d.name}</b>
              <span className="muted small"> · {d.cards} {t("cardsWord")} · <b style={{ color: d.due ? "#b98cff" : undefined }}>{d.due} {t("dueWord")}</b></span>
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              <button className="btn tiny primary" disabled={!d.due} onClick={() => startReview(d.name)}>▶ {t("review")}</button>
              <button className="btn tiny danger" onClick={() => deleteDeck(d.name)}>🗑</button>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
