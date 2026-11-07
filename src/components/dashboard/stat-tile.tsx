"use client";
import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { CalcTree } from "@/db/schema";
import { BasisChip, Modal, Tooltip } from "@/components/ui";
import { CalcTreeView } from "@/components/calc-tree";
import { cn } from "@/lib/utils";

export type Drill = { tree: CalcTree; meaning: string; basisCounts?: { observed: number; estimated: number; assumed: number } };

/** Count basis tags in a tree (used for the "based on N observed / M estimated / K assumed inputs" line). */
export function basisCounts(tree: CalcTree): { observed: number; estimated: number; assumed: number } {
  const acc = { observed: 0, estimated: 0, assumed: 0 };
  const walk = (n: CalcTree) => { acc[n.basis] += 1; for (const c of n.children ?? []) walk(c); };
  walk(tree); return acc;
}

/** Modal that renders a CalcTree with a plain-English explanation. */
export function DrilldownModal({ open, onClose, title, drill }: { open: boolean; onClose: () => void; title: React.ReactNode; drill: Drill | null }) {
  if (!drill) return null;
  const bc = drill.basisCounts ?? basisCounts(drill.tree);
  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      <div data-testid="drilldown-modal">
        <div className="mb-4 rounded-lg bg-surface-2 p-3 text-sm">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-2">What this means</div>
          <p className="text-ink">{drill.meaning}</p>
          <p className="mt-2 text-xs text-ink-2">Based on <span className="font-medium text-verified">{bc.observed} observed</span>, <span className="font-medium text-projected">{bc.estimated} estimated</span> and <span className="font-medium text-warn">{bc.assumed} assumed</span> inputs. Expand any line to see its formula and source.</p>
        </div>
        <CalcTreeView node={drill.tree} />
      </div>
    </Modal>
  );
}

/** Clickable KPI tile. `drill` opens the calculation; `href` navigates instead. Never a dead card. */
export function StatTile({ label, value, caption, hint, basis, tone = "ink", testid, drill, href, size = "md", className, children }: {
  label: string; value: React.ReactNode; caption?: React.ReactNode; hint?: string; basis?: "observed" | "estimated" | "assumed";
  tone?: "ink" | "projected" | "verified" | "money" | "warn" | "brand"; testid: string; drill?: Drill; href?: string; size?: "md" | "lg"; className?: string; children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const toneCls = { ink: "text-ink", projected: "text-projected", verified: "text-verified", money: "text-money", warn: "text-warn", brand: "text-brand" }[tone];
  const body = (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <div className="flex items-center gap-1 text-xs text-ink-2">{label}{hint && <Tooltip text={hint} />}</div>
        {basis && <span className="shrink-0"><BasisChip basis={basis} /></span>}
      </div>
      <div className={cn("mt-1 font-semibold tabular tracking-tight", size === "lg" ? "text-3xl sm:text-4xl" : "text-2xl", toneCls)}>{value}</div>
      {caption && <div className="mt-1 text-xs text-ink-2">{caption}</div>}
      {children}
      <div className="mt-2 flex items-center gap-0.5 text-[11px] text-ink-3 group-hover:text-brand">{drill ? "How is this calculated?" : "Open"}<ChevronRight size={12} /></div>
    </>
  );
  const cls = cn("card group block w-full p-4 text-left transition hover:border-brand/50 hover:shadow-pop focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-2", className);
  if (href && !drill) return <Link href={href} data-testid={testid} className={cls}>{body}</Link>;
  return (
    <>
      <button type="button" data-testid={testid} className={cls} onClick={() => setOpen(true)}>{body}</button>
      {drill && <DrilldownModal open={open} onClose={() => setOpen(false)} title={label} drill={drill} />}
    </>
  );
}

/** Horizontal meter: fill colour follows severity (good → warn → danger) by `invert`. */
export function Meter({ value, label, invert, testid }: { value: number; label: string; invert?: boolean; testid?: string }) {
  const v = Math.max(0, Math.min(100, value));
  const good = invert ? v < 34 : v >= 66; const bad = invert ? v >= 66 : v < 34;
  const color = good ? "var(--color-money)" : bad ? "var(--color-danger)" : "var(--color-warn)";
  return (
    <div className="min-w-[96px]" data-testid={testid} title={`${label}: ${Math.round(v)} / 100`}>
      <div className="flex justify-between text-[10px] text-ink-2"><span>{label}</span><span className="tabular">{Math.round(v)}</span></div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full" style={{ width: `${v}%`, background: color }} /></div>
    </div>
  );
}
