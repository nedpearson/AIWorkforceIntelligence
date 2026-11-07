"use client";
import * as React from "react";
import Link from "next/link";
import { Badge, Button, Card, CardHeader, Empty, PageHeader, Table, Th, Td, Tooltip } from "@/components/ui";
import { fmtUSD, fmtNum, fmtPct, cn } from "@/lib/utils";

export type DeptRow = { id: string | null; name: string; employees: number; laborAnnual: number; hoursPerWeek: number; repetitiveHoursPerWeek: number; recoverableHoursPerWeek: number; realizableAnnual: number; verifiedAnnual: number; efficiencyGainPct: number; opportunities: number };

const href = (r: DeptRow) => (r.id ? `/app/departments/${r.id}` : "/app/employees");

/** Heatmap cell: one hue (brand), opacity = share of all recoverable hours (sequential scale). */
function HeatCell({ r, share }: { r: DeptRow; share: number }) {
  const alpha = share <= 0 ? 0.06 : 0.15 + 0.85 * Math.sqrt(share);
  const dark = alpha > 0.55;
  return (
    <Link href={href(r)} data-testid={`heat-${r.id ?? "unassigned"}`} className="group relative flex min-h-[112px] flex-col justify-between rounded-xl border border-border p-3 transition hover:shadow-pop" style={{ background: `color-mix(in oklab, var(--color-brand) ${Math.round(alpha * 100)}%, var(--color-surface))` }}>
      <div className={cn("text-sm font-semibold", dark ? "text-white" : "text-ink")}>{r.name}</div>
      <div>
        <div className={cn("text-2xl font-semibold tabular", dark ? "text-white" : "text-ink")}>{fmtNum(r.recoverableHoursPerWeek, 0)}<span className="text-xs font-normal opacity-80"> hrs/wk</span></div>
        <div className={cn("text-[11px]", dark ? "text-white/85" : "text-ink-2")}>{fmtPct(share)} of recoverable · {r.employees} people · {r.opportunities} opp{r.opportunities === 1 ? "" : "s"}</div>
      </div>
    </Link>
  );
}

export function DepartmentsList({ rows, totals }: { rows: DeptRow[]; totals: { recoverable: number; realizable: number; verified: number } }) {
  const [sort, setSort] = React.useState<keyof DeptRow>("realizableAnnual");
  const [dir, setDir] = React.useState<1 | -1>(-1);
  const sorted = [...rows].sort((a, b) => { const x = a[sort], y = b[sort]; return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir; });
  const th = (k: keyof DeptRow, label: React.ReactNode, right = true) => <Th className={cn(right && "text-right", "cursor-pointer select-none hover:text-ink")} onClick={() => { if (sort === k) setDir(dir === 1 ? -1 : 1); else { setSort(k); setDir(-1); } }} data-testid={`sort-${String(k)}`}>{label}{sort === k ? (dir === -1 ? " ↓" : " ↑") : ""}</Th>;
  if (!rows.length) return <div><PageHeader title="Departments" /><Empty title="No departments analyzed yet" body="Departments appear here once employees have observed activity and the analysis has run." action={<Button href="/app/onboarding">Open the rollout checklist</Button>} /></div>;
  return (
    <div className="space-y-6">
      <PageHeader title="Departments" subtitle="Where the recoverable hours are. Darker = a bigger share of the hours software could take over." />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="dept-heatmap">
        {sorted.map((r) => <HeatCell key={r.id ?? "unassigned"} r={r} share={totals.recoverable > 0 ? r.recoverableHoursPerWeek / totals.recoverable : 0} />)}
      </div>
      <Card className="p-0">
        <CardHeader className="px-5 pt-5" title="By the numbers" subtitle="Click a column to sort. Every figure comes from the finance engine; open a department for the calculation." />
        <Table className="rounded-t-none border-0 shadow-none">
          <thead><tr>
            {th("name", "Department", false)}{th("employees", "People")}{th("laborAnnual", <span className="inline-flex items-center gap-1">Labor $/yr<Tooltip text="Salary plus benefits load for the people in this department with observed activity." /></span>)}
            {th("hoursPerWeek", "Hrs/wk observed")}{th("repetitiveHoursPerWeek", "Repetitive")}{th("recoverableHoursPerWeek", "Recoverable")}
            {th("realizableAnnual", <span className="text-projected">Realizable $/yr</span>)}{th("verifiedAnnual", <span className="text-verified">Verified $/yr</span>)}
            {th("efficiencyGainPct", <span className="inline-flex items-center gap-1">Efficiency gain<Tooltip text="Recoverable hours ÷ observed hours: the share of this department's workflow time that could be freed." /></span>)}
          </tr></thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id ?? "unassigned"} className="hover:bg-surface-2" data-testid={`dept-row-${r.id ?? "unassigned"}`}>
                <Td><Link href={href(r)} className="font-medium text-brand hover:underline">{r.name}</Link></Td>
                <Td className="text-right tabular">{r.employees}</Td><Td className="text-right tabular">{fmtUSD(r.laborAnnual, { compact: true })}</Td>
                <Td className="text-right tabular">{fmtNum(r.hoursPerWeek, 1)}</Td><Td className="text-right tabular">{fmtNum(r.repetitiveHoursPerWeek, 1)}</Td><Td className="text-right tabular text-projected">{fmtNum(r.recoverableHoursPerWeek, 1)}</Td>
                <Td className="text-right tabular text-projected">{fmtUSD(r.realizableAnnual)}</Td><Td className="text-right tabular text-verified">{r.verifiedAnnual > 0 ? fmtUSD(r.verifiedAnnual) : "—"}</Td>
                <Td className="text-right"><Badge tone={r.efficiencyGainPct >= 0.3 ? "money" : r.efficiencyGainPct >= 0.1 ? "warn" : "neutral"}>{fmtPct(r.efficiencyGainPct)}</Badge></Td>
              </tr>
            ))}
            <tr className="bg-surface-2 font-semibold"><Td>Total</Td><Td className="text-right tabular">{rows.reduce((s, r) => s + r.employees, 0)}</Td><Td className="text-right tabular">{fmtUSD(rows.reduce((s, r) => s + r.laborAnnual, 0), { compact: true })}</Td><Td className="text-right tabular">{fmtNum(rows.reduce((s, r) => s + r.hoursPerWeek, 0), 1)}</Td><Td className="text-right tabular">{fmtNum(rows.reduce((s, r) => s + r.repetitiveHoursPerWeek, 0), 1)}</Td><Td className="text-right tabular text-projected">{fmtNum(totals.recoverable, 1)}</Td><Td className="text-right tabular text-projected">{fmtUSD(totals.realizable)}</Td><Td className="text-right tabular text-verified">{totals.verified > 0 ? fmtUSD(totals.verified) : "—"}</Td><Td /></tr>
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
