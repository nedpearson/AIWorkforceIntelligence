"use client";
/**
 * Command-center widgets: drill-down drawer (CalcTree + meaning + lineage), 7-tier savings waterfall, opportunity heatmap.
 */
import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, ExternalLink } from "lucide-react";
import type { CalcTree } from "@/db/schema";
import type { LineageItem, Tier, TierKey } from "@/engine/savings";
import { CalcTreeView } from "@/components/calc-tree";
import { BasisChip } from "@/components/ui";
import { Drawer } from "@/components/ui/enterprise";
import { cn } from "@/lib/utils";
import { ACCENT_HEX, TYPE_LABEL, fmtValue, type Accent, type Basis, type Fmt } from "./format";

export type Drill = { key: string; title: string; value: number | null; format: Fmt; accent: Accent; basis: Basis; meaning: string; tree: CalcTree; lineage?: (Pick<LineageItem, "label" | "href" | "amount" | "basis"> & { hours?: number; status?: string; type?: string })[]; lineageTitle?: string; cta?: { label: string; href: string } };

const INK: Record<Accent, string> = { royal: "text-royal-ink", purple: "text-purple-ink", cyan: "text-cyan-ink", emerald: "text-emerald-ink", gold: "text-gold-ink", coral: "text-coral-ink", indigo: "text-indigo-ink", midnight: "text-ink" };

export function DrillDrawer({ drill, onClose }: { drill: Drill | null; onClose: () => void }) {
  return (
    <Drawer open={!!drill} onClose={onClose} title={drill?.title ?? ""} testid="drill-drawer" width="max-w-2xl">
      {drill && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className={cn("font-display text-4xl font-bold tracking-tight tabular", drill.value == null ? "text-ink-3" : INK[drill.accent])}>{drill.value == null ? "Not yet measured" : fmtValue(drill.value, drill.format)}</div>
            <BasisChip basis={drill.basis} />
          </div>
          <section className="rounded-xl border border-border bg-surface-2/60 p-4">
            <h3 className="text-xs font-bold uppercase tracking-wide text-ink-2">What this means</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink">{drill.meaning}</p>
            {drill.cta && <Link href={drill.cta.href} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-royal-ink hover:underline" data-testid="drill-cta">{drill.cta.label}<ArrowUpRight size={14} /></Link>}
          </section>
          <section>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-2">How it is calculated</h3>
            <div className="rounded-xl border border-border p-2" data-testid="drill-tree"><CalcTreeView node={drill.tree} /></div>
          </section>
          {drill.lineage && (
            <section>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-2">{drill.lineageTitle ?? "Source records"} <span className="font-normal normal-case text-ink-3">({drill.lineage.length})</span></h3>
              {drill.lineage.length === 0 ? <p className="rounded-xl border border-dashed border-border p-4 text-sm text-ink-2">No source records yet.</p> : (
                <ul className="divide-y divide-border rounded-xl border border-border" data-testid="drill-lineage">
                  {drill.lineage.slice(0, 40).map((l, i) => (
                    <li key={l.href + i}>
                      <Link href={l.href} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-surface-2">
                        <span className="min-w-0 flex-1 truncate font-medium">{l.label}</span>
                        {l.status && <span className="hidden text-[11px] capitalize text-ink-3 sm:inline">{l.status.replace(/_/g, " ")}</span>}
                        {l.hours != null && l.hours > 0 && <span className="tabular text-xs text-ink-2">{fmtValue(l.hours, "hours")}</span>}
                        <span className={cn("tabular text-sm font-semibold", l.amount < 0 ? "text-coral-ink" : "text-ink")}>{fmtValue(l.amount, "usdCompact")}</span>
                        <ExternalLink size={13} className="shrink-0 text-ink-3" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {drill.lineage.length > 40 && <p className="mt-1 text-xs text-ink-3">Showing 40 of {drill.lineage.length}.</p>}
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------------------------
// 7-tier savings waterfall
// ---------------------------------------------------------------------------------------------
const SHORT: Record<TierKey, string> = { potential: "Potential", approved: "Approved", verifiedTime: "Verified time", capacityReleased: "Capacity", costAvoidance: "Avoidance", realizedHard: "Hard savings", net: "Net kept" };
const TIER_ACCENT = (t: Tier): Accent => (t.key === "net" ? (t.amount >= 0 ? "emerald" : "coral") : t.color);

export function SavingsWaterfall({ tiers, order, onOpen }: { tiers: Record<TierKey, Tier>; order: TierKey[]; onOpen: (k: TierKey) => void }) {
  const vals = order.map((k) => tiers[k].amount);
  const max = Math.max(1, ...vals); const min = Math.min(0, ...vals); const span = max - min;
  const H = 210; const zeroY = (max / span) * H;
  const summary = order.map((k) => `${tiers[k].label} ${fmtValue(tiers[k].amount, "usdCompact")}`).join(", ");
  return (
    <div role="group" aria-label={`Savings waterfall: ${summary}`} data-testid="waterfall">
      <div className="relative" style={{ height: H + 28 + (min < 0 ? 22 : 0) }}>
        {[0.25, 0.5, 0.75].map((g) => <div key={g} className="absolute inset-x-0 border-t border-dashed border-border/70" style={{ top: 22 + H * (1 - g) * (max / span) }} />)}
        <div className="absolute inset-x-0 border-t border-ink-3/40" style={{ top: 22 + zeroY }} />
        <div className="absolute inset-0 grid gap-1.5 sm:gap-3" style={{ gridTemplateColumns: `repeat(${order.length}, minmax(0, 1fr))`, top: 0 }}>
          {order.map((k, i) => {
            const t = tiers[k]; const acc = TIER_ACCENT(t); const v = t.amount;
            const top = 22 + (v >= 0 ? zeroY - (v / span) * H : zeroY); const h = Math.max(v === 0 ? 2 : 4, (Math.abs(v) / span) * H);
            return (
              <button key={k} type="button" onClick={() => onOpen(k)} data-testid={`waterfall-${k}`}
                className="group relative h-full rounded-lg outline-offset-2 transition hover:bg-surface-2/60">
                <span className="sr-only">{t.label}: {fmtValue(v, "usd")}. Open drill-down. </span>
                <span className="absolute inset-x-0 text-center text-[10px] font-bold tabular text-ink sm:text-xs" style={{ top: Math.max(0, (v >= 0 ? top : top + h) - (v >= 0 ? 18 : -4)) }}>{fmtValue(v, "usdCompact")}</span>
                <span className="absolute left-1/2 w-[70%] max-w-[64px] -translate-x-1/2 rounded-md transition-all duration-700 group-hover:brightness-110"
                  style={{ top, height: h, background: v === 0 ? "var(--color-surface-3)" : `linear-gradient(180deg, ${ACCENT_HEX[acc]}, ${ACCENT_HEX[acc]}cc)`, boxShadow: v ? `0 8px 18px -10px ${ACCENT_HEX[acc]}` : undefined, transitionDelay: `${i * 40}ms` }} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-2 grid gap-1.5 sm:gap-3" style={{ gridTemplateColumns: `repeat(${order.length}, minmax(0, 1fr))` }}>
        {order.map((k) => (
          <div key={k} className="text-center">
            <div className="mx-auto mb-1 h-1 w-6 rounded-full" style={{ background: ACCENT_HEX[TIER_ACCENT(tiers[k])] }} />
            <div className="break-words text-[9px] font-semibold leading-tight text-ink-2 sm:text-[11px]">{SHORT[k]}</div>
            <div className="mt-0.5 hidden text-[10px] capitalize text-ink-3 sm:block">{tiers[k].basis}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Opportunity heatmap
// ---------------------------------------------------------------------------------------------
export function OpportunityHeatmap({ types, rows, max }: { types: string[]; rows: { departmentId: string | null; name: string; cells: Record<string, { value: number; count: number }> }[]; max: number }) {
  if (!rows.length || !types.length) return <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-ink-2">No opportunities in this view yet.</p>;
  return (
    <div className="scrollbar-thin -mx-1 overflow-x-auto px-1" data-testid="heatmap">
      <table className="w-full min-w-[440px] border-separate border-spacing-1 text-xs" aria-label="Realizable annual savings by department and opportunity type">
        <thead>
          <tr>
            <th className="w-[28%] px-1 text-left text-[11px] font-semibold text-ink-3" scope="col">Department</th>
            {types.map((t) => <th key={t} scope="col" className="px-1 text-center text-[11px] font-semibold text-ink-2">{TYPE_LABEL[t] ?? t}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.departmentId ?? "none"}>
              <th scope="row" className="truncate px-1 text-left text-[12px] font-semibold text-ink">{r.name}</th>
              {types.map((t) => {
                const c = r.cells[t]; const k = c && max > 0 ? c.value / max : 0;
                if (!c) return <td key={t}><div className="flex h-11 items-center justify-center rounded-lg bg-surface-2/60 text-ink-3">—</div></td>;
                const q = new URLSearchParams({ type: t, ...(r.departmentId ? { dept: r.departmentId } : {}) });
                return (
                  <td key={t}>
                    <Link href={`/app/opportunities?${q}`} data-testid={`heat-${r.departmentId ?? "none"}-${t}`}
                      className={cn("heat-gold flex h-11 flex-col items-center justify-center rounded-lg font-bold tabular ring-1 ring-inset ring-gold/20 transition hover:scale-[1.04] hover:ring-gold", k > 0.45 ? "text-midnight dark:text-ink" : "text-ink")}
                      style={{ "--heat-k": k.toFixed(3) } as React.CSSProperties}>
                      <span className="sr-only">{r.name}, {TYPE_LABEL[t] ?? t}: {fmtValue(c.value, "usd")} per year — </span>
                      <span>{fmtValue(c.value, "usdCompact")}</span>
                      <span className="text-[9px] font-medium">{c.count} opp{c.count === 1 ? "" : "s"}</span>
                    </Link>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-end gap-2 text-[10px] text-ink-3"><span>Lower</span><span className="h-2 w-24 rounded-full" style={{ background: "linear-gradient(90deg, rgba(245,158,11,.1), rgba(245,158,11,.95))" }} /><span>Higher realizable $/yr</span></div>
    </div>
  );
}
