"use client";
import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export type OrgNode = { id: string; name: string; title: string | null; departmentName?: string | null; hoursPerWeek?: number; recoverableHoursPerWeek?: number; isCurrent?: boolean };
type Row = OrgNode & { managerId: string | null };

/** Build a forest from flat rows (manager → reports). Roots are employees whose manager is missing or outside the set. */
export function buildTree(rows: Row[]): { node: OrgNode; children: ReturnType<typeof buildTree> }[] {
  const ids = new Set(rows.map((r) => r.id));
  const byManager = new Map<string | null, Row[]>();
  for (const r of rows) { const k = r.managerId && ids.has(r.managerId) ? r.managerId : null; const arr = byManager.get(k) ?? []; arr.push(r); byManager.set(k, arr); }
  const seen = new Set<string>();
  const make = (r: Row): { node: OrgNode; children: ReturnType<typeof buildTree> } => { seen.add(r.id); return { node: r, children: (byManager.get(r.id) ?? []).filter((c) => !seen.has(c.id)).sort((a, b) => a.name.localeCompare(b.name)).map(make) }; };
  return (byManager.get(null) ?? []).sort((a, b) => a.name.localeCompare(b.name)).map(make);
}

function Node({ t, depth, showHours }: { t: ReturnType<typeof buildTree>[number]; depth: number; showHours: boolean }) {
  const n = t.node;
  return (
    <li className={depth === 0 ? "relative" : "relative pl-5"}>
      {depth > 0 && <>
        <span className="absolute left-0 top-0 h-full border-l border-border" aria-hidden />
        <span className="absolute left-0 top-5 w-4 border-t border-border" aria-hidden />
      </>}
      <Link href={`/app/employees/${n.id}`} data-testid={`org-node-${n.id}`} className={cn("relative mb-2 inline-flex max-w-full items-center gap-3 rounded-lg border bg-surface px-3 py-1.5 text-sm transition hover:border-brand/60 hover:shadow-pop", n.isCurrent ? "border-brand bg-brand-soft/40" : "border-border")}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand">{n.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}</span>
        <span className="min-w-0"><span className="block truncate font-medium text-ink">{n.name}</span><span className="block truncate text-[11px] text-ink-2">{n.title ?? "—"}{n.departmentName ? ` · ${n.departmentName}` : ""}</span></span>
        {showHours && n.recoverableHoursPerWeek != null && n.recoverableHoursPerWeek > 0 && <span className="ml-1 shrink-0 rounded-full bg-projected-soft px-1.5 py-0.5 text-[10px] font-semibold text-projected tabular">{n.recoverableHoursPerWeek.toFixed(1)}h/wk</span>}
      </Link>
      {t.children.length > 0 && <ul className="ml-3">{t.children.map((c) => <Node key={c.node.id} t={c} depth={depth + 1} showHours={showHours} />)}</ul>}
    </li>
  );
}

/** Simple nested org chart with connector lines. Pass the subtree (or the whole org). */
export function OrgChart({ rows, showHours = true, testid = "org-chart" }: { rows: Row[]; showHours?: boolean; testid?: string }) {
  const forest = React.useMemo(() => buildTree(rows), [rows]);
  if (!rows.length) return <p className="text-xs text-ink-3">No people to show.</p>;
  return (
    <div className="overflow-x-auto scrollbar-thin" data-testid={testid}>
      <ul className="min-w-[280px]">{forest.map((t) => <Node key={t.node.id} t={t} depth={0} showHours={showHours} />)}</ul>
      {showHours && <p className="mt-1 text-[11px] text-ink-3">Purple badge = hours per week software could take over for that person.</p>}
    </div>
  );
}
