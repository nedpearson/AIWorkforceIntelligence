/**
 * Opportunity scoring — an explainable 0–100 score for every AI / automation opportunity.
 *
 *  - scoreOpportunity(inputs)              → pure: 8 weighted factors + evidence confidence (unit tested)
 *  - analyzeOpportunities(orgId, filters?) → DB orchestration: loads tenant data, takes every money figure from
 *                                            computeOrgFinancials lines (never re-derives savings math), scores,
 *                                            ranks and answers the 18 per-workflow questions.
 *
 * Every factor carries its weight, the inputs it used and a plain-English reason, so the number can be defended
 * in front of a CFO. Weights sum to 100 (asserted in tests/unit/opportunity-score.test.ts).
 */
import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import type { CalcTree, Evidence, WorkflowStep } from "@/db/schema";
import { computeOrgFinancials } from "./finance";
import type { OpportunityLine, OrgFinancials } from "./finance.types";
import { recommendTemplate } from "./agents/templates";

const num = (v: unknown) => (v == null ? 0 : typeof v === "number" ? v : Number(v) || 0);
const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const r1 = (n: number) => Math.round(n * 10) / 10;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

// ---------------------------------------------------------------------------------------------
// Pure scoring
// ---------------------------------------------------------------------------------------------

export type FactorKey = "financial" | "feasibility" | "effort" | "dataReadiness" | "stability" | "businessImpact" | "compliance" | "expectedReturn";

/** Factor weights (points out of 100). */
export const SCORE_WEIGHTS: Record<FactorKey, number> = {
  financial: 20, feasibility: 15, effort: 10, dataReadiness: 10, stability: 10, businessImpact: 15, compliance: 10, expectedReturn: 10,
};
export const FACTOR_LABEL: Record<FactorKey, string> = {
  financial: "Financial impact", feasibility: "Automation feasibility", effort: "Implementation effort", dataReadiness: "Data readiness",
  stability: "Workflow stability", businessImpact: "Business impact", compliance: "Compliance risk", expectedReturn: "Expected return",
};
export const FACTOR_ORDER: FactorKey[] = ["financial", "feasibility", "effort", "dataReadiness", "stability", "businessImpact", "compliance", "expectedReturn"];

export type ScoreInputs = {
  realizableAnnual: number; orgMaxRealizable: number;
  feasibility: number; // 0..100 (analysis engine)
  implementationCost: number; orgMaxImplementationCost: number; complexity: number; // complexity 0..1
  sampleSize: number; basis: "observed" | "estimated" | "assumed"; performers: number; performersWithCollector: number;
  repetitionScore: number; reworkRate: number; // 0..100, 0..1
  hoursRecoverablePerWeek: number; orgMaxHoursRecoverable: number; peopleAffected: number; orgMaxPeople: number;
  risk: number; regulatoryFlag: string | null; requiresJudgment: boolean;
  roi1y: number; paybackMonths: number | null;
};
export type ScoreFactor = { key: FactorKey; label: string; value: number; weight: number; contribution: number; inputs: { label: string; value: string }[]; reason: string };
export type ConfidenceLevel = "High" | "Medium" | "Low";
export type Confidence = { level: ConfidenceLevel; rule: string; reasons: string[] };
export type OpportunityScore = { total: number; factors: ScoreFactor[]; confidence: Confidence };

/** Sample size at which the evidence is considered statistically comfortable (runs observed). */
export const SAMPLE_TARGET = 200;
export const CONFIDENCE_RULE = "High: observed basis, ≥ 100 runs and ≥ 80% of performers covered by a collector. Medium: ≥ 30 runs and not assumed. Otherwise Low.";

export function evidenceConfidence(i: Pick<ScoreInputs, "sampleSize" | "basis" | "performers" | "performersWithCollector">): Confidence {
  const coverage = i.performers > 0 ? i.performersWithCollector / i.performers : 0;
  const reasons = [
    `${i.sampleSize.toLocaleString("en-US")} observed run${i.sampleSize === 1 ? "" : "s"}`,
    `basis: ${i.basis}`,
    `${i.performersWithCollector} of ${i.performers} performer${i.performers === 1 ? "" : "s"} covered by a desktop collector (${Math.round(coverage * 100)}%)`,
  ];
  const level: ConfidenceLevel = i.basis === "observed" && i.sampleSize >= 100 && coverage >= 0.8 ? "High"
    : i.sampleSize >= 30 && i.basis !== "assumed" ? "Medium" : "Low";
  return { level, rule: CONFIDENCE_RULE, reasons };
}

export function scoreOpportunity(i: ScoreInputs): OpportunityScore {
  const f: Record<FactorKey, Omit<ScoreFactor, "key" | "label" | "weight" | "contribution">> = {} as never;
  const share = (v: number, max: number) => (max > 0 ? clamp((v / max) * 100) : 0);

  // 1. financial impact
  const fin = share(i.realizableAnnual, i.orgMaxRealizable);
  f.financial = { value: fin, inputs: [{ label: "Realizable savings / yr", value: usd(i.realizableAnnual) }, { label: "Largest opportunity in org", value: usd(i.orgMaxRealizable) }],
    reason: `Worth ${usd(i.realizableAnnual)}/yr realizable — ${Math.round(fin)}% of the organization's largest opportunity.` };

  // 2. feasibility
  const feas = clamp(i.feasibility);
  f.feasibility = { value: feas, inputs: [{ label: "Feasibility (analysis engine)", value: `${Math.round(feas)}/100` }],
    reason: feas >= 70 ? "Highly automatable: structured, repetitive steps in apps with usable interfaces." : feas >= 45 ? "Partly automatable: some steps need adaptation or a human checkpoint." : "Hard to automate with today's tooling; expect partial coverage." };

  // 3. implementation effort (inverse of cost & complexity)
  const costShare = i.orgMaxImplementationCost > 0 ? clamp(i.implementationCost / i.orgMaxImplementationCost, 0, 1) : 0;
  const cx = clamp(i.complexity, 0, 1);
  const effort = clamp(100 - 60 * costShare - 40 * cx);
  f.effort = { value: effort, inputs: [{ label: "Implementation cost", value: usd(i.implementationCost) }, { label: "Highest in org", value: usd(i.orgMaxImplementationCost) }, { label: "Complexity", value: `${Math.round(cx * 100)}%` }],
    reason: `100 − 60 × cost share (${Math.round(costShare * 100)}%) − 40 × complexity (${Math.round(cx * 100)}%). ${effort >= 60 ? "Light lift." : effort >= 35 ? "Moderate build." : "Heavy build — plan a phased delivery."}` };

  // 4. data readiness
  const coverage = i.performers > 0 ? clamp(i.performersWithCollector / i.performers, 0, 1) : 0;
  const sampleShare = clamp(i.sampleSize / SAMPLE_TARGET, 0, 1);
  const basisPts = i.basis === "observed" ? 25 : i.basis === "estimated" ? 12 : 0;
  const ready = clamp(50 * sampleShare + basisPts + 25 * coverage);
  f.dataReadiness = { value: ready, inputs: [{ label: "Runs observed", value: i.sampleSize.toLocaleString("en-US") }, { label: "Basis", value: i.basis }, { label: "Collector coverage of performers", value: `${i.performersWithCollector}/${i.performers}` }],
    reason: `50 × sample (${Math.round(sampleShare * 100)}% of ${SAMPLE_TARGET} runs) + ${basisPts} for ${i.basis} basis + 25 × collector coverage (${Math.round(coverage * 100)}%).` };

  // 5. workflow stability
  const rework = clamp(i.reworkRate, 0, 1);
  const stab = clamp(0.7 * clamp(i.repetitionScore) + 30 * (1 - clamp(rework / 0.3, 0, 1)));
  f.stability = { value: stab, inputs: [{ label: "Repetition score", value: `${Math.round(i.repetitionScore)}/100` }, { label: "Rework rate", value: `${(rework * 100).toFixed(1)}%` }],
    reason: `0.7 × repetition + 30 × (1 − rework ÷ 30%). ${stab >= 70 ? "The process runs the same way nearly every time." : stab >= 45 ? "Mostly consistent, with some variation or rework." : "Variable process — standardize before automating."}` };

  // 6. business impact
  const hrsShare = share(i.hoursRecoverablePerWeek, i.orgMaxHoursRecoverable);
  const pplShare = share(i.peopleAffected, i.orgMaxPeople);
  const impact = clamp(0.7 * hrsShare + 0.3 * pplShare);
  f.businessImpact = { value: impact, inputs: [{ label: "Hours recoverable / wk", value: `${r1(i.hoursRecoverablePerWeek)}` }, { label: "Most in org", value: `${r1(i.orgMaxHoursRecoverable)}` }, { label: "People affected", value: `${i.peopleAffected} (max ${i.orgMaxPeople})` }],
    reason: `0.7 × hours share (${Math.round(hrsShare)}%) + 0.3 × people share (${Math.round(pplShare)}%).` };

  // 7. compliance risk (inverse)
  const regPen = i.regulatoryFlag ? 25 : 0; const judgPen = i.requiresJudgment ? 15 : 0;
  const comp = clamp(100 - 0.6 * clamp(i.risk) - regPen - judgPen);
  f.compliance = { value: comp, inputs: [{ label: "Risk score", value: `${Math.round(i.risk)}/100` }, { label: "Regulated data", value: i.regulatoryFlag ?? "none" }, { label: "Human judgment", value: i.requiresJudgment ? "yes" : "no" }],
    reason: `100 − 0.6 × risk${regPen ? ` − 25 (${i.regulatoryFlag} data)` : ""}${judgPen ? " − 15 (judgment steps)" : ""}. Higher is safer.` };

  // 8. expected return
  const roiPts = 60 * clamp(i.roi1y / 3, 0, 1);
  const payPts = i.paybackMonths == null ? 0 : 40 * clamp(1 - i.paybackMonths / 36, 0, 1);
  const ret = clamp(roiPts + payPts);
  f.expectedReturn = { value: ret, inputs: [{ label: "First-year ROI", value: `${Math.round(i.roi1y * 100)}%` }, { label: "Payback", value: i.paybackMonths == null ? "not reached" : `${r1(i.paybackMonths)} mo` }],
    reason: `60 × ROI ÷ 300% (capped) + 40 × (1 − payback ÷ 36 mo). ${i.paybackMonths == null ? "Net savings never cover the setup cost under current assumptions." : i.paybackMonths <= 12 ? "Pays back inside a year." : "Pays back over more than a year."}` };

  const factors: ScoreFactor[] = FACTOR_ORDER.map((k) => {
    const v = r1(f[k].value); const w = SCORE_WEIGHTS[k];
    return { key: k, label: FACTOR_LABEL[k], value: v, weight: w, contribution: r1((v * w) / 100), inputs: f[k].inputs, reason: f[k].reason };
  });
  const total = r1(clamp(factors.reduce((s, x) => s + (x.value * x.weight) / 100, 0)));
  return { total, factors, confidence: evidenceConfidence(i) };
}

// ---------------------------------------------------------------------------------------------
// Helpers shared with the roadmap / UI
// ---------------------------------------------------------------------------------------------

export function findNode(tree: CalcTree | null | undefined, label: string): CalcTree | undefined {
  if (!tree) return undefined;
  if (tree.label === label) return tree;
  for (const c of tree.children ?? []) { const x = findNode(c, label); if (x) return x; }
  return undefined;
}
export type RiskBucket = "low" | "medium" | "high";
export const riskBucket = (risk: number): RiskBucket => (risk >= 60 ? "high" : risk >= 35 ? "medium" : "low");
export type Quadrant = "quick_win" | "strategic" | "fill_in" | "reconsider";
export const QUADRANT_LABEL: Record<Quadrant, string> = { quick_win: "Quick wins", strategic: "Strategic bets", fill_in: "Fill-ins", reconsider: "Reconsider" };
/** value high + effort low = quick win; value high + effort high = strategic; value low + effort low = fill-in; else reconsider. */
export function quadrantOf(value: number, effort: number, valueSplit: number, effortSplit: number): Quadrant {
  const hiV = value >= valueSplit; const hiE = effort > effortSplit;
  return hiV ? (hiE ? "strategic" : "quick_win") : hiE ? "reconsider" : "fill_in";
}
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------------------------------------------------------------------------------------------
// DB orchestration
// ---------------------------------------------------------------------------------------------

export type OppFilters = { dept?: string; bu?: string; loc?: string; status?: string; risk?: string; type?: string };

export type OpportunityAnswers = {
  currentProcessCost: { value: number; tree: CalcTree };
  hoursPerWeek: number; runsPerWeek: number; avgDurationMin: number; manualSteps: number; automationPct: number; feasibility: number;
  integrations: { app: string; steps: number }[]; requiredCredentials: { provider: string; label: string }[];
  difficulty: { level: "Low" | "Medium" | "High"; reason: string };
  implementationCost: number; recurringCost: number; annualHoursSaved: number; realizableAnnual: number; grossAnnual: number; netAnnual: number; roi1y: number;
  operationalRisk: { score: number; level: RiskBucket; drivers: string[] };
  regulatory: string[];
  recommendedSolution: { key: string; name: string; description: string; category: string; monthlyCost: number; runtime: string };
  paybackMonths: number | null; confidence: ConfidenceLevel; priorityRank: number;
};

export type OpportunityAnalysis = {
  id: string; title: string; summary: string; type: string; status: string; basis: "observed" | "estimated" | "assumed"; inScope: boolean;
  departmentId: string | null; departmentName: string | null; businessUnitId: string | null; locationId: string | null;
  workflowId: string | null; workflowName: string | null; duplicate: boolean; requiresHumanJudgment: boolean; regulatoryFlag: string | null;
  agent: { id: string; name: string; status: string } | null;
  line: OpportunityLine; complexity: number; peopleAffected: number;
  score: OpportunityScore; answers: OpportunityAnswers;
  riskBucket: RiskBucket; valueScore: number; effortScore: number; quadrant: Quadrant;
  evidence: { sampleSize: number; observedFrom: string; observedTo: string; eventIds: number[]; notes: string[]; performers: number; performersWithCollector: number };
};

export type OpportunityAnalysisResult = {
  fin: OrgFinancials;
  all: OpportunityAnalysis[]; // every opportunity (ranked)
  filtered: OpportunityAnalysis[]; // after filters
  splits: { value: number; effort: number };
  options: { departments: { id: string; name: string; businessUnitId: string | null; locationId: string | null }[]; businessUnits: { id: string; name: string }[]; locations: { id: string; name: string }[] };
  weeksPerYear: number;
};

export function matchesFilters(a: Pick<OpportunityAnalysis, "departmentId" | "businessUnitId" | "locationId" | "status" | "riskBucket" | "type">, f: OppFilters): boolean {
  return (!f.dept || a.departmentId === f.dept) && (!f.bu || a.businessUnitId === f.bu) && (!f.loc || a.locationId === f.loc)
    && (!f.status || a.status === f.status) && (!f.risk || a.riskBucket === f.risk) && (!f.type || a.type === f.type);
}

export async function analyzeOpportunities(orgId: string, filters: OppFilters = {}): Promise<OpportunityAnalysisResult> {
  const fin = await computeOrgFinancials(orgId);
  const raw = await withTenant(orgId, async (tx) => {
    const [opps, workflows, links, collectors, agents, departments, bus, locs] = await Promise.all([
      tx.select().from(schema.opportunities).where(eq(schema.opportunities.orgId, orgId)),
      tx.select({ id: schema.workflows.id, name: schema.workflows.name, departmentId: schema.workflows.departmentId, steps: schema.workflows.steps, runsPerWeek: schema.workflows.runsPerWeek, avgDurationMin: schema.workflows.avgDurationMin, hoursPerWeek: schema.workflows.hoursPerWeek, repetitionScore: schema.workflows.repetitionScore, reworkRate: schema.workflows.reworkRate, handoffCount: schema.workflows.handoffCount, isManual: schema.workflows.isManual, employeeCount: schema.workflows.employeeCount, duplicateOfWorkflowId: schema.workflows.duplicateOfWorkflowId, regulatoryFlag: schema.workflows.regulatoryFlag, requiresJudgment: schema.workflows.requiresJudgment }).from(schema.workflows).where(eq(schema.workflows.orgId, orgId)),
      tx.select({ workflowId: schema.workflowEmployees.workflowId, employeeId: schema.workflowEmployees.employeeId }).from(schema.workflowEmployees).where(eq(schema.workflowEmployees.orgId, orgId)),
      tx.select({ employeeId: schema.collectors.employeeId, status: schema.collectors.status }).from(schema.collectors).where(eq(schema.collectors.orgId, orgId)),
      tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, opportunityId: schema.agents.opportunityId }).from(schema.agents).where(eq(schema.agents.orgId, orgId)),
      tx.select({ id: schema.departments.id, name: schema.departments.name, businessUnitId: schema.departments.businessUnitId, locationId: schema.departments.locationId }).from(schema.departments).where(eq(schema.departments.orgId, orgId)),
      tx.select({ id: schema.businessUnits.id, name: schema.businessUnits.name }).from(schema.businessUnits).where(eq(schema.businessUnits.orgId, orgId)),
      tx.select({ id: schema.locations.id, name: schema.locations.name }).from(schema.locations).where(eq(schema.locations.orgId, orgId)),
    ]);
    return { opps, workflows, links, collectors, agents, departments, bus, locs };
  });

  // Rejected opportunities are out of the default finance scope; their lines come from the same engine, scoped to them.
  const lineById = new Map(fin.opportunities.map((l) => [l.id, l]));
  const outOfScope = raw.opps.filter((o) => !lineById.has(o.id)).map((o) => o.id);
  if (outOfScope.length) { const extra = await computeOrgFinancials(orgId, { opportunityIds: outOfScope }); for (const l of extra.opportunities) if (!lineById.has(l.id)) lineById.set(l.id, l); }

  const weeks = fin.assumptions.workWeeksPerYear || 48;
  const wfById = new Map(raw.workflows.map((w) => [w.id, w]));
  const deptById = new Map(raw.departments.map((d) => [d.id, d]));
  const activeCollectorEmps = new Set(raw.collectors.filter((c) => c.employeeId && c.status === "active").map((c) => c.employeeId as string));
  const perfByWf = new Map<string, string[]>();
  for (const l of raw.links) { const a = perfByWf.get(l.workflowId) ?? []; a.push(l.employeeId); perfByWf.set(l.workflowId, a); }
  const inScopeIds = new Set(fin.opportunities.map((l) => l.id));

  const prelim = raw.opps.filter((o) => lineById.has(o.id)).map((o) => {
    const line = lineById.get(o.id)!;
    const wf = o.workflowId ? wfById.get(o.workflowId) : undefined;
    const perf = wf ? perfByWf.get(wf.id) ?? [] : [];
    const ev = (o.evidence ?? { eventIds: [], sampleSize: 0, observedFrom: "", observedTo: "" }) as Evidence;
    const complexityNode = findNode(line.tree, "Complexity multiplier");
    const complexity = complexityNode ? clamp(complexityNode.value - 1, 0, 1) : 0;
    return { o, line, wf, perf, ev, complexity, peopleAffected: perf.length || wf?.employeeCount || 0 };
  });
  const scoped = prelim.filter((p) => inScopeIds.has(p.o.id));
  const basisSet = scoped.length ? scoped : prelim;
  const orgMaxRealizable = Math.max(0, ...basisSet.map((p) => p.line.realizableAnnualSavings));
  const orgMaxImpl = Math.max(0, ...basisSet.map((p) => p.line.implementationCost));
  const orgMaxHours = Math.max(0, ...basisSet.map((p) => p.line.hoursRecoverablePerWeek));
  const orgMaxPeople = Math.max(0, ...basisSet.map((p) => p.peopleAffected));

  const scoredList = prelim.map((p) => {
    const { o, line, wf, perf, ev } = p;
    const withCollector = perf.filter((e) => activeCollectorEmps.has(e)).length;
    const score = scoreOpportunity({
      realizableAnnual: line.realizableAnnualSavings, orgMaxRealizable, feasibility: line.feasibility, implementationCost: line.implementationCost, orgMaxImplementationCost: orgMaxImpl,
      complexity: p.complexity, sampleSize: ev.sampleSize ?? 0, basis: o.basis, performers: perf.length, performersWithCollector: withCollector,
      repetitionScore: num(wf?.repetitionScore), reworkRate: num(wf?.reworkRate), hoursRecoverablePerWeek: line.hoursRecoverablePerWeek, orgMaxHoursRecoverable: orgMaxHours,
      peopleAffected: p.peopleAffected, orgMaxPeople, risk: line.risk, regulatoryFlag: o.regulatoryFlag ?? wf?.regulatoryFlag ?? null, requiresJudgment: o.requiresHumanJudgment || !!wf?.requiresJudgment,
      roi1y: line.roi1y, paybackMonths: line.paybackMonths,
    });
    return { ...p, score, withCollector };
  });
  // Priority rank: in-scope first, by score desc, ties broken by realizable then id (deterministic).
  scoredList.sort((a, b) => (Number(inScopeIds.has(b.o.id)) - Number(inScopeIds.has(a.o.id))) || (b.score.total - a.score.total) || (b.line.realizableAnnualSavings - a.line.realizableAnnualSavings) || a.o.id.localeCompare(b.o.id));

  const valueOf = (s: OpportunityScore) => s.factors.find((f) => f.key === "financial")!.value;
  const effortOf = (s: OpportunityScore) => r1(100 - s.factors.find((f) => f.key === "effort")!.value);
  const splits = { value: median(scoredList.filter((x) => inScopeIds.has(x.o.id)).map((x) => valueOf(x.score))), effort: median(scoredList.filter((x) => inScopeIds.has(x.o.id)).map((x) => effortOf(x.score))) };

  const all: OpportunityAnalysis[] = scoredList.map((p, idx) => {
    const { o, line, wf, ev, score } = p;
    const deptId = line.departmentId ?? o.departmentId ?? wf?.departmentId ?? null;
    const dept = deptId ? deptById.get(deptId) : undefined;
    const steps: WorkflowStep[] = wf?.steps ?? [];
    const appCounts = new Map<string, number>(); for (const s of steps) appCounts.set(s.app, (appCounts.get(s.app) ?? 0) + 1);
    const template = recommendTemplate({ recommendedAgentCategory: o.recommendedAgentCategory, title: o.title, type: o.type }, wf ? { steps, name: wf.name } : null);
    const hourly = num(findNode(line.tree, "Average loaded hourly cost")?.value);
    const hourlyNode = findNode(line.tree, "Average loaded hourly cost");
    const hoursNode = findNode(line.tree, "Observed workflow hours per week");
    const currentCost = line.hoursPerWeek * weeks * hourly;
    const regulatory = [o.regulatoryFlag ?? wf?.regulatoryFlag, (o.requiresHumanJudgment || wf?.requiresJudgment) ? "Human judgment required at some steps — keep an approval checkpoint" : null, wf?.duplicateOfWorkflowId ? "Duplicates another workflow — consolidate before automating" : null].filter((x): x is string => !!x);
    const riskDrivers = [o.regulatoryFlag ? `${o.regulatoryFlag}-regulated data` : null, o.requiresHumanJudgment ? "judgment steps" : null, p.peopleAffected > 5 ? `${p.peopleAffected} people affected` : null, num(wf?.handoffCount) > 2 ? `${wf?.handoffCount} handoffs` : null].filter((x): x is string => !!x);
    const difficulty: OpportunityAnswers["difficulty"] = p.complexity >= 0.5 || appCounts.size >= 5 ? { level: "High", reason: `Complexity ${Math.round(p.complexity * 100)}% across ${appCounts.size} apps` }
      : p.complexity >= 0.25 || appCounts.size >= 3 ? { level: "Medium", reason: `Complexity ${Math.round(p.complexity * 100)}% across ${appCounts.size} apps` } : { level: "Low", reason: `Complexity ${Math.round(p.complexity * 100)}% across ${appCounts.size} app${appCounts.size === 1 ? "" : "s"}` };
    const agent = raw.agents.find((a) => a.opportunityId === o.id) ?? null;
    const valueScore = valueOf(score); const effortScore = effortOf(score);
    return {
      id: o.id, title: o.title, summary: o.summary, type: o.type, status: o.status, basis: o.basis, inScope: inScopeIds.has(o.id),
      departmentId: deptId, departmentName: dept?.name ?? line.departmentName ?? null, businessUnitId: dept?.businessUnitId ?? null, locationId: dept?.locationId ?? null,
      workflowId: o.workflowId ?? null, workflowName: wf?.name ?? null, duplicate: !!wf?.duplicateOfWorkflowId, requiresHumanJudgment: o.requiresHumanJudgment, regulatoryFlag: o.regulatoryFlag ?? null,
      agent: agent ? { id: agent.id, name: agent.name, status: agent.status } : null,
      line, complexity: p.complexity, peopleAffected: p.peopleAffected, score,
      answers: {
        currentProcessCost: { value: currentCost, tree: { label: "Current process cost (annual, loaded)", value: currentCost, unit: "usd", basis: hoursNode?.basis ?? "estimated", formula: "observed workflow hrs/wk × working weeks/yr × avg loaded hourly (finance engine inputs)", children: [
          hoursNode ?? { label: "Observed workflow hours per week", value: line.hoursPerWeek, unit: "hours", basis: "estimated" },
          { label: "Working weeks per year", value: weeks, unit: "weeks", basis: "assumed", source: "Financial model assumption" },
          hourlyNode ?? { label: "Average loaded hourly cost", value: hourly, unit: "usd", basis: "estimated" },
        ] } },
        hoursPerWeek: line.hoursPerWeek, runsPerWeek: num(wf?.runsPerWeek), avgDurationMin: num(wf?.avgDurationMin), manualSteps: wf?.isManual === false ? 0 : steps.length, automationPct: line.automationPct, feasibility: line.feasibility,
        integrations: [...appCounts.entries()].map(([app, n]) => ({ app, steps: n })).sort((a, b) => b.steps - a.steps),
        requiredCredentials: template.requiredCredentials.map((c) => ({ provider: c.provider, label: c.label })),
        difficulty, implementationCost: line.implementationCost, recurringCost: line.annualOperatingCost, annualHoursSaved: line.hoursRecoverablePerWeek * weeks,
        realizableAnnual: line.realizableAnnualSavings, grossAnnual: line.grossAnnualSavings, netAnnual: line.netAnnualSavings, roi1y: line.roi1y,
        operationalRisk: { score: line.risk, level: riskBucket(line.risk), drivers: riskDrivers },
        regulatory,
        recommendedSolution: { key: template.key, name: template.name, description: template.description, category: template.category, monthlyCost: template.monthlyCost, runtime: template.runtime },
        paybackMonths: line.paybackMonths, confidence: score.confidence.level, priorityRank: idx + 1,
      },
      riskBucket: riskBucket(line.risk), valueScore, effortScore, quadrant: quadrantOf(valueScore, effortScore, splits.value, splits.effort),
      evidence: { sampleSize: ev.sampleSize ?? 0, observedFrom: ev.observedFrom ?? "", observedTo: ev.observedTo ?? "", eventIds: (ev.eventIds ?? []).slice(0, 50), notes: ev.notes ?? [], performers: p.perf.length, performersWithCollector: p.withCollector },
    };
  });

  return {
    fin, all, filtered: all.filter((a) => matchesFilters(a, filters)), splits,
    options: { departments: raw.departments, businessUnits: raw.bus, locations: raw.locs }, weeksPerYear: weeks,
  };
}

/** Sample activity events for an opportunity's evidence panel (metadata only — never content). */
export async function sampleEvidenceEvents(orgId: string, eventIds: number[], limit = 8) {
  if (!eventIds.length) return [];
  return withTenant(orgId, (tx) => tx.select({ id: schema.activityEvents.id, ts: schema.activityEvents.ts, type: schema.activityEvents.type, app: schema.activityEvents.app, titleCategory: schema.activityEvents.titleCategory, durationMs: schema.activityEvents.durationMs })
    .from(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, orgId), inArray(schema.activityEvents.id, eventIds.slice(0, limit)))));
}
