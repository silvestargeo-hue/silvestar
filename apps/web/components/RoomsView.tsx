"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

interface ChatLine {
  user: string;
  text: string;
  me: boolean;
}

export function RoomsView({ userId }: { userId: string }) {
  const [room, setRoom] = useState("lounge");
  const [joined, setJoined] = useState(false);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState("");
  const [users, setUsers] = useState<string[]>([]);
  const [tk, setTk] = useState<{ mode: string; url: string } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const API_WS = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/^http/, "ws");

  const join = () => {
    if (joined) return;
    const ws = new WebSocket(`${API_WS}/ws/${encodeURIComponent(room)}?user=${encodeURIComponent(userId)}`);
    wsRef.current = ws;
    ws.onopen = () => {
      setJoined(true);
      setLines((l) => [...l, { user: "system", text: `joined #${room}`, me: false }]);
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "chat") setLines((l) => [...l.slice(-200), { user: m.user, text: m.text, me: m.user === userId }]);
        else if (m.type === "presence") setUsers(m.users || []);
        else if (m.type === "error") setLines((l) => [...l, { user: "system", text: m.error, me: false }]);
      } catch {}
    };
    ws.onclose = () => {
      setJoined(false);
      setUsers([]);
    };
  };

  const leave = () => {
    wsRef.current?.close();
    wsRef.current = null;
    setJoined(false);
  };

  const send = () => {
    if (!draft.trim() || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "chat", text: draft.trim() }));
    setDraft("");
  };

  useEffect(() => {
    return () => wsRef.current?.close();
  }, []);

  const getMediaToken = async () => {
    const r = await api.roomToken(room, userId);
    setTk({ mode: r.mode, url: r.url });
  };

  return (
    <div className="grid2">
      <div className="card">
        <h2>🎙 Realtime room</h2>
        <div className="hint">
          Native WebSocket chat with presence + flood control. Media rooms use LiveKit tokens when configured,
          otherwise P2P signaling relay.
        </div>
        <div className="row">
          <input value={room} onChange={(e) => setRoom(e.target.value)} disabled={joined} />
          {!joined ? <button onClick={join}>Join</button> : <button className="danger" onClick={leave}>Leave</button>}
          <button className="ghost" onClick={getMediaToken}>Get media token</button>
        </div>
        {tk && (
          <div className="hint">
            media mode: <b>{tk.mode}</b>
            {tk.url ? ` · ${tk.url}` : " · connect via /ws signaling"}
          </div>
        )}
        {users.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {users.map((u) => (
              <span key={u} className="tag">{u}</span>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Chat {joined ? `#${room}` : ""}</h2>
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {lines.map((l, i) => (
            <div key={i} className={`chatmsg ${l.me ? "me" : ""}`}>
              <div className="who">{l.user}</div>
              <div>{l.text}</div>
            </div>
          ))}
          {lines.length === 0 && <div className="hint">No messages yet.</div>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <input
            value={draft}
            placeholder={joined ? "Message…" : "Join a room first"}
            disabled={!joined}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button onClick={send} disabled={!joined}>Send</button>
        </div>
      </div>
    </div>
  );
}
