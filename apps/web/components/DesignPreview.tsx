"use client";

/** AI Design preview — renders generated HTML in a sandboxed iframe
 * (scripts disabled) with device-size toggles. */
import { useState } from "react";
import { toast } from "@/lib/kit";

const SIZES: Record<string, string> = {
  "📱": "390px",
  "📲": "768px",
  "🖥": "100%",
};

export function DesignPreview({ html, colors }: { html: string; colors: string[] }) {
  const [size, setSize] = useState("📱");
  const [tab, setTab] = useState<"preview" | "code">("preview");

  const copyHtml = async () => {
    try {
      await navigator.clipboard.writeText(html);
      toast("HTML copied ✓", "ok");
    } catch { toast("Copy failed", "err"); }
  };

  const downloadHtml = () => {
    const blob = new Blob([html], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "silvestar-design.html";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span style={{ display: "flex", gap: 6 }}>
          {Object.keys(SIZES).map((s) => (
            <button key={s} className={`btn tiny ${size === s ? "primary" : "ghost"}`} onClick={() => setSize(s)}>{s}</button>
          ))}
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          {colors.length > 0 && colors.map((c) => (
            <span key={c} title={c} style={{ width: 20, height: 20, borderRadius: 6, background: c, border: "1px solid rgba(128,128,128,.4)", display: "inline-block" }} />
          ))}
          <button className="btn tiny ghost" onClick={() => setTab(tab === "preview" ? "code" : "preview")}>
            {tab === "preview" ? "</> Code" : "👁 Preview"}
          </button>
          <button className="btn tiny ghost" onClick={copyHtml}>📋</button>
          <button className="btn tiny ghost" onClick={downloadHtml}>⇩</button>
        </span>
      </div>
      {tab === "preview" ? (
        <iframe
          title="AI design preview"
          srcDoc={html}
          sandbox=""
          style={{
            width: size === "100%" ? "100%" : SIZES[size],
            maxWidth: "100%", height: 480, marginTop: 10,
            border: "1px solid rgba(128,128,128,.3)", borderRadius: 12,
            background: "#fff", margin: "10px auto 0", display: "block",
          }}
        />
      ) : (
        <pre style={{
          maxHeight: 480, overflow: "auto", marginTop: 10, padding: 12,
          background: "rgba(0,0,0,.35)", borderRadius: 12, fontSize: 12,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{html}</pre>
      )}
    </div>
  );
}
