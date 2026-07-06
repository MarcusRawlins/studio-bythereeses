import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Reeses Studio",
  description: "Private CRM and executive assistant studio for The Reeses.",
  // Phase 15: static PWA manifest (public/manifest.webmanifest) — emits
  // <link rel="manifest">. Inert metadata; installability only, no behavior.
  manifest: "/manifest.webmanifest",
  // Phase 15: iOS "Add to Home Screen" standalone meta (Safari ignores the
  // web manifest for install; it reads these apple-* tags + apple-touch-icon).
  appleWebApp: {
    capable: true,
    title: "Studio",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "64x64" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180" }],
  },
};

// Phase 15: viewport-fit=cover fills the screen incl. the notch/Dynamic Island
// in standalone mode. themeColor tints the Android/desktop title bar to match
// the app's warm cream (--bg in globals.css).
export const viewport: Viewport = {
  themeColor: "#fbf8f2",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
