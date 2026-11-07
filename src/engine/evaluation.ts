/**
 * Business Evaluation engine — live 16-step evaluation workflow + Company Transformation Score.
 *
 * Everything is computed from tenant data on every call (nothing cached, nothing invented). Each of the nine score
 * dimensions returns its actual inputs, the formula used, a confidence derived from evidence volume, and the list of
 * evidence that is missing. A dimension with no usable data scores `null` and is excluded from the composite
 * (remaining weights are re-normalized and the exclusion is reported).
 */
import { and, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { computeOrgFinancials } from "./finance";
import { computeSavingsIntelligence } from "./savings";

const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

export type EvalStep = { key: string; idx: number; title: string; body: string; done: boolean; evidence: string; href: string; cta: string };
export type Confidence = { level: "high" | "medium" | "low" | "none"; value: number; basis: string };
export type DimensionKey = "automationReadiness" | "operationalEfficiency" | "dataMaturity" | "aiAdoption" | "processStandardization" | "financialOpportunity" | "technologyReadiness" | "integrationComplexity" | "implementationRisk";
export type Dimension = {
  key: DimensionKey; label: string; description: string; score: number | null; weight: number;
  inputs: { label: string; value: number | string; unit?: string }[]; methodology: string; confidence: Confidence; missingEvidence: string[]; href: string;
};
export type EvaluationSnapshot = {
  computedAt: string; score: number | null; dimensions: Record<DimensionKey, number | null>; stepsDone: number; stepsTotal: number;
  savings: { potential: number; approved: number; verified: number; realizedHard: number; costAvoidance: number; net: number };
  hours: { recoverablePerWeek: number; verifiedPerYear: number; capacityPerYear: number };
};
export type Evaluation = {
  orgId: string; computedAt: string; steps: EvalStep[]; progressPct: number;
  score: number | null; scoreMethodology: string; excluded: DimensionKey[];
  dimensions: Dimension[]; snapshot: EvaluationSnapshot;
};

export const DIMENSION_WEIGHTS: Record<DimensionKey, number> = {
  automationReadiness: 0.15, financialOpportunity: 0.15, operationalEfficiency: 0.1, dataMaturity: 0.1, aiAdoption: 0.1,
  processStandardization: 0.1, technologyReadiness: 0.1, integrationComplexity: 0.1, implementationRisk: 0.1,
};

/** Confidence from evidence volume: n = number of independent records behind the dimension. */
export function confidenceFrom(n: number, highAt: number, medAt: number, what: string): Confidence {
  if (n <= 0) return { level: "none", value: 0, basis: `No ${what}` };
  const level = n >= highAt ? "high" : n >= medAt ? "medium" : "low";
  return { level, value: clamp(n / highAt, 0, 1), basis: `${n.toLocaleString()} ${what}` };
}

/** Weighted composite over non-null dimensions; weights re-normalized. */
export function compositeScore(dims: { score: number | null; weight: number }[]): number | null {
  const used = dims.filter((d) => d.score != null);
  const w = sum(used.map((d) => d.weight));
  if (!used.length || w <= 0) return null;
  return sum(used.map((d) => (d.score as number) * d.weight)) / w;
}

export async function computeEvaluation(orgId: string): Promise<Evaluation> {
  const [fin, si, d] = await Promise.all([
    computeOrgFinancials(orgId),
    computeSavingsIntelligence(orgId),
    withTenant(orgId, async (tx) => {
      const o = (col: AnyPgColumn) => eq(col, orgId);
      const count = async (q: Promise<{ n: string | number }[]>) => num((await q)[0]?.n);
      const [org, depts, employees, bus, locs, integrations, collectors, workflows, opps, agents, measurements, projects, reports, evaluations, ledgerApproved, events] = await Promise.all([
        tx.select({ name: schema.organizations.name, industry: schema.organizations.industry, timezone: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1),
        tx.select({ id: schema.departments.id, overhead: schema.departments.annualOverhead }).from(schema.departments).where(o(schema.departments.orgId)),
        tx.select({ id: schema.employees.id, base: schema.employees.baseAnnualCost, hourly: schema.employees.loadedHourlyCost, basis: schema.employees.costBasis }).from(schema.employees).where(and(o(schema.employees.orgId), eq(schema.employees.isActive, true))),
        count(tx.select({ n: sql<string>`count(*)` }).from(schema.businessUnits).where(o(schema.businessUnits.orgId))),
        count(tx.select({ n: sql<string>`count(*)` }).from(schema.locations).where(o(schema.locations.orgId))),
        tx.select({ provider: schema.integrations.provider, status: schema.integrations.status }).from(schema.integrations).where(o(schema.integrations.orgId)),
        tx.select({ status: schema.collectors.status }).from(schema.collectors).where(o(schema.collectors.orgId)),
        tx.select({ id: schema.workflows.id, hours: schema.workflows.hoursPerWeek, automation: schema.workflows.automationScore, repetition: schema.workflows.repetitionScore, rework: schema.workflows.reworkRate, handoffs: schema.workflows.handoffCount, dup: schema.workflows.duplicateOfWorkflowId, basis: schema.workflows.basis, steps: schema.workflows.steps }).from(schema.workflows).where(o(schema.workflows.orgId)),
        tx.select({ id: schema.opportunities.id, status: schema.opportunities.status, risk: schema.opportunities.risk, realizable: schema.opportunities.realizableAnnualSavings, agentCat: schema.opportunities.recommendedAgentCategory, type: schema.opportunities.type, flag: schema.opportunities.regulatoryFlag }).from(schema.opportunities).where(o(schema.opportunities.orgId)),
        tx.select({ id: schema.agents.id, status: schema.agents.status }).from(schema.agents).where(o(schema.agents.orgId)),
        count(tx.select({ n: sql<string>`count(*)` }).from(schema.savingsMeasurements).where(o(schema.savingsMeasurements.orgId))),
        count(tx.select({ n: sql<string>`count(*)` }).from(schema.projects).where(o(schema.projects.orgId))),
        count(tx.select({ n: sql<string>`count(*)` }).from(schema.reports).where(o(schema.reports.orgId))),
        tx.select({ status: schema.evaluations.status }).from(schema.evaluations).where(o(schema.evaluations.orgId)),
        count(tx.select({ n: sql<string>`count(*)` }).from(schema.savingsLedger).where(and(o(schema.savingsLedger.orgId), eq(schema.savingsLedger.status, "approved")))),
        count(tx.select({ n: sql<string>`count(*)` }).from(schema.activityEvents).where(eq(schema.activityEvents.orgId, orgId))),
      ]);
      return { org: org[0], depts, employees, bus, locs, integrations, collectors, workflows, opps, agents, measurements, projects, reports, evaluations, ledgerApproved, events };
    }),
  ]);

  // ---------------- 16-step workflow ----------------
  const emp = d.employees.length; const costed = d.employees.filter((e) => num(e.base) > 0 || num(e.hourly) > 0).length;
  const overheadDepts = d.depts.filter((x) => x.overhead != null).length;
  const connected = d.integrations.filter((i) => i.status === "connected").length;
  const collectorsActive = d.collectors.filter((c) => c.status === "active").length;
  const repetitiveWfs = d.workflows.filter((w) => num(w.repetition) >= 50 || num(w.rework) > 0.05 || w.dup).length;
  const liveOpps = d.opps.filter((o) => o.status !== "rejected");
  const recommended = liveOpps.filter((o) => o.agentCat || o.type === "ai_agent" || o.type === "rpa").length;
  const approvedOpps = d.opps.filter((o) => ["approved", "in_progress", "deployed", "verified"].includes(o.status)).length;
  const deployed = d.agents.filter((a) => a.status === "deployed").length;
  const presented = d.evaluations.filter((e) => e.status === "presented" || e.status === "approved").length;
  const step = (idx: number, key: string, title: string, body: string, done: boolean, evidence: string, href: string, cta: string): EvalStep => ({ idx, key, title, body, done, evidence, href, cta });
  const steps: EvalStep[] = [
    step(1, "profile", "Company profile", "Name, industry and time zone so benchmarks and reports are framed correctly.", !!d.org?.industry, d.org?.industry ? `Industry: ${d.org.industry}` : "Industry not set", "/app/settings", "Edit profile"),
    step(2, "structure", "Organization structure imported", "Departments and employees (business units and locations optional).", d.depts.length > 0 && emp > 0, `${d.depts.length} departments · ${emp} employees · ${d.bus} business units · ${d.locs} locations`, "/app/settings/structure", "Import structure"),
    step(3, "systems", "Systems connected", "At least one business system integration connected.", connected > 0, `${connected} of ${d.integrations.length} integrations connected`, "/app/integrations", "Connect systems"),
    step(4, "financials", "Financial information", "Employee compensation for loaded-cost math, plus department overhead.", emp > 0 && costed > 0 && overheadDepts > 0, `${costed} of ${emp} employees with cost data · ${overheadDepts} of ${d.depts.length} departments with overhead`, "/app/employees", "Add cost data"),
    step(5, "collectors", "Collectors deployed", "Desktop collectors active (metadata only, never content).", collectorsActive > 0, `${collectorsActive} of ${d.collectors.length} collectors active`, "/app/collection?tab=collectors", "Deploy collectors"),
    step(6, "workflows", "Workflows analyzed", "Raw activity turned into discovered workflows.", d.workflows.length > 0, `${d.workflows.length} workflows from ${d.events.toLocaleString()} events`, "/app/workflows", "Run analysis"),
    step(7, "inefficiencies", "Inefficiencies identified", "Repetitive, reworked or duplicated workflows flagged.", repetitiveWfs > 0, `${repetitiveWfs} workflows flagged (repetition ≥ 50, rework > 5% or duplicate)`, "/app/workflows", "Review workflows"),
    step(8, "potential", "Automation potential calculated", "Opportunities scored for feasibility, risk and recoverable hours.", liveOpps.length > 0, `${liveOpps.length} opportunities · ${fin.hoursRecoverablePerWeek.toFixed(0)} hrs/wk recoverable`, "/app/opportunities", "Open opportunities"),
    step(9, "agents_recommended", "AI agents recommended", "Opportunities with a recommended agent or bot type.", recommended > 0, `${recommended} opportunities with an agent/bot recommendation`, "/app/opportunities", "See recommendations"),
    step(10, "savings", "Savings estimated", "Realizable annual savings computed by the finance engine.", si.tiers.potential.amount > 0, `Potential ${Math.round(si.tiers.potential.amount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}/yr`, "/app/savings", "Open savings"),
    step(11, "roadmap", "Roadmap developed", "Transformation projects planned from approved opportunities.", d.projects > 0, `${d.projects} transformation projects`, "/app/roadmap", "Build roadmap"),
    step(12, "report", "Executive report generated", "An executive ROI report has been generated.", d.reports > 0, `${d.reports} reports generated`, "/app/reports", "Generate report"),
    step(13, "presented", "Findings presented", "An evaluation snapshot marked as presented to leadership.", presented > 0, `${presented} evaluation snapshot(s) presented or approved`, "/present", "Present findings"),
    step(14, "approved", "Initiatives approved", "Leadership approved opportunities or finance approved a ledger entry.", approvedOpps > 0 || d.ledgerApproved > 0, `${approvedOpps} opportunities approved · ${d.ledgerApproved} approved ledger entries`, "/app/opportunities", "Approve initiatives"),
    step(15, "deployed", "Automation deployed", "At least one AI agent or automation is live.", deployed > 0, `${deployed} deployed agents`, "/app/agents", "Deploy an agent"),
    step(16, "measured", "Results measured", "Post-deployment savings measured (verified, not projected).", d.measurements > 0, `${d.measurements} savings measurements`, "/app/agents", "Record a measurement"),
  ];
  const progressPct = (steps.filter((s) => s.done).length / steps.length) * 100;

  // ---------------- dimensions ----------------
  const wfHours = sum(d.workflows.map((w) => num(w.hours)));
  const hw = (pick: (w: (typeof d.workflows)[number]) => number) => (wfHours > 0 ? sum(d.workflows.map((w) => pick(w) * num(w.hours))) / wfHours : 0);
  const wfConf = confidenceFrom(d.workflows.length, 10, 3, "discovered workflows");
  const noWf = d.workflows.length === 0 ? ["No discovered workflows — run an observation campaign and the analysis"] : [];
  const dims: Dimension[] = [];
  const push = (x: Omit<Dimension, "weight">) => dims.push({ ...x, score: x.score == null ? null : clamp(x.score), weight: DIMENSION_WEIGHTS[x.key] });

  // 1. automation readiness
  const avgAuto = hw((w) => num(w.automation));
  push({ key: "automationReadiness", label: "Automation readiness", description: "How much of the observed work is structured enough for software to do.", href: "/app/workflows",
    score: d.workflows.length ? avgAuto : null, inputs: [{ label: "Hours-weighted automation score", value: Number(avgAuto.toFixed(1)), unit: "/100" }, { label: "Workflows", value: d.workflows.length }, { label: "Observed workflow hours/week", value: Number(wfHours.toFixed(1)), unit: "hrs" }],
    methodology: "Σ(workflow automation score × workflow hrs/wk) ÷ Σ workflow hrs/wk", confidence: wfConf, missingEvidence: noWf });

  // 2. operational efficiency
  const rep = fin.repetitiveSharePct; const rework = hw((w) => num(w.rework));
  push({ key: "operationalEfficiency", label: "Operational efficiency", description: "Share of observed time that is not repetitive and not rework. Higher = more efficient today.", href: "/app/process-mining",
    score: fin.hoursObservedPerWeek > 0 ? 100 * (1 - rep) * (1 - rework) : null, inputs: [{ label: "Repetitive share of observed hours", value: Number((rep * 100).toFixed(1)), unit: "%" }, { label: "Hours-weighted rework rate", value: Number((rework * 100).toFixed(1)), unit: "%" }, { label: "Observed hours/week", value: Number(fin.hoursObservedPerWeek.toFixed(1)), unit: "hrs" }],
    methodology: "100 × (1 − repetitive share) × (1 − hours-weighted rework rate)", confidence: wfConf, missingEvidence: noWf });

  // 3. data maturity
  const costShare = emp ? costed / emp : 0; const observedCost = emp ? d.employees.filter((e) => e.basis === "observed").length / emp : 0;
  const observedWf = d.workflows.length ? d.workflows.filter((w) => w.basis === "observed").length / d.workflows.length : 0;
  const dmMissing = [...(emp - costed > 0 ? [`${emp - costed} employees without compensation data`] : []), ...(emp && observedCost < 1 ? [`${emp - d.employees.filter((e) => e.basis === "observed").length} employees with assumed (not observed) cost`] : []), ...(d.depts.length - overheadDepts > 0 ? [`${d.depts.length - overheadDepts} departments without overhead`] : []), ...noWf];
  push({ key: "dataMaturity", label: "Data maturity", description: "How much of the analysis rests on observed rather than assumed data.", href: "/app/employees",
    score: emp || d.workflows.length ? 100 * (0.4 * costShare + 0.3 * observedCost + 0.3 * observedWf) : null,
    inputs: [{ label: "Employees with cost data", value: Number((costShare * 100).toFixed(0)), unit: "%" }, { label: "Employees with observed cost basis", value: Number((observedCost * 100).toFixed(0)), unit: "%" }, { label: "Workflows with observed basis", value: Number((observedWf * 100).toFixed(0)), unit: "%" }],
    methodology: "100 × (0.4 × cost coverage + 0.3 × observed-cost share + 0.3 × observed-workflow share)", confidence: confidenceFrom(emp + d.workflows.length, 30, 10, "employee and workflow records"), missingEvidence: dmMissing });

  // 4. AI adoption
  push({ key: "aiAdoption", label: "AI adoption", description: "How far identified opportunities have been turned into live, measured automation.", href: "/app/agents",
    score: liveOpps.length ? 100 * (0.5 * fin.deploymentCompletionPct + 0.5 * fin.automationCompletionPct) : null,
    inputs: [{ label: "Deployed agents", value: deployed }, { label: "Deployment completion (deployed ÷ opportunities)", value: Number((fin.deploymentCompletionPct * 100).toFixed(0)), unit: "%" }, { label: "Automation completion (verified ÷ potential)", value: Number((fin.automationCompletionPct * 100).toFixed(0)), unit: "%" }],
    methodology: "100 × (0.5 × deployment completion + 0.5 × automation completion)", confidence: confidenceFrom(d.agents.length + d.measurements, 6, 2, "agents and measurements"),
    missingEvidence: [...(deployed === 0 ? ["No deployed agents"] : []), ...(d.measurements === 0 ? ["No savings measurements"] : []), ...(liveOpps.length === 0 ? ["No opportunities"] : [])] });

  // 5. process standardization
  const dupShare = d.workflows.length ? d.workflows.filter((w) => w.dup).length / d.workflows.length : 0;
  const avgHandoffs = hw((w) => num(w.handoffs));
  push({ key: "processStandardization", label: "Process standardization", description: "Fewer duplicate variants and hand-offs means more standard processes.", href: "/app/process-mining",
    score: d.workflows.length ? 100 * (0.6 * (1 - dupShare) + 0.4 * (1 - Math.min(1, avgHandoffs / 6))) : null,
    inputs: [{ label: "Duplicate workflow share", value: Number((dupShare * 100).toFixed(0)), unit: "%" }, { label: "Hours-weighted hand-offs per run", value: Number(avgHandoffs.toFixed(2)) }],
    methodology: "100 × (0.6 × (1 − duplicate share) + 0.4 × (1 − min(1, hand-offs ÷ 6)))", confidence: wfConf, missingEvidence: noWf });

  // 6. financial opportunity
  const ratio = fin.totalAnnualLaborAnalyzed > 0 ? si.tiers.potential.amount / fin.totalAnnualLaborAnalyzed : 0;
  push({ key: "financialOpportunity", label: "Financial opportunity", description: "Size of realizable savings relative to the labor analyzed (20% of labor or more scores 100).", href: "/app/savings",
    score: fin.totalAnnualLaborAnalyzed > 0 ? (ratio / 0.2) * 100 : null,
    inputs: [{ label: "Potential savings (realizable)", value: Math.round(si.tiers.potential.amount), unit: "usd" }, { label: "Annual labor analyzed", value: Math.round(fin.totalAnnualLaborAnalyzed), unit: "usd" }, { label: "Ratio", value: Number((ratio * 100).toFixed(1)), unit: "%" }],
    methodology: "min(100, (realizable potential ÷ labor analyzed) ÷ 0.20 × 100)", confidence: confidenceFrom(liveOpps.length, 8, 3, "opportunities"),
    missingEvidence: [...(fin.totalAnnualLaborAnalyzed <= 0 ? ["No labor cost analyzed (employee compensation + observed activity)"] : []), ...(liveOpps.length === 0 ? ["No opportunities"] : [])] });

  // 7. technology readiness
  const collShare = d.collectors.length ? collectorsActive / d.collectors.length : 0;
  push({ key: "technologyReadiness", label: "Technology readiness", description: "Connected business systems and healthy collectors.", href: "/app/integrations",
    score: d.integrations.length || d.collectors.length ? 50 * Math.min(1, connected / 3) + 50 * collShare : null,
    inputs: [{ label: "Integrations connected", value: connected }, { label: "Integrations configured or pending", value: d.integrations.length }, { label: "Collectors active", value: `${collectorsActive} / ${d.collectors.length}` }],
    methodology: "50 × min(1, connected integrations ÷ 3) + 50 × active collectors ÷ all collectors", confidence: confidenceFrom(d.integrations.length + d.collectors.length, 10, 3, "integration and collector records"),
    missingEvidence: [...(connected === 0 ? ["No business system integration connected"] : []), ...(d.collectors.length === 0 ? ["No collectors enrolled"] : [])] });

  // 8. integration complexity (higher = simpler)
  const appsPerWf = d.workflows.map((w) => new Set((w.steps ?? []).map((s) => s.app)).size || 1);
  const avgApps = appsPerWf.length ? sum(appsPerWf) / appsPerWf.length : 0;
  push({ key: "integrationComplexity", label: "Integration complexity", description: "Fewer applications per workflow means simpler integrations. Higher score = simpler.", href: "/app/workflows",
    score: d.workflows.length ? 100 * (1 - Math.min(1, (avgApps - 1) / 5)) : null,
    inputs: [{ label: "Average distinct applications per workflow", value: Number(avgApps.toFixed(2)) }, { label: "Workflows", value: d.workflows.length }],
    methodology: "100 × (1 − min(1, (avg apps per workflow − 1) ÷ 5))", confidence: wfConf, missingEvidence: noWf });

  // 9. implementation risk (higher = lower risk)
  const realizableTotal = sum(liveOpps.map((o) => num(o.realizable)));
  const avgRisk = realizableTotal > 0 ? sum(liveOpps.map((o) => num(o.risk) * num(o.realizable))) / realizableTotal : liveOpps.length ? sum(liveOpps.map((o) => num(o.risk))) / liveOpps.length : 0;
  const flagged = liveOpps.filter((o) => o.flag).length; const flaggedShare = liveOpps.length ? flagged / liveOpps.length : 0;
  push({ key: "implementationRisk", label: "Implementation risk", description: "Savings-weighted opportunity risk, with a penalty for regulated work. Higher score = lower risk.", href: "/app/risk",
    score: liveOpps.length ? (100 - avgRisk) * (1 - 0.3 * flaggedShare) : null,
    inputs: [{ label: "Savings-weighted opportunity risk", value: Number(avgRisk.toFixed(1)), unit: "/100" }, { label: "Opportunities on regulated workflows", value: `${flagged} / ${liveOpps.length}` }],
    methodology: "(100 − savings-weighted risk) × (1 − 0.3 × regulated share)", confidence: confidenceFrom(liveOpps.length, 8, 3, "opportunities"), missingEvidence: liveOpps.length ? [] : ["No opportunities"] });

  const score = compositeScore(dims);
  const excluded = dims.filter((x) => x.score == null).map((x) => x.key);
  const computedAt = new Date().toISOString();
  const snapshot: EvaluationSnapshot = {
    computedAt, score, dimensions: Object.fromEntries(dims.map((x) => [x.key, x.score])) as Record<DimensionKey, number | null>,
    stepsDone: steps.filter((s) => s.done).length, stepsTotal: steps.length,
    savings: { potential: si.tiers.potential.amount, approved: si.tiers.approved.amount, verified: si.tiers.verifiedTime.amount, realizedHard: si.tiers.realizedHard.amount, costAvoidance: si.tiers.costAvoidance.amount, net: si.tiers.net.amount },
    hours: { recoverablePerWeek: fin.hoursRecoverablePerWeek, verifiedPerYear: si.tiers.verifiedTime.hours ?? 0, capacityPerYear: si.tiers.capacityReleased.hours ?? 0 },
  };
  return {
    orgId, computedAt, steps, progressPct, score, excluded, dimensions: dims, snapshot,
    scoreMethodology: `Weighted mean of the ${dims.length - excluded.length} dimensions with data (weights re-normalized${excluded.length ? `; ${excluded.length} excluded for missing data` : ""}).`,
  };
}

/** Per-dimension delta between two snapshots (b − a). */
export function compareSnapshots(a: EvaluationSnapshot, b: EvaluationSnapshot) {
  const keys = Object.keys(DIMENSION_WEIGHTS) as DimensionKey[];
  const delta = (x: number | null, y: number | null) => (x == null || y == null ? null : y - x);
  return {
    score: delta(a.score, b.score),
    dimensions: Object.fromEntries(keys.map((k) => [k, delta(a.dimensions[k] ?? null, b.dimensions[k] ?? null)])) as Record<DimensionKey, number | null>,
    savings: Object.fromEntries(Object.keys(b.savings).map((k) => [k, (b.savings as Record<string, number>)[k] - ((a.savings as Record<string, number>)[k] ?? 0)])) as EvaluationSnapshot["savings"],
    hours: Object.fromEntries(Object.keys(b.hours).map((k) => [k, (b.hours as Record<string, number>)[k] - ((a.hours as Record<string, number>)[k] ?? 0)])) as EvaluationSnapshot["hours"],
    stepsDone: b.stepsDone - a.stepsDone,
  };
}
