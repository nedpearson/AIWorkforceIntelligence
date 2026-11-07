import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import type { CalcTree } from "@/db/schema";
import { analyzeOpportunities, type OppFilters } from "@/engine/opportunity-score";
import { OPP_TYPE_LABEL } from "@/components/dashboard/opportunity-meta";
import { OpportunityCenter, type CenterRow, type CenterKpis } from "./opportunity-center";

export const metadata = { title: "AI Opportunity Center" };
export const dynamic = "force-dynamic";

const STATUSES = ["identified", "reviewing", "approved", "postponed", "analysis_requested", "in_progress", "deployed", "verified", "rejected"];

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("opportunities:read");
  const sp = await searchParams;
  const filters: OppFilters = { dept: sp.dept, bu: sp.bu, loc: sp.loc, status: sp.status, risk: sp.risk, type: sp.type };
  const a = await analyzeOpportunities(ctx.orgId, filters);

  const rows: CenterRow[] = a.filtered.map((o) => ({
    id: o.id, title: o.title, summary: o.summary, type: o.type, status: o.status, rank: o.answers.priorityRank, feasibility: o.line.feasibility, risk: o.line.risk,
    hoursRecoverablePerWeek: o.line.hoursRecoverablePerWeek, grossAnnualSavings: o.line.grossAnnualSavings, realizableAnnualSavings: o.line.realizableAnnualSavings,
    implementationCost: o.line.implementationCost, paybackMonths: o.line.paybackMonths, basis: o.basis, deployed: o.line.deployed, requiresHumanJudgment: o.requiresHumanJudgment,
    regulatoryFlag: o.regulatoryFlag, duplicate: o.duplicate, departmentId: o.departmentId, departmentName: o.departmentName, workflowName: o.workflowName, agent: o.agent,
    score: o.score.total, confidence: o.score.confidence.level, solution: o.answers.recommendedSolution.name, overlapRemoved: o.line.overlap?.realizableRemoved ?? 0,
    inScope: o.inScope, quadrant: o.quadrant, valueScore: o.valueScore, effortScore: o.effortScore, roi1y: o.line.roi1y, annualHoursSaved: o.answers.annualHoursSaved,
  }));

  // KPI drill-downs: aggregations of finance-engine lines (no new formulas).
  const scoped = a.filtered.filter((o) => o.inScope);
  const total = scoped.reduce((s, o) => s + o.line.realizableAnnualSavings, 0);
  const totalTree: CalcTree = { label: "Total potential (realizable, filtered)", value: total, unit: "usd", basis: "estimated", formula: `Σ realizable savings of ${scoped.length} in-scope opportunit${scoped.length === 1 ? "y" : "ies"} after overlap de-duplication`, source: "Finance engine (computeOrgFinancials)", children: scoped.slice(0, 25).map((o) => ({ label: o.title, value: o.line.realizableAnnualSavings, unit: "usd", basis: "estimated" as const, children: [o.line.tree] })) };
  const high = a.filtered.filter((o) => o.score.confidence.level === "High");
  const highTree: CalcTree = { label: "High-confidence opportunities", value: high.length, basis: "observed", formula: a.filtered[0]?.score.confidence.rule ?? "", children: a.filtered.map((o) => ({ label: `${o.title} — ${o.score.confidence.level}`, value: o.evidence.sampleSize, unit: "runs", basis: o.basis, source: o.score.confidence.reasons.join(" · ") })) };
  const withPayback = scoped.filter((o) => o.line.paybackMonths != null).sort((x, y) => (x.line.paybackMonths ?? 0) - (y.line.paybackMonths ?? 0));
  const top = withPayback[0];
  const paybackTree: CalcTree | null = top ? { label: `Fastest payback: ${top.title}`, value: top.line.paybackMonths ?? 0, unit: "months", basis: "estimated", formula: "implementation ÷ (net annual ÷ 12)", children: [
    { label: "Implementation cost (one-time)", value: top.line.implementationCost, unit: "usd", basis: "estimated" },
    { label: "Net annual savings", value: top.line.netAnnualSavings, unit: "usd", basis: "estimated", formula: "realizable − operating" },
  ] } : null;
  const overlapped = scoped.filter((o) => (o.line.overlap?.realizableRemoved ?? 0) > 0);
  const overlap = overlapped.reduce((s, o) => s + (o.line.overlap?.realizableRemoved ?? 0), 0);
  const overlapTree: CalcTree = { label: "Overlap removed", value: overlap, unit: "usd", basis: "estimated", formula: "Σ realizable removed where several opportunities target the same workflow (capped at 90% of its observed hours)", children: overlapped.map((o) => ({ label: o.title, value: o.line.overlap!.realizableRemoved, unit: "usd", basis: "estimated" as const, formula: `scaled × ${o.line.overlap!.factor.toFixed(3)}` })) };

  const kpis: CenterKpis = { total, totalTree, highConfidence: high.length, highTree, topPayback: top ? { months: top.line.paybackMonths ?? 0, title: top.title, id: top.id } : null, paybackTree, overlap, overlapTree, inScope: scoped.length };
  const deptName = new Map(a.options.departments.map((d) => [d.id, d.name]));
  const filterDefs = [
    { key: "dept", label: "Department", options: a.options.departments.map((d) => ({ value: d.id, label: d.name })) },
    { key: "bu", label: "Business unit", all: "All business units", options: a.options.businessUnits.map((d) => ({ value: d.id, label: d.name })) },
    { key: "loc", label: "Location", options: a.options.locations.map((d) => ({ value: d.id, label: d.name })) },
    { key: "status", label: "Status", all: "All statuses", options: STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ") })) },
    { key: "risk", label: "Risk", all: "Any risk", options: [{ value: "low", label: "Low risk (< 35)" }, { value: "medium", label: "Medium risk (35–59)" }, { value: "high", label: "High risk (≥ 60)" }] },
    { key: "type", label: "Type", all: "All types", options: Object.entries(OPP_TYPE_LABEL).map(([value, label]) => ({ value, label })) },
  ];
  return (
    <OpportunityCenter rows={rows} totalCount={a.all.length} kpis={kpis} filterDefs={filterDefs} splits={a.splits}
      departments={[...new Set(rows.map((r) => r.departmentId ?? ""))].map((id) => ({ id, name: id ? (deptName.get(id) ?? "Unknown") : "Unassigned" }))}
      canWrite={can(ctx.role, "opportunities:write")} canAutomate={can(ctx.role, "agents:write")} />
  );
}
