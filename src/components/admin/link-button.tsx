"use client";
/** Link styled as a Button that keeps data-testid and other anchor attributes (the ui Button drops them when href is set). */
import Link from "next/link";
import { cn } from "@/lib/utils";
export function LinkButton({ href, variant = "primary", size = "md", className, children, ...p }: { href: string; variant?: "primary" | "secondary" | "ghost"; size?: "sm" | "md" | "lg"; className?: string; children: React.ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <Link href={href} className={cn(
      "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-2 whitespace-nowrap",
      size === "sm" ? "h-8 px-3 text-xs" : size === "lg" ? "h-11 px-5 text-sm" : "h-9 px-4 text-sm",
      variant === "primary" && "bg-brand text-white hover:bg-brand/90 shadow-sm",
      variant === "secondary" && "bg-surface border border-border text-ink hover:bg-surface-2",
      variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
      className)} {...p}>{children}</Link>
  );
}
