"use client";
import * as React from "react";
import Link from "next/link";
import { Bot, MapPin, Mail } from "lucide-react";
import type { CalcTree } from "@/db/schema";
import { Badge, BasisChip, Button, Card, CardHeader, PageHeader, Table, Th, Td, Tooltip } from "@/components/ui";
import { StatTile } from "@/components/dashboard/stat-tile";
import { OpportunityCard, type OppCardData } from "@/components/dashboard/opportunity-card";
import { ChartFrame, CategoryDonut, HoursSparkline } from "@/components/charts";
import { fmtUSD, fmtNum, fmtPct } from "@/lib/utils";

export type EmployeeDetailData = {
  employee: { id: string; name: string; title: string | null; email: string | null; location: string | null; departmentId: string | null; departmentName: string | null; manager: { id: string; name: string; title: string | null } | null; reports: { id: string; name: string; title: string | null }[]; hoursContract: number; isSelf: boolean };
  cost: { baseAnnualCost: number; loadedHourlyCost: number; laborAnnual: number; basis: "observed" | "estimated" | "assumed" } | null;
  kpis: { hoursPerWeek: number; repetitiveHoursPerWeek: number; recoverableHoursPerWeek: number; realizableAnnual: number | null; efficiencyGainPct: number };
  impactTree: CalcTree;
  workflows: { id: string; name: string; hoursPerWeek: number; runsPerWeek: number; avgDurationMin: number; repetitionScore: number; automationScore: number; automated: boolean; agent: { id: string; name: string; status: string } | null; opportunity: { id: string; title: string; status: string } | null }[];
  opportunities: OppCardData[];
  recommendedAgents: { category: string; label: string; templateName: string | null; templateKey: string | null; forOpportunities: string[] }[];
  byCategory: { name: string; hours: number }[];
  byDay: { day: string; hours: number }[];
  evidence: { events: number; from: string | null; to: string | null };
  canWriteAgents: boolean; canCost: boolean;
};

const freq = (runs: number) => (runs >= 25 ? "many times a day" : runs >= 5 ? "about daily" : runs >= 1 ? "weekly" : "occasionally");

export function EmployeeDetail({ data }: { data: EmployeeDetailData }) {
  const { employee: e, kpis, cost } = data;
  const dateRange = data.evidence.from && data.evidence.to ? `${data.evidence.from.slice(0, 10)} → ${data.evidence.to.slice(0, 10)}` : null;
  return (
    <div className="space-y-6" data-testid="employee-detail">
      <PageHeader title={<span className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand">{e.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}</span>{e.name}{e.isSelf && <Badge tone="brand">you</Badge>}</span>}
        subtitle={<span className="flex flex-wrap items-center gap-x-3 gap-y-1">{e.title ?? "—"}{e.departmentName && <Link href={`/app/departments/${e.departmentId}`} className="text-brand hover:underline">{e.departmentName}</Link>}{e.manager && <span>Reports to <Link href={`/app/employees/${e.manager.id}`} className="text-brand hover:underline">{e.manager.name}</Link></span>}{e.location && <span className="inline-flex items-center gap-1"><MapPin size={12} />{e.location}</span>}{e.email && data.canCost && <span className="inline-flex items-center gap-1"><Mail size={12} />{e.email}</span>}</span>} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatTile testid="kpi-emp-hours" label="Hrs/wk in workflows" value={fmtNum(kpis.hoursPerWeek, 1)} caption={`of ${e.hoursContract} contracted`} basis="observed" href="#workflows" hint="Hours per week inside workflows the analysis found. Ad-hoc and idle time are excluded." />
        <StatTile testid="kpi-emp-repetitive" label="Repetitive hrs/wk" value={fmtNum(kpis.repetitiveHoursPerWeek, 1)} caption={kpis.hoursPerWeek > 0 ? `${fmtPct(kpis.repetitiveHoursPerWeek / kpis.hoursPerWeek)} of workflow time` : "—"} basis="observed" href="#workflows" />
        <StatTile testid="kpi-emp-recoverable" label="Recoverable hrs/wk" value={fmtNum(kpis.recoverableHoursPerWeek, 1)} caption={`${fmtPct(kpis.efficiencyGainPct)} efficiency gain`} basis="estimated" tone="projected" drill={{ tree: data.impactTree, meaning: "Hours per week software could take over for this person: their share of each automatable workflow's recoverable hours." }} />
        {data.canCost ? (
          <StatTile testid="kpi-emp-impact" label="Potential $ impact / yr" value={fmtUSD(kpis.realizableAnnual ?? 0)} caption="realizable, not payroll cut" basis="estimated" tone="projected" drill={{ tree: data.impactTree, meaning: "This person's share of the realizable annual savings of the opportunities on the workflows they perform. It is freed capacity, not a payroll reduction." }} />
        ) : (
          <StatTile testid="kpi-emp-impact" label="Potential $ impact" value="—" caption={<span className="inline-flex items-center gap-1">dept-level only<Tooltip text="Per-person dollar figures need the 'employees:cost:read' permission (owners/admins). See the department page for dollars." /></span>} href={e.departmentId ? `/app/departments/${e.departmentId}` : "/app/departments"} />
        )}
        {cost ? (
          <StatTile testid="kpi-emp-cost" label="Loaded cost" value={fmtUSD(cost.laborAnnual, { compact: true })} caption={`$${fmtNum(cost.loadedHourlyCost, 2)}/hr · base ${fmtUSD(cost.baseAnnualCost, { compact: true })}`} basis={cost.basis} hint="Base pay × (1 + benefits load). Only owners and admins can see this." drill={{ tree: { label: "Loaded annual cost", value: cost.laborAnnual, unit: "usd", basis: cost.basis, formula: "base annual cost × (1 + benefits load)", children: [{ label: "Base annual cost", value: cost.baseAnnualCost, unit: "usd", basis: cost.basis, source: "Employee record" }, { label: "Loaded hourly cost", value: cost.loadedHourlyCost, unit: "usd", basis: "estimated", formula: "loaded annual ÷ paid hours per year" }] }, meaning: "What this person costs the company per year including employer taxes and benefits. Used only to value recovered hours." }} />
        ) : (
          <StatTile testid="kpi-emp-cost" label="Loaded cost" value="hidden" caption={<span className="inline-flex items-center gap-1">not visible to your role<Tooltip text="Compensation is restricted to owners and admins. Managers see hours; dollars are aggregated per department." /></span>} href={e.departmentId ? `/app/departments/${e.departmentId}` : "/app/departments"} />
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ChartFrame testid="chart-emp-categories" title="Where the time goes" subtitle="Share of observed active time by kind of application." help="Grouped by app category (spreadsheet, ERP, email, browser…). Only metadata is collected: which app, for how long — never what was typed or shown.">
          {data.byCategory.length ? <CategoryDonut rows={data.byCategory} /> : <p className="p-4 text-xs text-ink-3">No activity recorded for this person yet.</p>}
        </ChartFrame>
        <ChartFrame testid="chart-emp-sparkline" title="Active hours per day" subtitle={dateRange ? `${fmtNum(data.evidence.events)} events · ${dateRange}` : "No events yet"} help="Sum of recorded activity durations per day. Gaps are days off or days with the collector paused.">
          {data.byDay.length ? <HoursSparkline rows={data.byDay} /> : <p className="p-4 text-xs text-ink-3">No activity recorded for this person yet.</p>}
        </ChartFrame>
      </div>

      <Card className="p-0" id="workflows">
        <CardHeader className="px-5 pt-5" title="Workflows this person performs" subtitle="Observed from activity. 'Automated' = an agent is deployed for that workflow." />
        {data.workflows.length === 0 ? <p className="px-5 pb-5 text-xs text-ink-3">No workflows found yet for this person. Workflows need at least 3 observed runs.</p> : (
          <Table className="rounded-t-none border-0 shadow-none">
            <thead><tr><Th>Workflow</Th><Th className="text-right">Time per task</Th><Th>How often</Th><Th className="text-right">Hrs/wk</Th><Th className="text-right">Repetition</Th><Th className="text-right">Automation score</Th><Th>Status</Th></tr></thead>
            <tbody>{data.workflows.map((w) => (
              <tr key={w.id} className="hover:bg-surface-2" data-testid={`emp-wf-${w.id}`}>
                <Td><Link href={`/app/workflows/${w.id}`} className="font-medium text-brand hover:underline">{w.name}</Link>{w.opportunity && <div className="text-[11px] text-ink-3"><Link href={`/app/opportunities/${w.opportunity.id}`} className="hover:underline">{w.opportunity.title}</Link></div>}</Td>
                <Td className="text-right tabular">{fmtNum(w.avgDurationMin, 1)} min</Td>
                <Td className="text-xs text-ink-2">{fmtNum(w.runsPerWeek, 1)}× / wk <span className="text-ink-3">({freq(w.runsPerWeek)})</span></Td>
                <Td className="text-right tabular">{fmtNum(w.hoursPerWeek, 1)}</Td>
                <Td className="text-right tabular">{Math.round(w.repetitionScore)}</Td>
                <Td className="text-right tabular">{Math.round(w.automationScore)}</Td>
                <Td>{w.automated ? <Link href={`/app/agents/${w.agent?.id}`}><Badge tone="verified">automated</Badge></Link> : w.agent ? <Link href={`/app/agents/${w.agent.id}`}><Badge tone="warn">agent {w.agent.status}</Badge></Link> : <Badge tone="neutral">manual</Badge>}</Td>
              </tr>))}</tbody>
          </Table>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <CardHeader title="Workflow improvement opportunities" subtitle="Opportunities on the workflows this person performs." className="mb-0" />
          {data.opportunities.length === 0 ? <Card><p className="text-xs text-ink-3">None yet.</p></Card> : data.opportunities.map((o) => <OpportunityCard key={o.id} o={o} canAutomate={data.canWriteAgents} compact />)}
        </div>
        <div className="space-y-3">
          <Card data-testid="emp-recommended-agents">
            <CardHeader title="Recommended AI agents" subtitle="Templates matched to this person's workflows." />
            {data.recommendedAgents.length === 0 ? <p className="text-xs text-ink-3">No recommendations yet.</p> : (
              <ul className="space-y-2">{data.recommendedAgents.map((r) => (
                <li key={r.category} className="rounded-lg border border-border p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-ink"><Bot size={15} className="text-brand" />{r.templateName ?? r.label}</div>
                  <div className="mt-0.5 text-xs text-ink-2">{r.label} · for: {r.forOpportunities.join(", ")}</div>
                  {data.canWriteAgents && <Button size="sm" variant="secondary" className="mt-2" href={r.templateKey ? `/app/agents/new?template=${r.templateKey}` : "/app/agents/new"}>Start from this template</Button>}
                </li>))}</ul>
            )}
          </Card>
          {e.reports.length > 0 && (
            <Card data-testid="emp-reports">
              <CardHeader title="Direct reports" />
              <ul className="space-y-1 text-sm">{e.reports.map((r) => <li key={r.id}><Link href={`/app/employees/${r.id}`} className="text-brand hover:underline">{r.name}</Link> <span className="text-xs text-ink-3">{r.title}</span></li>)}</ul>
            </Card>
          )}
          <Card>
            <CardHeader title="Evidence" />
            <dl className="space-y-1 text-xs text-ink-2">
              <div className="flex justify-between"><dt>Events recorded</dt><dd className="tabular text-ink">{fmtNum(data.evidence.events)}</dd></div>
              <div className="flex justify-between"><dt>Observed window</dt><dd className="text-ink">{dateRange ?? "—"}</dd></div>
              <div className="flex justify-between"><dt>Basis of hours</dt><dd><BasisChip basis="observed" /></dd></div>
            </dl>
            <p className="mt-2 text-[11px] text-ink-3">Metadata only: app, category, duration, counts. No keystrokes, screenshots or window titles.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
