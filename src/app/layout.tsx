import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = { title: { default: "BridgeBox AI Workforce Intelligence", template: "%s · BridgeBox" }, description: "Turn real workplace activity into evidence-backed automation savings." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f766e" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en" suppressHydrationWarning><body className="min-h-screen">{children}</body></html>);
}
