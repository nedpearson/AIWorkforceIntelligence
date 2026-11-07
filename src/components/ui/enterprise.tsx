"use client";
/**
 * Enterprise component kit — shared by every module. Colors carry meaning everywhere:
 *   gold = financial opportunity / projected · emerald = verified / realized · purple = AI · cyan = automation
 *   coral = risk · royal = navigation / primary · indigo = premium highlight.
 */
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Download, X, ArrowUpRight, ArrowDownRight, Filter, Check, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { BasisChip } from "./index";

export type Accent = "royal" | "purple" | "cyan" | "emerald" | "gold" | "coral" | "indigo" | "midnight";
const ACCENT_BAR: Record<Accent, string> = { royal: "from-royal to-indigo", purple: "from-purple to-indigo", cyan: "from-cyan to-royal", emerald: "from-emerald to-cyan", gold: "from-gold to-coral", coral: "from-coral to-purple", indigo: "from-indigo to-purple", midnight: "from-midnight to-royal" };
const ACCENT_TILE: Record<Accent, string> = { royal: "bg-royal-soft text-royal-ink", purple: "bg-purple-soft text-purple-ink", cyan: "bg-cyan-soft text-cyan-ink", emerald: "bg-emerald-soft text-emerald-ink", gold: "bg-gold-soft text-gold-ink", coral: "bg-coral-soft text-coral-ink", indigo: "bg-indigo-soft text-indigo-ink", midnight: "bg-surface-2 text-ink" };
const ACCENT_TEXT: Record<Accent, string> = { royal: "text-royal-ink", purple: "text-purple-ink", cyan: "text-cyan-ink", emerald: "text-emerald-ink", gold: "text-gold-ink", coral: "text-coral-ink", indigo: "text-indigo-ink", midnight: "text-ink" };
export const ACCENT_HEX: Record<Accent, string> = { royal: "#2563EB", purple: "#8B5CF6", cyan: "#06B6D4", emerald: "#10B981", gold: "#F59E0B", coral: "#F43F5E", indigo: "#6366F1", midnight: "#071426" };

function usePrefersReducedMotion() {
  const [r, setR] = React.useState(false);
  React.useEffect(() => { const m = window.matchMedia("(prefers-reduced-motion: reduce)"); setR(m.matches); const h = () => setR(m.matches); m.addEventListener("change", h); return () => m.removeEventListener("change", h); }, []);
  return r;
}
/** Counts up to `value` (eased, 700ms). Respects reduced motion. Renders the final value on the server. */
export function AnimatedNumber({ value, format, duration = 700 }: { value: number; format: (n: number) => string; duration?: number }) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = React.useState(value);
  const prev = React.useRef(value);
  React.useEffect(() => {
    if (reduced) { setShown(value); prev.current = value; return; }
    const from = prev.current === value ? 0 : prev.current; const start = performance.now(); let raf = 0;
    const tick = (t: number) => { const k = Math.min(1, (t - start) / duration); const e = 1 - Math.pow(1 - k, 3); setShown(from + (value - from) * e); if (k < 1) raf = requestAnimationFrame(tick); else prev.current = value; };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [value, duration, reduced]);
  return <span className="tabular">{format(shown)}</span>;
}

/** Large financial KPI card. Clickable (onClick or href) → drill-down. Accent conveys meaning (see header). */
export function KpiCard({ label, value, format, accent = "royal", basis, caption, icon, onClick, href, trend, size = "md", testid, hint, emptyText }: {
  label: string; value: number | null; format: (n: number) => string; accent?: Accent; basis?: "observed" | "estimated" | "assumed"; caption?: React.ReactNode; icon?: React.ReactNode;
  onClick?: () => void; href?: string; trend?: { delta: number; label: string; goodWhenUp?: boolean }; size?: "md" | "lg"; testid?: string; hint?: string; emptyText?: React.ReactNode;
}) {
  const body = (
    <>
      <div className={cn("absolute inset-x-0 top-0 h-1 rounded-t-[var(--radius-card)] bg-gradient-to-r", ACCENT_BAR[accent])} />
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {icon && <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", ACCENT_TILE[accent])}>{icon}</span>}
          <span className="text-[12px] font-semibold leading-tight text-ink-2" title={hint}>{label}</span>
        </div>
        {basis && <BasisChip basis={basis} />}
      </div>
      <div className={cn("mt-3 font-display font-bold tracking-tight", size === "lg" ? "text-[2rem] leading-none sm:text-[2.35rem]" : "text-2xl", value == null ? "text-ink-3" : ACCENT_TEXT[accent])}>
        {value == null ? (emptyText ?? "—") : <AnimatedNumber value={value} format={format} />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
        {trend && <span className={cn("inline-flex items-center gap-0.5 font-semibold", (trend.delta >= 0) === (trend.goodWhenUp ?? true) ? "text-emerald-ink" : "text-coral-ink")}>{trend.delta >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{trend.label}</span>}
        {caption && <span className="min-w-0">{caption}</span>}
      </div>
      {(onClick || href) && <div className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-royal-ink opacity-80 group-hover:opacity-100">How is this calculated? <ChevronRight size={12} /></div>}
    </>
  );
  const cls = cn("card card-hover group relative block w-full overflow-hidden p-5 text-left", size === "lg" && "sm:p-6");
  if (href) return <Link href={href} className={cls} data-testid={testid}>{body}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={cls} data-testid={testid}>{body}</button>;
  return <div className={cls} data-testid={testid}>{body}</div>;
}

/** Colored section header used inside pages. */
export function SectionHeader({ title, subtitle, accent = "royal", icon, action, id }: { title: React.ReactNode; subtitle?: React.ReactNode; accent?: Accent; icon?: React.ReactNode; action?: React.ReactNode; id?: string }) {
  return (
    <div className="mb-3 mt-8 flex flex-wrap items-end justify-between gap-3 first:mt-0" id={id}>
      <div className="flex items-center gap-3">
        <span className={cn("h-8 w-1.5 rounded-full bg-gradient-to-b", ACCENT_BAR[accent])} />
        {icon && <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg", ACCENT_TILE[accent])}>{icon}</span>}
        <div><h2 className="text-base font-bold tracking-tight sm:text-lg">{title}</h2>{subtitle && <p className="text-xs text-ink-2">{subtitle}</p>}</div>
      </div>
      {action}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, testid }: { tabs: { key: T; label: React.ReactNode; count?: number }[]; value: T; onChange: (k: T) => void; testid?: string }) {
  return (
    <div role="tablist" className="scrollbar-thin -mx-1 mb-4 flex gap-1 overflow-x-auto px-1" data-testid={testid}>
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)} data-testid={testid ? `${testid}-${t.key}` : undefined}
          className={cn("whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-semibold transition", value === t.key ? "bg-midnight text-white shadow-sm dark:bg-royal" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}>
          {t.label}{t.count != null && <span className={cn("ml-1.5 rounded-full px-1.5 text-[10px]", value === t.key ? "bg-white/20" : "bg-surface-2")}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function Segmented<T extends string>({ options, value, onChange, testid, size = "md" }: { options: { key: T; label: React.ReactNode }[]; value: T; onChange: (k: T) => void; testid?: string; size?: "sm" | "md" }) {
  return (
    <div className="inline-flex rounded-xl border border-border bg-surface-2 p-0.5" role="radiogroup" data-testid={testid}>
      {options.map((o) => (
        <button key={o.key} role="radio" aria-checked={value === o.key} onClick={() => onChange(o.key)} data-testid={testid ? `${testid}-${o.key}` : undefined}
          className={cn("rounded-[10px] font-semibold transition", size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm", value === o.key ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink")}>{o.label}</button>
      ))}
    </div>
  );
}

/** 0–100 score ring. */
export function ScoreRing({ score, size = 96, accent, label, sub }: { score: number; size?: number; accent?: Accent; label?: string; sub?: string }) {
  const a: Accent = accent ?? (score >= 70 ? "emerald" : score >= 45 ? "gold" : "coral");
  const r = size / 2 - 7; const c = 2 * Math.PI * r; const pct = Math.max(0, Math.min(100, score)) / 100;
  return (
    <div className="inline-flex flex-col items-center" role="img" aria-label={`${label ?? "Score"} ${Math.round(score)} of 100`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-3)" strokeWidth={7} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ACCENT_HEX[a]} strokeWidth={7} strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} style={{ transition: "stroke-dasharray .7s ease" }} />
        </svg>
        <div className={cn("absolute inset-0 flex items-center justify-center font-display font-bold", size >= 90 ? "text-2xl" : "text-lg", ACCENT_TEXT[a])}>{Math.round(score)}</div>
      </div>
      {label && <div className="mt-1.5 text-xs font-semibold text-ink">{label}</div>}
      {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

export function Meter({ value, max = 100, accent = "royal", label }: { value: number; max?: number; accent?: Accent; label?: string }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className="w-full" aria-label={label} role="meter" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={max}>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3"><div className={cn("h-full rounded-full bg-gradient-to-r", ACCENT_BAR[accent])} style={{ width: `${pct}%`, transition: "width .6s ease" }} /></div>
    </div>
  );
}

export function StatusPill({ status, map }: { status: string; map?: Record<string, Accent> }) {
  const m: Record<string, Accent> = { active: "emerald", deployed: "emerald", verified: "emerald", succeeded: "emerald", done: "emerald", approved: "indigo", live: "emerald", connected: "emerald", pass: "emerald",
    running: "cyan", in_progress: "cyan", measuring: "cyan", reviewing: "purple", configured: "purple", submitted: "purple", analysis_requested: "purple",
    identified: "gold", proposed: "gold", pending: "gold", queued: "gold", not_started: "gold", postponed: "gold", warn: "gold", license_required: "gold", draft: "gold", not_configured: "midnight", available: "royal",
    failed: "coral", error: "coral", rejected: "coral", blocked: "coral", revoked: "coral", fail: "coral", offline: "coral", paused: "gold", closed: "midnight", ...map };
  const a = m[status] ?? "midnight";
  return <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize", ACCENT_TILE[a])}><span className={cn("h-1.5 w-1.5 rounded-full", ["running", "in_progress", "measuring"].includes(status) && "live-dot")} style={{ background: ACCENT_HEX[a] }} />{status.replace(/_/g, " ")}</span>;
}

export function Drawer({ open, onClose, title, children, width = "max-w-xl", testid }: { open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; width?: string; testid?: string }) {
  React.useEffect(() => { const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); if (open) window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-midnight/50 backdrop-blur-[2px]" onClick={onClose} role="dialog" aria-modal="true" data-testid={testid}>
      <div className={cn("h-full w-full overflow-y-auto bg-surface shadow-[var(--shadow-pop)] fade-up", width)} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface/95 px-5 py-4 backdrop-blur">
          <h2 className="text-base font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-2"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/** Client-side export of tabular data to CSV (Excel-compatible) or JSON. */
export function ExportButton({ rows, filename, columns, testid = "export" }: { rows: Record<string, unknown>[]; filename: string; columns?: { key: string; label: string }[]; testid?: string }) {
  const [open, setOpen] = React.useState(false);
  const cols = columns ?? Object.keys(rows[0] ?? {}).map((k) => ({ key: k, label: k }));
  const dl = (content: string, type: string, ext: string) => { const b = new Blob([content], { type }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = `${filename}.${ext}`; a.click(); URL.revokeObjectURL(u); setOpen(false); };
  const csv = () => { const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; dl("﻿" + [cols.map((c) => esc(c.label)).join(","), ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(","))].join("\n"), "text/csv;charset=utf-8", "csv"); };
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm font-semibold text-ink hover:bg-surface-2" data-testid={testid} aria-haspopup="menu" aria-expanded={open}><Download size={15} />Export</button>
      {open && (
        <div role="menu" className="card absolute right-0 z-30 mt-1 w-44 p-1 shadow-[var(--shadow-pop)]">
          <button role="menuitem" onClick={csv} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2" data-testid={`${testid}-csv`}>CSV / Excel</button>
          <button role="menuitem" onClick={() => dl(JSON.stringify(rows, null, 2), "application/json", "json")} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2" data-testid={`${testid}-json`}>JSON</button>
        </div>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) { return <div className={cn("skeleton h-4 w-full", className)} />; }

/** AI-generated insight card: always shows the evidence it was derived from. */
export function InsightCard({ title, body, accent = "purple", evidence, action }: { title: string; body: React.ReactNode; accent?: Accent; evidence?: { label: string; href: string }[]; action?: React.ReactNode }) {
  return (
    <div className="card card-hover relative overflow-hidden p-4">
      <div className={cn("absolute inset-y-0 left-0 w-1 bg-gradient-to-b", ACCENT_BAR[accent])} />
      <div className="flex items-start gap-3 pl-1">
        <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", ACCENT_TILE[accent])}><Sparkles size={14} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">{title}</div>
          <div className="mt-1 text-sm text-ink-2">{body}</div>
          {evidence && evidence.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{evidence.map((e) => <Link key={e.href + e.label} href={e.href} className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-royal-ink hover:underline">{e.label}</Link>)}</div>}
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Global filters — URL search params are the single source of filter state, so every view is
// shareable/bookmarkable and server components can read the same values.
// Keys: bu, dept, loc, role, wf, agent, from, to, scenario, status, risk, savings
// ---------------------------------------------------------------------------------------------
export type FilterOption = { value: string; label: string };
export type FilterDef = { key: string; label: string; options: FilterOption[]; all?: string };
export function FilterBar({ filters, testid = "filter-bar", extra }: { filters: FilterDef[]; testid?: string; extra?: React.ReactNode }) {
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams();
  const set = (key: string, value: string) => { const q = new URLSearchParams(sp.toString()); if (value) q.set(key, value); else q.delete(key); router.push(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }); };
  const active = filters.filter((f) => sp.get(f.key));
  return (
    <div className="card mb-5 flex flex-wrap items-center gap-2 p-2.5" data-testid={testid}>
      <span className="ml-1 inline-flex items-center gap-1.5 text-xs font-semibold text-ink-2"><Filter size={14} />Filters</span>
      {filters.map((f) => (
        <select key={f.key} aria-label={f.label} value={sp.get(f.key) ?? ""} onChange={(e) => set(f.key, e.target.value)} data-testid={`${testid}-${f.key}`}
          className={cn("h-8 max-w-[11rem] rounded-lg border bg-surface px-2 text-xs font-medium", sp.get(f.key) ? "border-royal text-royal-ink" : "border-border text-ink-2")}>
          <option value="">{f.all ?? `All ${f.label.toLowerCase()}`}</option>
          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ))}
      {extra}
      {active.length > 0 && <button onClick={() => { const q = new URLSearchParams(sp.toString()); filters.forEach((f) => q.delete(f.key)); router.push(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }); }} className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-coral-ink hover:bg-coral-soft" data-testid={`${testid}-clear`}><X size={12} />Clear {active.length}</button>}
    </div>
  );
}

/** Checklist row used by evaluation & onboarding flows. */
export function CheckRow({ done, title, body, href, cta }: { done: boolean; title: string; body?: string; href?: string; cta?: string }) {
  return (
    <div className={cn("flex items-start gap-3 rounded-xl border p-3", done ? "border-emerald/30 bg-emerald-soft/40" : "border-border")}>
      <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", done ? "bg-emerald text-white" : "border-2 border-surface-3")}>{done && <Check size={14} />}</span>
      <div className="min-w-0 flex-1"><div className="text-sm font-semibold">{title}</div>{body && <div className="text-xs text-ink-2">{body}</div>}</div>
      {href && !done && <Link href={href} className="shrink-0 text-xs font-semibold text-royal-ink hover:underline">{cta ?? "Open"} →</Link>}
    </div>
  );
}
