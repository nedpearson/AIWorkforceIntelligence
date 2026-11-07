"use client";
import * as React from "react";
import Link from "next/link";
import { Bot, Scale, ShieldAlert } from "lucide-react";
import { Badge, Button, Card, CardHeader, PageHeader, Table, Th, Td, Tooltip } from "@/components/ui";
import { StatTile } from "@/components/dashboard/stat-tile";
import { OrgChart } from "@/components/dashboard/org-chart";
import { OpportunityCard, type OppCardData } from "@/components/dashboard/opportunity-card";
import { fmtUSD, fmtNum, fmtPct } from "@/lib/utils";

export type DeptDetailData = {
  dept: { id: string; name: string; headEmployeeId: string | null; headName: string | null };
  kpis: { employees: number; laborAnnual: number; hoursPerWeek: number; repetitiveHoursPerWeek: number; recoverableHoursPerWeek: number; grossAnnual: number; realizableAnnual: number; verifiedAnnual: number; efficiencyGainPct: number; opportunities: number };
  canCost: boolean;
  workflows: { id: string; name: string; hoursPerWeek: number; runsPerWeek: number; avgDurationMin: number; people: number; repetitionScore: number; automationScore: number; requiresJudgment: boolean; regulatoryFlag: string | null; automated: boolean; opportunityId: string | null }[];
  employees: { id: string; name: string; title: string | null; hoursPerWeek: number; repetitiveHoursPerWeek: number; recoverableHoursPerWeek: number; realizableAnnual: number | null; laborAnnual: number | null; topWorkflow: string | null }[];
  treeRows: { id: string; name: string; title: string | null; managerId: string | null; departmentName: string | null; hoursPerWeek?: number; recoverableHoursPerWeek?: number }[];
  opportunities: (OppCardData & { workflowName: string | null })[];
  recommendedAgents: { category: string; label: string; templateName: string | null; templateKey: string | null; forOpportunities: string[] }[];
  canWriteAgents: boolean;
};

export function DepartmentDetail({ data }: { data: DeptDetailData }) {
  const { dept, kpis } = data;
  return (
    <div className="space-y-6" data-testid="department-detail">
      <PageHeader title={dept.name} subtitle={<span>{kpis.employees} people with observed activity{dept.headName && <> · Head: <Link href={`/app/employees/${dept.headEmployeeId}`} className="text-brand hover:underline">{dept.headName}</Link></>} · <Link href="/app/departments" className="text-brand hover:underline">All departments</Link></span>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile testid="kpi-dept-labor" label="Labor analyzed" value={fmtUSD(kpis.laborAnnual, { compact: true })} caption="per year, loaded" basis="observed" href="/app/employees" hint="Salary + benefits of the people in this department with observed activity." />
        <StatTile testid="kpi-dept-hours" label="Hours / week observed" value={fmtNum(kpis.hoursPerWeek, 0)} caption={`${fmtNum(kpis.repetitiveHoursPerWeek, 0)} repetitive`} basis="observed" href="/app/workflows" />
        <StatTile testid="kpi-dept-recoverable" label="Recoverable hrs / wk" value={fmtNum(kpis.recoverableHoursPerWeek, 0)} caption={`${fmtPct(kpis.efficiencyGainPct)} efficiency gain`} basis="estimated" tone="projected" href="/app/opportunities" hint="Hours software could take over each week; efficiency gain = recoverable ÷ observed." />
        <StatTile testid="kpi-dept-realizable" label="Realizable $ / yr" value={fmtUSD(kpis.realizableAnnual, { compact: true })} caption={`gross ${fmtUSD(kpis.grossAnnual, { compact: true })}`} basis="estimated" tone="projected" href="/app/opportunities" />
        <StatTile testid="kpi-dept-verified" label="Verified $ / yr" value={kpis.verifiedAnnual > 0 ? fmtUSD(kpis.verifiedAnnual, { compact: true }) : "—"} caption={kpis.verifiedAnnual > 0 ? "measured" : "nothing measured yet"} basis="observed" tone="verified" href="/app/agents" />
        <StatTile testid="kpi-dept-opps" label="Opportunities" value={kpis.opportunities} caption="in this department" href="/app/opportunities" />
      </div>

      <Card className="p-0">
        <CardHeader className="px-5 pt-5" title="Workflows performed here" subtitle="Found by the analysis from observed activity. 'Automated' means an agent is deployed for that workflow." />
        {data.workflows.length === 0 ? <p className="px-5 pb-5 text-xs text-ink-3">No workflows found in this department yet.</p> : (
          <Table className="rounded-t-none border-0 shadow-none">
            <thead><tr><Th>Workflow</Th><Th className="text-right">Hrs/wk</Th><Th className="text-right">Runs/wk</Th><Th className="text-right">Avg min</Th><Th className="text-right">People</Th><Th className="text-right">Repetition</Th><Th className="text-right">Automation</Th><Th>Flags</Th><Th>Status</Th></tr></thead>
            <tbody>{data.workflows.map((w) => (
              <tr key={w.id} className="hover:bg-surface-2" data-testid={`dept-wf-${w.id}`}>
                <Td><Link href={`/app/workflows/${w.id}`} className="font-medium text-brand hover:underline">{w.name}</Link></Td>
                <Td className="text-right tabular">{fmtNum(w.hoursPerWeek, 1)}</Td><Td className="text-right tabular">{fmtNum(w.runsPerWeek, 1)}</Td><Td className="text-right tabular">{fmtNum(w.avgDurationMin, 1)}</Td><Td className="text-right tabular">{w.people}</Td>
                <Td className="text-right tabular">{Math.round(w.repetitionScore)}</Td><Td className="text-right tabular">{Math.round(w.automationScore)}</Td>
                <Td><span className="flex gap-1">{w.requiresJudgment && <Badge tone="warn"><Scale size={11} className="mr-1" />judgment</Badge>}{w.regulatoryFlag && <Badge tone="danger"><ShieldAlert size={11} className="mr-1" />{w.regulatoryFlag}</Badge>}</span></Td>
                <Td>{w.automated ? <Badge tone="verified">automated</Badge> : w.opportunityId ? <Link href={`/app/opportunities/${w.opportunityId}`}><Badge tone="projected">opportunity</Badge></Link> : <Badge tone="neutral">manual</Badge>}</Td>
              </tr>))}</tbody>
          </Table>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="p-0 lg:col-span-2">
          <CardHeader className="px-5 pt-5" title="People in this department" subtitle={data.canCost ? "Hours are observed; dollars are each person's share of the opportunities they take part in." : <span className="inline-flex items-center gap-1">Hours only. <Tooltip text="Per-person compensation is visible to owners and admins only. Department-level dollars are shown in the tiles above." /></span>} />
          {data.employees.length === 0 ? <p className="px-5 pb-5 text-xs text-ink-3">No active employees in this department.</p> : (
            <Table className="rounded-t-none border-0 shadow-none">
              <thead><tr><Th>Person</Th><Th className="text-right">Hrs/wk</Th><Th className="text-right">Repetitive</Th><Th className="text-right">Recoverable</Th>{data.canCost && <Th className="text-right">Potential $/yr</Th>}<Th>Top workflow</Th></tr></thead>
              <tbody>{data.employees.map((e) => (
                <tr key={e.id} className="hover:bg-surface-2" data-testid={`dept-emp-${e.id}`}>
                  <Td><Link href={`/app/employees/${e.id}`} className="font-medium text-brand hover:underline">{e.name}</Link><div className="text-xs text-ink-3">{e.title ?? "—"}</div></Td>
                  <Td className="text-right tabular">{fmtNum(e.hoursPerWeek, 1)}</Td><Td className="text-right tabular">{fmtNum(e.repetitiveHoursPerWeek, 1)}</Td><Td className="text-right tabular text-projected">{fmtNum(e.recoverableHoursPerWeek, 1)}</Td>
                  {data.canCost && <Td className="text-right tabular text-projected">{fmtUSD(e.realizableAnnual ?? 0)}</Td>}
                  <Td className="max-w-[220px] truncate text-xs text-ink-2">{e.topWorkflow ?? "—"}</Td>
                </tr>))}</tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title="Org chart" subtitle="Manager → direct reports. Click a person." />
          <OrgChart rows={data.treeRows} testid="dept-org-chart" />
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <CardHeader title="Opportunities in this department" subtitle="Ranked by realizable savings, feasibility and risk." className="mb-0" />
          {data.opportunities.length === 0 ? <Card><p className="text-xs text-ink-3">No opportunities here yet. Workflows with an automation score of 35+ get one when the analysis runs.</p></Card> : data.opportunities.map((o) => <OpportunityCard key={o.id} o={o} canAutomate={data.canWriteAgents} compact />)}
        </div>
        <Card data-testid="dept-recommended-agents">
          <CardHeader title="Recommended agents" subtitle="Templates matched to this department's opportunities." />
          {data.recommendedAgents.length === 0 ? <p className="text-xs text-ink-3">No recommendations yet.</p> : (
            <ul className="space-y-2">{data.recommendedAgents.map((r) => (
              <li key={r.category} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex items-center gap-2 font-medium text-ink"><Bot size={15} className="text-brand" />{r.templateName ?? r.label}</div>
                <div className="mt-0.5 text-xs text-ink-2">{r.label} · for: {r.forOpportunities.join(", ")}</div>
                {data.canWriteAgents && <Button size="sm" variant="secondary" className="mt-2" href={r.templateKey ? `/app/agents/new?template=${r.templateKey}` : "/app/agents/new"}>Start from this template</Button>}
              </li>))}</ul>
          )}
        </Card>
      </div>
    </div>
  );
}
