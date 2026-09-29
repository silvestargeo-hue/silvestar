"use client";

import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{
      minHeight: "100vh", display: "grid", placeItems: "center", textAlign: "center",
      background: "var(--bg)", color: "var(--text)", padding: 24,
    }}>
      <div>
        <div style={{ fontSize: 64 }}>⭐</div>
        <h1 style={{ fontSize: 28, margin: "12px 0 6px" }}>Page not found</h1>
        <p style={{ color: "var(--muted)", margin: "0 0 18px" }}>
          This corner of Silvestar doesn&apos;t exist — but everything else does.
        </p>
        <Link href="/" className="btn primary" style={{ display: "inline-block" }}>
          Take me home
        </Link>
      </div>
    </div>
  );
}
