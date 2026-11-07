import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...i: ClassValue[]) { return twMerge(clsx(i)); }
export const fmtUSD = (n: number, opts: { compact?: boolean } = {}) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0, notation: opts.compact ? "compact" : "standard" }).format(n);
export const fmtNum = (n: number, d = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits: d }).format(n);
export const fmtPct = (n: number, d = 0) => `${(n * 100).toFixed(d)}%`;
export const fmtHours = (h: number) => `${fmtNum(h, h < 10 ? 1 : 0)} hrs`;
export const num = (v: unknown): number => (v == null ? 0 : typeof v === "number" ? v : Number(v) || 0);
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
