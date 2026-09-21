import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastHost } from "@/lib/kit";
import { SWRegister } from "@/components/SWRegister";

export const metadata: Metadata = {
  title: "Silvestar Platform",
  description:
    "Archive Library, Personal Vault, cross-library RAG, realtime rooms, knowledge graph, and the Silvestar AI assistant.",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#7c5cff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ToastHost />
        <SWRegister />
      </body>
    </html>
  );
}
