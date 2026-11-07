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
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg"; href?: string; loading?: boolean };
export function Button({ className, variant = "primary", size = "md", href, loading, children, disabled, ...p }: BtnProps) {
  const cls = cn(
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-2 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap",
    size === "sm" ? "h-8 px-3 text-xs" : size === "lg" ? "h-11 px-5 text-sm" : "h-9 px-4 text-sm",
    variant === "primary" && "bg-brand text-white hover:bg-brand/90 shadow-sm",
    variant === "secondary" && "bg-surface border border-border text-ink hover:bg-surface-2",
    variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
    variant === "danger" && "bg-danger text-white hover:bg-danger/90",
    className,
  );
  if (href) { const { type: _t, disabled: _d, onClick: _o, ...rest } = p as Record<string, unknown>; void _t; void _d; void _o; return <Link href={href} className={cls} {...(rest as object)}>{children}</Link>; }
  return <button className={cls} disabled={disabled || loading} {...p}>{loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />}{children}</button>;
}
export function Badge({ children, tone = "neutral", className }: { children: React.ReactNode; tone?: "neutral" | "brand" | "money" | "warn" | "danger" | "info" | "verified" | "projected"; className?: string }) {
  const t: Record<string, string> = { neutral: "bg-surface-2 text-ink-2", brand: "bg-brand-soft text-brand", money: "bg-money-soft text-money", warn: "bg-warn-soft text-warn", danger: "bg-danger-soft text-danger", info: "bg-info-soft text-info", verified: "bg-verified-soft text-verified", projected: "bg-projected-soft text-projected" };
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", t[tone], className)}>{children}</span>;
}
/** Basis chip: observed / estimated / assumed — required next to every analytical number. */
export function BasisChip({ basis }: { basis: "observed" | "estimated" | "assumed" }) {
  const tone = basis === "observed" ? "verified" : basis === "estimated" ? "projected" : "warn";
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
  React.useEffect(() => { const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); if (open) window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className={cn("card max-h-[92vh] w-full overflow-y-auto rounded-b-none sm:rounded-b-[var(--radius-card)] fade-up", wide ? "sm:max-w-4xl" : "sm:max-w-xl")} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-2 hover:bg-surface-2"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
export function Tooltip({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <span className="group relative inline-flex items-center">
      {children ?? <Info size={14} className="text-ink-3" />}
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 w-56 -translate-x-1/2 rounded-md bg-ink px-2.5 py-1.5 text-[11px] leading-snug text-white opacity-0 shadow-pop transition group-hover:opacity-100 group-focus-within:opacity-100">{text}</span>
    </span>
  );
}
export function Empty({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center"><p className="text-sm font-semibold">{title}</p>{body && <p className="max-w-md text-xs text-ink-2">{body}</p>}{action}</div>;
}
export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>{subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}</div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("card overflow-x-auto scrollbar-thin p-0", className)}><table className="w-full text-sm">{children}</table></div>;
}
export const Th = ({ children, className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) => <th className={cn("whitespace-nowrap border-b border-border bg-surface-2 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-2", className)} {...p}>{children}</th>;
export const Td = ({ children, className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn("border-b border-border px-4 py-2.5 align-middle", className)} {...p}>{children}</td>;
