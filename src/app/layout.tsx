import type { Metadata, Viewport } from "next";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { headers } from "next/headers";
import { ThemeGuard } from "@/components/theme-guard";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-jakarta", display: "swap", weight: ["500", "600", "700", "800"] });

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
