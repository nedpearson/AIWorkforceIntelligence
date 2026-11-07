/**
 * AI employee financials — single source for every number shown on "Review my savings".
 *
 * Sources (never sandbox): live skill_runs + runs of the linked agent (agent_runs) + approved, in-effect savings ledger
 * entries linked to the employee's agent/opportunity + the finance engine (loaded hourly, opportunity line).
 *  - verified hours recovered  = Σ live succeeded runs (manual baseline − human review) + Σ linked agent runs minutesSaved   [observed]
 *  - capacity value            = verified hours × loaded hourly (finance engine)  — CAPACITY, not cash                  [observed × observed/assumed]
 *  - hard savings              = approved realized_hard + cost_avoidance ledger entries (annual, prorated to the period)  [observed]
 *  - AI operating cost         = linked agent monthlyCost × months + Σ skill unit costs (all runs, incl. sandbox)          [assumed]
 *  - net capacity benefit      = capacity value − operating cost;  ROI = net ÷ operating cost
 */
import { and, eq, gte, inArray, lt, or } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import type { CalcTree } from "@/db/schema";
import { num } from "@/lib/utils";
import { computeOrgFinancials } from "@/engine/finance";
import type { OrgFinancials, OpportunityLine } from "@/engine/finance.types";
import { listSkillInfo } from "./skills-adapter";

export type Range = { from: Date; to: Date };
export type MonthRow = {
  month: string; tasksCompleted: number; liveRuns: number; sandboxRuns: number; manualBaselineHours: number; automatedHours: number; humanReviewHours: number;
  agentRunHours: number; verifiedHoursRecovered: number; capacityValue: number; operatingCost: number;
};
export type EmployeeFinancialsResult = {
  aiEmployeeId: string; range: { from: string; to: string }; loadedHourly: number; loadedHourlyBasis: "observed" | "assumed"; loadedHourlySource: string;
  months: MonthRow[];
  totals: {
    tasksCompleted: number; liveRuns: number; sandboxRuns: number; reviewedRuns: number; manualBaselineHours: number; automatedHours: number; humanReviewHours: number;
    verifiedHoursRecovered: number; capacityValue: number; hardSavingsAnnual: number; hardSavingsPeriod: number; operatingCost: number;
    netBenefit: number; roi: number | null; costPerTask: number | null; accuracy: number | null; interventionRate: number | null;
  };
  trees: Record<"tasks" | "verifiedHours" | "capacityValue" | "hardSavings" | "operatingCost" | "netBenefit" | "roi" | "costPerTask" | "accuracy" | "interventionRate", CalcTree>;
  beforeAfter: null | {
    workflowId: string; workflowName: string; runsPerWeek: number; manualHoursPerWeek: number; projectedAfterHoursPerWeek: number; observedAfterHoursPerWeek: number | null;
    observedBasisRuns: number; automationPct: number; tree: CalcTree;
  };
  opportunity: null | { id: string; title: string; realizableAnnualSavings: number; hoursRecoverablePerWeek: number; tree: CalcTree };
  notes: string[];
};

const H = (min: number) => min / 60;
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
function monthsBetween(r: Range): string[] {
  const out: string[] = []; const d = new Date(Date.UTC(r.from.getUTCFullYear(), r.from.getUTCMonth(), 1));
  while (d <= r.to && out.length < 60) { out.push(monthKey(d)); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}
const daysIn = (r: Range) => Math.max(0, (+r.to - +r.from) / 86_400_000);

/** Hours-weighted loaded hourly of the workflow's performers; org-wide hours-weighted average otherwise. */
export function loadedHourlyFor(fin: OrgFinancials, workflowId: string | null): { value: number; basis: "observed" | "assumed"; source: string } {
  const pick = (rows: OrgFinancials["byEmployee"]) => {
    const w = rows.reduce((s, e) => s + (e.hoursPerWeek || 0), 0);
    return w > 0 ? rows.reduce((s, e) => s + e.loadedHourly * (e.hoursPerWeek || 0), 0) / w : rows.length ? rows.reduce((s, e) => s + e.loadedHourly, 0) / rows.length : 0;
  };
  if (workflowId) {
    const perf = fin.byEmployee.filter((e) => e.topWorkflows.some((t) => t.workflowId === workflowId));
    if (perf.length) return { value: pick(perf), basis: perf.every((e) => e.costBasis === "observed") ? "observed" : "assumed", source: `hours-weighted loaded hourly of ${perf.length} observed performer(s) of the workflow (finance engine)` };
  }
  return { value: pick(fin.byEmployee), basis: "assumed", source: `hours-weighted loaded hourly across ${fin.byEmployee.length} analyzed employee(s) (finance engine)` };
}

export async function employeeFinancials(orgId: string, aiEmployeeId: string, range: Range, deps: { fin?: OrgFinancials } = {}): Promise<EmployeeFinancialsResult> {
  const fin = deps.fin ?? (await computeOrgFinancials(orgId));
  const infos = await listSkillInfo();
  const unitCost = new Map((infos ?? []).map((s) => [s.key, s.unitCost ?? 0]));
  const d = await withTenant(orgId, async (tx) => {
    const [emp] = await tx.select().from(schema.aiEmployees).where(and(eq(schema.aiEmployees.orgId, orgId), eq(schema.aiEmployees.id, aiEmployeeId))).limit(1);
    if (!emp) throw new Error("AI employee not found");
    const runs = await tx.select().from(schema.skillRuns).where(and(eq(schema.skillRuns.orgId, orgId), eq(schema.skillRuns.aiEmployeeId, aiEmployeeId), gte(schema.skillRuns.createdAt, range.from), lt(schema.skillRuns.createdAt, range.to)));
    const [agent] = emp.agentId ? await tx.select().from(schema.agents).where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, emp.agentId))).limit(1) : [];
    const agentRuns = agent ? await tx.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.agentId, agent.id), eq(schema.agentRuns.status, "succeeded"), gte(schema.agentRuns.createdAt, range.from), lt(schema.agentRuns.createdAt, range.to))) : [];
    // agent runs written by the skills engine mirror a live skill run (trigger "skill") — counted once, via skill_runs
    const agentRunsOwn = agentRuns.filter((r) => r.trigger !== "skill");
    const oppId = emp.opportunityId ?? agent?.opportunityId ?? null;
    const [opp] = oppId ? await tx.select().from(schema.opportunities).where(and(eq(schema.opportunities.orgId, orgId), eq(schema.opportunities.id, oppId))).limit(1) : [];
    const wfId = opp?.workflowId ?? agent?.workflowId ?? null;
    const [wf] = wfId ? await tx.select().from(schema.workflows).where(and(eq(schema.workflows.orgId, orgId), eq(schema.workflows.id, wfId))).limit(1) : [];
    const links = [emp.agentId ? eq(schema.savingsLedger.agentId, emp.agentId) : null, oppId ? eq(schema.savingsLedger.opportunityId, oppId) : null].filter((x): x is NonNullable<typeof x> => !!x);
    const ledger = links.length ? await tx.select().from(schema.savingsLedger).where(and(eq(schema.savingsLedger.orgId, orgId), eq(schema.savingsLedger.status, "approved"), inArray(schema.savingsLedger.tier, ["realized_hard", "cost_avoidance"]), links.length > 1 ? or(...links) : links[0])) : [];
    return { emp, runs: runs.filter((r) => !(r.output as Record<string, unknown>)?.blocked), blocked: runs.filter((r) => !!(r.output as Record<string, unknown>)?.blocked).length, agent, agentRuns: agentRunsOwn, opp, wf, ledger };
  });

  const line: OpportunityLine | undefined = d.opp ? fin.opportunities.find((o) => o.id === d.opp!.id) : undefined;
  const lh = loadedHourlyFor(fin, d.wf?.id ?? null);
  const live = d.runs.filter((r) => r.mode === "live");
  const sandbox = d.runs.filter((r) => r.mode === "sandbox");
  const liveOk = live.filter((r) => r.status === "succeeded" && r.reviewStatus !== "rejected");
  const recovered = (r: (typeof d.runs)[number]) => Math.max(0, H(num(r.manualBaselineMinutes)) - H(num(r.humanReviewMinutes)));
  const months = monthsBetween(range);
  const monthsCount = Math.max(daysIn(range) / (365 / 12), 0);
  const agentMonthly = num(d.agent?.monthlyCost);

  const rows: MonthRow[] = months.map((m) => {
    const inM = <T extends { createdAt: Date }>(xs: T[]) => xs.filter((x) => monthKey(x.createdAt) === m);
    const ok = inM(liveOk); const ar = inM(d.agentRuns);
    const agentRunHours = ar.reduce((s, r) => s + H(num(r.minutesSaved)), 0);
    const verified = ok.reduce((s, r) => s + recovered(r), 0) + agentRunHours;
    // agent subscription cost for the part of this month inside the range
    const [y, mo] = m.split("-").map(Number); const ms = new Date(Date.UTC(y, mo - 1, 1)); const me = new Date(Date.UTC(y, mo, 1));
    const overlap = Math.max(0, (Math.min(+me, +range.to) - Math.max(+ms, +range.from)) / (+me - +ms));
    const unit = inM(d.runs).reduce((s, r) => s + (unitCost.get(r.skillKey) ?? 0), 0);
    return {
      month: m, tasksCompleted: ok.length, liveRuns: inM(live).length, sandboxRuns: inM(sandbox).length,
      manualBaselineHours: ok.reduce((s, r) => s + H(num(r.manualBaselineMinutes)), 0), automatedHours: ok.reduce((s, r) => s + r.durationMs / 3_600_000, 0),
      humanReviewHours: inM(live).reduce((s, r) => s + H(num(r.humanReviewMinutes)), 0) + ar.reduce((s, r) => s + H(num(r.humanMinutes)), 0),
      agentRunHours, verifiedHoursRecovered: verified, capacityValue: verified * lh.value, operatingCost: agentMonthly * overlap + unit,
    };
  });
  const sum = (k: keyof MonthRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
  const verifiedHours = sum("verifiedHoursRecovered");
  const capacityValue = verifiedHours * lh.value;
  // de-dup ledger by tier + dedupeKey, newest approved wins; only in-effect entries (same rule as the savings engine)
  const now = Date.now();
  const inEffect = d.ledger.filter((r) => +new Date(r.effectiveFrom) <= now && (!r.effectiveTo || +new Date(r.effectiveTo) >= now));
  const dd = new Map<string, (typeof inEffect)[number]>();
  for (const r of inEffect.sort((a, b) => +new Date(b.approvedAt ?? b.createdAt) - +new Date(a.approvedAt ?? a.createdAt))) { const k = `${r.tier}:${r.dedupeKey}`; if (!dd.has(k)) dd.set(k, r); }
  const ledgerRows = [...dd.values()];
  const hardAnnual = ledgerRows.reduce((s, r) => s + num(r.annualAmount), 0);
  const periodShare = (r: (typeof ledgerRows)[number]) => {
    const s = Math.max(+range.from, +new Date(r.effectiveFrom)); const e = Math.min(+range.to, r.effectiveTo ? +new Date(r.effectiveTo) : +range.to);
    return Math.max(0, (e - s) / 86_400_000) / 365;
  };
  const hardPeriod = ledgerRows.reduce((s, r) => s + num(r.annualAmount) * periodShare(r), 0);
  const unitTotal = d.runs.reduce((s, r) => s + (unitCost.get(r.skillKey) ?? 0), 0);
  const operatingCost = agentMonthly * monthsCount + unitTotal;
  const netBenefit = capacityValue - operatingCost;
  const roi = operatingCost > 0 && d.runs.some((r) => r.mode === "live") ? netBenefit / operatingCost : null; // undefined until there is live work
  const tasks = liveOk.length;
  const reviewed = live.filter((r) => r.reviewStatus);
  const accepted = reviewed.filter((r) => r.reviewStatus === "accepted");
  const interventions = live.filter((r) => r.reviewStatus === "corrected" || r.status === "awaiting_approval" || r.steps.some((s) => s.status === "awaiting_approval" || s.key.startsWith("approval")));
  const label = d.emp.firstName;

  const tree = {
    tasks: { label: "Tasks completed (live)", value: tasks, unit: "tasks", basis: "observed", formula: "count of live skill runs with status succeeded and not rejected in review", source: `skill_runs · ${live.length} live, ${sandbox.length} sandbox (sandbox excluded)` },
    verifiedHours: { label: "Verified hours recovered", value: verifiedHours, unit: "hours", basis: "observed", formula: "Σ live runs (manual baseline − human review) + Σ linked agent runs minutes saved", children: [
      { label: "Live skill runs: manual baseline", value: rows.reduce((s, r) => s + r.manualBaselineHours, 0), unit: "hours", basis: "assumed", source: "skill definition manualBaselineMinutes (documented assumption per execution)" },
      { label: "Live skill runs: human review time", value: liveOk.reduce((s, r) => s + H(num(r.humanReviewMinutes)), 0), unit: "hours", basis: "observed", source: "skill_runs.human_review_minutes" },
      { label: "Linked agent runs: minutes saved", value: sum("agentRunHours"), unit: "hours", basis: "observed", source: d.agent ? `agent_runs of ${d.agent.name} (${d.agentRuns.length} succeeded)` : "no agent linked" },
    ] },
    capacityValue: { label: "Capacity value (not cash)", value: capacityValue, unit: "usd", basis: "observed", formula: "verified hours × loaded hourly", children: [
      { label: "Verified hours recovered", value: verifiedHours, unit: "hours", basis: "observed" },
      { label: "Loaded hourly", value: lh.value, unit: "usd", basis: lh.basis, source: lh.source },
    ] },
    hardSavings: { label: "Attributable hard savings (annual)", value: hardAnnual, unit: "usd", basis: "observed", formula: "Σ approved, in-effect realized-hard + cost-avoidance ledger entries linked to this employee's agent/opportunity (de-duplicated)", source: "Savings Intelligence Engine ledger", children: ledgerRows.map((r) => ({ label: `${r.title} (${r.tier.replace("_", " ")})`, value: num(r.annualAmount), unit: "usd", basis: r.basis, source: `in this period: ${Math.round(num(r.annualAmount) * periodShare(r)).toLocaleString("en-US")} USD` })) },
    operatingCost: { label: "AI operating cost", value: operatingCost, unit: "usd", basis: "assumed", formula: "agent monthly cost × months in range + Σ skill unit costs (all runs)", children: [
      { label: "Linked agent monthly cost", value: agentMonthly, unit: "usd", basis: "assumed", source: d.agent ? `agents.monthly_cost (${d.agent.name})` : "no agent linked" },
      { label: "Months in range", value: monthsCount, unit: "months", basis: "observed" },
      { label: "Skill unit costs", value: unitTotal, unit: "usd", basis: "assumed", source: infos ? `${d.runs.length} runs × unit cost from the skills engine` : "skills engine unavailable — unit costs not included" },
    ] },
    netBenefit: { label: "Net capacity benefit", value: netBenefit, unit: "usd", basis: "observed", formula: "capacity value − AI operating cost (capacity, not cash; hard savings shown separately)", children: [] as CalcTree[] },
    roi: { label: "ROI (capacity basis)", value: roi ?? 0, unit: "pct", basis: "observed", formula: roi == null ? "no live work or no operating cost yet — ROI undefined" : "net capacity benefit ÷ AI operating cost" },
    costPerTask: { label: "Cost per task", value: tasks ? operatingCost / tasks : 0, unit: "usd", basis: "assumed", formula: tasks ? "AI operating cost ÷ tasks completed" : "no live tasks completed yet" },
    accuracy: { label: "Accuracy", value: reviewed.length ? accepted.length / reviewed.length : 0, unit: "pct", basis: "observed", formula: `accepted ÷ reviewed live runs (${accepted.length} ÷ ${reviewed.length})` },
    interventionRate: { label: "Human intervention rate", value: live.length ? interventions.length / live.length : 0, unit: "pct", basis: "observed", formula: `(approvals + corrections) ÷ live runs (${interventions.length} ÷ ${live.length})` },
  } satisfies Record<string, CalcTree>;
  tree.netBenefit.children = [tree.capacityValue, tree.operatingCost];

  let beforeAfter: EmployeeFinancialsResult["beforeAfter"] = null;
  if (d.wf) {
    const manual = num(d.wf.hoursPerWeek); const runsPw = num(d.wf.runsPerWeek); const pct = line?.automationPct ?? num(d.opp?.automationPct);
    const projectedAfter = manual * (1 - pct);
    const reviewPerRun = liveOk.length ? liveOk.reduce((s, r) => s + H(num(r.humanReviewMinutes)), 0) / liveOk.length : null;
    const observedAfter = reviewPerRun == null ? null : reviewPerRun * runsPw;
    beforeAfter = { workflowId: d.wf.id, workflowName: d.wf.name, runsPerWeek: runsPw, manualHoursPerWeek: manual, projectedAfterHoursPerWeek: projectedAfter, observedAfterHoursPerWeek: observedAfter, observedBasisRuns: liveOk.length, automationPct: pct,
      tree: { label: `Before/after — ${d.wf.name}`, value: manual - (observedAfter ?? projectedAfter), unit: "hours", basis: observedAfter == null ? "estimated" : "observed", formula: "observed manual hours/week − hours/week after automation", children: [
        { label: "Observed manual hours/week", value: manual, unit: "hours", basis: d.wf.basis, source: `workflows (${d.wf.evidence?.sampleSize ?? 0} sampled runs)` },
        { label: "Projected after (manual × (1 − automation %))", value: projectedAfter, unit: "hours", basis: "estimated", source: `automation ${(pct * 100).toFixed(0)}% from the opportunity / finance engine` },
        ...(observedAfter == null ? [] : [{ label: "Observed after (avg human review per live run × runs/week)", value: observedAfter, unit: "hours", basis: "observed" as const, source: `${liveOk.length} live runs` }]),
      ] } };
  }
  const notes: string[] = [];
  if (!live.length) notes.push(`${label} has no live runs in this period — sandbox demonstrations never count toward savings.`);
  if (!d.agent) notes.push("No executable agent is linked, so agent subscription cost and agent-run savings are not included.");
  if (d.blocked) notes.push(`${d.blocked} run request(s) were blocked by policy (status, permission, budget or input) and are excluded.`);
  if (!infos) notes.push("Skills engine unavailable: skill unit costs could not be read.");
  return {
    aiEmployeeId, range: { from: range.from.toISOString(), to: range.to.toISOString() }, loadedHourly: lh.value, loadedHourlyBasis: lh.basis, loadedHourlySource: lh.source, months: rows,
    totals: { tasksCompleted: tasks, liveRuns: live.length, sandboxRuns: sandbox.length, reviewedRuns: reviewed.length, manualBaselineHours: sum("manualBaselineHours"), automatedHours: sum("automatedHours"), humanReviewHours: sum("humanReviewHours"),
      verifiedHoursRecovered: verifiedHours, capacityValue, hardSavingsAnnual: hardAnnual, hardSavingsPeriod: hardPeriod, operatingCost, netBenefit, roi, costPerTask: tasks ? operatingCost / tasks : null,
      accuracy: reviewed.length ? accepted.length / reviewed.length : null, interventionRate: live.length ? interventions.length / live.length : null },
    trees: tree, beforeAfter,
    opportunity: line ? { id: line.id, title: line.title, realizableAnnualSavings: line.realizableAnnualSavings, hoursRecoverablePerWeek: line.hoursRecoverablePerWeek, tree: line.tree } : null,
    notes,
  };
}

/** Default range: the last 6 calendar months up to now. */
export function defaultRange(now = new Date()): Range {
  return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)), to: now };
}
