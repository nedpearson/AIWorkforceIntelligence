import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { headers } from "next/headers";
import { ThemeGuard } from "@/components/theme-guard";

// Self-hosted (OFL, src/app/fonts/LICENSE-*): next/font/google fetched from Google at build time and repeatedly failed
// on GitHub Actions runners ("An error occurred in next/font"), breaking CI.
const inter = localFont({ src: "./fonts/inter-latin-var.woff2", variable: "--font-inter", display: "swap", weight: "100 900" });
const jakarta = localFont({ src: "./fonts/plus-jakarta-sans-latin-var.woff2", variable: "--font-jakarta", display: "swap", weight: "200 800" });

export const metadata: Metadata = {
  title: { default: "BridgeBox AI Workforce Intelligence", template: "%s · BridgeBox" },
  description: "Discover. Automate. Optimize. Prove. Evidence-backed AI transformation for the enterprise.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: [{ media: "(prefers-color-scheme: light)", color: "#F8FAFC" }, { media: "(prefers-color-scheme: dark)", color: "#071426" }] };

/** Applies the saved theme before paint (light | dark | present; default follows the OS). */
const themeScript = `(function(){try{var t=localStorage.getItem('bb-theme');if(!t){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})()`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // CSP nonce from src/middleware.ts (reading headers() makes every page dynamic, which a per-request nonce requires).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jakarta.variable}`}>
      <head><script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body className="min-h-screen"><ThemeGuard />{children}</body>
    </html>
  );
}
