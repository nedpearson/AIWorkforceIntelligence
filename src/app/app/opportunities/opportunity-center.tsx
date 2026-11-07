"use client";
import * as React from "react";
import { Lightbulb, DollarSign, ShieldCheck, Timer, Layers, LayoutList, Grid2x2, CircleDot, Table2, Route } from "lucide-react";
import type { CalcTree } from "@/db/schema";
import { Button, Empty, PageHeader } from "@/components/ui";
import { KpiCard, FilterBar, Segmented, ExportButton, SectionHeader, type FilterDef } from "@/components/ui/enterprise";
import { DrilldownModal, type Drill } from "@/components/dashboard/stat-tile";
import { OpportunityCard, OPP_TYPE_LABEL, type OppCardData } from "@/components/dashboard/opportunity-card";
import { OpportunityActions } from "@/components/dashboard/opportunity-actions";
import { fmtUSD, fmtNum } from "@/lib/utils";
import { PriorityMatrix, OpportunityBubbles, OpportunityHeatmap } from "./opportunity-charts";

export type CenterRow = OppCardData & {
  departmentId: string | null; inScope: boolean; quadrant: string; valueScore: number; effortScore: number; roi1y: number; annualHoursSaved: number;
  score: number; confidence: "High" | "Medium" | "Low";
};
export type CenterKpis = {
  total: number; totalTree: CalcTree; highConfidence: number; highTree: CalcTree; topPayback: { months: number; title: string; id: string } | null; paybackTree: CalcTree | null;
  overlap: number; overlapTree: CalcTree; inScope: number;
};
type View = "cards" | "matrix" | "bubble" | "heatmap";
const VIEW_KEY = "bb-opp-view";

export function OpportunityCenter({ rows, totalCount, kpis, filterDefs, splits, departments, canWrite, canAutomate }: {
  rows: CenterRow[]; totalCount: number; kpis: CenterKpis; filterDefs: FilterDef[]; splits: { value: number; effort: number }; departments: { id: string; name: string }[]; canWrite: boolean; canAutomate: boolean;
}) {
  const [view, setView] = React.useState<View>("cards");
  React.useEffect(() => { try { const v = localStorage.getItem(VIEW_KEY) as View | null; if (v && ["cards", "matrix", "bubble", "heatmap"].includes(v)) setView(v); } catch {} }, []);
  const pick = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch {} };
  const [drill, setDrill] = React.useState<{ title: string; drill: Drill } | null>(null);

  const header = <PageHeader hero eyebrow="AI Opportunity Center" icon={<Lightbulb size={22} className="text-amber-300" />} title="Opportunities"
    subtitle="Every automation opportunity found in your observed work — scored 0–100 on eight explainable factors, with realizable (not gross) savings from the finance engine."
    actions={<><Button variant="glass" href="/app/roadmap" data-testid="opp-to-roadmap"><Route size={15} />Transformation roadmap</Button></>} />;

  if (!totalCount) return (
    <div>{header}<Empty title="No opportunities yet" body="Opportunities are created by the analysis for every workflow with an automation score of 35 or more. Run an observation campaign and the analysis first." action={<Button href="/app/onboarding">Open the rollout checklist</Button>} /></div>
  );
  const exportRows = rows.map((r) => ({ rank: r.rank, title: r.title, type: OPP_TYPE_LABEL[r.type] ?? r.type, status: r.status, department: r.departmentName ?? "", workflow: r.workflowName ?? "", score: r.score, confidence: r.confidence, quadrant: r.quadrant, feasibility: Math.round(r.feasibility), risk: Math.round(r.risk), hours_recoverable_per_week: Number(r.hoursRecoverablePerWeek.toFixed(2)), annual_hours_saved: Math.round(r.annualHoursSaved), gross_annual: Math.round(r.grossAnnualSavings ?? 0), realizable_annual: Math.round(r.realizableAnnualSavings), implementation_cost: Math.round(r.implementationCost ?? 0), payback_months: r.paybackMonths == null ? "" : Number(r.paybackMonths.toFixed(1)), roi_1y_pct: Math.round(r.roi1y * 100), recommended_solution: r.solution ?? "", in_scope: r.inScope ? "yes" : "no (rejected)" }));

  return (
    <div className="space-y-5">
      {header}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 stagger">
        <KpiCard testid="kpi-opp-total" label="Potential / yr" value={kpis.total} format={(n) => fmtUSD(n, { compact: true })} accent="gold" basis="estimated" icon={<DollarSign size={16} />} size="lg"
          caption={`${kpis.inScope} in-scope opportunit${kpis.inScope === 1 ? "y" : "ies"} · realizable, not gross`} onClick={() => setDrill({ title: "Total potential", drill: { tree: kpis.totalTree, meaning: "The realistic yearly value of the filtered opportunities: hours recoverable × loaded hourly cost × the share that becomes real money. Time saved is not a payroll cut." } })} />
        <KpiCard testid="kpi-opp-high" label="High confidence" value={kpis.highConfidence} format={(n) => fmtNum(n, 0)} accent="emerald" basis="observed" icon={<ShieldCheck size={16} />}
          caption={`of ${rows.length} shown · observed, ≥ 100 runs, ≥ 80% coverage`} onClick={() => setDrill({ title: "Evidence confidence", drill: { tree: kpis.highTree, meaning: "High confidence means the opportunity rests on observed data: at least 100 runs and at least 80% of the people doing it covered by a desktop collector." } })} />
        <KpiCard testid="kpi-opp-payback" label="Fastest payback" value={kpis.topPayback?.months ?? null} format={(n) => `${fmtNum(n, 1)} mo`} accent="cyan" basis="estimated" icon={<Timer size={16} />} emptyText="not reached"
          caption={kpis.topPayback ? kpis.topPayback.title : "no opportunity pays back under current assumptions"} onClick={kpis.paybackTree ? () => setDrill({ title: "Fastest payback", drill: { tree: kpis.paybackTree!, meaning: "Months of net savings needed to earn back the one-time implementation cost." } }) : undefined} />
        <KpiCard testid="kpi-opp-overlap" label="Overlap removed" value={kpis.overlap} format={(n) => fmtUSD(n, { compact: true })} accent="coral" basis="estimated" icon={<Layers size={16} />}
          caption={kpis.overlap > 0 ? "never double counted: shared workflows scaled down" : "no overlapping opportunities — nothing double counted"} onClick={() => setDrill({ title: "Overlap removed", drill: { tree: kpis.overlapTree, meaning: "When several opportunities target the same workflow, together they may claim at most 90% of its observed hours. The excess is removed so savings are never counted twice." } })} />
      </div>

      <FilterBar filters={filterDefs} testid="opp-filter" extra={<span className="text-xs text-ink-3" data-testid="opp-count">{rows.length} of {totalCount}</span>} />

      <SectionHeader accent="purple" title="Opportunity portfolio" subtitle="Ranked by the explainable opportunity score. Switch views to see value vs effort, feasibility vs value or where the money sits."
        action={<div className="flex flex-wrap items-center gap-2">
          <Segmented testid="opp-view" size="sm" value={view} onChange={pick} options={[
            { key: "cards", label: <span className="inline-flex items-center gap-1"><LayoutList size={13} />Ranked</span> },
            { key: "matrix", label: <span className="inline-flex items-center gap-1"><Grid2x2 size={13} />Matrix</span> },
            { key: "bubble", label: <span className="inline-flex items-center gap-1"><CircleDot size={13} />Bubble</span> },
            { key: "heatmap", label: <span className="inline-flex items-center gap-1"><Table2 size={13} />Heatmap</span> },
          ]} />
          <ExportButton rows={exportRows} filename="opportunities" testid="opp-export" />
        </div>} />

      {rows.length === 0 ? <Empty title="Nothing matches these filters" body="Clear a filter to see more opportunities." /> : (
        <>
          {view === "matrix" && <PriorityMatrix rows={rows.filter((r) => r.inScope)} splits={splits} />}
          {view === "bubble" && <OpportunityBubbles rows={rows.filter((r) => r.inScope)} />}
          {view === "heatmap" && <OpportunityHeatmap rows={rows} departments={departments} />}
          <div className={view === "cards" ? "space-y-3 stagger" : "hidden"} data-testid="opp-list">
            {rows.map((o) => <OpportunityCard key={o.id} o={o} canAutomate={canAutomate} actions={canWrite ? <OpportunityActions id={o.id} status={o.status} /> : undefined} />)}
          </div>
        </>
      )}
      <p className="text-[11px] text-ink-3">All dollar figures come from the finance engine (current default scenario). Realizable = gross × realization rate; capacity freed is not a payroll reduction.</p>
      {drill && <DrilldownModal open onClose={() => setDrill(null)} title={drill.title} drill={drill.drill} />}
    </div>
  );
}
