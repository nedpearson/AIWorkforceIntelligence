/**
 * Finance engine — the single source for every dashboard number and for executive PDF reports.
 *
 *  - ensureDefaultFinancialModel(orgId)        → default `financial_models` row from DEFAULTS + org settings
 *  - computeOrgFinancials(orgId, overrides?)   → OrgFinancials (projected vs verified, scenarios, CalcTrees)
 *  - recordSavingsFromRunLedger(...)           → observed `savings_measurements` row from agent_runs
 *  - generateExecutiveReport(orgId, kind, opts)→ pdfkit PDF stored in `reports`
 *
 * All formulas come from src/engine/costing.ts. Nothing here re-derives savings math; it only
 * loads tenant data, calls the pure functions, and rolls the results up. Formulas are documented in
 * docs/FINANCIAL_METHOD.md.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { withTenant, type TenantDb } from "@/db/tenant";
import { schema } from "@/db/client";
import type { CalcTree, FinancialAssumptions } from "@/db/schema";
import { num, clamp } from "@/lib/utils";
import {
  DEFAULTS, SCENARIOS, IMPLEMENTATION_PROFILES, loadedHourlyCost, opportunityEconomics, threeYearProjection,
  type ScenarioKey, type OpportunityInput,
} from "./costing";
import type {
  Basis, DepartmentFinancials, EmployeeFinancials, FinancialOverrides, HeadlineNumbers, OpportunityLine,
  OrgFinancials, ReportKind, ReportOptions, ScenarioResult, ThreeYear,
} from "./finance.types";

export type * from "./finance.types";

const DAYS_PER_YEAR = 365.25;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Default financial model
// ---------------------------------------------------------------------------------------------

/** Assumptions derived from DEFAULTS / SCENARIOS.expected, overlaid with org settings. */
export function defaultAssumptions(settings: schema.OrgSettings | null | undefined): FinancialAssumptions {
  const s = settings ?? {};
  return {
    automationPct: SCENARIOS.expected.automationMult, // multiplier on each opportunity's modelled automation share
    adoptionRate: s.adoptionRate ?? SCENARIOS.expected.adoptionRate,
    realizationRate: s.realizationRate ?? SCENARIOS.expected.realizationRate,
    benefitsLoadPct: s.benefitsLoadPct ?? DEFAULTS.benefitsLoadPct,
    discountRate: DEFAULTS.discountRate,
    rampMonths: DEFAULTS.rampMonths,
    platformFeeMonthly: DEFAULTS.platformFeeMonthly,
    perAgentMonthly: DEFAULTS.perAgentMonthly,
    consultingHourly: DEFAULTS.consultingHourly,
    workWeeksPerYear: s.workWeeksPerYear ?? DEFAULTS.workWeeksPerYear,
  };
}

export async function ensureDefaultFinancialModel(orgId: string): Promise<typeof schema.financialModels.$inferSelect> {
  return withTenant(orgId, async (tx) => {
    const [existing] = await tx.select().from(schema.financialModels)
      .where(and(eq(schema.financialModels.orgId, orgId), eq(schema.financialModels.isDefault, true))).limit(1);
    if (existing) return existing;
    const [org] = await tx.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
    const [row] = await tx.insert(schema.financialModels)
      .values({ orgId, name: "Default", isDefault: true, assumptions: defaultAssumptions(org?.settings) })
      .returning();
    return row;
  });
}

// ---------------------------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------------------------

type Loaded = {
  org: typeof schema.organizations.$inferSelect;
  model: FinancialAssumptions;
  departments: (typeof schema.departments.$inferSelect)[];
  employees: (typeof schema.employees.$inferSelect)[];
  workflows: (typeof schema.workflows.$inferSelect)[];
  workflowEmployees: (typeof schema.workflowEmployees.$inferSelect)[];
  opportunities: (typeof schema.opportunities.$inferSelect)[];
  agents: (typeof schema.agents.$inferSelect)[];
  measurements: (typeof schema.savingsMeasurements.$inferSelect)[];
  employeesWithEvents: Set<string>;
};

async function loadOrg(tx: TenantDb, orgId: string): Promise<Loaded> {
  const [org] = await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
  if (!org) throw new Error(`computeOrgFinancials: organization ${orgId} not found`);
  const [modelRow] = await tx.select().from(schema.financialModels)
    .where(and(eq(schema.financialModels.orgId, orgId), eq(schema.financialModels.isDefault, true))).limit(1);
  const model: FinancialAssumptions = { ...defaultAssumptions(org.settings), ...(modelRow?.assumptions ?? {}) };
  const [departments, employees, workflows, workflowEmployees, opportunities, agents, measurements, eventEmps] = await Promise.all([
    tx.select().from(schema.departments).where(eq(schema.departments.orgId, orgId)),
    tx.select().from(schema.employees).where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.isActive, true))),
    tx.select().from(schema.workflows).where(eq(schema.workflows.orgId, orgId)),
    tx.select().from(schema.workflowEmployees).where(eq(schema.workflowEmployees.orgId, orgId)),
    tx.select().from(schema.opportunities).where(eq(schema.opportunities.orgId, orgId)),
    tx.select().from(schema.agents).where(eq(schema.agents.orgId, orgId)),
    tx.select().from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId)),
    tx.selectDistinct({ employeeId: schema.activityEvents.employeeId }).from(schema.activityEvents).where(eq(schema.activityEvents.orgId, orgId)),
  ]);
  return { org, model, departments, employees, workflows, workflowEmployees, opportunities, agents, measurements, employeesWithEvents: new Set(eventEmps.map((e) => e.employeeId)) };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function findNode(tree: CalcTree | null | undefined, label: string): CalcTree | undefined {
  if (!tree) return undefined;
  if (tree.label === label) return tree;
  for (const c of tree.children ?? []) { const f = findNode(c, label); if (f) return f; }
  return undefined;
}

/** Loaded hourly for an employee under a given benefits load; falls back to the stored loadedHourlyCost. */
function employeeLoadedHourly(e: typeof schema.employees.$inferSelect, benefitsLoadPct: number, weeks: number): { value: number; basis: Basis } {
  const base = num(e.baseAnnualCost);
  const hpw = num(e.hoursPerWeek) || DEFAULTS.workHoursPerWeek;
  if (base > 0) return { value: loadedHourlyCost(base, benefitsLoadPct, hpw, weeks).value, basis: e.costBasis };
  const stored = num(e.loadedHourlyCost);
  if (stored > 0) return { value: stored, basis: e.costBasis };
  return { value: 0, basis: "assumed" };
}

/** Recover the complexity (0..1) the analysis engine used, from the stored tree or by back-solving the stored implementation cost. */
function opportunityComplexity(o: typeof schema.opportunities.$inferSelect): number {
  const node = findNode(o.calculation, "Complexity multiplier");
  if (node && Number.isFinite(node.value)) return clamp(node.value - 1, 0, 1);
  const prof = IMPLEMENTATION_PROFILES[o.type];
  const impl = num(o.implementationCost);
  if (prof && impl > 0) {
    const consultingHoursCost = impl - prof.toolingOneTime;
    const hourlyNode = findNode(o.calculation, "Implementation cost (one-time)");
    const hourly = hourlyNode?.formula?.match(/×\s*\$(\d+(?:\.\d+)?)/)?.[1];
    const rate = hourly ? Number(hourly) : DEFAULTS.consultingHourly;
    const mult = consultingHoursCost / (prof.consultingHours * rate);
    if (Number.isFinite(mult)) return clamp(mult - 1, 0, 1);
  }
  return 0;
}

function annualizeFactor(periodStart: Date, periodEnd: Date): number {
  const days = Math.max(1, (periodEnd.getTime() - periodStart.getTime()) / MS_PER_DAY);
  return DAYS_PER_YEAR / days;
}

function countBasis(tree: CalcTree, acc: { observed: number; estimated: number; assumed: number }) {
  acc[tree.basis] += 1;
  for (const c of tree.children ?? []) countBasis(c, acc);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

type ScenarioParams = { automationMult: number; adoptionRate: number; realizationRate: number; costMult: number };

/** Resolve the effective assumptions for a given scenario: explicit user overrides win over scenario presets, which win over the stored model. */
function resolveAssumptions(model: FinancialAssumptions, overrides: FinancialOverrides, scenarioKey: ScenarioKey | null): { a: FinancialAssumptions; p: ScenarioParams } {
  const { scenario: _s, opportunityIds: _o, ...explicit } = overrides;
  void _s; void _o;
  const sc = scenarioKey ? SCENARIOS[scenarioKey] : null;
  const a: FinancialAssumptions = {
    ...model,
    ...(sc ? { automationPct: sc.automationMult, adoptionRate: sc.adoptionRate, realizationRate: sc.realizationRate } : {}),
    ...Object.fromEntries(Object.entries(explicit).filter(([, v]) => v !== undefined)),
  };
  return { a, p: { automationMult: a.automationPct, adoptionRate: a.adoptionRate, realizationRate: a.realizationRate, costMult: sc?.costMult ?? 1 } };
}

// ---------------------------------------------------------------------------------------------
// Roll-up core (pure given loaded data)
// ---------------------------------------------------------------------------------------------

type Rollup = HeadlineNumbers & {
  lines: OpportunityLine[];
  threeYear: ThreeYear;
  trees: Pick<OrgFinancials["trees"], "recoverableHours" | "grossSavings" | "realizableSavings" | "implementationCost" | "operatingCost" | "netSavings" | "roi" | "payback">;
};

function rollupOpportunities(d: Loaded, a: FinancialAssumptions, p: ScenarioParams, inScope: (typeof schema.opportunities.$inferSelect)[], deployedAgents: number): Rollup {
  const wfById = new Map(d.workflows.map((w) => [w.id, w]));
  const empById = new Map(d.employees.map((e) => [e.id, e]));
  const deptById = new Map(d.departments.map((x) => [x.id, x]));
  const linksByWf = new Map<string, (typeof schema.workflowEmployees.$inferSelect)[]>();
  for (const l of d.workflowEmployees) { const arr = linksByWf.get(l.workflowId) ?? []; arr.push(l); linksByWf.set(l.workflowId, arr); }
  const deployedOppIds = new Set(d.agents.filter((g) => g.status === "deployed" && g.opportunityId).map((g) => g.opportunityId as string));

  // org-wide fallback hourly (hours-weighted across all employees with cost data)
  const costed = d.employees.map((e) => ({ h: employeeLoadedHourly(e, a.benefitsLoadPct, a.workWeeksPerYear).value, w: num(e.hoursPerWeek) || 40 })).filter((x) => x.h > 0);
  const orgAvgHourly = costed.length ? sum(costed.map((x) => x.h * x.w)) / sum(costed.map((x) => x.w)) : 0;

  const lines: OpportunityLine[] = inScope.map((o) => {
    const wf = o.workflowId ? wfById.get(o.workflowId) : undefined;
    const links = (o.workflowId ? linksByWf.get(o.workflowId) : undefined) ?? [];
    const hoursPerWeek = wf ? num(wf.hoursPerWeek) : num(findNode(o.calculation, "Observed workflow hours per week")?.value);
    // hours-weighted average loaded hourly across the performers, under the (possibly overridden) benefits load
    let avgHourly = 0; let wSum = 0;
    for (const l of links) {
      const e = empById.get(l.employeeId); if (!e) continue;
      const h = employeeLoadedHourly(e, a.benefitsLoadPct, a.workWeeksPerYear).value; if (h <= 0) continue;
      const w = num(l.hoursPerWeek) || 1; avgHourly += h * w; wSum += w;
    }
    avgHourly = wSum > 0 ? avgHourly / wSum : (num(findNode(o.calculation, "Average loaded hourly cost")?.value) || orgAvgHourly);
    const employeeCount = links.length || wf?.employeeCount || 1;
    const basisHours: Basis = wf?.basis ?? (findNode(o.calculation, "Observed workflow hours per week")?.basis ?? "estimated");
    const input: OpportunityInput = {
      type: o.type, hoursPerWeek, automationPct: clamp(num(o.automationPct) * p.automationMult, 0, 1), avgLoadedHourly: avgHourly,
      employeeCount, complexity: opportunityComplexity(o), adoptionRate: p.adoptionRate, realizationRate: p.realizationRate,
      weeksPerYear: a.workWeeksPerYear, consultingHourly: a.consultingHourly, basisHours, perAgentMonthly: a.perAgentMonthly, costMult: p.costMult,
    };
    const ec = opportunityEconomics(input);
    const deptId = o.departmentId ?? wf?.departmentId ?? null;
    return {
      id: o.id, title: o.title, type: o.type, status: o.status, rank: o.rank, workflowId: o.workflowId ?? null, workflowName: wf?.name ?? null,
      departmentId: deptId, departmentName: deptId ? (deptById.get(deptId)?.name ?? null) : null,
      feasibility: num(o.feasibility), risk: num(o.risk), automationPct: input.automationPct, hoursPerWeek,
      hoursRecoverablePerWeek: ec.hoursRecoverablePerWeek, grossAnnualSavings: ec.grossAnnualSavings, realizableAnnualSavings: ec.realizableAnnualSavings,
      implementationCost: ec.implementationCost, annualOperatingCost: ec.annualOperatingCost, netAnnualSavings: ec.netAnnualSavings,
      paybackMonths: ec.paybackMonths, roi1y: ec.roi1y, basis: o.basis, deployed: deployedOppIds.has(o.id) || o.status === "deployed" || o.status === "verified", tree: ec.tree,
    };
  }).sort((x, y) => y.realizableAnnualSavings - x.realizableAnnualSavings);

  const hoursRecoverablePerWeek = sum(lines.map((l) => l.hoursRecoverablePerWeek));
  const grossAnnualSavings = sum(lines.map((l) => l.grossAnnualSavings));
  const realizableAnnualSavings = sum(lines.map((l) => l.realizableAnnualSavings));
  const implementationCost = a.implementationCostOverride ?? sum(lines.map((l) => l.implementationCost));
  const annualOperatingCost = a.annualOpexOverride ?? sum(lines.map((l) => l.annualOperatingCost));
  const platformBaseAnnual = a.platformFeeMonthly * 12;
  const platformAnnual = platformBaseAnnual + a.perAgentMonthly * 12 * deployedAgents;
  const netAnnualSavings = realizableAnnualSavings - annualOperatingCost - platformBaseAnnual;
  const roi1y = implementationCost > 0 ? (netAnnualSavings - implementationCost) / implementationCost : 0;
  const paybackMonths = netAnnualSavings > 0 && implementationCost > 0 ? implementationCost / (netAnnualSavings / 12) : null;
  const threeYear = threeYearProjection({ realizableAnnual: realizableAnnualSavings, operatingAnnual: annualOperatingCost, implementationCost, rampMonths: a.rampMonths, discountRate: a.discountRate, platformAnnual: platformBaseAnnual });

  const oppChildren = (pick: (l: OpportunityLine) => number, unit: string): CalcTree[] =>
    lines.slice(0, 25).map((l) => ({ label: l.title, value: pick(l), unit, basis: "estimated", source: `Opportunity ${l.id}`, children: [l.tree] }));

  const trees: Rollup["trees"] = {
    recoverableHours: { label: "Hours recoverable per week", value: hoursRecoverablePerWeek, unit: "hours", basis: "estimated", formula: "Σ opportunity (workflow hrs/wk × automation % × adoption rate)", source: `${lines.length} opportunities in scope`, children: oppChildren((l) => l.hoursRecoverablePerWeek, "hours") },
    grossSavings: { label: "Gross annual savings", value: grossAnnualSavings, unit: "usd", basis: "estimated", formula: "Σ opportunity (recoverable hrs/wk × weeks/yr × avg loaded hourly)", children: oppChildren((l) => l.grossAnnualSavings, "usd") },
    realizableSavings: { label: "Realizable annual savings", value: realizableAnnualSavings, unit: "usd", basis: "estimated", formula: `gross × realization rate (${a.realizationRate})`, source: "Time saved ≠ payroll cut; only the realizable share is counted", children: [
      { label: "Gross annual savings", value: grossAnnualSavings, unit: "usd", basis: "estimated" },
      { label: "Realization rate", value: a.realizationRate, unit: "pct", basis: "assumed", source: "Financial model assumption" },
    ] },
    implementationCost: { label: "Implementation cost (one-time)", value: implementationCost, unit: "usd", basis: "estimated", formula: a.implementationCostOverride != null ? "manual override" : `Σ opportunity (consulting hrs × $${a.consultingHourly} + tooling)${p.costMult !== 1 ? ` × ${p.costMult}` : ""}`, children: a.implementationCostOverride != null ? [] : oppChildren((l) => l.implementationCost, "usd") },
    operatingCost: { label: "Annual operating cost", value: annualOperatingCost, unit: "usd", basis: "assumed", formula: a.annualOpexOverride != null ? "manual override" : "Σ opportunity monthly run cost × 12", children: a.annualOpexOverride != null ? [] : oppChildren((l) => l.annualOperatingCost, "usd") },
    netSavings: { label: "Net annual savings", value: netAnnualSavings, unit: "usd", basis: "estimated", formula: "realizable − operating − platform base fee", children: [
      { label: "Realizable annual savings", value: realizableAnnualSavings, unit: "usd", basis: "estimated" },
      { label: "Annual operating cost", value: annualOperatingCost, unit: "usd", basis: "assumed" },
      { label: "Platform base fee (annual)", value: platformBaseAnnual, unit: "usd", basis: "assumed", formula: `$${a.platformFeeMonthly}/mo × 12` },
      { label: "Platform per-agent fees (annual, deployed agents)", value: platformAnnual - platformBaseAnnual, unit: "usd", basis: "assumed", formula: `$${a.perAgentMonthly}/mo × 12 × ${deployedAgents} deployed agents`, source: "Already included in operating cost for AI-agent opportunities; shown for the subscription bill" },
    ] },
    roi: { label: "First-year ROI", value: roi1y, unit: "pct", basis: "estimated", formula: "(net annual − implementation) ÷ implementation", children: [
      { label: "Net annual savings", value: netAnnualSavings, unit: "usd", basis: "estimated" },
      { label: "Implementation cost (one-time)", value: implementationCost, unit: "usd", basis: "estimated" },
    ] },
    payback: { label: "Payback period", value: paybackMonths ?? 0, unit: "months", basis: "estimated", formula: paybackMonths == null ? "not reached (net annual ≤ 0)" : "implementation ÷ (net annual ÷ 12)", children: [
      { label: "Implementation cost (one-time)", value: implementationCost, unit: "usd", basis: "estimated" },
      { label: "Net annual savings", value: netAnnualSavings, unit: "usd", basis: "estimated" },
    ] },
  };
  return { hoursRecoverablePerWeek, grossAnnualSavings, realizableAnnualSavings, implementationCost, annualOperatingCost, platformAnnual, netAnnualSavings, roi1y, paybackMonths, lines, threeYear, trees };
}

// ---------------------------------------------------------------------------------------------
// computeOrgFinancials
// ---------------------------------------------------------------------------------------------

export async function computeOrgFinancials(orgId: string, overrides: FinancialOverrides & { periodStart?: Date; periodEnd?: Date } = {}): Promise<OrgFinancials> {
  const d = await withTenant(orgId, (tx) => loadOrg(tx, orgId));
  const scenarioKey: ScenarioKey = overrides.scenario ?? "expected";
  const { a, p } = resolveAssumptions(d.model, overrides, overrides.scenario ?? null);

  // --- scope ---
  const scopeIds = overrides.opportunityIds ? new Set(overrides.opportunityIds) : null;
  const inScope = d.opportunities.filter((o) => (scopeIds ? scopeIds.has(o.id) : o.status !== "rejected"));
  const deployedAgents = d.agents.filter((g) => g.status === "deployed").length;

  // --- labor ---
  const empHours = new Map<string, number>(); const empRepHours = new Map<string, number>();
  const wfById = new Map(d.workflows.map((w) => [w.id, w]));
  const linksByEmp = new Map<string, (typeof schema.workflowEmployees.$inferSelect)[]>();
  for (const l of d.workflowEmployees) {
    const arr = linksByEmp.get(l.employeeId) ?? []; arr.push(l); linksByEmp.set(l.employeeId, arr);
    const h = num(l.hoursPerWeek); empHours.set(l.employeeId, (empHours.get(l.employeeId) ?? 0) + h);
    const wf = wfById.get(l.workflowId); if (wf && num(wf.repetitionScore) >= 50) empRepHours.set(l.employeeId, (empRepHours.get(l.employeeId) ?? 0) + h);
  }
  const analyzed = d.employees.filter((e) => d.employeesWithEvents.has(e.id) || linksByEmp.has(e.id));
  const laborChildren: CalcTree[] = [];
  let totalAnnualLaborAnalyzed = 0;
  const empLabor = new Map<string, { annual: number; hourly: number; basis: Basis }>();
  for (const e of analyzed) {
    const base = num(e.baseAnnualCost);
    const hpw = num(e.hoursPerWeek) || DEFAULTS.workHoursPerWeek;
    let annual: number; let basis: Basis;
    if (base > 0) { annual = base * (1 + a.benefitsLoadPct); basis = e.costBasis === "observed" ? "observed" : "assumed"; }
    else { annual = num(e.loadedHourlyCost) * hpw * a.workWeeksPerYear; basis = "assumed"; }
    const hourly = employeeLoadedHourly(e, a.benefitsLoadPct, a.workWeeksPerYear).value;
    empLabor.set(e.id, { annual, hourly, basis });
    totalAnnualLaborAnalyzed += annual;
    if (laborChildren.length < 50) laborChildren.push({ label: e.displayName, value: annual, unit: "usd", basis, formula: base > 0 ? `${base} × (1 + ${a.benefitsLoadPct})` : `loaded hourly × ${hpw} × ${a.workWeeksPerYear}`, source: "Employee record" });
  }

  const hoursObservedPerWeek = sum(d.workflows.map((w) => num(w.hoursPerWeek)));
  const repetitiveWfs = d.workflows.filter((w) => num(w.repetitionScore) >= 50);
  const repetitiveHoursPerWeek = sum(repetitiveWfs.map((w) => num(w.hoursPerWeek)));
  const repetitiveSharePct = hoursObservedPerWeek > 0 ? repetitiveHoursPerWeek / hoursObservedPerWeek : 0;

  // --- projected (opportunities) ---
  const main = rollupOpportunities(d, a, p, inScope, deployedAgents);

  // --- verified (measurements; always separate) ---
  const inPeriod = d.measurements.filter((m) => {
    if (overrides.periodStart && m.periodEnd < overrides.periodStart) return false;
    if (overrides.periodEnd && m.periodStart > overrides.periodEnd) return false;
    return true;
  });
  let verifiedAnnualizedSavings = 0, verifiedHoursSaved = 0, verifiedHoursSavedAnnualized = 0, verifiedDollarsSaved = 0;
  const verifiedByAgent = new Map<string, number>();
  const verifiedChildren: CalcTree[] = [];
  for (const m of inPeriod) {
    const f = annualizeFactor(m.periodStart, m.periodEnd);
    const dollars = num(m.dollarsSaved); const hours = num(m.hoursSaved);
    verifiedDollarsSaved += dollars; verifiedHoursSaved += hours; verifiedAnnualizedSavings += dollars * f; verifiedHoursSavedAnnualized += hours * f;
    if (m.agentId) verifiedByAgent.set(m.agentId, (verifiedByAgent.get(m.agentId) ?? 0) + dollars * f);
    if (verifiedChildren.length < 50) verifiedChildren.push({ label: `${m.method} ${m.periodStart.toISOString().slice(0, 10)} → ${m.periodEnd.toISOString().slice(0, 10)}`, value: dollars * f, unit: "usd", basis: m.basis, formula: `$${dollars.toFixed(2)} × (${DAYS_PER_YEAR} ÷ ${((m.periodEnd.getTime() - m.periodStart.getTime()) / MS_PER_DAY).toFixed(1)} days)`, source: `savings_measurements ${m.id}`, children: [m.calculation] });
  }

  // --- completion ---
  const automationCompletionPct = main.realizableAnnualSavings > 0 ? clamp(verifiedAnnualizedSavings / main.realizableAnnualSavings, 0, 1) : 0;
  const deploymentCompletionPct = inScope.length > 0 ? clamp(deployedAgents / inScope.length, 0, 1) : 0;

  // --- by department ---
  const deptById = new Map(d.departments.map((x) => [x.id, x]));
  const agentOpp = new Map(d.agents.map((g) => [g.id, g.opportunityId]));
  const deptMap = new Map<string | null, DepartmentFinancials>();
  const deptOf = (id: string | null) => {
    const key = id ?? null;
    let row = deptMap.get(key);
    if (!row) { row = { departmentId: key, name: key ? (deptById.get(key)?.name ?? "Unknown") : "Unassigned", employees: 0, laborAnnual: 0, hoursPerWeek: 0, repetitiveHoursPerWeek: 0, recoverableHoursPerWeek: 0, grossAnnual: 0, realizableAnnual: 0, verifiedAnnual: 0, efficiencyGainPct: 0, opportunities: 0 }; deptMap.set(key, row); }
    return row;
  };
  for (const e of analyzed) {
    const r = deptOf(e.departmentId ?? null); r.employees += 1; r.laborAnnual += empLabor.get(e.id)?.annual ?? 0;
    r.hoursPerWeek += empHours.get(e.id) ?? 0; r.repetitiveHoursPerWeek += empRepHours.get(e.id) ?? 0;
  }
  const lineById = new Map(main.lines.map((l) => [l.id, l]));
  for (const l of main.lines) {
    const r = deptOf(l.departmentId); r.opportunities += 1; r.recoverableHoursPerWeek += l.hoursRecoverablePerWeek; r.grossAnnual += l.grossAnnualSavings; r.realizableAnnual += l.realizableAnnualSavings;
  }
  for (const [agentId, v] of verifiedByAgent) {
    const oppId = agentOpp.get(agentId); const line = oppId ? lineById.get(oppId) : undefined;
    const depId = line?.departmentId ?? (oppId ? (d.opportunities.find((o) => o.id === oppId)?.departmentId ?? null) : null);
    deptOf(depId).verifiedAnnual += v;
  }
  const byDepartment = [...deptMap.values()].map((r) => ({ ...r, efficiencyGainPct: r.hoursPerWeek > 0 ? r.recoverableHoursPerWeek / r.hoursPerWeek : 0 })).sort((x, y) => y.realizableAnnual - x.realizableAnnual);

  // --- by employee (opportunity hours attributed by share of workflow hours) ---
  const wfHoursTotal = new Map<string, number>();
  for (const l of d.workflowEmployees) wfHoursTotal.set(l.workflowId, (wfHoursTotal.get(l.workflowId) ?? 0) + num(l.hoursPerWeek));
  const linesByWf = new Map<string, OpportunityLine[]>();
  for (const l of main.lines) if (l.workflowId) { const arr = linesByWf.get(l.workflowId) ?? []; arr.push(l); linesByWf.set(l.workflowId, arr); }
  const byEmployee: EmployeeFinancials[] = analyzed.map((e) => {
    const links = linksByEmp.get(e.id) ?? [];
    let recoverable = 0, realizable = 0;
    for (const l of links) {
      const tot = wfHoursTotal.get(l.workflowId) ?? 0; const share = tot > 0 ? num(l.hoursPerWeek) / tot : 0;
      for (const line of linesByWf.get(l.workflowId) ?? []) { recoverable += line.hoursRecoverablePerWeek * share; realizable += line.realizableAnnualSavings * share; }
    }
    const hours = empHours.get(e.id) ?? 0; const lab = empLabor.get(e.id)!;
    return {
      employeeId: e.id, name: e.displayName, title: e.title ?? null, departmentId: e.departmentId ?? null, departmentName: e.departmentId ? (deptById.get(e.departmentId)?.name ?? null) : null,
      laborAnnual: lab.annual, loadedHourly: lab.hourly, costBasis: lab.basis, hoursPerWeek: hours, repetitiveHoursPerWeek: empRepHours.get(e.id) ?? 0,
      recoverableHoursPerWeek: recoverable, realizableAnnual: realizable, efficiencyGainPct: hours > 0 ? recoverable / hours : 0,
      topWorkflows: links.map((l) => ({ workflowId: l.workflowId, name: wfById.get(l.workflowId)?.name ?? "", hoursPerWeek: num(l.hoursPerWeek), repetitionScore: num(wfById.get(l.workflowId)?.repetitionScore) })).sort((x, y) => y.hoursPerWeek - x.hoursPerWeek).slice(0, 5),
    };
  }).sort((x, y) => y.realizableAnnual - x.realizableAnnual);

  // --- scenarios (same explicit overrides, different presets) ---
  const scenarios = Object.fromEntries((Object.keys(SCENARIOS) as ScenarioKey[]).map((k) => {
    const r = resolveAssumptions(d.model, overrides, k);
    const roll = rollupOpportunities(d, r.a, r.p, inScope, deployedAgents);
    const res: ScenarioResult = { key: k, label: SCENARIOS[k].label, hoursRecoverablePerWeek: roll.hoursRecoverablePerWeek, grossAnnualSavings: roll.grossAnnualSavings, realizableAnnualSavings: roll.realizableAnnualSavings, implementationCost: roll.implementationCost, annualOperatingCost: roll.annualOperatingCost, platformAnnual: roll.platformAnnual, netAnnualSavings: roll.netAnnualSavings, roi1y: roll.roi1y, paybackMonths: roll.paybackMonths, threeYear: roll.threeYear };
    return [k, res];
  })) as Record<ScenarioKey, ScenarioResult>;

  // --- trees ---
  const trees: OrgFinancials["trees"] = {
    totalLabor: { label: "Annual labor cost analyzed", value: totalAnnualLaborAnalyzed, unit: "usd", basis: analyzed.every((e) => empLabor.get(e.id)?.basis === "observed") && analyzed.length > 0 ? "observed" : "assumed", formula: `Σ base annual cost × (1 + ${a.benefitsLoadPct}) over ${analyzed.length} employees with observed activity`, children: laborChildren },
    repetitiveHours: { label: "Repetitive hours per week", value: repetitiveHoursPerWeek, unit: "hours", basis: "observed", formula: "Σ workflow hours/week where repetition score ≥ 50", source: `${repetitiveWfs.length} of ${d.workflows.length} workflows`, children: repetitiveWfs.slice(0, 50).map((w) => ({ label: w.name, value: num(w.hoursPerWeek), unit: "hours", basis: w.basis, source: `repetition ${num(w.repetitionScore).toFixed(0)}/100` })) },
    ...main.trees,
    verifiedSavings: { label: "Verified savings (annualized)", value: verifiedAnnualizedSavings, unit: "usd", basis: "observed", formula: "Σ measurement dollars × (365.25 ÷ period days)", source: `${inPeriod.length} measurement(s); kept separate from projections`, children: verifiedChildren },
    automationCompletion: { label: "Automation completion", value: automationCompletionPct, unit: "pct", basis: "observed", formula: "verified annualized ÷ realizable projected (cap 100%)", children: [
      { label: "Verified savings (annualized)", value: verifiedAnnualizedSavings, unit: "usd", basis: "observed" },
      { label: "Realizable annual savings (projected)", value: main.realizableAnnualSavings, unit: "usd", basis: "estimated" },
      { label: "Deployment completion", value: deploymentCompletionPct, unit: "pct", basis: "observed", formula: `${deployedAgents} deployed agents ÷ ${inScope.length} opportunities` },
    ] },
  };
  const basisSummary = { observed: 0, estimated: 0, assumed: 0 };
  for (const t of Object.values(trees)) countBasis(t, basisSummary);

  return {
    orgId, computedAt: new Date().toISOString(),
    totalAnnualLaborAnalyzed, employeesAnalyzed: analyzed.length, hoursObservedPerWeek, repetitiveHoursPerWeek, repetitiveSharePct,
    hoursRecoverablePerWeek: main.hoursRecoverablePerWeek, grossAnnualSavings: main.grossAnnualSavings, realizableAnnualSavings: main.realizableAnnualSavings,
    verifiedAnnualizedSavings, verifiedHoursSaved, verifiedHoursSavedAnnualized, verifiedDollarsSaved, verifiedMeasurements: inPeriod.length,
    implementationCost: main.implementationCost, annualOperatingCost: main.annualOperatingCost, platformAnnual: main.platformAnnual, netAnnualSavings: main.netAnnualSavings,
    roi1y: main.roi1y, paybackMonths: main.paybackMonths, automationCompletionPct, deploymentCompletionPct, deployedAgents, opportunityCount: inScope.length,
    byDepartment, byEmployee, opportunities: main.lines, scenarios, threeYear: main.threeYear, trees, assumptions: a, scenario: scenarioKey, basisSummary,
  };
}

// ---------------------------------------------------------------------------------------------
// Run-ledger measurement
// ---------------------------------------------------------------------------------------------

export async function recordSavingsFromRunLedger(orgId: string, agentId: string, periodStart: Date, periodEnd: Date): Promise<typeof schema.savingsMeasurements.$inferSelect> {
  if (!(periodEnd > periodStart)) throw new Error("recordSavingsFromRunLedger: periodEnd must be after periodStart");
  return withTenant(orgId, async (tx) => {
    const [agent] = await tx.select().from(schema.agents).where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, agentId))).limit(1);
    if (!agent) throw new Error(`recordSavingsFromRunLedger: agent ${agentId} not found`);
    const [org] = await tx.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
    const [modelRow] = await tx.select().from(schema.financialModels).where(and(eq(schema.financialModels.orgId, orgId), eq(schema.financialModels.isDefault, true))).limit(1);
    const a: FinancialAssumptions = { ...defaultAssumptions(org?.settings), ...(modelRow?.assumptions ?? {}) };

    const runs = await tx.select().from(schema.agentRuns).where(and(
      eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.agentId, agentId), eq(schema.agentRuns.status, "succeeded"),
      sql`coalesce(${schema.agentRuns.finishedAt}, ${schema.agentRuns.startedAt}, ${schema.agentRuns.createdAt}) >= ${periodStart.toISOString()}::timestamptz`,
      sql`coalesce(${schema.agentRuns.finishedAt}, ${schema.agentRuns.startedAt}, ${schema.agentRuns.createdAt}) < ${periodEnd.toISOString()}::timestamptz`,
    ));
    const minutesSaved = sum(runs.map((r) => num(r.minutesSaved)));
    const humanMinutes = sum(runs.map((r) => num(r.humanMinutes)));
    const hoursSaved = minutesSaved / 60;
    const hoursAfter = humanMinutes / 60;
    const hoursBaseline = hoursSaved + hoursAfter;

    // hours-weighted loaded hourly across the workflow's performers
    let hourly = 0, hourlyBasis: Basis = "assumed", performers = 0;
    if (agent.workflowId) {
      const links = await tx.select({ employeeId: schema.workflowEmployees.employeeId, hoursPerWeek: schema.workflowEmployees.hoursPerWeek }).from(schema.workflowEmployees)
        .where(and(eq(schema.workflowEmployees.orgId, orgId), eq(schema.workflowEmployees.workflowId, agent.workflowId)));
      if (links.length) {
        const emps = await tx.select().from(schema.employees).where(and(eq(schema.employees.orgId, orgId), inArray(schema.employees.id, links.map((l) => l.employeeId))));
        const byId = new Map(emps.map((e) => [e.id, e]));
        let wSum = 0; let allObserved = true;
        for (const l of links) {
          const e = byId.get(l.employeeId); if (!e) continue;
          const h = employeeLoadedHourly(e, a.benefitsLoadPct, a.workWeeksPerYear); if (h.value <= 0) continue;
          const w = num(l.hoursPerWeek) || 1; hourly += h.value * w; wSum += w; performers += 1; if (h.basis !== "observed") allObserved = false;
        }
        if (wSum > 0) { hourly /= wSum; hourlyBasis = allObserved ? "observed" : "estimated"; }
      }
    }
    if (hourly <= 0) {
      const emps = await tx.select().from(schema.employees).where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.isActive, true)));
      const costed = emps.map((e) => employeeLoadedHourly(e, a.benefitsLoadPct, a.workWeeksPerYear).value).filter((v) => v > 0);
      hourly = costed.length ? sum(costed) / costed.length : 0; hourlyBasis = "estimated"; performers = costed.length;
    }
    const dollarsSaved = hoursSaved * hourly;
    const months = (periodEnd.getTime() - periodStart.getTime()) / MS_PER_DAY / (DAYS_PER_YEAR / 12);
    const costIncurred = num(agent.monthlyCost) * months;

    const calculation: CalcTree = { label: "Verified dollars saved", value: dollarsSaved, unit: "usd", basis: "observed", formula: "hours saved × avg loaded hourly of workflow performers", source: `run_ledger: ${runs.length} succeeded run(s) ${periodStart.toISOString().slice(0, 10)} → ${periodEnd.toISOString().slice(0, 10)}`, children: [
      { label: "Hours saved", value: hoursSaved, unit: "hours", basis: "observed", formula: "Σ run minutes_saved ÷ 60", source: "agent_runs ledger", children: [
        { label: "Minutes saved (all runs)", value: minutesSaved, unit: "minutes", basis: "observed", source: `${runs.length} succeeded runs` },
        { label: "Human minutes still spent (review/approval)", value: humanMinutes, unit: "minutes", basis: "observed", source: "agent_runs.human_minutes" },
      ] },
      { label: "Average loaded hourly cost", value: hourly, unit: "usd", basis: hourlyBasis, source: `Weighted across ${performers} performer(s)` },
      { label: "Platform cost incurred in period", value: costIncurred, unit: "usd", basis: "observed", formula: `$${num(agent.monthlyCost)}/mo × ${months.toFixed(2)} months` },
    ] };

    const [existing] = await tx.select().from(schema.savingsMeasurements).where(and(
      eq(schema.savingsMeasurements.orgId, orgId), eq(schema.savingsMeasurements.agentId, agentId), eq(schema.savingsMeasurements.method, "run_ledger"),
      eq(schema.savingsMeasurements.periodStart, periodStart), eq(schema.savingsMeasurements.periodEnd, periodEnd),
    )).limit(1);
    const values = { runs: runs.length, hoursSaved: hoursSaved.toFixed(2), hoursBaseline: hoursBaseline.toFixed(2), hoursAfter: hoursAfter.toFixed(2), dollarsSaved: dollarsSaved.toFixed(2), costIncurred: costIncurred.toFixed(2), basis: "observed" as const, calculation, workflowId: agent.workflowId ?? null };
    if (existing) {
      const [row] = await tx.update(schema.savingsMeasurements).set(values).where(eq(schema.savingsMeasurements.id, existing.id)).returning();
      return row;
    }
    const [row] = await tx.insert(schema.savingsMeasurements).values({ orgId, agentId, periodStart, periodEnd, method: "run_ledger", ...values }).returning();
    return row;
  });
}

// ---------------------------------------------------------------------------------------------
// Executive PDF report
// ---------------------------------------------------------------------------------------------

const REPORT_TITLES: Record<ReportKind, string> = {
  executive_roi: "Executive ROI Summary",
  investment_proposal: "Automation Investment Proposal",
  monthly_performance: "Monthly Automation Performance",
};

const usd = (n: number) => (n < 0 ? "-" : "") + "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
const pct = (n: number, d = 0) => `${(n * 100).toFixed(d)}%`;
const hrs = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)} h`;
const months = (n: number | null) => (n == null ? "n/a" : `${n.toFixed(1)} mo`);
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

type Col = { label: string; width: number; align?: "left" | "right" };

/** Standard PDF fonts are WinAnsi: swap glyphs that are not in that encoding. */
const san = (t: string) => t.replace(/\u2212/g, "-").replace(/\u2265/g, ">=").replace(/\u2264/g, "<=").replace(/\u2260/g, "!=").replace(/\u2192/g, "->").replace(/\u03a3/g, "Sum of");

class Pdf {
  doc: PDFKit.PDFDocument;
  readonly color: string;
  readonly left = 54; readonly right: number; readonly bottom: number;
  constructor(public brand: { reportName: string; primaryColor: string; footer: string; isDemo: boolean }) {
    this.doc = new PDFDocument({ size: "LETTER", margins: { top: 60, bottom: 60, left: 54, right: 54 }, bufferPages: true, info: { Title: brand.reportName, Author: brand.reportName } });
    this.color = brand.primaryColor;
    this.right = this.doc.page.width - 54; this.bottom = this.doc.page.height - 60;
  }
  get width() { return this.right - this.left; }
  ensure(h: number) { if (this.doc.y + h > this.bottom) this.doc.addPage(); }
  h1(t: string) { this.ensure(40); this.doc.moveDown(0.3).font("Helvetica-Bold").fontSize(20).fillColor(this.color).text(san(t), this.left).moveDown(0.4); this.doc.fillColor("#111"); }
  h2(t: string) { this.ensure(30); this.doc.moveDown(0.5).font("Helvetica-Bold").fontSize(13).fillColor("#111").text(san(t), this.left).moveDown(0.25); }
  p(t: string, opts: { size?: number; color?: string; italic?: boolean } = {}) { this.ensure(20); this.doc.font(opts.italic ? "Helvetica-Oblique" : "Helvetica").fontSize(opts.size ?? 10).fillColor(opts.color ?? "#222").text(san(t), this.left, undefined, { width: this.width }).moveDown(0.35); }
  bullet(t: string) { this.ensure(16); this.doc.font("Helvetica").fontSize(10).fillColor("#222").text("•  " + san(t), this.left + 8, undefined, { width: this.width - 8 }).moveDown(0.15); }
  stat(label: string, value: string, note: string, x: number, w: number, y: number) {
    this.doc.roundedRect(x, y, w, 70, 6).lineWidth(1).strokeColor("#ddd").stroke();
    this.doc.font("Helvetica").fontSize(7.5).fillColor("#555").text(san(label).toUpperCase(), x + 10, y + 9, { width: w - 20, height: 10, lineBreak: false, ellipsis: true });
    this.doc.font("Helvetica-Bold").fontSize(18).fillColor(this.color).text(san(value), x + 10, y + 24, { width: w - 20 });
    this.doc.font("Helvetica").fontSize(8).fillColor("#666").text(san(note), x + 10, y + 50, { width: w - 20 });
  }
  statRow(items: { label: string; value: string; note: string }[]) {
    this.ensure(90);
    const gap = 10; const w = (this.width - gap * (items.length - 1)) / items.length; const y = this.doc.y;
    items.forEach((it, i) => this.stat(it.label, it.value, it.note, this.left + i * (w + gap), w, y));
    this.doc.y = y + 80; this.doc.x = this.left;
  }
  table(cols: Col[], rows: string[][], opts: { zebra?: boolean; boldLast?: boolean } = {}) {
    const doc = this.doc; const rowH = 16; const total = cols.reduce((s, c) => s + c.width, 0); const scale = this.width / total;
    const widths = cols.map((c) => c.width * scale);
    const header = () => {
      const y = doc.y; doc.rect(this.left, y, this.width, rowH).fill(this.color);
      let x = this.left; doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#fff");
      cols.forEach((c, i) => { doc.text(san(c.label), x + 4, y + 4, { width: widths[i] - 8, height: rowH - 4, align: c.align ?? "left", lineBreak: false, ellipsis: true }); x += widths[i]; });
      doc.y = y + rowH; doc.fillColor("#111");
    };
    this.ensure(rowH * 3); header();
    rows.forEach((r, ri) => {
      if (doc.y + rowH > this.bottom) { doc.addPage(); header(); }
      const y = doc.y; const last = opts.boldLast && ri === rows.length - 1;
      if (opts.zebra !== false && ri % 2 === 1) doc.rect(this.left, y, this.width, rowH).fill("#f4f6f8");
      if (last) doc.moveTo(this.left, y).lineTo(this.right, y).lineWidth(0.8).strokeColor("#999").stroke();
      let x = this.left; doc.font(last ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor("#111");
      r.forEach((cell, i) => { doc.text(san(cell), x + 4, y + 4, { width: widths[i] - 8, height: rowH - 4, align: cols[i].align ?? "left", lineBreak: false, ellipsis: true }); x += widths[i]; });
      doc.y = y + rowH;
    });
    doc.x = this.left; doc.moveDown(0.6);
  }
  finish(): Promise<Buffer> {
    const doc = this.doc; const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      if (this.brand.isDemo) {
        doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).font("Helvetica-Bold").fontSize(48).fillColor("#000").fillOpacity(0.07)
          .text("SYNTHETIC DEMO DATA", 0, doc.page.height / 2 - 24, { width: doc.page.width, align: "center" }).restore();
      }
      const footY = doc.page.height - 40;
      doc.page.margins.bottom = 0; // writing inside the margin must not trigger an automatic page add
      doc.font("Helvetica").fontSize(7.5).fillColor("#777").fillOpacity(1)
        .text(this.brand.footer, this.left, footY, { width: this.width - 80, lineBreak: false, ellipsis: true })
        .text(`Page ${i - range.start + 1} of ${range.count}`, this.right - 80, footY, { width: 80, align: "right", lineBreak: false });
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
      doc.end();
    });
  }
}

function assumptionRows(a: FinancialAssumptions, scenario: ScenarioKey): string[][] {
  const r = (label: string, value: string, basis: string, why: string) => [label, value, basis, why];
  return [
    r("Automation share multiplier", `${a.automationPct.toFixed(2)}×`, "assumed", `Scales each opportunity's modelled automatable share (${SCENARIOS[scenario].label} scenario)`),
    r("Adoption rate", pct(a.adoptionRate), "assumed", "Share of eligible runs that actually go through the automation"),
    r("Realization rate", pct(a.realizationRate), "assumed", "Share of freed hours that becomes avoided hiring, reassigned work or attrition backfill"),
    r("Benefits & taxes load", pct(a.benefitsLoadPct), "assumed", "Employer taxes + benefits on top of base pay"),
    r("Working weeks per year", `${a.workWeeksPerYear}`, "assumed", "After PTO and holidays"),
    r("Consulting rate", `$${a.consultingHourly}/h`, "assumed", "Implementation effort priced at this rate"),
    r("Per-agent platform fee", `$${a.perAgentMonthly}/mo`, "assumed", "Platform + model + runtime cost per deployed AI agent"),
    r("Platform base fee", `$${a.platformFeeMonthly}/mo`, "assumed", "Subscription base fee"),
    r("Ramp-up period", `${a.rampMonths} months`, "assumed", "Linear ramp to full savings in year 1"),
    r("Discount rate", pct(a.discountRate), "assumed", "Used for 3-year NPV"),
    ...(a.implementationCostOverride != null ? [r("Implementation cost override", usd(a.implementationCostOverride), "assumed", "Manual override of modelled implementation cost")] : []),
    ...(a.annualOpexOverride != null ? [r("Operating cost override", usd(a.annualOpexOverride), "assumed", "Manual override of modelled operating cost")] : []),
  ];
}

export async function generateExecutiveReport(orgId: string, kind: ReportKind, opts: ReportOptions = {}): Promise<{ reportId: string; pdf: Buffer }> {
  const now = new Date();
  const periodEnd = opts.periodEnd ?? now;
  const periodStart = opts.periodStart ?? (kind === "monthly_performance" ? new Date(periodEnd.getTime() - 30 * MS_PER_DAY) : new Date(periodEnd.getTime() - DAYS_PER_YEAR * MS_PER_DAY));
  const scenario = opts.scenario ?? "expected";
  const fin = await computeOrgFinancials(orgId, { scenario, opportunityIds: opts.opportunityIds, ...(kind === "monthly_performance" ? { periodStart, periodEnd } : {}) });
  const org = await withTenant(orgId, async (tx) => (await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1))[0]);
  const branding = org.branding ?? {};
  const whiteLabel = !!branding.reportName;
  const reportName = branding.reportName ?? "BridgeBox AI Workforce Intelligence";
  const footer = branding.footer ?? (whiteLabel ? `${reportName} — Confidential` : "BridgeBox AI Workforce Intelligence — Confidential");
  const pdf = new Pdf({ reportName, primaryColor: branding.primaryColor ?? "#0f766e", footer, isDemo: org.isDemo });
  const doc = pdf.doc; const title = REPORT_TITLES[kind];
  const top = fin.opportunities.slice(0, 10);

  // ---- cover ----
  doc.rect(0, 0, doc.page.width, 170).fill(pdf.color);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#fff").fillOpacity(0.85).text(reportName.toUpperCase(), pdf.left, 60, { characterSpacing: 1 });
  doc.fillOpacity(1).fontSize(26).text(title, pdf.left, 90, { width: pdf.width });
  doc.y = 210; doc.x = pdf.left;
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111").text(org.name, pdf.left);
  doc.font("Helvetica").fontSize(10).fillColor("#444").moveDown(0.3)
    .text(`Prepared ${dateStr(now)}`).text(`Scenario: ${SCENARIOS[scenario].label}`)
    .text(kind === "monthly_performance" ? `Period: ${dateStr(periodStart)} to ${dateStr(periodEnd)}` : `Basis: ${fin.employeesAnalyzed} employees analyzed, ${fin.opportunityCount} opportunities in scope`);
  if (org.isDemo) doc.moveDown(0.5).font("Helvetica-Bold").fillColor("#b45309").text("This report is built from synthetic demonstration data. Figures are illustrative only.");
  doc.moveDown(2);
  pdf.statRow([
    { label: "Spent on automatable work", value: usd(fin.grossAnnualSavings), note: "Gross annual labor cost of time the model expects to remove" },
    { label: "Achievable per year", value: usd(fin.realizableAnnualSavings), note: `After ${pct(fin.assumptions.adoptionRate)} adoption and ${pct(fin.assumptions.realizationRate)} realization` },
    { label: "Verified so far", value: usd(fin.verifiedAnnualizedSavings), note: `${fin.verifiedMeasurements} measurement(s), annualized — measured, not projected` },
  ]);
  doc.moveDown(1);
  pdf.p("How to read this report: projected figures come from observed workflow hours multiplied by modelled automation, adoption and realization rates. Verified figures come only from post-deployment measurements and are never mixed into projections. Time saved is not the same as payroll removed; only the realizable share is counted as savings.", { size: 9, color: "#555", italic: true });

  // ---- executive summary ----
  doc.addPage(); pdf.h1("Executive summary");
  const bullets = [
    `${fin.employeesAnalyzed} employees with ${usd(fin.totalAnnualLaborAnalyzed)} of annual loaded labor cost were analyzed across ${fin.byDepartment.length} department(s).`,
    `${hrs(fin.repetitiveHoursPerWeek)} per week (${pct(fin.repetitiveSharePct)} of ${hrs(fin.hoursObservedPerWeek)} observed) is spent on repetitive workflows.`,
    `${fin.opportunityCount} automation opportunities could recover ${hrs(fin.hoursRecoverablePerWeek)} per week, worth ${usd(fin.grossAnnualSavings)} gross and ${usd(fin.realizableAnnualSavings)} realizable per year.`,
    `One-time implementation of ${usd(fin.implementationCost)} plus ${usd(fin.annualOperatingCost)} annual operating cost yields ${usd(fin.netAnnualSavings)} net annual savings, ${pct(fin.roi1y)} first-year ROI and a payback of ${months(fin.paybackMonths)}.`,
    `${fin.deployedAgents} agent(s) are deployed (${pct(fin.deploymentCompletionPct)} of opportunities). Verified savings to date are ${usd(fin.verifiedAnnualizedSavings)} annualized (${hrs(fin.verifiedHoursSaved)} measured), ${pct(fin.automationCompletionPct)} of the realizable projection.`,
    `Three-year net benefit under the ${SCENARIOS[scenario].label} scenario: ${usd(fin.threeYear.totalNet)} (NPV ${usd(fin.threeYear.npv)} at ${pct(fin.assumptions.discountRate)}).`,
  ];
  if (kind === "investment_proposal") bullets.push(`Recommendation: approve ${usd(fin.implementationCost)} to implement the top ${Math.min(10, fin.opportunityCount)} opportunities listed on page 3; even the Conservative scenario returns ${usd(fin.scenarios.conservative.netAnnualSavings)} net per year.`);
  if (kind === "monthly_performance") bullets.push(`This period: ${usd(fin.verifiedDollarsSaved)} verified savings and ${hrs(fin.verifiedHoursSaved)} saved across ${fin.verifiedMeasurements} measurement(s).`);
  bullets.forEach((b) => pdf.bullet(b));
  pdf.statRow([
    { label: "Net annual savings", value: usd(fin.netAnnualSavings), note: "Realizable − operating − platform base fee" },
    { label: "First-year ROI", value: pct(fin.roi1y), note: "(net − implementation) ÷ implementation" },
    { label: "Payback", value: months(fin.paybackMonths), note: "Implementation ÷ monthly net savings" },
    { label: "Completion", value: pct(fin.automationCompletionPct), note: "Verified ÷ realizable projection" },
  ]);

  // ---- departments ----
  pdf.h2("Savings by department");
  pdf.table(
    [{ label: "Department", width: 120 }, { label: "Staff", width: 36, align: "right" }, { label: "Labor/yr", width: 70, align: "right" }, { label: "Hrs/wk", width: 50, align: "right" }, { label: "Repetitive", width: 60, align: "right" }, { label: "Recov/wk", width: 60, align: "right" }, { label: "Realizable/yr", width: 76, align: "right" }, { label: "Verified/yr", width: 70, align: "right" }, { label: "Gain", width: 40, align: "right" }],
    [...fin.byDepartment.map((d) => [d.name, String(d.employees), usd(d.laborAnnual), hrs(d.hoursPerWeek), hrs(d.repetitiveHoursPerWeek), hrs(d.recoverableHoursPerWeek), usd(d.realizableAnnual), usd(d.verifiedAnnual), pct(d.efficiencyGainPct)]),
      ["Total", String(fin.employeesAnalyzed), usd(fin.totalAnnualLaborAnalyzed), hrs(sum(fin.byDepartment.map((d) => d.hoursPerWeek))), hrs(sum(fin.byDepartment.map((d) => d.repetitiveHoursPerWeek))), hrs(fin.hoursRecoverablePerWeek), usd(fin.realizableAnnualSavings), usd(fin.verifiedAnnualizedSavings), ""]],
    { boldLast: true },
  );

  // ---- top opportunities ----
  doc.addPage(); pdf.h1("Top opportunities");
  pdf.p(`Ranked by realizable annual savings under the ${SCENARIOS[scenario].label} scenario. "Deployed" marks opportunities with a live agent.`, { size: 9, color: "#555" });
  pdf.table(
    [{ label: "#", width: 20 }, { label: "Opportunity", width: 170 }, { label: "Type", width: 66 }, { label: "Dept", width: 76 }, { label: "Hrs/wk", width: 46, align: "right" }, { label: "Realizable/yr", width: 78, align: "right" }, { label: "Implement", width: 62, align: "right" }, { label: "Payback", width: 52, align: "right" }, { label: "Status", width: 60 }],
    top.map((o, i) => [String(i + 1), o.title, o.type.replace(/_/g, " "), o.departmentName ?? "—", hrs(o.hoursRecoverablePerWeek), usd(o.realizableAnnualSavings), usd(o.implementationCost), months(o.paybackMonths), o.deployed ? "deployed" : o.status.replace(/_/g, " ")]),
  );
  if (!top.length) pdf.p("No opportunities have been identified yet. Run an analysis after an observation campaign completes.", { italic: true, color: "#666" });

  // ---- scenarios ----
  pdf.h2("Scenario comparison");
  const sc = (k: ScenarioKey) => fin.scenarios[k];
  pdf.table(
    [{ label: "Metric", width: 170 }, { label: "Conservative", width: 110, align: "right" }, { label: "Expected", width: 110, align: "right" }, { label: "Aggressive", width: 110, align: "right" }],
    [
      ["Adoption / realization / automation ×", ...(["conservative", "expected", "aggressive"] as ScenarioKey[]).map((k) => `${pct(SCENARIOS[k].adoptionRate)} / ${pct(SCENARIOS[k].realizationRate)} / ${SCENARIOS[k].automationMult}×`)],
      ["Hours recoverable / week", hrs(sc("conservative").hoursRecoverablePerWeek), hrs(sc("expected").hoursRecoverablePerWeek), hrs(sc("aggressive").hoursRecoverablePerWeek)],
      ["Gross annual savings", usd(sc("conservative").grossAnnualSavings), usd(sc("expected").grossAnnualSavings), usd(sc("aggressive").grossAnnualSavings)],
      ["Realizable annual savings", usd(sc("conservative").realizableAnnualSavings), usd(sc("expected").realizableAnnualSavings), usd(sc("aggressive").realizableAnnualSavings)],
      ["Implementation cost", usd(sc("conservative").implementationCost), usd(sc("expected").implementationCost), usd(sc("aggressive").implementationCost)],
      ["Annual operating cost", usd(sc("conservative").annualOperatingCost), usd(sc("expected").annualOperatingCost), usd(sc("aggressive").annualOperatingCost)],
      ["Net annual savings", usd(sc("conservative").netAnnualSavings), usd(sc("expected").netAnnualSavings), usd(sc("aggressive").netAnnualSavings)],
      ["First-year ROI", pct(sc("conservative").roi1y), pct(sc("expected").roi1y), pct(sc("aggressive").roi1y)],
      ["Payback", months(sc("conservative").paybackMonths), months(sc("expected").paybackMonths), months(sc("aggressive").paybackMonths)],
      ["3-year net benefit", usd(sc("conservative").threeYear.totalNet), usd(sc("expected").threeYear.totalNet), usd(sc("aggressive").threeYear.totalNet)],
      ["3-year NPV", usd(sc("conservative").threeYear.npv), usd(sc("expected").threeYear.npv), usd(sc("aggressive").threeYear.npv)],
    ],
  );

  // ---- three-year ----
  pdf.h2(`Three-year projection (${SCENARIOS[scenario].label})`);
  pdf.p(`Savings ramp linearly over ${fin.assumptions.rampMonths} months in year 1. Costs include operating cost, the platform base fee and (year 1 only) implementation. Discounted at ${pct(fin.assumptions.discountRate)}.`, { size: 9, color: "#555" });
  pdf.table(
    [{ label: "Year", width: 60 }, { label: "Savings", width: 100, align: "right" }, { label: "Costs", width: 100, align: "right" }, { label: "Net", width: 100, align: "right" }, { label: "Cumulative", width: 100, align: "right" }, { label: "Discounted", width: 100, align: "right" }],
    [...fin.threeYear.years.map((y) => [`Year ${y.year}`, usd(y.savings), usd(y.costs), usd(y.net), usd(y.cumulative), usd(y.discounted)]),
      ["Total", usd(sum(fin.threeYear.years.map((y) => y.savings))), usd(sum(fin.threeYear.years.map((y) => y.costs))), usd(fin.threeYear.totalNet), "", usd(fin.threeYear.npv)]],
    { boldLast: true },
  );

  // ---- assumptions ----
  doc.addPage(); pdf.h1("Assumptions");
  pdf.p("Every figure in this report carries a basis: observed (measured from collector events or run ledgers), estimated (derived from observed data via a model) or assumed (a financial-model input you can change). Assumptions below drive all projected numbers.", { size: 9, color: "#555" });
  pdf.table([{ label: "Assumption", width: 140 }, { label: "Value", width: 70 }, { label: "Basis", width: 55 }, { label: "Why", width: 260 }], assumptionRows(fin.assumptions, scenario));
  pdf.p(`Evidence mix across calculation trees: ${fin.basisSummary.observed} observed, ${fin.basisSummary.estimated} estimated, ${fin.basisSummary.assumed} assumed nodes.`, { size: 9, color: "#555" });

  // ---- methodology ----
  pdf.h1("Methodology");
  const method = [
    "Loaded labor cost = base annual cost × (1 + benefits load). Loaded hourly = loaded annual ÷ (hours per week × working weeks per year).",
    "Observed hours per workflow come from collector activity metadata (application focus and step durations), never from keystroke contents or screenshots. Repetitive hours are workflows with a repetition score of 50 or more.",
    "Hours recoverable per week = workflow hours per week × automatable share × adoption rate.",
    "Gross annual savings = recoverable hours per week × working weeks per year × average loaded hourly cost of the people who perform the workflow.",
    "Realizable annual savings = gross × realization rate. Freed time only becomes money when it avoids a hire, backfills attrition or is redeployed to revenue work; the remainder is capacity, not cash.",
    "Implementation cost = base consulting hours for the opportunity type × (1 + complexity) × consulting rate + one-time tooling. Operating cost = monthly run cost × 12.",
    "Net annual savings = realizable − operating − platform base fee. ROI = (net − implementation) ÷ implementation. Payback = implementation ÷ (net ÷ 12).",
    "Verified savings are measured only after deployment: from the agent run ledger (minutes saved per succeeded run × loaded hourly of the displaced work), before/after observation, or signed attestation. They are annualized by period length and reported separately from projections; they are never added to projected figures.",
    "Automation completion = verified annualized savings ÷ realizable projected savings (capped at 100%), alongside deployed agents ÷ opportunities.",
    "Scenarios change only adoption, realization, the automation multiplier and a cost multiplier; observed hours and labor costs are identical across scenarios.",
  ];
  method.forEach((m) => pdf.bullet(m));
  if (!whiteLabel) pdf.p("Generated by BridgeBox AI Workforce Intelligence.", { size: 8, color: "#888", italic: true });

  const bytes = await pdf.finish();

  const data: Record<string, unknown> = {
    kind, scenario, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), reportName, generatedAt: now.toISOString(),
    headline: {
      totalAnnualLaborAnalyzed: fin.totalAnnualLaborAnalyzed, employeesAnalyzed: fin.employeesAnalyzed, hoursObservedPerWeek: fin.hoursObservedPerWeek, repetitiveHoursPerWeek: fin.repetitiveHoursPerWeek,
      hoursRecoverablePerWeek: fin.hoursRecoverablePerWeek, grossAnnualSavings: fin.grossAnnualSavings, realizableAnnualSavings: fin.realizableAnnualSavings,
      verifiedAnnualizedSavings: fin.verifiedAnnualizedSavings, verifiedHoursSaved: fin.verifiedHoursSaved, implementationCost: fin.implementationCost, annualOperatingCost: fin.annualOperatingCost,
      platformAnnual: fin.platformAnnual, netAnnualSavings: fin.netAnnualSavings, roi1y: fin.roi1y, paybackMonths: fin.paybackMonths, automationCompletionPct: fin.automationCompletionPct, deploymentCompletionPct: fin.deploymentCompletionPct,
    },
    byDepartment: fin.byDepartment,
    topOpportunities: top.map(({ tree: _t, ...o }) => { void _t; return o; }),
    scenarios: fin.scenarios, threeYear: fin.threeYear, assumptions: fin.assumptions, basisSummary: fin.basisSummary,
  };
  const reportId = await withTenant(orgId, async (tx) => {
    const [row] = await tx.insert(schema.reports).values({
      orgId, kind, title: `${title} — ${org.name} — ${dateStr(now)}`, periodStart, periodEnd, data, pdfBytes: bytes.toString("base64"), generatedBy: opts.generatedBy ?? null,
    }).returning({ id: schema.reports.id });
    return row.id;
  });
  return { reportId, pdf: bytes };
}
