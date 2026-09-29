import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastHost } from "@/lib/kit";
import { SWRegister } from "@/components/SWRegister";

const SITE_URL = "https://silvestar-web.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Silvestar Platform",
  description:
    "File Library, encrypted Vault, Archive, and a real AI assistant — free forever, no card required.",
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "⭐ Silvestar — your AI platform",
    description: "Files · Vault · Archive · real AI. Free forever.",
    url: SITE_URL,
    siteName: "Silvestar",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Silvestar Platform" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "⭐ Silvestar — your AI platform",
    description: "Files · Vault · Archive · real AI. Free forever.",
    images: ["/og-image.png"],
  },
  icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
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
