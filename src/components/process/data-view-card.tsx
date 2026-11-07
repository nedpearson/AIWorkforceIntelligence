"use client";
/**
 * Chart card with a "View data" toggle (chart ⇄ accessible table) and CSV/JSON export.
 * Every chart on Business Intelligence and Process Mining is wrapped in this so the numbers are always inspectable.
 */
import * as React from "react";
import { Table as TableIcon, BarChart3 } from "lucide-react";
import { Card, Table, Th, Td, Tooltip } from "@/components/ui";
import { ExportButton } from "@/components/ui/enterprise";
import { cn } from "@/lib/utils";

export type DataColumn = { key: string; label: string; format?: (v: unknown, row: Record<string, unknown>) => React.ReactNode; align?: "left" | "right" };

export function DataViewCard({ title, subtitle, help, testid, rows, columns, filename, summary, height = 260, children, className, action, legend }: {
  title: string; subtitle?: string; help?: string; testid: string; rows: Record<string, unknown>[]; columns: DataColumn[]; filename: string;
  /** Plain-text alternative for screen readers (what the chart shows). */
  summary: string; height?: number; children: React.ReactNode; className?: string; action?: React.ReactNode; legend?: { label: string; color: string }[];
}) {
  const [view, setView] = React.useState<"chart" | "table">("chart");
  const titleId = React.useId();
  return (
    <Card className={cn("card-hover flex min-w-0 flex-col", className)} data-testid={testid} aria-labelledby={titleId}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={titleId} className="flex items-center gap-1.5 text-sm font-semibold text-ink">{title}{help && <Tooltip text={help} />}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-ink-2">{subtitle}</p>}
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-1.5">
          {action}
          <button type="button" onClick={() => setView(view === "chart" ? "table" : "chart")} aria-pressed={view === "table"} data-testid={`${testid}-toggle`}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-xs font-semibold text-ink hover:bg-surface-2">
            {view === "chart" ? <><TableIcon size={14} />View data</> : <><BarChart3 size={14} />View chart</>}
          </button>
          <ExportButton rows={rows} filename={filename} columns={columns.map((c) => ({ key: c.key, label: c.label }))} testid={`${testid}-export`} />
        </div>
      </div>
      {legend && legend.length > 1 && view === "chart" && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2" aria-label="Legend">
          {legend.map((l) => <li key={l.label} className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: l.color }} />{l.label}</li>)}
        </ul>
      )}
      {view === "chart" ? (
        <div role="img" aria-label={summary} style={{ height }} className="w-full min-w-0">{children}</div>
      ) : (
        <div style={{ maxHeight: Math.max(height, 220) }} className="overflow-y-auto">
          <Table className="shadow-none">
            <caption className="sr-only">{summary}</caption>
            <thead><tr>{columns.map((c) => <Th key={c.key} className={c.align === "right" ? "text-right" : undefined}>{c.label}</Th>)}</tr></thead>
            <tbody>
              {rows.length === 0 && <tr><Td colSpan={columns.length} className="text-center text-xs text-ink-3">No rows</Td></tr>}
              {rows.map((r, i) => <tr key={i}>{columns.map((c) => <Td key={c.key} className={cn("text-xs", c.align === "right" && "text-right tabular")}>{c.format ? c.format(r[c.key], r) : String(r[c.key] ?? "—")}</Td>)}</tr>)}
            </tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}
