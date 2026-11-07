"use client";
import * as React from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Badge, BasisChip, Button, Card, CardHeader, Empty, Input, PageHeader, Select, Table, Th, Td, Tooltip } from "@/components/ui";
import { OrgChart } from "@/components/dashboard/org-chart";
import { fmtUSD, fmtNum, fmtPct, cn } from "@/lib/utils";

export type EmployeeRow = {
  id: string; name: string; title: string | null; departmentId: string | null; departmentName: string | null; managerId: string | null; observed: boolean;
  hoursPerWeek: number; repetitivePct: number; recoverableHoursPerWeek: number; realizableAnnual: number | null; laborAnnual: number | null; loadedHourly: number | null; costBasis: "observed" | "estimated" | "assumed";
  topWorkflow: { id: string; name: string } | null;
};
type SortKey = "name" | "title" | "departmentName" | "hoursPerWeek" | "repetitivePct" | "recoverableHoursPerWeek" | "realizableAnnual" | "laborAnnual";

export function EmployeesList({ rows, departments, deptTotals, canCost, initialQ, initialDept }: { rows: EmployeeRow[]; departments: { id: string; name: string }[]; deptTotals: { id: string | null; name: string; realizableAnnual: number; laborAnnual: number }[]; canCost: boolean; initialQ: string; initialDept: string }) {
  const [q, setQ] = React.useState(initialQ); const [dept, setDept] = React.useState(initialDept);
  const [sort, setSort] = React.useState<SortKey>("recoverableHoursPerWeek"); const [dir, setDir] = React.useState<1 | -1>(-1);
  const filtered = rows.filter((r) => (!dept || r.departmentId === dept) && (!q || `${r.name} ${r.title ?? ""} ${r.departmentName ?? ""} ${r.topWorkflow?.name ?? ""}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => { const x = a[sort] ?? "", y = b[sort] ?? ""; return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir; });
  const th = (k: SortKey, label: React.ReactNode, right = true) => <Th className={cn(right && "text-right", "cursor-pointer select-none hover:text-ink")} onClick={() => { if (sort === k) setDir(dir === 1 ? -1 : 1); else { setSort(k); setDir(k === "name" || k === "title" || k === "departmentName" ? 1 : -1); } }} data-testid={`sort-${k}`}>{label}{sort === k ? (dir === -1 ? " ↓" : " ↑") : ""}</Th>;
  if (!rows.length) return <div><PageHeader title="People" /><Empty title="No employees yet" body="Add employees in Settings or import them, then enroll collectors." action={<Button href="/app/settings">Go to Settings</Button>} /></div>;
  return (
    <div className="space-y-6">
      <PageHeader title="People" subtitle={canCost ? "Observed hours per person and each person's share of the automation opportunities." : "Observed hours per person. Dollar figures are shown at department level for your role."} />
      {!canCost && (
        <Card className="border-info/30 bg-info-soft/40 p-4 text-xs text-ink-2" data-testid="cost-hidden-note">
          <span className="font-medium text-ink">Compensation is hidden for your role.</span> Managers see hours, not dollars per person. Department-level potential: {deptTotals.filter((d) => d.realizableAnnual > 0).map((d) => <span key={d.id ?? "u"} className="ml-2 inline-flex items-center gap-1"><Link href={d.id ? `/app/departments/${d.id}` : "/app/departments"} className="text-brand hover:underline">{d.name}</Link> <span className="tabular text-projected">{fmtUSD(d.realizableAnnual, { compact: true })}/yr</span></span>)}
        </Card>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative w-full sm:w-72"><Input placeholder="Search name, title, department, workflow…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="emp-search" aria-label="Search people" className="pl-8" /><Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-ink-3" /></div>
        <Select value={dept} onChange={(e) => setDept(e.target.value)} className="w-48" data-testid="emp-filter-dept" aria-label="Department filter"><option value="">All departments</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <span className="self-center text-xs text-ink-3">{filtered.length} of {rows.length}</span>
      </div>
      <Table>
        <thead><tr>
          {th("name", "Name", false)}{th("title", "Title", false)}{th("departmentName", "Department", false)}
          {th("hoursPerWeek", <span className="inline-flex items-center gap-1">Hrs/wk observed<Tooltip text="Hours per week inside workflows the analysis found for this person. Ad-hoc work and idle time are not included." /></span>)}
          {th("repetitivePct", "Repetitive %")}{th("recoverableHoursPerWeek", <span className="inline-flex items-center gap-1">Recoverable hrs/wk<Tooltip text="This person's share of the hours software could take over, by their share of each workflow's hours." /></span>)}
          {canCost && th("realizableAnnual", <span className="text-projected">Potential $/yr</span>)}
          {canCost && th("laborAnnual", <span className="inline-flex items-center gap-1">Loaded cost<Tooltip text="Base pay × (1 + benefits load). Visible to owners and admins only." /></span>)}
          <Th>Top workflow</Th>
        </tr></thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.id} className="hover:bg-surface-2" data-testid={`emp-row-${r.id}`}>
              <Td><Link href={`/app/employees/${r.id}`} className="font-medium text-brand hover:underline">{r.name}</Link>{!r.observed && <Badge tone="neutral" className="ml-2">no activity</Badge>}</Td>
              <Td className="text-xs text-ink-2">{r.title ?? "—"}</Td>
              <Td className="text-xs">{r.departmentId ? <Link href={`/app/departments/${r.departmentId}`} className="text-brand hover:underline">{r.departmentName}</Link> : "—"}</Td>
              <Td className="text-right tabular">{fmtNum(r.hoursPerWeek, 1)}</Td>
              <Td className="text-right tabular">{r.hoursPerWeek > 0 ? fmtPct(r.repetitivePct) : "—"}</Td>
              <Td className="text-right tabular text-projected">{fmtNum(r.recoverableHoursPerWeek, 1)}</Td>
              {canCost && <Td className="text-right tabular text-projected">{fmtUSD(r.realizableAnnual ?? 0)}</Td>}
              {canCost && <Td className="text-right tabular"><span className="inline-flex items-center gap-1.5">{fmtUSD(r.laborAnnual ?? 0, { compact: true })}<span className="text-[10px] text-ink-3">${fmtNum(r.loadedHourly ?? 0)}/h</span><BasisChip basis={r.costBasis} /></span></Td>}
              <Td className="max-w-[220px] truncate text-xs">{r.topWorkflow ? <Link href={`/app/workflows/${r.topWorkflow.id}`} className="text-brand hover:underline">{r.topWorkflow.name}</Link> : "—"}</Td>
            </tr>
          ))}
          {filtered.length === 0 && <tr><Td colSpan={canCost ? 9 : 7} className="text-center text-xs text-ink-3">No one matches.</Td></tr>}
        </tbody>
      </Table>
      <Card>
        <CardHeader title="Org chart" subtitle="Manager → direct reports across the organization. Purple badge = recoverable hours per week." />
        <OrgChart rows={rows.map((r) => ({ id: r.id, name: r.name, title: r.title, managerId: r.managerId, departmentName: r.departmentName, hoursPerWeek: r.hoursPerWeek, recoverableHoursPerWeek: r.recoverableHoursPerWeek }))} />
      </Card>
    </div>
  );
}
