"use client";
import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { X, Info } from "lucide-react";

export function Card({ className, children, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card p-5", className)} {...p}>{children}</div>;
}
export function CardHeader({ title, subtitle, action, className }: { title: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-4 flex items-start justify-between gap-3", className)}>
      <div><h3 className="text-sm font-semibold text-ink">{title}</h3>{subtitle && <p className="mt-0.5 text-xs text-ink-2">{subtitle}</p>}</div>
      {action}
    </div>
  );
}
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "gradient" | "glass"; size?: "sm" | "md" | "lg"; href?: string; loading?: boolean };
export function Button({ className, variant = "primary", size = "md", href, loading, children, disabled, ...p }: BtnProps) {
  const cls = cn(
    "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap active:scale-[.98]",
    size === "sm" ? "h-8 px-3 text-xs" : size === "lg" ? "h-11 px-5 text-sm" : "h-9 px-4 text-sm",
    variant === "primary" && "bg-royal text-white hover:bg-royal-ink shadow-[0_6px_16px_-6px_rgba(37,99,235,.6)]",
    variant === "gradient" && "bg-[linear-gradient(135deg,#2563eb,#6366f1_55%,#8b5cf6)] text-white shadow-[0_8px_20px_-8px_rgba(99,102,241,.7)] hover:brightness-110",
    variant === "glass" && "bg-white/10 text-white ring-1 ring-white/20 backdrop-blur hover:bg-white/20",
    variant === "secondary" && "bg-surface border border-border text-ink hover:bg-surface-2",
    variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
    variant === "danger" && "bg-danger text-white hover:bg-danger/90",
    className,
  );
  if (href) { const { type: _t, disabled: _d, onClick: _o, ...rest } = p as Record<string, unknown>; void _t; void _d; void _o; return <Link href={href} className={cls} {...(rest as object)}>{children}</Link>; }
  return <button className={cls} disabled={disabled || loading} {...p}>{loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />}{children}</button>;
}
export type Tone = "neutral" | "brand" | "money" | "warn" | "danger" | "info" | "verified" | "projected" | "royal" | "purple" | "cyan" | "emerald" | "gold" | "coral" | "indigo";
export const TONE_CLASS: Record<Tone, string> = { neutral: "bg-surface-2 text-ink-2", brand: "bg-royal-soft text-royal-ink", money: "bg-emerald-soft text-emerald-ink", warn: "bg-gold-soft text-gold-ink", danger: "bg-coral-soft text-coral-ink", info: "bg-cyan-soft text-cyan-ink", verified: "bg-emerald-soft text-emerald-ink", projected: "bg-gold-soft text-gold-ink", royal: "bg-royal-soft text-royal-ink", purple: "bg-purple-soft text-purple-ink", cyan: "bg-cyan-soft text-cyan-ink", emerald: "bg-emerald-soft text-emerald-ink", gold: "bg-gold-soft text-gold-ink", coral: "bg-coral-soft text-coral-ink", indigo: "bg-indigo-soft text-indigo-ink" };
export function Badge({ children, tone = "neutral", className }: { children: React.ReactNode; tone?: Tone; className?: string }) {
  const t = TONE_CLASS;
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", t[tone], className)}>{children}</span>;
}
/** Basis chip: observed / estimated / assumed — required next to every analytical number. */
export function BasisChip({ basis }: { basis: "observed" | "estimated" | "assumed" }) {
  const tone: Tone = basis === "observed" ? "emerald" : basis === "estimated" ? "gold" : "neutral";
  return <Badge tone={tone}>{basis}</Badge>;
}
export function Input({ className, label, hint, error, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }) {
  return (
    <label className="block text-sm">
      {label && <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>}
      <input className={cn("h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20", error && "border-danger", className)} {...p} />
      {hint && !error && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}
export function Select({ className, label, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <label className="block text-sm">
      {label && <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>}
      <select className={cn("h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink focus:border-brand focus:outline-none", className)} {...p}>{children}</select>
    </label>
  );
}
export function Textarea({ className, label, ...p }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }) {
  return (
    <label className="block text-sm">
      {label && <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>}
      <textarea className={cn("w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none", className)} {...p} />
    </label>
  );
}
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  const titleId = React.useId(); const closeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); if (open) window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, onClose]);
  React.useEffect(() => { if (open) closeRef.current?.focus(); }, [open]); // keyboard users land inside the dialog
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={cn("card max-h-[92vh] w-full overflow-y-auto rounded-b-none sm:rounded-b-[var(--radius-card)] fade-up", wide ? "sm:max-w-4xl" : "sm:max-w-xl")} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-5 py-3">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-2 hover:bg-surface-2"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
export function Tooltip({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <span className="group relative inline-flex items-center">
      {children ?? <span tabIndex={0} role="img" aria-label={text} className="inline-flex rounded-full focus-visible:outline-2 focus-visible:outline-royal"><Info size={14} className="text-ink-3" aria-hidden /></span>}
      {/* display:none while hidden — an opacity-0 popover still widens the page at the right edge (horizontal scroll) */}
      <span role="tooltip" aria-hidden className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 hidden w-56 -translate-x-1/2 rounded-lg bg-midnight px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-pop ring-1 ring-white/10 group-hover:block group-focus-within:block">{text}</span>
      {children && <span className="sr-only">{text}</span>}
    </span>
  );
}
export function Empty({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center"><p className="text-sm font-semibold">{title}</p>{body && <p className="max-w-md text-xs text-ink-2">{body}</p>}{action}</div>;
}
/**
 * Page header. Pass `hero` for the signature gradient band (module landing pages); `eyebrow` names the module group;
 * `icon` renders in a tinted tile. Actions sit right on desktop and wrap below on mobile.
 */
export function PageHeader({ title, subtitle, actions, eyebrow, icon, hero, accent = "royal" }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; eyebrow?: string; icon?: React.ReactNode; hero?: boolean; accent?: "royal" | "purple" | "cyan" | "emerald" | "gold" | "coral" | "indigo" }) {
  if (hero) return (
    <div className="bg-hero relative mb-6 overflow-hidden rounded-[20px] px-5 py-6 text-white shadow-[var(--shadow-lift)] sm:px-7 sm:py-7">
      <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(245,158,11,.25),transparent_70%)]" />
      <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-start gap-3">
          {icon && <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/20">{icon}</div>}
          <div>
            {eyebrow && <div className="text-[11px] font-semibold uppercase tracking-[.16em] text-cyan-300">{eyebrow}</div>}
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
            {subtitle && <p className="mt-1 max-w-3xl text-sm text-slate-300">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
  const tile: Record<string, string> = { royal: "bg-royal-soft text-royal-ink", purple: "bg-purple-soft text-purple-ink", cyan: "bg-cyan-soft text-cyan-ink", emerald: "bg-emerald-soft text-emerald-ink", gold: "bg-gold-soft text-gold-ink", coral: "bg-coral-soft text-coral-ink", indigo: "bg-indigo-soft text-indigo-ink" };
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex items-start gap-3">
        {icon && <div className={cn("mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", tile[accent])}>{icon}</div>}
        <div>
          {eyebrow && <div className="text-[11px] font-semibold uppercase tracking-[.14em] text-ink-3">{eyebrow}</div>}
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
          {subtitle && <p className="mt-1 max-w-3xl text-sm text-ink-2">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("card overflow-x-auto scrollbar-thin p-0", className)}><table className="w-full text-sm">{children}</table></div>;
}
export const Th = ({ children, className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) => <th className={cn("whitespace-nowrap border-b border-border bg-surface-2/70 px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-2", className)} {...p}>{children}</th>;
export const Td = ({ children, className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn("border-b border-border/70 px-4 py-3 align-middle", className)} {...p}>{children}</td>;
