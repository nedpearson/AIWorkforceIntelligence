"use client";
import * as React from "react";
import Link from "next/link";
import { Bot, Sparkles, Scale, ShieldAlert } from "lucide-react";
import type { CalcTree, ProcessMap, WorkflowStep } from "@/db/schema";
import { Badge, BasisChip, Button, Card, CardHeader, PageHeader, Table, Th, Td, Tooltip } from "@/components/ui";
import { CalcTreeView } from "@/components/calc-tree";
import { StatTile, Meter } from "@/components/dashboard/stat-tile";
import { ProcessMapView } from "@/components/dashboard/process-map";
import { OpportunityActions } from "@/components/dashboard/opportunity-actions";
import { OPP_TYPE_LABEL, OPP_STATUS_TONE } from "@/components/dashboard/opportunity-card";
import { fmtUSD, fmtNum, fmtPct } from "@/lib/utils";

export type OppDetailData = {
  opp: {
    id: string; title: string; summary: string; type: string; status: string; rank: number; feasibility: number; risk: number; automationPct: number; hoursPerWeek: number; hoursRecoverablePerWeek: number;
    grossAnnualSavings: number; realizableAnnualSavings: number; implementationCost: number; annualOperatingCost: number; netAnnualSavings: number; paybackMonths: number | null; roi1y: number;
    basis: "observed" | "estimated" | "assumed"; requiresHumanJudgment: boolean; regulatoryFlag: string | null; recommendedAgentCategory: string | null; deployed: boolean;
    departmentId: string | null; departmentName: string | null; workflowName: string | null; createdAt: string; updatedAt: string; inScope: boolean;
    evidence: { sampleSize: number; observedFrom: string; observedTo: string; eventCount: number; employeeIds: string[]; notes: string[] };
  };
  calculation: CalcTree; storedCalculation: CalcTree; liveDiffers: boolean;
  workflow: { id: string; name: string; processMap: ProcessMap | null; steps: WorkflowStep[]; runsPerWeek: number; avgDurationMin: number; hoursPerWeek: number; repetitionScore: number; automationScore: number; duplicateOf: string | null } | null;
  performers: { id: string; name: string; title: string | null; hoursPerWeek: number }[];
  agents: { id: string; name: string; status: string; deployedAt: string | null; templateKey: string }[];
  measurements: { id: string; agentId: string | null; periodStart: string; periodEnd: string; hoursSaved: number; dollarsSaved: number; method: string; basis: "observed" | "estimated" | "assumed" }[];
  template: { key: string; name: string; description: string; category: string; monthlyCost: number };
  canWrite: boolean; canAutomate: boolean;
};

export function OpportunityDetail({ data }: { data: OppDetailData }) {
  const { opp: o } = data;
  const [showStored, setShowStored] = React.useState(false);
  const agent = data.agents.find((a) => a.status === "deployed") ?? data.agents[0] ?? null;
  const verified = data.measurements.reduce((s, m) => s + m.dollarsSaved, 0);
  return (
    <div className="space-y-6" data-testid="opportunity-detail">
      <PageHeader title={<span className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-sm font-semibold text-ink-2">{o.rank || "—"}</span>{o.title}</span>}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Badge tone="neutral">{OPP_TYPE_LABEL[o.type] ?? o.type}</Badge><Badge tone={OPP_STATUS_TONE[o.status] ?? "neutral"}>{o.status.replace("_", " ")}</Badge><BasisChip basis={o.basis} />{o.requiresHumanJudgment && <Badge tone="warn"><Scale size={11} className="mr-1" />judgment</Badge>}{o.regulatoryFlag && <Badge tone="danger"><ShieldAlert size={11} className="mr-1" />{o.regulatoryFlag}</Badge>}{o.departmentName && <Link href={`/app/departments/${o.departmentId}`} className="text-brand hover:underline">{o.departmentName}</Link>}{data.workflow && <Link href={`/app/workflows/${data.workflow.id}`} className="text-brand hover:underline">Workflow: {data.workflow.name}</Link>}<Link href="/app/opportunities" className="text-ink-3 hover:underline">All opportunities</Link></span>}
        actions={<>{data.canWrite && <OpportunityActions id={o.id} status={o.status} size="md" />}{data.canAutomate && !agent && o.status !== "rejected" && <Button href={`/app/agents/new?opportunityId=${o.id}`} data-testid="opp-automate"><Sparkles size={15} />Automate this</Button>}</>} />

      {!o.inScope && <Card className="border-warn/40 bg-warn-soft/40 text-xs text-ink-2" data-testid="opp-out-of-scope">This opportunity is rejected, so it is excluded from the organization totals. The numbers below are the ones stored when it was last analyzed.</Card>}

      <Card><p className="text-sm leading-relaxed text-ink">{o.summary}</p></Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile testid="kpi-opp-hours" label="Hrs recoverable / wk" value={fmtNum(o.hoursRecoverablePerWeek, 1)} caption={`of ${fmtNum(o.hoursPerWeek, 1)} observed · ${fmtPct(o.automationPct)} automatable`} basis="estimated" tone="projected" drill={{ tree: data.calculation, meaning: "Workflow hours per week × the share the automation removes × expected adoption." }} />
        <StatTile testid="kpi-opp-gross" label="Gross savings / yr" value={fmtUSD(o.grossAnnualSavings, { compact: true })} caption="value of all recoverable hours" basis="estimated" drill={{ tree: data.calculation, meaning: "Recoverable hours × working weeks × what those people cost per hour, loaded." }} />
        <StatTile testid="kpi-opp-realizable" label="Realizable / yr" value={fmtUSD(o.realizableAnnualSavings, { compact: true })} caption="after realization rate" basis="estimated" tone="projected" drill={{ tree: data.calculation, meaning: "The share of gross savings that becomes real money. Time saved ≠ payroll cut." }} />
        <StatTile testid="kpi-opp-cost" label="Setup + operating" value={<span>{fmtUSD(o.implementationCost, { compact: true })} <span className="text-base text-ink-2">+ {fmtUSD(o.annualOperatingCost, { compact: true })}/yr</span></span>} caption="one-time + yearly" basis="estimated" drill={{ tree: data.calculation, meaning: "Consulting hours and tooling to build it, plus monthly platform/model/runtime fees." }} />
        <StatTile testid="kpi-opp-payback" label="Payback" value={o.paybackMonths == null ? "—" : `${fmtNum(o.paybackMonths, 0)} mo`} caption={o.paybackMonths == null ? "not reached (net ≤ 0)" : `net ${fmtUSD(o.netAnnualSavings, { compact: true })}/yr · ROI ${fmtPct(o.roi1y)}`} basis="estimated" tone={o.paybackMonths != null && o.paybackMonths <= 24 ? "money" : "warn"} drill={{ tree: data.calculation, meaning: "Months of net savings needed to earn back the setup cost." }} />
        <StatTile testid="kpi-opp-verified" label="Verified so far" value={verified > 0 ? fmtUSD(verified, { compact: true }) : "—"} caption={verified > 0 ? `${data.measurements.length} measurement(s)` : agent ? "no measurement yet" : "no agent yet"} basis="observed" tone="verified" href={agent ? `/app/agents/${agent.id}` : "/app/agents"} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2" data-testid="opp-calculation">
          <CardHeader title="How the money is calculated" subtitle={data.liveDiffers ? "Live figures from the finance engine with current assumptions. The stored calculation from the analysis run is available below." : "Every line shows its formula, basis and source."} action={data.liveDiffers ? <button className="text-xs text-brand hover:underline" onClick={() => setShowStored(!showStored)} data-testid="opp-toggle-stored">{showStored ? "Show live" : "Show as analyzed"}</button> : undefined} />
          <CalcTreeView node={showStored ? data.storedCalculation : data.calculation} />
        </Card>
        <div className="space-y-3">
          <Card data-testid="opp-meters">
            <CardHeader title="Feasibility & risk" />
            <div className="space-y-3">
              <Meter value={o.feasibility} label="Feasibility" testid="opp-meter-feas" />
              <p className="text-[11px] text-ink-2">Automation score + API-friendliness of the apps involved; lower if no automation platform is connected.</p>
              <Meter value={o.risk} label="Risk" invert testid="opp-meter-risk" />
              <p className="text-[11px] text-ink-2">Regulatory data (+35), human judgment (+30), number of people affected (up to +25), handoffs (up to +10).</p>
            </div>
          </Card>
          <Card data-testid="opp-agent">
            <CardHeader title={agent ? "Linked agent" : "Recommended agent"} />
            {agent ? (
              <div className="text-sm"><Link href={`/app/agents/${agent.id}`} className="flex items-center gap-2 font-medium text-brand hover:underline"><Bot size={15} />{agent.name}</Link><div className="mt-1 text-xs text-ink-2">Status: <Badge tone={agent.status === "deployed" ? "money" : "neutral"}>{agent.status}</Badge>{agent.deployedAt && <> · deployed {agent.deployedAt.slice(0, 10)}</>}</div>{data.agents.length > 1 && <div className="mt-1 text-[11px] text-ink-3">{data.agents.length} agents linked</div>}</div>
            ) : (
              <div className="text-sm"><div className="flex items-center gap-2 font-medium text-ink"><Bot size={15} className="text-brand" />{data.template.name}</div><p className="mt-1 text-xs text-ink-2">{data.template.description}</p><p className="mt-1 text-[11px] text-ink-3">Template: {data.template.key} · about {fmtUSD(data.template.monthlyCost)}/mo to run</p>{data.canAutomate && o.status !== "rejected" && <Button size="sm" className="mt-2" href={`/app/agents/new?opportunityId=${o.id}&template=${data.template.key}`} data-testid="opp-use-template">Build from this template</Button>}</div>
            )}
          </Card>
          <Card data-testid="opp-evidence">
            <CardHeader title="Evidence" />
            <dl className="space-y-1 text-xs text-ink-2">
              <div className="flex justify-between"><dt>Observed runs</dt><dd className="tabular text-ink">{fmtNum(o.evidence.sampleSize)}</dd></div>
              <div className="flex justify-between"><dt>Window</dt><dd className="text-ink">{o.evidence.observedFrom.slice(0, 10) || "?"} → {o.evidence.observedTo.slice(0, 10) || "?"}</dd></div>
              <div className="flex justify-between"><dt>People</dt><dd className="text-ink">{o.evidence.employeeIds.length || data.performers.length}</dd></div>
              <div className="flex justify-between"><dt>Analyzed</dt><dd className="text-ink">{o.updatedAt.slice(0, 10)}</dd></div>
            </dl>
            {o.evidence.notes.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-ink-3">{o.evidence.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            {data.workflow && <Link href={`/app/workflows/${data.workflow.id}#evidence`} className="mt-2 inline-block text-xs text-brand hover:underline">View sample events on the workflow →</Link>}
          </Card>
        </div>
      </div>

      {data.workflow && (
        <Card data-testid="opp-workflow">
          <CardHeader title={<span>Linked workflow: <Link href={`/app/workflows/${data.workflow.id}`} className="text-brand hover:underline">{data.workflow.name}</Link></span>} subtitle={`${fmtNum(data.workflow.runsPerWeek, 1)} runs/wk · ${fmtNum(data.workflow.avgDurationMin, 1)} min avg · ${fmtNum(data.workflow.hoursPerWeek, 1)} hrs/wk · repetition ${Math.round(data.workflow.repetitionScore)} · automation ${Math.round(data.workflow.automationScore)}`} />
          <ProcessMapView map={data.workflow.processMap} testid="opp-process-map" />
        </Card>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-0">
          <CardHeader className="px-5 pt-5" title="People affected" subtitle="Who performs the workflow today." action={<Tooltip text="Their freed time is capacity to reassign, not a headcount reduction." />} />
          {data.performers.length === 0 ? <p className="px-5 pb-5 text-xs text-ink-3">No performer data.</p> : (
            <Table className="rounded-t-none border-0 shadow-none"><thead><tr><Th>Person</Th><Th className="text-right">Hrs/wk on this</Th><Th className="text-right">Share</Th></tr></thead>
              <tbody>{data.performers.map((p) => <tr key={p.id} className="hover:bg-surface-2"><Td><Link href={`/app/employees/${p.id}`} className="font-medium text-brand hover:underline">{p.name}</Link><div className="text-xs text-ink-3">{p.title ?? "—"}</div></Td><Td className="text-right tabular">{fmtNum(p.hoursPerWeek, 1)}</Td><Td className="text-right tabular">{o.hoursPerWeek > 0 ? fmtPct(p.hoursPerWeek / o.hoursPerWeek) : "—"}</Td></tr>)}</tbody></Table>
          )}
        </Card>
        <Card className="p-0" data-testid="opp-measurements">
          <CardHeader className="px-5 pt-5" title="Verified measurements" subtitle="Recorded after deployment. Never mixed into the projections above." />
          {data.measurements.length === 0 ? <p className="px-5 pb-5 text-xs text-ink-3">{agent ? "No measurement recorded yet. Record one from the agent page after a few weeks of runs." : "Deploy an agent first; measurements come from its run ledger."}</p> : (
            <Table className="rounded-t-none border-0 shadow-none"><thead><tr><Th>Period</Th><Th>Method</Th><Th className="text-right">Hours saved</Th><Th className="text-right">$ saved</Th><Th>Basis</Th></tr></thead>
              <tbody>{data.measurements.map((m) => <tr key={m.id}><Td className="text-xs">{m.periodStart.slice(0, 10)} → {m.periodEnd.slice(0, 10)}</Td><Td className="text-xs">{m.method.replace(/_/g, " ")}</Td><Td className="text-right tabular text-verified">{fmtNum(m.hoursSaved, 1)}</Td><Td className="text-right tabular text-verified">{fmtUSD(m.dollarsSaved)}</Td><Td><BasisChip basis={m.basis} /></Td></tr>)}</tbody></Table>
          )}
        </Card>
      </div>
    </div>
  );
}
