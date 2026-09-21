import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Silvestar Platform",
  description:
    "Archive Library, Personal Vault, cross-library RAG, realtime rooms, knowledge graph, and the Silvestar AI assistant.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
