/**
 * Executive model + exports engine.
 *
 *  - computeExecutiveModel(orgId, overrides)  → ExecutiveModel: ONE serializable state object that drives the
 *    Executive Command Center (/app), Presentation Mode (/present), the Excel workbook and the PowerPoint deck.
 *    Every number comes from computeOrgFinancials (finance engine) or computeSavingsIntelligence (savings engine);
 *    this module only rolls them up, groups them and attaches drill-down trees / lineage.
 *  - fiveYearProjection(...)                  → extends costing.threeYearProjection with steady-state years 4–5
 *  - buildDeckSlides(model)                   → 12 slide specs (pure) shared by the web deck and the PPTX
 *  - buildExecutiveWorkbook(orgId, overrides) → exceljs Workbook (Summary, Savings Tiers, Departments, Opportunities,
 *                                               Workflows, Assumptions, Reconciliation)
 *  - buildExecutiveDeck(orgId, overrides, branding?) → PPTX Buffer (native charts + tables, branded)
 *  - computePortfolio(consultancyOrgId)       → per-client roll-up for the consultancy portfolio command center
 *
 * exceljs / pptxgenjs are loaded with createRequire at call time so they are never bundled into pages.
 */
import { eq } from "drizzle-orm";
import type ExcelJSNS from "exceljs";
import type PptxGenJSNS from "pptxgenjs";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import type { CalcTree } from "@/db/schema";
import { computeOrgFinancials } from "./finance";
import { computeSavingsIntelligence, type LineageItem, type SavingsIntelligence, type TierKey } from "./savings";
import { SCENARIOS, threeYearProjection, type ScenarioKey } from "./costing";
import type { OrgFinancials } from "./finance.types";
import {
  ACCENT_HEX, CONFIDENCE_RULE, OPP_TYPES, PRIORITY_RULE, SCENARIO_BOUNDS, TYPE_LABEL, confidenceOf, fmtValue, priorityOf,
  type Accent, type Basis, type Fmt,
} from "@/components/command/format";

// Resolved at runtime from the project root via process.getBuiltinModule (Node ≥ 22.3), which bundlers do not
// statically analyze — so exceljs/pptxgenjs are never pulled into the webpack server bundle.
let _req: NodeJS.Require | null = null;
const req = (id: string): unknown => {
  if (!_req) { const mod = process.getBuiltinModule("module") as typeof import("node:module"); _req = mod.createRequire(`${process.cwd()}/package.json`); }
  return _req(id);
};
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const n = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const clampTo = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type ExecOverrides = {
  scenario?: ScenarioKey;
  /** Multiplier on each opportunity's modelled automation share (FinancialAssumptions.automationPct). */
  automationPct?: number;
  adoptionRate?: number;
  realizationRate?: number;
  /** Verified-savings period (measurements overlapping the window). */
  periodStart?: Date;
  periodEnd?: Date;
};

export type Branding = { reportName?: string; primaryColor?: string; logoUrl?: string; footer?: string };

export type DeptRow = {
  departmentId: string | null; name: string; businessUnitId: string | null; locationId: string | null;
  employees: number; laborAnnual: number; hoursPerWeek: number; repetitiveHoursPerWeek: number; recoverableHoursPerWeek: number;
  grossAnnual: number; realizableAnnual: number; verifiedAnnual: number; automationPotentialPct: number; opportunities: number;
  share: number; priority: "High" | "Medium" | "Low" | "None"; overhead: number | null; overheadBasis: Basis;
};
export type Recommendation = {
  id: string; rank: number; title: string; type: string; status: string; departmentId: string | null; departmentName: string | null; workflowName: string | null;
  hoursRecoverablePerWeek: number; grossAnnual: number; realizableAnnual: number; implementationCost: number; annualOperatingCost: number; netAnnual: number;
  roi1y: number; paybackMonths: number | null; sampleSize: number; confidence: "High" | "Medium" | "Low"; deployed: boolean; feasibility: number; risk: number;
  automationPct: number; overlapRemoved: number; tree: CalcTree;
};
export type Insight = { key: string; title: string; body: string; accent: Accent; evidence: { label: string; href: string }[] };
export type WorkflowRow = { id: string; name: string; departmentName: string | null; hoursPerWeek: number; runsPerWeek: number; avgDurationMin: number; employeeCount: number; repetitionScore: number; automationScore: number; reworkRate: number; handoffCount: number; regulatoryFlag: string | null; basis: Basis; sampleSize: number };
export type YearRow = { year: number; savings: number; costs: number; net: number; cumulative: number; discounted: number };
export type FiveYear = { years: YearRow[]; npv: number; totalNet: number; roi5y: number; assumptions: string[] };

export type ExecutiveModel = {
  org: { id: string; name: string; industry: string | null; isDemo: boolean; branding: Branding; kind: "consultancy" | "client" };
  overrides: { scenario: ScenarioKey; automationPct: number; adoptionRate: number; realizationRate: number; periodStart: string | null; periodEnd: string | null };
  computedAt: string;
  fin: Omit<OrgFinancials, "byEmployee">;
  savings: SavingsIntelligence;
  headline: {
    laborExpense: { value: number; basis: Basis; tree: CalcTree };
    automationOpportunity: { value: number; tree: CalcTree };
    projectedNet: { value: number; tree: CalcTree };
    verified: { value: number; measurements: number; hours: number; tree: CalcTree };
  };
  opex: { show: boolean; total: number; overheadTotal: number; rows: { departmentId: string; name: string; overhead: number; basis: Basis }[]; tree: CalcTree };
  fiveYear: FiveYear;
  departments: DeptRow[];
  heatmap: { types: string[]; rows: { departmentId: string | null; name: string; cells: Record<string, { value: number; count: number }> }[]; max: number };
  recommendations: Recommendation[];
  tracker: { projectsByStatus: Record<string, number>; projects: { id: string; name: string; status: string; budget: number; spent: number }[]; approvedOpportunities: number; deployedAgents: number; agents: number; measurements: number; verifiedAnnual: number; ledgerApproved: number };
  insights: Insight[];
  workflows: WorkflowRow[];
  counts: { employeesActive: number; employeesCosted: number; departments: number; workflows: number; opportunities: number; collectorsActive: number; collectorsTotal: number; consentGaps: number };
  filters: { businessUnits: { id: string; name: string }[]; locations: { id: string; name: string; businessUnitId: string | null }[]; departments: { id: string; name: string; businessUnitId: string | null; locationId: string | null }[] };
  gaps: { key: string; title: string; body: string; href: string }[];
};

// ---------------------------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------------------------

/** Five-year cash flow: years 1–3 are costing.threeYearProjection verbatim; years 4–5 repeat year 3 (steady state), discounted. */
export function fiveYearProjection(p: { realizableAnnual: number; operatingAnnual: number; implementationCost: number; rampMonths: number; discountRate: number; platformAnnual: number }): FiveYear {
  const three = threeYearProjection(p);
  const years: YearRow[] = three.years.map((y) => ({ ...y }));
  const y3 = years[2];
  for (const year of [4, 5]) { const net = y3.savings - y3.costs; years.push({ year, savings: y3.savings, costs: y3.costs, net, cumulative: 0, discounted: net / Math.pow(1 + p.discountRate, year) }); }
  let cum = 0; for (const y of years) { cum += y.net; y.cumulative = cum; }
  return {
    years, npv: sum(years.map((y) => y.discounted)), totalNet: cum, roi5y: p.implementationCost > 0 ? cum / p.implementationCost : 0,
    assumptions: [
      `Year 1 savings ramp linearly over ${p.rampMonths} months; implementation cost is spent in year 1.`,
      "Years 2–5 hold savings, operating and platform cost flat at the year-2/3 run rate (no growth, no inflation).",
      `Discounted at ${(p.discountRate * 100).toFixed(0)}% per year for NPV.`,
      "Projected (estimated) — not verified. Time saved is capacity, not a payroll cut.",
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Executive model
// ---------------------------------------------------------------------------------------------

export function sanitizeOverrides(o: Partial<Record<keyof ExecOverrides, unknown>>): ExecOverrides {
  const out: ExecOverrides = {};
  if (o.scenario === "conservative" || o.scenario === "expected" || o.scenario === "aggressive") out.scenario = o.scenario;
  for (const k of ["automationPct", "adoptionRate", "realizationRate"] as const) {
    const v = o[k]; if (v === undefined || v === null || v === "") continue;
    const x = Number(v); if (Number.isFinite(x)) out[k] = clampTo(x, SCENARIO_BOUNDS[k]);
  }
  for (const k of ["periodStart", "periodEnd"] as const) {
    const v = o[k]; if (!v) continue;
    const d = v instanceof Date ? v : new Date(String(v)); if (!Number.isNaN(d.getTime())) out[k] = d;
  }
  return out;
}

export async function computeExecutiveModel(orgId: string, overrides: ExecOverrides = {}): Promise<ExecutiveModel> {
  const finOverrides = { scenario: overrides.scenario, automationPct: overrides.automationPct, adoptionRate: overrides.adoptionRate, realizationRate: overrides.realizationRate, periodStart: overrides.periodStart, periodEnd: overrides.periodEnd };
  const [finFull, savings, raw] = await Promise.all([
    computeOrgFinancials(orgId, finOverrides),
    computeSavingsIntelligence(orgId, finOverrides),
    withTenant(orgId, async (tx) => {
      const [org] = await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
      const [departments, businessUnits, locations, workflows, opps, agents, measurements, projects, collectors, consents, employees] = await Promise.all([
        tx.select().from(schema.departments).where(eq(schema.departments.orgId, orgId)),
        tx.select({ id: schema.businessUnits.id, name: schema.businessUnits.name }).from(schema.businessUnits).where(eq(schema.businessUnits.orgId, orgId)),
        tx.select({ id: schema.locations.id, name: schema.locations.name, businessUnitId: schema.locations.businessUnitId }).from(schema.locations).where(eq(schema.locations.orgId, orgId)),
        tx.select().from(schema.workflows).where(eq(schema.workflows.orgId, orgId)),
        tx.select({ id: schema.opportunities.id, evidence: schema.opportunities.evidence }).from(schema.opportunities).where(eq(schema.opportunities.orgId, orgId)),
        tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, opportunityId: schema.agents.opportunityId }).from(schema.agents).where(eq(schema.agents.orgId, orgId)),
        tx.select({ id: schema.savingsMeasurements.id, agentId: schema.savingsMeasurements.agentId }).from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId)),
        tx.select({ id: schema.projects.id, name: schema.projects.name, status: schema.projects.status, budget: schema.projects.budget, spent: schema.projects.spent }).from(schema.projects).where(eq(schema.projects.orgId, orgId)),
        tx.select({ id: schema.collectors.id, status: schema.collectors.status, employeeId: schema.collectors.employeeId }).from(schema.collectors).where(eq(schema.collectors.orgId, orgId)),
        tx.select({ employeeId: schema.consentRecords.employeeId, acknowledgedAt: schema.consentRecords.acknowledgedAt, withdrawnAt: schema.consentRecords.withdrawnAt }).from(schema.consentRecords).where(eq(schema.consentRecords.orgId, orgId)),
        tx.select({ id: schema.employees.id, base: schema.employees.baseAnnualCost, hourly: schema.employees.loadedHourlyCost }).from(schema.employees).where(eq(schema.employees.orgId, orgId)),
      ]);
      return { org, departments, businessUnits, locations, workflows, opps, agents, measurements, projects, collectors, consents, employees };
    }),
  ]);
  if (!raw.org) throw new Error(`computeExecutiveModel: organization ${orgId} not found`);
  const { byEmployee: _drop, ...fin } = finFull; void _drop; // per-person $ never leaves the server
  const a = fin.assumptions;
  const deptById = new Map(raw.departments.map((d) => [d.id, d]));

  // ---- headline: labor (aggregated by department, never per person) ----
  const laborTree: CalcTree = {
    ...fin.trees.totalLabor,
    children: fin.byDepartment.filter((d) => d.laborAnnual > 0).map((d) => ({ label: d.name, value: d.laborAnnual, unit: "usd", basis: fin.trees.totalLabor.basis, formula: `Σ base annual cost × (1 + ${a.benefitsLoadPct}) for ${d.employees} employee${d.employees === 1 ? "" : "s"}`, source: "Employee records (aggregated by department)" })),
  };

  // ---- opex (only when department overhead is entered) ----
  const overheadRows = raw.departments.filter((d) => d.annualOverhead != null && n(d.annualOverhead) > 0).map((d) => ({ departmentId: d.id, name: d.name, overhead: n(d.annualOverhead), basis: d.overheadBasis as Basis }));
  const overheadTotal = sum(overheadRows.map((r) => r.overhead));
  const opexTree: CalcTree = { label: "Entered annual operating expense", value: fin.totalAnnualLaborAnalyzed + overheadTotal, unit: "usd", basis: "assumed", formula: "annual labor analyzed + Σ department non-labor overhead (as entered)", children: [
    { label: "Annual labor analyzed", value: fin.totalAnnualLaborAnalyzed, unit: "usd", basis: fin.trees.totalLabor.basis },
    { label: "Department overhead (entered)", value: overheadTotal, unit: "usd", basis: "assumed", source: "departments.annual_overhead", children: overheadRows.map((r) => ({ label: r.name, value: r.overhead, unit: "usd", basis: r.basis, source: "Entered by the organization" })) },
  ] };

  // ---- 5-year ----
  const fiveYear = fiveYearProjection({ realizableAnnual: fin.realizableAnnualSavings, operatingAnnual: fin.annualOperatingCost, implementationCost: fin.implementationCost, rampMonths: a.rampMonths, discountRate: a.discountRate, platformAnnual: a.platformFeeMonthly * 12 });

  // ---- departments ----
  const totalRealizable = fin.realizableAnnualSavings;
  const departments: DeptRow[] = fin.byDepartment.map((d) => {
    const row = d.departmentId ? deptById.get(d.departmentId) : undefined;
    const share = totalRealizable > 0 ? d.realizableAnnual / totalRealizable : 0;
    return {
      departmentId: d.departmentId, name: d.name, businessUnitId: row?.businessUnitId ?? null, locationId: row?.locationId ?? null,
      employees: d.employees, laborAnnual: d.laborAnnual, hoursPerWeek: d.hoursPerWeek, repetitiveHoursPerWeek: d.repetitiveHoursPerWeek, recoverableHoursPerWeek: d.recoverableHoursPerWeek,
      grossAnnual: d.grossAnnual, realizableAnnual: d.realizableAnnual, verifiedAnnual: d.verifiedAnnual, automationPotentialPct: d.efficiencyGainPct, opportunities: d.opportunities,
      share, priority: priorityOf(share), overhead: row?.annualOverhead != null ? n(row.annualOverhead) : null, overheadBasis: (row?.overheadBasis ?? "assumed") as Basis,
    };
  });

  // ---- heatmap ----
  const heatRows = new Map<string, { departmentId: string | null; name: string; cells: Record<string, { value: number; count: number }> }>();
  for (const o of fin.opportunities) {
    const key = o.departmentId ?? "__none";
    let r = heatRows.get(key); if (!r) { r = { departmentId: o.departmentId, name: o.departmentName ?? "Unassigned", cells: {} }; heatRows.set(key, r); }
    const c = r.cells[o.type] ?? { value: 0, count: 0 }; c.value += o.realizableAnnualSavings; c.count += 1; r.cells[o.type] = c;
  }
  const heatTypes = OPP_TYPES.filter((t) => fin.opportunities.some((o) => o.type === t));
  const heatList = [...heatRows.values()].sort((x, y) => sum(Object.values(y.cells).map((c) => c.value)) - sum(Object.values(x.cells).map((c) => c.value)));
  const heatMax = Math.max(0, ...heatList.flatMap((r) => Object.values(r.cells).map((c) => c.value)));

  // ---- recommendations ----
  const sampleById = new Map(raw.opps.map((o) => [o.id, n(o.evidence?.sampleSize)]));
  const recommendations: Recommendation[] = fin.opportunities.map((o, i) => {
    const s = sampleById.get(o.id) ?? 0;
    return { id: o.id, rank: i + 1, title: o.title, type: o.type, status: o.status, departmentId: o.departmentId, departmentName: o.departmentName, workflowName: o.workflowName,
      hoursRecoverablePerWeek: o.hoursRecoverablePerWeek, grossAnnual: o.grossAnnualSavings, realizableAnnual: o.realizableAnnualSavings, implementationCost: o.implementationCost, annualOperatingCost: o.annualOperatingCost, netAnnual: o.netAnnualSavings,
      roi1y: o.implementationCost > 0 ? (o.netAnnualSavings - o.implementationCost) / o.implementationCost : 0, paybackMonths: o.paybackMonths, sampleSize: s, confidence: confidenceOf(s), deployed: o.deployed, feasibility: o.feasibility, risk: o.risk,
      automationPct: o.automationPct, overlapRemoved: o.overlap?.realizableRemoved ?? 0, tree: o.tree };
  });

  // ---- tracker ----
  const projectsByStatus: Record<string, number> = {};
  for (const p of raw.projects) projectsByStatus[p.status] = (projectsByStatus[p.status] ?? 0) + 1;
  const deployedAgents = raw.agents.filter((g) => g.status === "deployed");
  const approvedOpportunities = fin.opportunities.filter((o) => ["approved", "in_progress", "deployed", "verified"].includes(o.status)).length;

  // ---- consent gaps: employees with an active collector but no current acknowledged consent ----
  const consentOk = new Set(raw.consents.filter((c) => c.acknowledgedAt && !c.withdrawnAt).map((c) => c.employeeId));
  const monitored = new Set(raw.collectors.filter((c) => c.status === "active" && c.employeeId).map((c) => c.employeeId as string));
  const consentGaps = [...monitored].filter((id) => !consentOk.has(id)).length;

  // ---- insights (deterministic) ----
  const insights: Insight[] = [];
  const topDept = departments.filter((d) => d.departmentId && d.realizableAnnual > 0)[0];
  if (topDept) insights.push({ key: "top_dept", accent: "gold", title: `${topDept.name} holds the largest opportunity`, body: `${fmtValue(topDept.realizableAnnual, "usdCompact")}/yr realizable — ${fmtValue(topDept.share, "pct")} of the enterprise total across ${topDept.opportunities} opportunit${topDept.opportunities === 1 ? "y" : "ies"}; ${fmtValue(topDept.recoverableHoursPerWeek, "hours")}/wk of capacity.`, evidence: [{ label: topDept.name, href: `/app/departments/${topDept.departmentId}` }, { label: "Opportunities", href: `/app/opportunities?dept=${topDept.departmentId}` }] });
  if (fin.overlapRemovedAnnual > 0) {
    const ov = fin.opportunities.filter((o) => o.overlap);
    insights.push({ key: "overlap", accent: "indigo", title: "Overlapping opportunities de-duplicated", body: `${fmtValue(fin.overlapRemovedAnnual, "usdCompact")}/yr was removed because ${ov.length} opportunities target the same workflows. Totals never double count.`, evidence: ov.slice(0, 4).map((o) => ({ label: o.title, href: `/app/opportunities/${o.id}` })) });
  }
  const measuredAgents = new Set(raw.measurements.map((m) => m.agentId).filter(Boolean) as string[]);
  const unverified = deployedAgents.filter((g) => !measuredAgents.has(g.id));
  if (unverified.length) insights.push({ key: "unverified_agents", accent: "cyan", title: `${unverified.length} deployed agent${unverified.length === 1 ? " has" : "s have"} no verified results`, body: "Record a measurement from the run ledger so their savings move from projected to verified.", evidence: unverified.slice(0, 4).map((g) => ({ label: g.name, href: `/app/agents/${g.id}?tab=results` })) });
  const badChecks = savings.checks.filter((c) => c.status !== "pass");
  if (badChecks.length) insights.push({ key: "recon", accent: "coral", title: `${badChecks.length} reconciliation check${badChecks.length === 1 ? "" : "s"} need attention`, body: badChecks.map((c) => `${c.label}: ${c.detail}`).join(" · "), evidence: [{ label: "Savings reconciliation", href: "/app/savings" }] });
  if (consentGaps > 0) insights.push({ key: "consent", accent: "coral", title: `${consentGaps} monitored employee${consentGaps === 1 ? "" : "s"} without current consent`, body: "An active collector is assigned but no acknowledged, non-withdrawn notice is on file. Resolve before using their data.", evidence: [{ label: "Desktop collectors", href: "/app/collection" }, { label: "Workforce", href: "/app/employees" }] });
  if (savings.pendingApprovals.length) insights.push({ key: "pending", accent: "purple", title: `${savings.pendingApprovals.length} savings claim${savings.pendingApprovals.length === 1 ? "" : "s"} awaiting approval`, body: `${fmtValue(sum(savings.pendingApprovals.map((p) => p.amount)), "usdCompact")}/yr submitted to the ledger is not counted until finance approves it.`, evidence: savings.pendingApprovals.slice(0, 4).map((p) => ({ label: p.title, href: `/app/savings?entry=${p.id}` })) });
  if (insights.length < 3 && fin.repetitiveHoursPerWeek > 0) insights.push({ key: "repetitive", accent: "cyan", title: `${fmtValue(fin.repetitiveSharePct, "pct")} of observed time is repetitive`, body: `${fmtValue(fin.repetitiveHoursPerWeek, "hours")}/wk of ${fmtValue(fin.hoursObservedPerWeek, "hours")}/wk observed is spent in workflows with a repetition score of 50+.`, evidence: [{ label: "Workflow explorer", href: "/app/workflows" }] });
  const topRec = recommendations.find((r) => !r.deployed);
  if (insights.length < 3 && topRec) insights.push({ key: "top_rec", accent: "purple", title: `Best next automation: ${topRec.title}`, body: `${fmtValue(topRec.realizableAnnual, "usdCompact")}/yr realizable for ${fmtValue(topRec.implementationCost, "usdCompact")} to implement${topRec.paybackMonths != null ? `, payback ${fmtValue(topRec.paybackMonths, "months")}` : ""}. Confidence ${topRec.confidence} (${topRec.sampleSize} observations).`, evidence: [{ label: "View analysis", href: `/app/opportunities/${topRec.id}` }] });
  if (insights.length < 3 && fin.verifiedMeasurements === 0 && fin.opportunityCount > 0) insights.push({ key: "no_verified", accent: "emerald", title: "Nothing verified yet", body: "All savings on this page are projections until an agent is deployed and measured. Verified results are always shown separately.", evidence: [{ label: "AI agents", href: "/app/agents" }] });

  // ---- workflows ----
  const workflows: WorkflowRow[] = raw.workflows.map((w) => ({ id: w.id, name: w.name, departmentName: w.departmentId ? (deptById.get(w.departmentId)?.name ?? null) : null, hoursPerWeek: n(w.hoursPerWeek), runsPerWeek: n(w.runsPerWeek), avgDurationMin: n(w.avgDurationMin), employeeCount: w.employeeCount, repetitionScore: n(w.repetitionScore), automationScore: n(w.automationScore), reworkRate: n(w.reworkRate), handoffCount: w.handoffCount ?? 0, regulatoryFlag: w.regulatoryFlag, basis: w.basis as Basis, sampleSize: n(w.evidence?.sampleSize) }))
    .sort((x, y) => y.hoursPerWeek - x.hoursPerWeek);

  // ---- gaps ----
  const employeesCosted = raw.employees.filter((e) => n(e.base) > 0 || n(e.hourly) > 0).length;
  const gaps: ExecutiveModel["gaps"] = [];
  if (raw.employees.length === 0) gaps.push({ key: "employees", title: "No employees on file", body: "Import your workforce so labor cost can be analyzed.", href: "/app/employees" });
  else if (employeesCosted === 0) gaps.push({ key: "costs", title: "No compensation data", body: "Add base annual cost per employee so time can be valued.", href: "/app/employees" });
  if (raw.collectors.length === 0) gaps.push({ key: "collectors", title: "No desktop collectors", body: "Deploy collectors (with employee notice) to observe real work.", href: "/app/collection" });
  if (raw.workflows.length === 0) gaps.push({ key: "workflows", title: "No workflows discovered", body: "Run the analysis once a few weeks of activity are collected.", href: "/app/workflows" });
  if (fin.opportunityCount === 0) gaps.push({ key: "opportunities", title: "No automation opportunities", body: "Opportunities appear after the analysis identifies repetitive workflows.", href: "/app/opportunities" });
  if (fin.verifiedMeasurements === 0) gaps.push({ key: "verified", title: "No verified results", body: "Deploy an agent and record a measurement to verify savings.", href: "/app/agents" });

  const branding = raw.org.branding ?? {};
  return {
    org: { id: raw.org.id, name: raw.org.name, industry: raw.org.industry, isDemo: raw.org.isDemo, branding, kind: raw.org.kind },
    overrides: { scenario: fin.scenario, automationPct: a.automationPct, adoptionRate: a.adoptionRate, realizationRate: a.realizationRate, periodStart: overrides.periodStart?.toISOString() ?? null, periodEnd: overrides.periodEnd?.toISOString() ?? null },
    computedAt: fin.computedAt,
    fin: { ...fin, trees: { ...fin.trees, totalLabor: laborTree } },
    savings,
    headline: {
      laborExpense: { value: fin.totalAnnualLaborAnalyzed, basis: fin.trees.totalLabor.basis, tree: laborTree },
      automationOpportunity: { value: fin.grossAnnualSavings, tree: fin.trees.grossSavings },
      projectedNet: { value: fin.netAnnualSavings, tree: fin.trees.netSavings },
      verified: { value: savings.tiers.verifiedTime.amount, measurements: fin.verifiedMeasurements, hours: fin.verifiedHoursSaved, tree: savings.tiers.verifiedTime.tree },
    },
    opex: { show: overheadRows.length > 0, total: fin.totalAnnualLaborAnalyzed + overheadTotal, overheadTotal, rows: overheadRows, tree: opexTree },
    fiveYear, departments,
    heatmap: { types: [...heatTypes], rows: heatList, max: heatMax },
    recommendations,
    tracker: { projectsByStatus, projects: raw.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, budget: n(p.budget), spent: n(p.spent) })), approvedOpportunities, deployedAgents: deployedAgents.length, agents: raw.agents.length, measurements: fin.verifiedMeasurements, verifiedAnnual: savings.tiers.verifiedTime.amount, ledgerApproved: savings.tiers.approved.lineage.length + savings.tiers.costAvoidance.lineage.length + savings.tiers.realizedHard.lineage.length },
    insights: insights.slice(0, 6), workflows,
    counts: { employeesActive: raw.employees.length, employeesCosted, departments: raw.departments.length, workflows: raw.workflows.length, opportunities: fin.opportunityCount, collectorsActive: raw.collectors.filter((c) => c.status === "active").length, collectorsTotal: raw.collectors.length, consentGaps },
    filters: { businessUnits: raw.businessUnits, locations: raw.locations, departments: raw.departments.map((d) => ({ id: d.id, name: d.name, businessUnitId: d.businessUnitId, locationId: d.locationId })) },
    gaps,
  };
}

/** Resolve global filter params (bu, dept, loc) to a department-id set; null = no filter. */
export function resolveDepartmentFilter(model: Pick<ExecutiveModel, "filters">, f: { bu?: string; dept?: string; loc?: string }): Set<string> | null {
  if (!f.bu && !f.dept && !f.loc) return null;
  return new Set(model.filters.departments.filter((d) => (!f.dept || d.id === f.dept) && (!f.bu || d.businessUnitId === f.bu) && (!f.loc || d.locationId === f.loc)).map((d) => d.id));
}

// ---------------------------------------------------------------------------------------------
// Slides (pure; shared by the web deck and the PPTX)
// ---------------------------------------------------------------------------------------------

export type SlideMetric = { label: string; value: number | null; format: Fmt; basis?: Basis; accent: Accent; note?: string };
export type SlideSpec = {
  key: string; n: number; title: string; kicker: string; lead: string;
  metrics: SlideMetric[];
  chart?: { title: string; format: Fmt; bars: { label: string; value: number; accent: Accent }[] };
  table?: { title?: string; columns: { label: string; format?: Fmt }[]; rows: (string | number | null)[][] };
  bullets?: string[];
  phases?: { name: string; window: string; value: number; items: string[] }[];
  footnote?: string;
  empty?: { title: string; body: string; href: string };
};
export const SLIDE_TITLES = ["Company overview", "Current operational expenses", "Workforce workflow analysis", "Major inefficiencies", "Department automation opportunities", "Recommended AI solutions", "Potential time savings", "Financial savings projections", "Required investment", "Expected ROI", "Transformation roadmap", "Next steps"] as const;

export function buildDeckSlides(m: ExecutiveModel): SlideSpec[] {
  const f = m.fin; const a = f.assumptions; const weeks = a.workWeeksPerYear;
  const sc = SCENARIOS[m.overrides.scenario].label;
  const gap = (key: string) => m.gaps.find((g) => g.key === key);
  const emptyFrom = (...keys: string[]) => { const g = keys.map(gap).find(Boolean); return g ? { title: g.title, body: g.body, href: g.href } : undefined; };
  const depts = m.departments.filter((d) => d.departmentId || d.realizableAnnual > 0 || d.laborAnnual > 0);
  const recs = m.recommendations;
  const annualHours = f.hoursRecoverablePerWeek * weeks;
  const fte = annualHours / (40 * weeks);
  const ineff = [...m.workflows].sort((x, y) => y.hoursPerWeek * y.repetitionScore - x.hoursPerWeek * x.repetitionScore).slice(0, 7);
  const quick = recs.filter((r) => !r.deployed && r.paybackMonths != null && r.paybackMonths <= 6 && r.risk < 50);
  const mid = recs.filter((r) => !r.deployed && !quick.includes(r) && r.paybackMonths != null && r.paybackMonths <= 18);
  const later = recs.filter((r) => !r.deployed && !quick.includes(r) && !mid.includes(r));
  const scenarioNote = `${sc} scenario · automation ×${m.overrides.automationPct.toFixed(2)} · adoption ${fmtValue(m.overrides.adoptionRate, "pct")} · realization ${fmtValue(m.overrides.realizationRate, "pct")}`;

  const s: Omit<SlideSpec, "n" | "title">[] = [
    { key: "overview", kicker: m.org.industry ?? "Company overview", lead: f.opportunityCount > 0 ? `AI can return ${fmtValue(f.realizableAnnualSavings, "usdCompact")}/yr in realizable value and ${fmtValue(f.hoursRecoverablePerWeek, "hours")}/wk of capacity — here is what we observed.` : `${m.org.name} — what we observed and analyzed so far.`,
      metrics: [
        { label: "Employees analyzed", value: f.employeesAnalyzed, format: "count", basis: "observed", accent: "royal" },
        { label: "Departments", value: m.counts.departments, format: "count", basis: "observed", accent: "indigo" },
        { label: "Workflows discovered", value: m.counts.workflows, format: "count", basis: "observed", accent: "cyan" },
        { label: "Hours observed / week", value: f.hoursObservedPerWeek, format: "hours", basis: "observed", accent: "purple" },
      ],
      bullets: [
        `${m.counts.collectorsActive} of ${m.counts.collectorsTotal} desktop collectors active; metadata only — never content, keystrokes or screenshots.`,
        `${fmtValue(f.repetitiveSharePct, "pct")} of observed time is in repetitive workflows (repetition score ≥ 50).`,
        `${f.opportunityCount} automation opportunities identified; ${f.deployedAgents} AI agent${f.deployedAgents === 1 ? "" : "s"} deployed.`,
      ],
      empty: f.employeesAnalyzed === 0 && m.counts.workflows === 0 ? emptyFrom("employees", "collectors", "workflows") : undefined },
    { key: "opex", kicker: "Cost base", lead: "What the analyzed workforce costs each year, before any automation.",
      metrics: [
        { label: "Annual labor expense", value: f.totalAnnualLaborAnalyzed, format: "usdCompact", basis: m.headline.laborExpense.basis, accent: "royal", note: `${f.employeesAnalyzed} employees, salary + ${fmtValue(a.benefitsLoadPct, "pct")} benefits load` },
        ...(m.opex.show ? [{ label: "Department overhead (entered)", value: m.opex.overheadTotal, format: "usdCompact" as Fmt, basis: "assumed" as Basis, accent: "indigo" as Accent }, { label: "Entered operating expense", value: m.opex.total, format: "usdCompact" as Fmt, basis: "assumed" as Basis, accent: "midnight" as Accent }] : []),
        { label: "Spent on automatable work", value: f.grossAnnualSavings, format: "usdCompact", basis: "estimated", accent: "gold", note: "Gross value of recoverable hours" },
      ],
      chart: depts.length ? { title: "Labor expense by department", format: "usdCompact", bars: depts.filter((d) => d.laborAnnual > 0).slice(0, 8).map((d) => ({ label: d.name, value: d.laborAnnual, accent: "royal" as Accent })) } : undefined,
      footnote: "Labor is aggregated by department; individual compensation is never shown.",
      empty: f.totalAnnualLaborAnalyzed === 0 ? emptyFrom("employees", "costs", "collectors") : undefined },
    { key: "workflows", kicker: "Workflow analysis", lead: "Where the hours go — the most time-consuming workflows observed.",
      metrics: [
        { label: "Observed hours / week", value: f.hoursObservedPerWeek, format: "hours", basis: "observed", accent: "royal" },
        { label: "Repetitive hours / week", value: f.repetitiveHoursPerWeek, format: "hours", basis: "observed", accent: "cyan" },
        { label: "Repetitive share", value: f.repetitiveSharePct, format: "pct", basis: "observed", accent: "purple" },
      ],
      table: m.workflows.length ? { columns: [{ label: "Workflow" }, { label: "Department" }, { label: "Hrs / wk", format: "hours" }, { label: "Repetition", format: "count" }, { label: "Automation score", format: "count" }], rows: m.workflows.slice(0, 7).map((w) => [w.name, w.departmentName ?? "—", w.hoursPerWeek, w.repetitionScore, w.automationScore]) } : undefined,
      empty: m.workflows.length === 0 ? emptyFrom("workflows", "collectors") : undefined },
    { key: "inefficiencies", kicker: "Inefficiencies", lead: "High-volume, highly repetitive work with rework and hand-offs.",
      metrics: [
        { label: "Overlap removed", value: f.overlapRemovedAnnual, format: "usdCompact", basis: "estimated", accent: "indigo", note: "De-duplicated, never double counted" },
        { label: "Workflows with rework", value: m.workflows.filter((w) => w.reworkRate > 0.05).length, format: "count", basis: "observed", accent: "coral", note: "Rework rate above 5%" },
        { label: "Regulated workflows", value: m.workflows.filter((w) => w.regulatoryFlag).length, format: "count", basis: "observed", accent: "gold", note: "Need human review" },
      ],
      table: ineff.length ? { columns: [{ label: "Workflow" }, { label: "Hrs / wk", format: "hours" }, { label: "Repetition", format: "count" }, { label: "Rework", format: "pct" }, { label: "Hand-offs", format: "count" }, { label: "Flag" }], rows: ineff.map((w) => [w.name, w.hoursPerWeek, w.repetitionScore, w.reworkRate, w.handoffCount, w.regulatoryFlag ?? "—"]) } : undefined,
      footnote: "Ranked by hours per week × repetition score.",
      empty: ineff.length === 0 ? emptyFrom("workflows", "collectors") : undefined },
    { key: "departments", kicker: "Department opportunities", lead: "Realizable annual savings by department, with automation potential.",
      metrics: depts.filter((d) => d.realizableAnnual > 0).slice(0, 3).map((d, i) => ({ label: d.name, value: d.realizableAnnual, format: "usdCompact" as Fmt, basis: "estimated" as Basis, accent: (["gold", "cyan", "purple"] as Accent[])[i], note: `${fmtValue(d.automationPotentialPct, "pct")} automation potential · ${d.priority} priority` })),
      chart: depts.some((d) => d.realizableAnnual > 0) ? { title: "Realizable savings by department", format: "usdCompact", bars: depts.filter((d) => d.realizableAnnual > 0).slice(0, 8).map((d) => ({ label: d.name, value: d.realizableAnnual, accent: "gold" as Accent })) } : undefined,
      footnote: PRIORITY_RULE,
      empty: f.opportunityCount === 0 ? emptyFrom("opportunities", "workflows") : undefined },
    { key: "solutions", kicker: "Recommended AI solutions", lead: "Ranked by realizable annual benefit.",
      metrics: [],
      table: recs.length ? { columns: [{ label: "Opportunity" }, { label: "Type" }, { label: "Annual benefit", format: "usdCompact" }, { label: "Implementation", format: "usdCompact" }, { label: "1-yr ROI", format: "pct" }, { label: "Confidence" }], rows: recs.slice(0, 7).map((r) => [r.title, TYPE_LABEL[r.type] ?? r.type, r.realizableAnnual, r.implementationCost, r.roi1y, `${r.confidence} (${r.sampleSize})`]) } : undefined,
      footnote: CONFIDENCE_RULE,
      empty: recs.length === 0 ? emptyFrom("opportunities", "workflows") : undefined },
    { key: "time", kicker: "Time savings", lead: "Capacity software can take over — to redeploy to higher-value work.",
      metrics: [
        { label: "Recoverable hours / week", value: f.hoursRecoverablePerWeek, format: "hours", basis: "estimated", accent: "cyan" },
        { label: "Recoverable hours / year", value: annualHours, format: "hours", basis: "estimated", accent: "cyan", note: `× ${weeks} working weeks` },
        { label: "Capacity (FTE-equivalent)", value: fte, format: "text", basis: "estimated", accent: "indigo", note: "Capacity, not headcount reduction" },
        { label: "Share of repetitive time", value: f.repetitiveHoursPerWeek > 0 ? f.hoursRecoverablePerWeek / f.repetitiveHoursPerWeek : null, format: "pct", basis: "estimated", accent: "purple" },
      ],
      chart: depts.some((d) => d.recoverableHoursPerWeek > 0) ? { title: "Recoverable hours per week by department", format: "hours", bars: depts.filter((d) => d.recoverableHoursPerWeek > 0).slice(0, 8).map((d) => ({ label: d.name, value: d.recoverableHoursPerWeek, accent: "cyan" as Accent })) } : undefined,
      footnote: "Time saved ≠ payroll cut. Any staffing or role change requires management and HR/legal review.",
      empty: f.opportunityCount === 0 ? emptyFrom("opportunities") : undefined },
    { key: "projections", kicker: "Financial projections", lead: `Five-year outlook · ${scenarioNote}.`,
      metrics: [
        { label: "Gross annual savings", value: f.grossAnnualSavings, format: "usdCompact", basis: "estimated", accent: "gold" },
        { label: "Realizable annual savings", value: f.realizableAnnualSavings, format: "usdCompact", basis: "estimated", accent: "gold" },
        { label: "Net annual savings", value: f.netAnnualSavings, format: "usdCompact", basis: "estimated", accent: "gold" },
        { label: "Verified to date (annualized)", value: m.headline.verified.measurements > 0 ? m.headline.verified.value : null, format: "usdCompact", basis: "observed", accent: "emerald", note: m.headline.verified.measurements > 0 ? `${m.headline.verified.measurements} measurements` : "Nothing measured yet" },
      ],
      table: { columns: [{ label: "Year" }, { label: "Savings", format: "usdCompact" }, { label: "Costs", format: "usdCompact" }, { label: "Net", format: "usdCompact" }, { label: "Cumulative", format: "usdCompact" }], rows: m.fiveYear.years.map((y) => [`Year ${y.year}`, y.savings, y.costs, y.net, y.cumulative]) },
      footnote: m.fiveYear.assumptions.join(" "),
      empty: f.opportunityCount === 0 ? emptyFrom("opportunities") : undefined },
    { key: "investment", kicker: "Required investment", lead: "One-time implementation plus the yearly cost to run.",
      metrics: [
        { label: "Implementation (one-time)", value: f.implementationCost, format: "usdCompact", basis: "estimated", accent: "indigo" },
        { label: "Annual operating cost", value: f.annualOperatingCost, format: "usdCompact", basis: "assumed", accent: "indigo" },
        { label: "Platform fee (annual)", value: a.platformFeeMonthly * 12, format: "usdCompact", basis: "assumed", accent: "royal" },
      ],
      table: recs.length ? { columns: [{ label: "Opportunity" }, { label: "Implementation", format: "usd" }, { label: "Operating / yr", format: "usd" }, { label: "Payback", format: "months" }], rows: [...recs].sort((x, y) => y.implementationCost - x.implementationCost).slice(0, 7).map((r) => [r.title, r.implementationCost, r.annualOperatingCost, r.paybackMonths]) } : undefined,
      footnote: `Implementation = consulting hours × $${a.consultingHourly}/hr + tooling, per opportunity${m.overrides.scenario !== "expected" ? ` (× ${SCENARIOS[m.overrides.scenario].costMult} ${sc.toLowerCase()} cost multiplier)` : ""}.`,
      empty: f.opportunityCount === 0 ? emptyFrom("opportunities") : undefined },
    { key: "roi", kicker: "Expected ROI", lead: "Return on the implementation investment.",
      metrics: [
        { label: "First-year ROI", value: f.roi1y, format: "pct", basis: "estimated", accent: "indigo" },
        { label: "Payback", value: f.paybackMonths, format: "months", basis: "estimated", accent: "indigo", note: f.paybackMonths == null ? "Not reached at current net" : undefined },
        { label: "3-year ROI", value: f.threeYear.roi3y, format: "pct", basis: "estimated", accent: "purple" },
        { label: "5-year NPV", value: m.fiveYear.npv, format: "usdCompact", basis: "estimated", accent: "gold" },
      ],
      table: { title: (() => { const pr = SCENARIOS[m.overrides.scenario]; const custom = Math.abs(pr.automationMult - m.overrides.automationPct) > 1e-6 || Math.abs(pr.adoptionRate - m.overrides.adoptionRate) > 1e-6 || Math.abs(pr.realizationRate - m.overrides.realizationRate) > 1e-6; return custom ? "Scenario comparison — your custom automation, adoption and realization apply to all three; presets then differ only by cost multiplier" : "Scenario comparison (preset assumptions)"; })(), columns: [{ label: "Scenario" }, { label: "Realizable / yr", format: "usdCompact" }, { label: "Net / yr", format: "usdCompact" }, { label: "1-yr ROI", format: "pct" }, { label: "Payback", format: "months" }], rows: (["conservative", "expected", "aggressive"] as ScenarioKey[]).map((k) => [f.scenarios[k].label, f.scenarios[k].realizableAnnualSavings, f.scenarios[k].netAnnualSavings, f.scenarios[k].roi1y, f.scenarios[k].paybackMonths]) },
      empty: f.opportunityCount === 0 ? emptyFrom("opportunities") : undefined },
    { key: "roadmap", kicker: "Transformation roadmap", lead: "Sequenced by payback and risk.",
      metrics: [], phases: [
        { name: "Phase 1 · Quick wins", window: "0–90 days", value: sum(quick.map((r) => r.realizableAnnual)), items: quick.slice(0, 4).map((r) => r.title) },
        { name: "Phase 2 · Scale", window: "3–6 months", value: sum(mid.map((r) => r.realizableAnnual)), items: mid.slice(0, 4).map((r) => r.title) },
        { name: "Phase 3 · Transform", window: "6–12 months", value: sum(later.map((r) => r.realizableAnnual)), items: later.slice(0, 4).map((r) => r.title) },
      ],
      footnote: `Phase 1 = payback ≤ 6 months and risk < 50; Phase 2 = payback ≤ 18 months; Phase 3 = the rest. ${m.tracker.projects.length} transformation project${m.tracker.projects.length === 1 ? "" : "s"} on record.`,
      empty: recs.length === 0 ? emptyFrom("opportunities") : undefined },
    { key: "next", kicker: "Next steps", lead: "What we recommend doing now.",
      metrics: [],
      bullets: [
        ...m.gaps.filter((g) => g.key !== "verified").map((g) => `${g.title}: ${g.body}`),
        ...(quick.length ? [`Approve Phase 1: ${quick.length} quick win${quick.length === 1 ? "" : "s"} worth ${fmtValue(sum(quick.map((r) => r.realizableAnnual)), "usdCompact")}/yr realizable.`] : recs.length ? [`Review the top recommendation: ${recs[0].title} (${fmtValue(recs[0].realizableAnnual, "usdCompact")}/yr).`] : []),
        ...(f.opportunityCount > 0 ? ["Deploy the first AI agents with human approval on sensitive steps, then measure from the run ledger."] : []),
        "Record verified results and finance-approved savings in the savings ledger — only evidenced, approved savings count as money kept.",
        "Plan redeployment of released capacity with management and HR/legal review. No role changes without that review.",
      ].slice(0, 6) },
  ];
  return s.map((x, i) => ({ ...x, n: i + 1, title: SLIDE_TITLES[i] }));
}

// ---------------------------------------------------------------------------------------------
// Excel workbook
// ---------------------------------------------------------------------------------------------

const XL_FMT: Record<Fmt, string> = { usd: '"$"#,##0;[Red]-"$"#,##0', usdCompact: '"$"#,##0;[Red]-"$"#,##0', hours: "#,##0.0", pct: "0.0%", months: "0.0", count: "#,##0", text: "@" };

export function workbookFromModel(m: ExecutiveModel): ExcelJSNS.Workbook {
  const ExcelJS = req("exceljs") as typeof ExcelJSNS;
  const wb = new ExcelJS.Workbook();
  const brand = (m.org.branding.primaryColor ?? "#071426").replace("#", "").toUpperCase();
  wb.creator = m.org.branding.reportName ?? "BridgeBox AI Workforce Intelligence"; wb.created = new Date(m.computedAt);
  const f = m.fin; const a = f.assumptions;
  const header = (ws: ExcelJSNS.Worksheet, row: number) => { const r = ws.getRow(row); r.font = { bold: true, color: { argb: "FFFFFFFF" } }; r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + brand } }; r.alignment = { vertical: "middle" }; r.height = 20; };
  const title = (ws: ExcelJSNS.Worksheet, t: string, sub: string) => { ws.getCell("A1").value = t; ws.getCell("A1").font = { bold: true, size: 15, color: { argb: "FF" + brand } }; ws.getCell("A2").value = sub; ws.getCell("A2").font = { italic: true, color: { argb: "FF64748B" } }; };
  const sub = `${m.org.name} · ${SCENARIOS[m.overrides.scenario].label} scenario · computed ${m.computedAt.slice(0, 16).replace("T", " ")} UTC`;
  const fmtCols = (ws: ExcelJSNS.Worksheet, fmts: (Fmt | null)[]) => fmts.forEach((fm, i) => { if (fm) ws.getColumn(i + 1).numFmt = XL_FMT[fm]; });

  // Summary
  const s = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 4 }] });
  title(s, `${m.org.branding.reportName ?? "Executive"} — Executive Summary`, sub);
  s.columns = [{ width: 44 }, { width: 18 }, { width: 10 }, { width: 12 }, { width: 70 }];
  s.getRow(4).values = ["Metric", "Value", "Unit", "Basis", "Formula / source"]; header(s, 4);
  const summaryRows: [string, number | null, Fmt, Basis, string][] = [
    ["Annual labor expense analyzed", f.totalAnnualLaborAnalyzed, "usd", m.headline.laborExpense.basis, m.headline.laborExpense.tree.formula ?? ""],
    ...(m.opex.show ? [["Entered annual operating expense (labor + dept overhead)", m.opex.total, "usd", "assumed", "labor + Σ departments.annual_overhead"] as [string, number, Fmt, Basis, string]] : []),
    ["Automation opportunity (gross annual savings)", f.grossAnnualSavings, "usd", "estimated", f.trees.grossSavings.formula ?? ""],
    ["Projected realizable savings", f.realizableAnnualSavings, "usd", "estimated", f.trees.realizableSavings.formula ?? ""],
    ["Overlap removed (not double counted)", f.overlapRemovedAnnual, "usd", "estimated", "Opportunities sharing a workflow capped at 90% of its hours"],
    ["Implementation cost (one-time)", f.implementationCost, "usd", "estimated", f.trees.implementationCost.formula ?? ""],
    ["Annual operating cost", f.annualOperatingCost, "usd", "assumed", f.trees.operatingCost.formula ?? ""],
    ["Projected net annual savings", f.netAnnualSavings, "usd", "estimated", f.trees.netSavings.formula ?? ""],
    ["First-year ROI", f.roi1y, "pct", "estimated", f.trees.roi.formula ?? ""],
    ["Payback (months)", f.paybackMonths, "months", "estimated", f.trees.payback.formula ?? ""],
    ["Recoverable hours per week", f.hoursRecoverablePerWeek, "hours", "estimated", f.trees.recoverableHours.formula ?? ""],
    ["Verified savings (annualized)", m.headline.verified.value, "usd", "observed", `${m.headline.verified.measurements} measurement(s); never mixed with projections`],
    ["Net savings kept (savings engine tier 7)", m.savings.tiers.net.amount, "usd", "observed", m.savings.tiers.net.tree.formula ?? ""],
    ["3-year cumulative net", f.threeYear.totalNet, "usd", "estimated", "costing.threeYearProjection"],
    ["5-year cumulative net", m.fiveYear.totalNet, "usd", "estimated", "years 4–5 at year-3 run rate"],
    ["5-year NPV", m.fiveYear.npv, "usd", "estimated", `discount rate ${a.discountRate}`],
  ];
  summaryRows.forEach(([label, v, fm, basis, formula], i) => { const r = s.getRow(5 + i); r.values = [label, v, fm === "usd" ? "USD" : fm, basis, formula]; r.getCell(2).numFmt = XL_FMT[fm]; });
  s.getRow(6 + summaryRows.length).values = ["Time saved is capacity, not a payroll cut. Projected figures are estimates; verified figures are measured after deployment."];
  s.getRow(6 + summaryRows.length).font = { italic: true, color: { argb: "FF64748B" } };

  // Savings tiers
  const t = wb.addWorksheet("Savings Tiers", { views: [{ state: "frozen", ySplit: 4 }] });
  title(t, "Savings Intelligence — seven tiers", sub);
  t.columns = [{ width: 26 }, { width: 18 }, { width: 14 }, { width: 12 }, { width: 90 }];
  t.getRow(4).values = ["Tier", "Annual amount", "Hours / yr", "Basis", "Definition"]; header(t, 4);
  m.savings.order.forEach((k, i) => { const tier = m.savings.tiers[k]; const r = t.getRow(5 + i); r.values = [tier.label, tier.amount, tier.hours ?? null, tier.basis, tier.description]; r.getCell(2).numFmt = XL_FMT.usd; r.getCell(3).numFmt = XL_FMT.hours; });
  let lr = 5 + m.savings.order.length + 2;
  t.getRow(lr).values = ["Lineage — source records behind each tier"]; t.getRow(lr).font = { bold: true }; lr++;
  t.getRow(lr).values = ["Tier", "Amount", "Hours", "Basis", "Source record", "Type", "Status", "Link"]; header(t, lr); lr++;
  t.getColumn(6).width = 14; t.getColumn(7).width = 14; t.getColumn(8).width = 40;
  for (const k of m.savings.order) for (const li of m.savings.tiers[k].lineage) { const r = t.getRow(lr++); r.values = [m.savings.tiers[k].label, li.amount, li.hours ?? null, li.basis, li.label, li.type, li.status ?? "", li.href]; r.getCell(2).numFmt = XL_FMT.usd; r.getCell(3).numFmt = XL_FMT.hours; }

  // Departments
  const d = wb.addWorksheet("Departments", { views: [{ state: "frozen", ySplit: 4 }] });
  title(d, "Department intelligence", sub);
  d.columns = [{ width: 24 }, { width: 11 }, { width: 16 }, { width: 11 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 13 }, { width: 10 }, { width: 15 }, { width: 12 }];
  d.getRow(4).values = ["Department", "Employees", "Labor / yr", "Hrs / wk", "Repetitive hrs", "Recoverable hrs", "Automation %", "Gross / yr", "Realizable / yr", "Verified / yr", "Opportunities", "Priority", "Overhead (entered)", "Overhead basis"]; header(d, 4);
  m.departments.forEach((x, i) => { d.getRow(5 + i).values = [x.name, x.employees, x.laborAnnual, x.hoursPerWeek, x.repetitiveHoursPerWeek, x.recoverableHoursPerWeek, x.automationPotentialPct, x.grossAnnual, x.realizableAnnual, x.verifiedAnnual, x.opportunities, x.priority, x.overhead, x.overhead != null ? x.overheadBasis : ""]; });
  const dl = 4 + m.departments.length; const dt = d.getRow(dl + 1);
  const colSum = (col: string, v: number) => ({ formula: `SUM(${col}5:${col}${Math.max(5, dl)})`, result: v });
  dt.values = ["Total", colSum("B", sum(m.departments.map((x) => x.employees))), colSum("C", sum(m.departments.map((x) => x.laborAnnual))), colSum("D", sum(m.departments.map((x) => x.hoursPerWeek))), colSum("E", sum(m.departments.map((x) => x.repetitiveHoursPerWeek))), colSum("F", sum(m.departments.map((x) => x.recoverableHoursPerWeek))), null, colSum("H", sum(m.departments.map((x) => x.grossAnnual))), colSum("I", sum(m.departments.map((x) => x.realizableAnnual))), colSum("J", sum(m.departments.map((x) => x.verifiedAnnual))), colSum("K", sum(m.departments.map((x) => x.opportunities))), null, colSum("M", sum(m.departments.map((x) => x.overhead ?? 0))), null];
  dt.font = { bold: true };
  fmtCols(d, [null, "count", "usd", "hours", "hours", "hours", "pct", "usd", "usd", "usd", "count", null, "usd", null]);

  // Opportunities
  const o = wb.addWorksheet("Opportunities", { views: [{ state: "frozen", ySplit: 4 }] });
  title(o, "AI opportunities (overlap de-duplicated)", sub);
  o.columns = [{ width: 6 }, { width: 44 }, { width: 16 }, { width: 12 }, { width: 18 }, { width: 26 }, { width: 12 }, { width: 11 }, { width: 13 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 11 }, { width: 10 }, { width: 14 }];
  o.getRow(4).values = ["Rank", "Opportunity", "Type", "Status", "Department", "Workflow", "Automation %", "Hrs / wk", "Recoverable hrs", "Gross / yr", "Realizable / yr", "Implementation", "Operating / yr", "Net / yr", "1-yr ROI", "Payback mo", "Confidence", "Sample", "Overlap removed"]; header(o, 4);
  m.recommendations.forEach((r, i) => { o.getRow(5 + i).values = [r.rank, r.title, TYPE_LABEL[r.type] ?? r.type, r.status, r.departmentName ?? "Unassigned", r.workflowName ?? "", r.automationPct, f.opportunities.find((x) => x.id === r.id)?.hoursPerWeek ?? null, r.hoursRecoverablePerWeek, r.grossAnnual, r.realizableAnnual, r.implementationCost, r.annualOperatingCost, r.netAnnual, r.roi1y, r.paybackMonths, r.confidence, r.sampleSize, r.overlapRemoved]; });
  const ol = 4 + m.recommendations.length; const ot = o.getRow(ol + 1);
  const oSum = (col: string, v: number) => ({ formula: `SUM(${col}5:${col}${Math.max(5, ol)})`, result: v });
  ot.values = [null, "Total", null, null, null, null, null, null, oSum("I", f.hoursRecoverablePerWeek), oSum("J", f.grossAnnualSavings), oSum("K", f.realizableAnnualSavings), oSum("L", sum(m.recommendations.map((r) => r.implementationCost))), oSum("M", sum(m.recommendations.map((r) => r.annualOperatingCost))), oSum("N", sum(m.recommendations.map((r) => r.netAnnual))), null, null, null, null, oSum("S", f.overlapRemovedAnnual)];
  ot.font = { bold: true };
  fmtCols(o, ["count", null, null, null, null, null, "pct", "hours", "hours", "usd", "usd", "usd", "usd", "usd", "pct", "months", null, "count", "usd"]);

  // Workflows
  const w = wb.addWorksheet("Workflows", { views: [{ state: "frozen", ySplit: 4 }] });
  title(w, "Workflows discovered", sub);
  w.columns = [{ width: 36 }, { width: 18 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 11 }, { width: 11 }, { width: 9 }, { width: 10 }, { width: 12 }, { width: 11 }, { width: 10 }];
  w.getRow(4).values = ["Workflow", "Department", "Hrs / wk", "Runs / wk", "Avg min", "People", "Repetition", "Automation", "Rework", "Hand-offs", "Regulatory", "Basis", "Sample"]; header(w, 4);
  m.workflows.forEach((x, i) => { w.getRow(5 + i).values = [x.name, x.departmentName ?? "", x.hoursPerWeek, x.runsPerWeek, x.avgDurationMin, x.employeeCount, x.repetitionScore, x.automationScore, x.reworkRate, x.handoffCount, x.regulatoryFlag ?? "", x.basis, x.sampleSize]; });
  fmtCols(w, [null, null, "hours", "hours", "hours", "count", "count", "count", "pct", "count", null, null, "count"]);

  // Assumptions
  const as = wb.addWorksheet("Assumptions");
  title(as, "Assumptions used for this export", sub);
  as.columns = [{ width: 34 }, { width: 16 }, { width: 90 }];
  as.getRow(4).values = ["Assumption", "Value", "Meaning"]; header(as, 4);
  const asRows: [string, number | string, Fmt, string][] = [
    ["Scenario", SCENARIOS[m.overrides.scenario].label, "text", "Preset for automation multiplier, adoption, realization and cost multiplier; explicit overrides win"],
    ["Automation multiplier", a.automationPct, "count", "Multiplier on each opportunity's modelled automation share"],
    ["Adoption rate", a.adoptionRate, "pct", "Share of eligible runs that go through the automation"],
    ["Realization rate", a.realizationRate, "pct", "Share of recovered time that becomes realizable value"],
    ["Benefits load", a.benefitsLoadPct, "pct", "Employer taxes + benefits on base pay"],
    ["Working weeks per year", a.workWeeksPerYear, "count", "After PTO and holidays"],
    ["Consulting rate ($/hr)", a.consultingHourly, "usd", "Implementation labor"],
    ["Platform fee ($/month)", a.platformFeeMonthly, "usd", "Base subscription"],
    ["Per-agent fee ($/month)", a.perAgentMonthly, "usd", "Per deployed agent"],
    ["Ramp (months)", a.rampMonths, "count", "Linear ramp of year-1 savings"],
    ["Discount rate", a.discountRate, "pct", "For NPV"],
    ["Savings amortization (years)", m.savings.amortizationYears, "count", "Implementation spent amortized in net savings tier"],
    ["Verified period start", m.overrides.periodStart?.slice(0, 10) ?? "all", "text", "Measurements overlapping this window"],
    ["Verified period end", m.overrides.periodEnd?.slice(0, 10) ?? "all", "text", ""],
  ];
  asRows.forEach(([k, v, fm, desc], i) => { const r = as.getRow(5 + i); r.values = [k, v, desc]; if (typeof v === "number") r.getCell(2).numFmt = fm === "count" ? "0.00" : XL_FMT[fm]; });
  m.fiveYear.assumptions.forEach((x, i) => { as.getRow(6 + asRows.length + i).values = [i === 0 ? "Projection notes" : "", "", x]; });

  // Reconciliation
  const rc = wb.addWorksheet("Reconciliation");
  title(rc, "Reconciliation", sub);
  rc.columns = [{ width: 52 }, { width: 10 }, { width: 100 }];
  rc.getRow(4).values = ["Check", "Status", "Detail"]; header(rc, 4);
  const rows = reconcile(m);
  rows.forEach((c, i) => { const r = rc.getRow(5 + i); r.values = [c.label, c.status.toUpperCase(), c.detail]; r.getCell(2).font = { bold: true, color: { argb: c.status === "pass" ? "FF047857" : c.status === "warn" ? "FFB45309" : "FFBE123C" } }; });
  return wb;
}

/** Savings-engine checks + export-level checks that tie the workbook to the engines. */
export function reconcile(m: ExecutiveModel): { key: string; label: string; status: "pass" | "warn" | "fail"; detail: string }[] {
  const f = m.fin; const usd = (v: number) => fmtValue(v, "usd");
  const deptSum = sum(m.departments.map((d) => d.realizableAnnual));
  const oppSum = sum(m.recommendations.map((r) => r.realizableAnnual));
  const y3 = m.fiveYear.years.slice(0, 3); const y3ok = y3.every((y, i) => Math.abs(y.net - f.threeYear.years[i].net) < 0.01);
  return [
    ...m.savings.checks,
    { key: "x_dept", label: "Departments sheet sums to projected realizable", status: Math.abs(deptSum - f.realizableAnnualSavings) <= 1 ? "pass" : "fail", detail: `${usd(deptSum)} vs ${usd(f.realizableAnnualSavings)}` },
    { key: "x_opp", label: "Opportunities sheet sums to projected realizable", status: Math.abs(oppSum - f.realizableAnnualSavings) <= 1 ? "pass" : "fail", detail: `${usd(oppSum)} vs ${usd(f.realizableAnnualSavings)}` },
    { key: "x_tier", label: "Potential tier equals finance-engine realizable", status: Math.abs(m.savings.tiers.potential.amount - f.realizableAnnualSavings) <= 1 ? "pass" : "fail", detail: `${usd(m.savings.tiers.potential.amount)} vs ${usd(f.realizableAnnualSavings)}` },
    { key: "x_proj", label: "5-year projection years 1–3 equal the 3-year projection", status: y3ok ? "pass" : "fail", detail: y3ok ? "Identical" : "Mismatch" },
  ];
}

export async function buildExecutiveWorkbook(orgId: string, overrides: ExecOverrides = {}): Promise<ExcelJSNS.Workbook> {
  return workbookFromModel(await computeExecutiveModel(orgId, overrides));
}

// ---------------------------------------------------------------------------------------------
// PowerPoint deck
// ---------------------------------------------------------------------------------------------

export async function deckFromModel(m: ExecutiveModel, brandingOverride?: Branding): Promise<{ buffer: Buffer; slides: number }> {
  const PptxGenJS = req("pptxgenjs") as typeof PptxGenJSNS;
  const pptx = new PptxGenJS();
  const branding = { ...m.org.branding, ...(brandingOverride ?? {}) };
  const reportName = branding.reportName ?? "BridgeBox AI Workforce Intelligence";
  const brand = (branding.primaryColor ?? "#2563EB").replace("#", "");
  pptx.layout = "LAYOUT_WIDE"; pptx.author = reportName; pptx.company = reportName; pptx.title = `${m.org.name} — Transformation briefing`;
  const MID = "071426", INK2 = "475569", INK3 = "64748B", BORDER = "E2E8F0";
  const hex = (a: Accent) => ACCENT_HEX[a].replace("#", "");
  const slides = buildDeckSlides(m);
  const scen = SCENARIOS[m.overrides.scenario].label;

  // Cover
  const cover = pptx.addSlide();
  cover.background = { color: MID };
  cover.addShape("rect", { x: 0, y: 0, w: 13.33, h: 0.12, fill: { color: brand } });
  cover.addText(reportName.toUpperCase(), { x: 0.7, y: 0.6, w: 12, h: 0.4, fontSize: 12, bold: true, color: "67E8F9", charSpacing: 3 });
  cover.addText("Enterprise Transformation Briefing", { x: 0.7, y: 2.2, w: 12, h: 0.9, fontSize: 40, bold: true, color: "FFFFFF" });
  cover.addText(m.org.name, { x: 0.7, y: 3.1, w: 12, h: 0.6, fontSize: 24, color: "CBD5E1" });
  cover.addText(`${scen} scenario · ${new Date(m.computedAt).toISOString().slice(0, 10)}${m.org.isDemo ? " · Synthetic demo data" : ""}`, { x: 0.7, y: 3.8, w: 12, h: 0.4, fontSize: 14, color: "94A3B8" });
  const coverStats: [string, string, string][] = [["Realizable / yr", fmtValue(m.fin.realizableAnnualSavings, "usdCompact"), hex("gold")], ["Recoverable hrs / wk", fmtValue(m.fin.hoursRecoverablePerWeek, "hours"), hex("cyan")], ["Verified / yr", m.headline.verified.measurements > 0 ? fmtValue(m.headline.verified.value, "usdCompact") : "Not yet measured", hex("emerald")]];
  coverStats.forEach(([l, v, c], i) => { cover.addText(v, { x: 0.7 + i * 4, y: 5.2, w: 3.8, h: 0.6, fontSize: 26, bold: true, color: c }); cover.addText(l, { x: 0.7 + i * 4, y: 5.8, w: 3.8, h: 0.35, fontSize: 12, color: "94A3B8" }); });

  for (const sl of slides) {
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    s.addShape("rect", { x: 0, y: 0, w: 0.14, h: 7.5, fill: { color: brand } });
    s.addText(sl.kicker.toUpperCase(), { x: 0.6, y: 0.35, w: 9, h: 0.3, fontSize: 11, bold: true, color: brand, charSpacing: 2 });
    s.addText(`${sl.n}. ${sl.title}`, { x: 0.6, y: 0.65, w: 12, h: 0.6, fontSize: 28, bold: true, color: MID });
    s.addText(sl.lead, { x: 0.6, y: 1.25, w: 12, h: 0.4, fontSize: 13, color: INK2 });
    s.addText(`${reportName} · ${m.org.name} · ${sl.n}/${slides.length}`, { x: 0.6, y: 7.05, w: 8, h: 0.3, fontSize: 9, color: INK3 });
    s.addText("Projected = estimated · Verified = measured · Time saved ≠ payroll cut", { x: 7.3, y: 7.05, w: 5.6, h: 0.3, fontSize: 9, color: INK3, align: "right" });
    if (sl.empty) {
      s.addShape("roundRect", { x: 0.6, y: 2.2, w: 12.1, h: 2.4, fill: { color: "F8FAFC" }, line: { color: BORDER }, rectRadius: 0.1 });
      s.addText(sl.empty.title, { x: 0.9, y: 2.5, w: 11.5, h: 0.6, fontSize: 22, bold: true, color: MID });
      s.addText(sl.empty.body, { x: 0.9, y: 3.1, w: 11.5, h: 0.5, fontSize: 14, color: INK2 });
      s.addText(`Next action: ${sl.empty.href}`, { x: 0.9, y: 3.7, w: 11.5, h: 0.4, fontSize: 12, color: brand });
      continue;
    }
    let y = 1.85;
    if (sl.metrics.length) {
      const k = sl.metrics.length; const gap = 0.2; const w = (12.1 - gap * (k - 1)) / k;
      sl.metrics.forEach((mt, i) => {
        const x = 0.6 + i * (w + gap);
        s.addShape("roundRect", { x, y, w, h: 1.25, fill: { color: "F8FAFC" }, line: { color: BORDER }, rectRadius: 0.08 });
        s.addShape("rect", { x, y, w, h: 0.06, fill: { color: hex(mt.accent) } });
        s.addText(mt.label, { x: x + 0.15, y: y + 0.12, w: w - 0.3, h: 0.3, fontSize: 10.5, color: INK2, bold: true });
        s.addText(mt.format === "text" && mt.value != null ? mt.value.toFixed(1) : fmtValue(mt.value, mt.format), { x: x + 0.15, y: y + 0.4, w: w - 0.3, h: 0.5, fontSize: 24, bold: true, color: mt.accent === "midnight" ? MID : hex(mt.accent) });
        s.addText(`${mt.basis ?? ""}${mt.note ? ` · ${mt.note}` : ""}`, { x: x + 0.15, y: y + 0.9, w: w - 0.3, h: 0.28, fontSize: 9, color: INK3 });
      });
      y += 1.5;
    }
    const bottom = 6.75; const h = bottom - y;
    const both = !!sl.chart && !!sl.table;
    if (sl.chart && sl.chart.bars.length) {
      const bars = [...sl.chart.bars].reverse(); // horizontal bars draw bottom-up; keep the largest on top
      s.addChart(pptx.ChartType.bar, [{ name: sl.chart.title, labels: bars.map((b) => b.label), values: bars.map((b) => Math.round(b.value * 100) / 100) }], {
        x: 0.6, y, w: both ? 6 : 12.1, h, barDir: "bar", chartColors: [hex(bars[0].accent)], showValue: true, dataLabelFontSize: 9, dataLabelColor: INK2,
        dataLabelFormatCode: sl.chart.format === "hours" ? "#,##0.0" : '"$"#,##0', valAxisLabelFormatCode: sl.chart.format === "hours" ? "#,##0" : '"$"#,##0', catAxisLabelFontSize: 10, valAxisLabelFontSize: 9,
        showTitle: true, title: sl.chart.title, titleFontSize: 12, titleColor: MID, valGridLine: { color: BORDER, size: 0.5 },
      });
    }
    if (sl.table) {
      const x = both ? 6.8 : 0.6; const w = both ? 5.9 : 12.1;
      const head = sl.table.columns.map((c) => ({ text: c.label, options: { bold: true, color: "FFFFFF", fill: { color: brand }, fontSize: 10, align: (c.format ? "right" : "left") as "right" | "left" } }));
      const body = sl.table.rows.map((r) => r.map((v, i) => { const c = sl.table!.columns[i]; return { text: typeof v === "number" ? fmtValue(v, c.format ?? "count") : v == null ? "—" : String(v), options: { fontSize: 10, color: MID, align: (c.format ? "right" : "left") as "right" | "left" } }; }));
      if (sl.table.title) s.addText(sl.table.title, { x, y, w, h: 0.3, fontSize: 11, bold: true, color: INK2 });
      s.addTable([head, ...body], { x, y: sl.table.title ? y + 0.35 : y, w, fontFace: "Calibri", border: { type: "solid", color: BORDER, pt: 0.5 }, rowH: 0.34, autoPage: false });
    }
    if (sl.phases) {
      const w = (12.1 - 0.4) / 3;
      sl.phases.forEach((p, i) => {
        const x = 0.6 + i * (w + 0.2); const acc = (["emerald", "cyan", "purple"] as Accent[])[i];
        s.addShape("roundRect", { x, y, w, h: 4.2, fill: { color: "F8FAFC" }, line: { color: BORDER }, rectRadius: 0.08 });
        s.addShape("rect", { x, y, w, h: 0.07, fill: { color: hex(acc) } });
        s.addText(p.name, { x: x + 0.2, y: y + 0.2, w: w - 0.4, h: 0.4, fontSize: 15, bold: true, color: MID });
        s.addText(p.window, { x: x + 0.2, y: y + 0.6, w: w - 0.4, h: 0.3, fontSize: 11, color: INK3 });
        s.addText(`${fmtValue(p.value, "usdCompact")}/yr realizable`, { x: x + 0.2, y: y + 0.95, w: w - 0.4, h: 0.45, fontSize: 18, bold: true, color: hex("gold") });
        s.addText(p.items.length ? p.items.map((t) => ({ text: t, options: { bullet: true } })) : [{ text: "No opportunities in this phase", options: { italic: true } }], { x: x + 0.2, y: y + 1.5, w: w - 0.4, h: 2.5, fontSize: 11, color: INK2, valign: "top" });
      });
    }
    if (sl.bullets && sl.bullets.length) {
      const yb = sl.phases ? y + 4.3 : y;
      s.addText(sl.bullets.map((t) => ({ text: t, options: { bullet: { code: "25A0" }, paraSpaceAfter: 8 } })), { x: 0.6, y: yb, w: 12.1, h: Math.max(0.6, bottom - yb), fontSize: 15, color: MID, valign: "top" });
    }
    if (sl.footnote) s.addText(sl.footnote, { x: 0.6, y: 6.72, w: 12.1, h: 0.3, fontSize: 8.5, italic: true, color: INK3 });
  }
  const out = await pptx.write({ outputType: "nodebuffer" });
  return { buffer: out as Buffer, slides: slides.length };
}

export async function buildExecutiveDeck(orgId: string, overrides: ExecOverrides = {}, branding?: Branding): Promise<Buffer> {
  return (await deckFromModel(await computeExecutiveModel(orgId, overrides), branding)).buffer;
}

// ---------------------------------------------------------------------------------------------
// Consultancy portfolio
// ---------------------------------------------------------------------------------------------

export type PortfolioRow = { orgId: string; name: string; industry: string | null; isDemo: boolean; employeesAnalyzed: number; realizable: number; net: number; verified: number; verifiedMeasurements: number; opportunities: number; deployedAgents: number; collectorsActive: number; collectorsTotal: number; collectorsStale: number; health: "healthy" | "attention" | "offline" | "none"; topLineage: LineageItem[] };
export type Portfolio = { rows: PortfolioRow[]; totals: { clients: number; realizable: number; net: number; verified: number; deployedAgents: number; opportunities: number; collectorsActive: number; collectorsTotal: number }; capped: boolean; totalClients: number };

/** Cross-org consultancy view: explicitly restricted to client orgs whose parent is `consultancyOrgId`. Capped at 25 clients. */
export async function computePortfolio(consultancyOrgId: string, cap = 25): Promise<Portfolio> {
  const children = await db.select({ id: schema.organizations.id, name: schema.organizations.name, industry: schema.organizations.industry, isDemo: schema.organizations.isDemo }).from(schema.organizations).where(eq(schema.organizations.parentOrgId, consultancyOrgId));
  const list = children.sort((x, y) => x.name.localeCompare(y.name)).slice(0, cap);
  const dayAgo = Date.now() - 24 * 3600_000;
  const rows = await Promise.all(list.map(async (c): Promise<PortfolioRow> => {
    const [fin, cols] = await Promise.all([
      computeOrgFinancials(c.id),
      withTenant(c.id, (tx) => tx.select({ status: schema.collectors.status, lastSeenAt: schema.collectors.lastSeenAt }).from(schema.collectors).where(eq(schema.collectors.orgId, c.id))),
    ]);
    const active = cols.filter((x) => x.status === "active"); const stale = active.filter((x) => !x.lastSeenAt || x.lastSeenAt.getTime() < dayAgo).length;
    const health: PortfolioRow["health"] = cols.length === 0 ? "none" : active.length === 0 ? "offline" : stale > 0 ? "attention" : "healthy";
    return { orgId: c.id, name: c.name, industry: c.industry, isDemo: c.isDemo, employeesAnalyzed: fin.employeesAnalyzed, realizable: fin.realizableAnnualSavings, net: fin.netAnnualSavings, verified: fin.verifiedAnnualizedSavings, verifiedMeasurements: fin.verifiedMeasurements, opportunities: fin.opportunityCount, deployedAgents: fin.deployedAgents, collectorsActive: active.length, collectorsTotal: cols.length, collectorsStale: stale, health,
      topLineage: fin.opportunities.slice(0, 3).map((o) => ({ type: "opportunity", id: o.id, label: o.title, href: `/app/opportunities/${o.id}`, amount: o.realizableAnnualSavings, basis: "estimated" })) };
  }));
  rows.sort((x, y) => y.realizable - x.realizable);
  return { rows, capped: children.length > cap, totalClients: children.length, totals: { clients: rows.length, realizable: sum(rows.map((r) => r.realizable)), net: sum(rows.map((r) => r.net)), verified: sum(rows.map((r) => r.verified)), deployedAgents: sum(rows.map((r) => r.deployedAgents)), opportunities: sum(rows.map((r) => r.opportunities)), collectorsActive: sum(rows.map((r) => r.collectorsActive)), collectorsTotal: sum(rows.map((r) => r.collectorsTotal)) } };
}

export type { TierKey };
