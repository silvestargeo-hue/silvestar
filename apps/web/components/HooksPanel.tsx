"use client";

/** HooksPanel — your personal webhook: token, copy-paste URLs, Termux CLI
 * snippet and the recent-calls audit log. */
import { useCallback, useEffect, useState } from "react";
import { copyText, toast } from "@/lib/kit";

const API = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type HooksMe = {
  token: string; calls: number;
  urls: { note: string; reminder: string; ask: string };
  recent: { action: string; detail: string; ok: boolean; ts: number }[];
};

export function HooksPanel({ authToken }: { authToken: string }) {
  const [me, setMe] = useState<HooksMe | null>(null);
  const h = (): Record<string, string> => (authToken ? { Authorization: `Bearer ${authToken}` } : {});

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/v1/hooks/me`, { headers: h() });
      if (r.ok) setMe(await r.json());
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  useEffect(() => { load(); }, [load]);

  const rotate = async () => {
    if (!confirm("Rotate the token? Old links stop working.")) return;
    const r = await fetch(`${API}/api/v1/hooks/me/rotate`, { method: "POST", headers: h() });
    if (r.ok) { toast("Token rotated ✓", "ok"); load(); }
  };

  const copy = (t: string) => { copyText(t); toast("Copied ✓", "ok"); };

  const termux = me ? `# Silvestar CLI for Termux — save as ~/bin/sv && chmod +x
SV_TOKEN="${me.token}"
SV_API="${API}"
case "\$1" in
  note)  curl -s "\\"\$SV_API/hooks/n?t=\$SV_TOKEN&text=\$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "\$2")\\"" ;;
  ask)   curl -s "\\"\$SV_API/hooks/a?t=\$SV_TOKEN&text=\$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "\$2")\\"" ;;
  rem)   curl -s "\\"\$SV_API/hooks/r?t=\$SV_TOKEN&text=\$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "\$2")&in_minutes=\${3:-30}\\"" ;;
  *)     echo "usage: sv note \\"text\\" | sv ask \\"question\\" | sv rem \\"text\\" [minutes]" ;;
esac` : "";

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>🪝 Personal Webhook</b>
        {me && <span className="muted small">{me.calls} calls</span>}
      </div>
      <div className="hint">Push into Silvestar from anything — Android Shortcuts, Tasker, IFTTT, cron, or your Termux. Notes land in Library → Inbox/.</div>
      {!me ? (
        <div className="muted small">Loading…</div>
      ) : (
        <>
          <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            <code className="small" style={{ background: "rgba(138,5,255,.12)", padding: "4px 8px", borderRadius: 6 }}>{me.token.slice(0, 12)}…{me.token.slice(-4)}</code>
            <button className="btn tiny ghost" onClick={() => copy(me.urls.note)}>📋 Copy note URL</button>
            <button className="btn tiny ghost" onClick={() => copy(me.urls.reminder)}>📋 Reminder URL</button>
            <button className="btn tiny ghost" onClick={() => copy(me.urls.ask)}>📋 Ask URL</button>
            <button className="btn tiny danger" onClick={rotate}>♻ Rotate</button>
          </div>
          <details style={{ marginTop: 10 }}>
            <summary className="btn ghost tiny" style={{ cursor: "pointer" }}>📱 Termux CLI setup</summary>
            <pre style={{ marginTop: 8, padding: 10, background: "rgba(0,0,0,.35)", borderRadius: 10, fontSize: 11, overflowX: "auto", whiteSpace: "pre-wrap" }}>{termux}</pre>
            <div className="muted small">Paste into Termux, then: <code>sv note &quot;idea!&quot;</code> · <code>sv ask &quot;what is due today?&quot;</code> · <code>sv rem &quot;call mom&quot; 45</code></div>
          </details>
          {me.recent.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <b className="small">Recent calls</b>
              {me.recent.slice(0, 5).map((c, i) => (
                <div key={i} className="muted small">
                  {c.ok ? "✅" : "⚠️"} {c.action} — {c.detail} · {new Date(c.ts * 1000).toLocaleTimeString()}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
