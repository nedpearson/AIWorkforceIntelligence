"use client";
import * as React from "react";
import { Card, Tooltip } from "@/components/ui";

/** Card wrapper for every chart: title, plain-English subtitle, optional help tooltip, legend row, fixed height. */
export function ChartFrame({ title, subtitle, help, legend, testid, children, height = 220, action }: {
  title: string; subtitle?: string; help?: string; legend?: { label: string; color: string; dashed?: boolean }[]; testid: string; children: React.ReactNode; height?: number; action?: React.ReactNode;
}) {
  return (
    <Card data-testid={testid} className="flex flex-col">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">{title}{help && <Tooltip text={help} />}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-ink-2">{subtitle}</p>}
        </div>
        {action}
      </div>
      {legend && legend.length > 1 && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2" aria-label="Legend">
          {legend.map((l) => <li key={l.label} className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: l.dashed ? "transparent" : l.color, border: l.dashed ? `2px dashed ${l.color}` : undefined }} />{l.label}</li>)}
        </ul>
      )}
      <div style={{ height }} className="w-full">{children}</div>
    </Card>
  );
}

/** Plain-English tooltip body used by all Recharts charts. */
export function ChartTip({ active, label, rows }: { active?: boolean; label?: React.ReactNode; rows: { name: string; value: string; color?: string }[] }) {
  if (!active || !rows.length) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-pop">
      {label && <div className="mb-1 font-semibold text-ink">{label}</div>}
      {rows.map((r) => <div key={r.name} className="flex items-center gap-2 text-ink-2"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: r.color ?? "var(--color-ink-3)" }} />{r.name}: <span className="tabular font-medium text-ink">{r.value}</span></div>)}
    </div>
  );
}
