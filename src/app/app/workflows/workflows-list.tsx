"use client";
import * as React from "react";
import Link from "next/link";
import { Search, Scale, ShieldAlert, Copy } from "lucide-react";
import { Badge, BasisChip, Button, Empty, Input, PageHeader, Select, Table, Th, Td, Tooltip } from "@/components/ui";
import { OPP_STATUS_TONE } from "@/components/dashboard/opportunity-card";
import { fmtNum, fmtPct, cn } from "@/lib/utils";

export type WorkflowRow = {
  id: string; name: string; departmentId: string | null; departmentName: string | null; people: number; runsPerWeek: number; avgDurationMin: number; hoursPerWeek: number;
  repetitionScore: number; automationScore: number; reworkRate: number; handoffCount: number; requiresJudgment: boolean; regulatoryFlag: string | null;
  duplicateOf: { id: string; name: string } | null; basis: "observed" | "estimated" | "assumed"; apps: string[]; opportunity: { id: string; status: string } | null; automated: boolean;
};
type SortKey = "name" | "departmentName" | "people" | "runsPerWeek" | "avgDurationMin" | "hoursPerWeek" | "repetitionScore" | "automationScore" | "reworkRate" | "handoffCount";

const Score = ({ v }: { v: number }) => <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-2"><span className="block h-full rounded-full" style={{ width: `${v}%`, background: v >= 66 ? "var(--color-money)" : v >= 35 ? "var(--color-warn)" : "var(--color-ink-3)" }} /></span><span className="tabular">{Math.round(v)}</span></span>;

export function WorkflowsList({ rows, departments, initial, hasAnalysis }: { rows: WorkflowRow[]; departments: { id: string; name: string }[]; initial: { q: string; dept: string; status: string; flag: string }; hasAnalysis: boolean }) {
  const [q, setQ] = React.useState(initial.q); const [dept, setDept] = React.useState(initial.dept); const [status, setStatus] = React.useState(initial.status); const [flag, setFlag] = React.useState(initial.flag);
  const [sort, setSort] = React.useState<SortKey>("hoursPerWeek"); const [dir, setDir] = React.useState<1 | -1>(-1);
  const filtered = rows.filter((r) =>
    (!dept || r.departmentId === dept) &&
    (!status || (status === "automated" ? r.automated : status === "none" ? !r.opportunity : r.opportunity?.status === status)) &&
    (!flag || (flag === "judgment" ? r.requiresJudgment : flag === "regulatory" ? !!r.regulatoryFlag : flag === "duplicate" ? !!r.duplicateOf : flag === "rework" ? r.reworkRate > 0.15 : true)) &&
    (!q || `${r.name} ${r.departmentName ?? ""} ${r.apps.join(" ")}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => { const x = a[sort] ?? "", y = b[sort] ?? ""; return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir; });
  const th = (k: SortKey, label: React.ReactNode, right = true) => <Th className={cn(right && "text-right", "cursor-pointer select-none hover:text-ink")} onClick={() => { if (sort === k) setDir(dir === 1 ? -1 : 1); else { setSort(k); setDir(k === "name" || k === "departmentName" ? 1 : -1); } }} data-testid={`sort-${k}`}>{label}{sort === k ? (dir === -1 ? " ↓" : " ↑") : ""}</Th>;
  if (!rows.length) return <div><PageHeader title="Workflows" /><Empty title="No workflows discovered yet" body={hasAnalysis ? "The analysis ran but found no workflow with at least 3 observed runs. Collect a longer window and re-run." : "Workflows are discovered by the analysis from observed activity. Run a campaign, then the analysis."} action={<Button href="/app/onboarding">Open the rollout checklist</Button>} /></div>;
  return (
    <div className="space-y-4">
      <PageHeader title="Workflows" subtitle="Repeating sequences of steps the analysis found in observed activity. Scores are 0–100." />
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative w-full sm:w-72"><Input placeholder="Search name, department, app…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="wf-search" aria-label="Search workflows" className="pl-8" /><Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-ink-3" /></div>
        <Select value={dept} onChange={(e) => setDept(e.target.value)} className="w-44" data-testid="wf-filter-dept" aria-label="Department"><option value="">All departments</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44" data-testid="wf-filter-status" aria-label="Opportunity status"><option value="">Any status</option><option value="none">No opportunity</option>{Object.keys(OPP_STATUS_TONE).map((s) => <option key={s} value={s}>Opportunity: {s.replace("_", " ")}</option>)}<option value="automated">Automated (agent deployed)</option></Select>
        <Select value={flag} onChange={(e) => setFlag(e.target.value)} className="w-40" data-testid="wf-filter-flag" aria-label="Flag"><option value="">Any flag</option><option value="judgment">Needs judgment</option><option value="regulatory">Regulated</option><option value="duplicate">Duplicate work</option><option value="rework">High rework (&gt;15%)</option></Select>
        <span className="self-center text-xs text-ink-3">{filtered.length} of {rows.length}</span>
      </div>
      <Table>
        <thead><tr>
          {th("name", "Workflow", false)}{th("departmentName", "Dept", false)}{th("people", "People")}{th("runsPerWeek", "Runs/wk")}{th("avgDurationMin", "Avg min")}{th("hoursPerWeek", "Hrs/wk")}
          {th("repetitionScore", <span className="inline-flex items-center gap-1">Repetition<Tooltip text="How often and how consistently this is done the same way (frequency, step consistency, structured data entry)." /></span>, false)}
          {th("automationScore", <span className="inline-flex items-center gap-1">Automation<Tooltip text="How much of this could software do (structured entry, copy/paste between apps, API-friendly apps, low variance), minus penalties for judgment, regulation and handoffs." /></span>, false)}
          {th("reworkRate", <span className="inline-flex items-center gap-1">Rework<Tooltip text="Share of runs where a step was repeated after other steps — going back to fix something." /></span>)}
          {th("handoffCount", <span className="inline-flex items-center gap-1">Handoffs<Tooltip text="Times the work was explicitly sent to another person." /></span>)}
          <Th>Flags</Th><Th>Opportunity</Th>
        </tr></thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.id} className="hover:bg-surface-2" data-testid={`wf-row-${r.id}`}>
              <Td><Link href={`/app/workflows/${r.id}`} className="font-medium text-brand hover:underline">{r.name}</Link><div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-3"><BasisChip basis={r.basis} />{r.apps.length} apps</div></Td>
              <Td className="text-xs">{r.departmentId ? <Link href={`/app/departments/${r.departmentId}`} className="text-brand hover:underline">{r.departmentName}</Link> : "—"}</Td>
              <Td className="text-right tabular">{r.people}</Td><Td className="text-right tabular">{fmtNum(r.runsPerWeek, 1)}</Td><Td className="text-right tabular">{fmtNum(r.avgDurationMin, 1)}</Td><Td className="text-right tabular font-medium">{fmtNum(r.hoursPerWeek, 1)}</Td>
              <Td><Score v={r.repetitionScore} /></Td><Td><Score v={r.automationScore} /></Td>
              <Td className="text-right tabular">{fmtPct(r.reworkRate)}</Td><Td className="text-right tabular">{r.handoffCount}</Td>
              <Td><span className="flex flex-wrap gap-1">
                {r.requiresJudgment && <Tooltip text="Some steps need a human decision."><Badge tone="warn"><Scale size={11} className="mr-1" />judgment</Badge></Tooltip>}
                {r.regulatoryFlag && <Tooltip text={`Touches ${r.regulatoryFlag}-regulated data.`}><Badge tone="danger"><ShieldAlert size={11} className="mr-1" />{r.regulatoryFlag}</Badge></Tooltip>}
                {r.duplicateOf && <Tooltip text={`Overlaps ≥80% with "${r.duplicateOf.name}" — the same work done twice.`}><Link href={`/app/workflows/${r.duplicateOf.id}`}><Badge tone="info"><Copy size={11} className="mr-1" />duplicate of</Badge></Link></Tooltip>}
              </span></Td>
              <Td>{r.automated ? <Badge tone="verified">automated</Badge> : r.opportunity ? <Link href={`/app/opportunities/${r.opportunity.id}`}><Badge tone={OPP_STATUS_TONE[r.opportunity.status] ?? "neutral"}>{r.opportunity.status.replace("_", " ")}</Badge></Link> : <Badge tone="neutral">none</Badge>}</Td>
            </tr>
          ))}
          {filtered.length === 0 && <tr><Td colSpan={12} className="text-center text-xs text-ink-3">No workflows match these filters.</Td></tr>}
        </tbody>
      </Table>
    </div>
  );
}
