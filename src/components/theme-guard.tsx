"use client";
import * as React from "react";

/**
 * Defense in depth for the theme: the inline script in the root layout sets `data-theme` on <html> before paint, but
 * if React ever has to client-render the root (e.g. after a hydration error) it rewrites <html>'s attributes from the
 * React tree and the attribute is lost. This re-applies the stored choice (or the OS preference) after mount.
 * It does not hide the underlying error: hydration errors still surface as page errors and fail
 * tests/e2e/hydration.spec.ts.
 */
export function ThemeGuard() {
  React.useEffect(() => {
    const el = document.documentElement;
    if (el.getAttribute("data-theme")) return;
    let t: string | null = null;
    try { t = localStorage.getItem("bb-theme"); } catch {}
    if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    el.setAttribute("data-theme", t);
  }, []);
  return null;
}
