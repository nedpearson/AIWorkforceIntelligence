/**
 * Agent portfolio engine — per-agent operating metrics and ROI for the AI Agent Command Center.
 *
 * Valuation is the finance engine's run-ledger method (src/engine/finance.ts → recordSavingsFromRunLedger), applied
 * live over a window instead of a recorded period:
 *    benefit  = Σ minutes_saved of succeeded, non-test runs ÷ 60 × loaded hourly
 *    loaded hourly = hours-weighted loaded hourly of the linked workflow's performers (workflow_employees), else the
 *                    average across active employees with cost data; employee loaded hourly = loadedHourlyCost(base,
 *                    benefitsLoad, hours/wk, weeks/yr) from costing.ts, falling back to the stored loaded_hourly_cost.
 *    cost     = monthly_cost × months in window (days ÷ (365.25 ÷ 12))
 * Assumptions = defaultAssumptions(org settings) overlaid with the org's default financial model — the same inputs
 * finance.ts uses. finance.ts keeps those helpers private, so the identical formula is mirrored here and the CalcTree
 * says so; a unit test asserts this module and recordSavingsFromRunLedger agree to the cent.
 *
 * Test runs (trigger "test", dry runs) are excluded from every count and dollar here.
 * Basis: run counts and minutes are "observed" (run ledger). Benefit is "estimated" unless every performer's cost is
 * observed — the per-run minutes come from the agent's expectation unless a run overrides them, which is stated.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import type { CalcTree, FinancialAssumptions } from "@/db/schema";
import { num } from "@/lib/utils";
import { DEFAULTS, loadedHourlyCost } from "@/engine/costing";
import { defaultAssumptions } from "@/engine/finance";
import { agentFunction, CATEGORY_LABELS, type AgentCategory, type BusinessFunction } from "./templates";
import { TEST_TRIGGER } from "./runner-constants";
import { nextRun, describeCron, isValidCron } from "./cron";

type Basis = "observed" | "estimated" | "assumed";
const DAYS_PER_YEAR = 365.25;
const MS_PER_DAY = 86_400_000;

export type AgentMetrics = {
  id: string; name: string; status: string; runtime: string; category: string; categoryLabel: string; fn: BusinessFunction; templateKey: string;
  workflows: { id: string; name: string }[]; opportunity: { id: string; title: string } | null;
  runs: number; succeeded: number; failed: number; cancelled: number; awaiting: number; successRate: number | null;
  tasksCompleted: number; humanInterventions: number; humanMinutes: number;
  minutesSaved: number; hoursSaved: number; hourly: number; hourlyBasis: Basis; performers: number;
  benefit: number; operatingCost: number; netBenefit: number; roi: number | null;
  connectedSystems: string[]; lastSuccessAt: string | null; lastRunAt: string | null;
  failures7d: number; consecutiveFailures: number; lastFailedRunId: string | null; lastError: string | null;
  lastTest: { runId: string; status: string; at: string } | null;
  schedule: { cron: string; description: string; nextRunAt: string | null; valid: boolean } | null;
  trees: { benefit: CalcTree; net: CalcTree };
};
export type PortfolioKpis = { activeAgents: number; totalAgents: number; executions: number; succeeded: number; failed: number; successRate: number | null; hoursSaved: number; benefit: number; operatingCost: number; netBenefit: number; trees: { executions: CalcTree; successRate: CalcTree; hoursSaved: CalcTree; netBenefit: CalcTree; activeAgents: CalcTree } };
export type FailureAlert = { agentId: string; agentName: string; failures7d: number; consecutiveFailures: number; lastFailedRunId: string | null; lastError: string | null; lastFailedAt: string | null };
export type Portfolio = { windowDays: number; windowStart: string; windowEnd: string; agents: AgentMetrics[]; kpis: PortfolioKpis; alerts: FailureAlert[]; timezone: string };

/** Loaded hourly for an employee — identical to finance.ts employeeLoadedHourly. */
function employeeHourly(e: typeof schema.employees.$inferSelect, benefitsLoadPct: number, weeks: number): { value: number; basis: Basis } {
  const base = num(e.baseAnnualCost);
  const hpw = num(e.hoursPerWeek) || DEFAULTS.workHoursPerWeek;
  if (base > 0) return { value: loadedHourlyCost(base, benefitsLoadPct, hpw, weeks).value, basis: e.costBasis };
  const stored = num(e.loadedHourlyCost);
  if (stored > 0) return { value: stored, basis: e.costBasis };
  return { value: 0, basis: "assumed" };
}

export async function computeAgentPortfolio(orgId: string, opts: { windowDays?: number; now?: Date } = {}): Promise<Portfolio> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);
  const since7 = new Date(now.getTime() - 7 * MS_PER_DAY);
  const months = windowDays / (DAYS_PER_YEAR / 12);

  const d = await withTenant(orgId, async (tx) => {
    const [org] = await tx.select({ settings: schema.organizations.settings, timezone: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
    const [model] = await tx.select().from(schema.financialModels).where(and(eq(schema.financialModels.orgId, orgId), eq(schema.financialModels.isDefault, true))).limit(1);
    const agents = await tx.select().from(schema.agents).where(eq(schema.agents.orgId, orgId));
    const stats = await tx.select({
      agentId: schema.agentRuns.agentId,
      runs: sql<string>`count(*)`,
      ok: sql<string>`count(*) filter (where ${schema.agentRuns.status} = 'succeeded')`,
      bad: sql<string>`count(*) filter (where ${schema.agentRuns.status} in ('failed','rolled_back'))`,
      cancelled: sql<string>`count(*) filter (where ${schema.agentRuns.status} = 'cancelled')`,
      awaiting: sql<string>`count(*) filter (where ${schema.agentRuns.status} = 'awaiting_approval')`,
      minutes: sql<string>`coalesce(sum(${schema.agentRuns.minutesSaved}) filter (where ${schema.agentRuns.status} = 'succeeded'), 0)`,
      human: sql<string>`coalesce(sum(${schema.agentRuns.humanMinutes}), 0)`,
    }).from(schema.agentRuns).where(and(eq(schema.agentRuns.orgId, orgId), sql`${schema.agentRuns.trigger} <> ${TEST_TRIGGER}`, gte(schema.agentRuns.createdAt, since))).groupBy(schema.agentRuns.agentId);
    const lastOk = await tx.select({ agentId: schema.agentRuns.agentId, at: sql<string | null>`max(coalesce(${schema.agentRuns.finishedAt}, ${schema.agentRuns.createdAt}))` }).from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.status, "succeeded"), sql`${schema.agentRuns.trigger} <> ${TEST_TRIGGER}`)).groupBy(schema.agentRuns.agentId);
    const lastAny = await tx.select({ agentId: schema.agentRuns.agentId, at: sql<string | null>`max(${schema.agentRuns.createdAt})` }).from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, orgId), sql`${schema.agentRuns.trigger} <> ${TEST_TRIGGER}`)).groupBy(schema.agentRuns.agentId);
    // Most recent 20 finished live runs per agent → consecutive failures + 7-day failures.
    const recent = await tx.execute(sql`select agent_id, id, status, error, created_at from (
        select agent_id, id, status, error, created_at, row_number() over (partition by agent_id order by created_at desc) rn
        from agent_runs where org_id = ${orgId} and trigger <> ${TEST_TRIGGER} and status in ('succeeded','failed','rolled_back','cancelled')
      ) x where rn <= 20 order by agent_id, created_at desc`) as unknown as { agent_id: string; id: string; status: string; error: string | null; created_at: string | Date }[];
    const lastTests = await tx.execute(sql`select distinct on (agent_id) agent_id, id, status, created_at from agent_runs where org_id = ${orgId} and trigger = ${TEST_TRIGGER} order by agent_id, created_at desc`) as unknown as { agent_id: string; id: string; status: string; created_at: string | Date }[];
    const interventions = await tx.select({ agentId: schema.approvals.agentId, n: sql<string>`count(*)` }).from(schema.approvals)
      .where(and(eq(schema.approvals.orgId, orgId), inArray(schema.approvals.status, ["approved", "rejected"]), gte(schema.approvals.createdAt, since))).groupBy(schema.approvals.agentId);
    const creds = await tx.select({ id: schema.credentials.id, name: schema.credentials.name, provider: schema.credentials.provider }).from(schema.credentials).where(eq(schema.credentials.orgId, orgId));
    const workflowIds = new Set<string>();
    const oppIds = agents.map((a) => a.opportunityId).filter((x): x is string => !!x);
    const opps = oppIds.length ? await tx.select({ id: schema.opportunities.id, title: schema.opportunities.title, workflowId: schema.opportunities.workflowId }).from(schema.opportunities).where(and(eq(schema.opportunities.orgId, orgId), inArray(schema.opportunities.id, oppIds))) : [];
    for (const a of agents) if (a.workflowId) workflowIds.add(a.workflowId);
    for (const o of opps) if (o.workflowId) workflowIds.add(o.workflowId);
    const wfs = workflowIds.size ? await tx.select({ id: schema.workflows.id, name: schema.workflows.name }).from(schema.workflows).where(and(eq(schema.workflows.orgId, orgId), inArray(schema.workflows.id, [...workflowIds]))) : [];
    const links = workflowIds.size ? await tx.select({ workflowId: schema.workflowEmployees.workflowId, employeeId: schema.workflowEmployees.employeeId, hoursPerWeek: schema.workflowEmployees.hoursPerWeek }).from(schema.workflowEmployees).where(and(eq(schema.workflowEmployees.orgId, orgId), inArray(schema.workflowEmployees.workflowId, [...workflowIds]))) : [];
    const emps = await tx.select().from(schema.employees).where(eq(schema.employees.orgId, orgId));
    return { org, model, agents, stats, lastOk, lastAny, recent, lastTests, interventions, creds, opps, wfs, links, emps };
  });

  const a: FinancialAssumptions = { ...defaultAssumptions(d.org?.settings), ...(d.model?.assumptions ?? {}) };
  const tz = d.org?.timezone ?? "UTC";
  const empById = new Map(d.emps.map((e) => [e.id, e]));
  const costedActive = d.emps.filter((e) => e.isActive).map((e) => employeeHourly(e, a.benefitsLoadPct, a.workWeeksPerYear).value).filter((v) => v > 0);
  const orgAvg = costedActive.length ? costedActive.reduce((s, v) => s + v, 0) / costedActive.length : 0;
  const hourlyFor = (workflowId: string | null): { value: number; basis: Basis; performers: number; source: string } => {
    if (workflowId) {
      let h = 0, w = 0, n = 0, allObs = true;
      for (const l of d.links.filter((x) => x.workflowId === workflowId)) {
        const e = empById.get(l.employeeId); if (!e) continue;
        const eh = employeeHourly(e, a.benefitsLoadPct, a.workWeeksPerYear); if (eh.value <= 0) continue;
        const wt = num(l.hoursPerWeek) || 1; h += eh.value * wt; w += wt; n++; if (eh.basis !== "observed") allObs = false;
      }
      if (w > 0) return { value: h / w, basis: allObs ? "observed" : "estimated", performers: n, source: `Hours-weighted across ${n} performer(s) of the linked workflow` };
    }
    return { value: orgAvg, basis: "estimated", performers: costedActive.length, source: `Average across ${costedActive.length} active employee(s) with cost data (no linked workflow performers)` };
  };

  const statBy = new Map(d.stats.map((s) => [s.agentId, s]));
  const okBy = new Map(d.lastOk.map((s) => [s.agentId, s.at]));
  const anyBy = new Map(d.lastAny.map((s) => [s.agentId, s.at]));
  const ivBy = new Map(d.interventions.map((s) => [s.agentId, num(s.n)]));
  const testBy = new Map(d.lastTests.map((t) => [t.agent_id, t]));
  const credBy = new Map(d.creds.map((c) => [c.id, c]));
  const oppBy = new Map(d.opps.map((o) => [o.id, o]));
  const wfBy = new Map(d.wfs.map((w) => [w.id, w]));
  const recentBy = new Map<string, typeof d.recent>();
  for (const r of d.recent) recentBy.set(r.agent_id, [...(recentBy.get(r.agent_id) ?? []), r]);
  const iso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : null);

  const agents: AgentMetrics[] = d.agents.map((ag) => {
    const s = statBy.get(ag.id);
    const runs = num(s?.runs), ok = num(s?.ok), bad = num(s?.bad);
    const minutesSaved = num(s?.minutes), humanMinutes = num(s?.human);
    const opp = ag.opportunityId ? oppBy.get(ag.opportunityId) ?? null : null;
    const wfId = ag.workflowId ?? opp?.workflowId ?? null;
    const wfList = [ag.workflowId, opp?.workflowId].filter((x, i, arr): x is string => !!x && arr.indexOf(x) === i).map((id) => wfBy.get(id)).filter((x): x is { id: string; name: string } => !!x);
    const hr = hourlyFor(wfId);
    const hoursSaved = minutesSaved / 60;
    const benefit = hoursSaved * hr.value;
    const monthly = num(ag.monthlyCost);
    // Cost accrues while an agent is deployed/paused or actually ran in the window; drafts that never ran cost nothing.
    const chargeable = ag.status === "deployed" || ag.status === "paused" || runs > 0;
    const operatingCost = chargeable ? monthly * months : 0;
    const netBenefit = benefit - operatingCost;
    const recent = recentBy.get(ag.id) ?? [];
    let consecutive = 0; for (const r of recent) { if (r.status === "failed" || r.status === "rolled_back") consecutive++; else break; }
    const fails = recent.filter((r) => (r.status === "failed" || r.status === "rolled_back"));
    const failures7d = fails.filter((r) => new Date(r.created_at) >= since7).length;
    const lastFail = fails[0] ?? null;
    const lt = testBy.get(ag.id);
    const cron = ag.definition.schedule?.trim();
    const schedule = cron ? (() => { const valid = isValidCron(cron); let next: Date | null = null; try { next = valid ? nextRun(cron, now, tz) : null; } catch { next = null; } return { cron, description: describeCron(cron), nextRunAt: next?.toISOString() ?? null, valid }; })() : null;
    const benefitTree: CalcTree = { label: `${ag.name} — financial benefit (${windowDays}d)`, value: benefit, unit: "usd", basis: hr.basis === "observed" ? "observed" : "estimated", formula: "hours saved × loaded hourly of the people who did this work (finance run-ledger method)", source: "agent_runs ledger (succeeded, non-test runs) · finance.ts valuation", children: [
      { label: "Hours saved", value: hoursSaved, unit: "hours", basis: "observed", formula: "Σ run minutes_saved ÷ 60", source: `${ok} succeeded run(s) since ${since.toISOString().slice(0, 10)}`, children: [
        { label: "Minutes saved (succeeded runs)", value: minutesSaved, unit: "minutes", basis: "observed", source: `Per-run minutes: agent expectation (${num(ag.expectedMinutesSavedPerRun)} min) unless a run's end node reports its own` },
      ] },
      { label: "Average loaded hourly cost", value: hr.value, unit: "usd", basis: hr.basis, source: hr.source, formula: `base × (1 + ${a.benefitsLoadPct}) ÷ (hours/wk × ${a.workWeeksPerYear} wk), hours-weighted` },
    ] };
    const costTree: CalcTree = { label: "Operating cost in window", value: operatingCost, unit: "usd", basis: "observed", formula: chargeable ? `$${monthly}/mo × ${months.toFixed(2)} months` : "not deployed and no runs in window → $0", source: "agents.monthly_cost" };
    const netTree: CalcTree = { label: `${ag.name} — net benefit (${windowDays}d)`, value: netBenefit, unit: "usd", basis: benefitTree.basis, formula: "financial benefit − operating cost", children: [benefitTree, costTree] };
    const connected = Array.from(new Set((ag.credentialIds ?? []).map((id) => credBy.get(id)?.provider).filter((x): x is string => !!x)));
    if (ag.runtime === "n8n") connected.push("n8n");
    return {
      id: ag.id, name: ag.name, status: ag.status, runtime: ag.runtime, category: ag.category, categoryLabel: CATEGORY_LABELS[ag.category as AgentCategory] ?? ag.category,
      fn: agentFunction(ag), templateKey: ag.templateKey, workflows: wfList, opportunity: opp ? { id: opp.id, title: opp.title } : null,
      runs, succeeded: ok, failed: bad, cancelled: num(s?.cancelled), awaiting: num(s?.awaiting), successRate: ok + bad > 0 ? ok / (ok + bad) : null,
      tasksCompleted: ok, humanInterventions: ivBy.get(ag.id) ?? 0, humanMinutes,
      minutesSaved, hoursSaved, hourly: hr.value, hourlyBasis: hr.basis, performers: hr.performers,
      benefit, operatingCost, netBenefit, roi: operatingCost > 0 ? netBenefit / operatingCost : null,
      connectedSystems: connected, lastSuccessAt: iso(okBy.get(ag.id)), lastRunAt: iso(anyBy.get(ag.id) ?? ag.lastRunAt),
      failures7d, consecutiveFailures: consecutive, lastFailedRunId: lastFail?.id ?? null, lastError: lastFail?.error ?? null,
      lastTest: lt ? { runId: lt.id, status: lt.status, at: new Date(lt.created_at).toISOString() } : null,
      schedule, trees: { benefit: benefitTree, net: netTree },
    };
  });

  const kpis = portfolioKpis(agents, windowDays);
  const alerts: FailureAlert[] = agents.filter((x) => x.failures7d > 0 || x.consecutiveFailures > 0)
    .map((x) => ({ agentId: x.id, agentName: x.name, failures7d: x.failures7d, consecutiveFailures: x.consecutiveFailures, lastFailedRunId: x.lastFailedRunId, lastError: x.lastError, lastFailedAt: (recentBy.get(x.id) ?? []).find((r) => r.id === x.lastFailedRunId)?.created_at ? new Date((recentBy.get(x.id) ?? []).find((r) => r.id === x.lastFailedRunId)!.created_at).toISOString() : null }))
    .sort((p, q) => q.consecutiveFailures - p.consecutiveFailures || q.failures7d - p.failures7d);
  return { windowDays, windowStart: since.toISOString(), windowEnd: now.toISOString(), agents, kpis, alerts, timezone: tz };
}

/** Portfolio KPIs (with CalcTrees) for any subset of agents — used for the filtered Command Center view. */
export function portfolioKpis(agents: AgentMetrics[], windowDays: number): PortfolioKpis {
  const sum = (f: (x: AgentMetrics) => number) => agents.reduce((s, x) => s + f(x), 0);
  const executions = sum((x) => x.runs), succeeded = sum((x) => x.succeeded), failed = sum((x) => x.failed);
  const benefit = sum((x) => x.benefit), operatingCost = sum((x) => x.operatingCost), hoursSaved = sum((x) => x.hoursSaved);
  const active = agents.filter((x) => x.status === "deployed");
  const top = (f: (x: AgentMetrics) => number, unit: CalcTree["unit"], basis: Basis = "observed") => [...agents].sort((p, q) => f(q) - f(p)).slice(0, 25).map((x) => ({ label: x.name, value: f(x), unit, basis }));
  return {
    activeAgents: active.length, totalAgents: agents.length, executions, succeeded, failed, successRate: succeeded + failed > 0 ? succeeded / (succeeded + failed) : null,
    hoursSaved, benefit, operatingCost, netBenefit: benefit - operatingCost,
    trees: {
      activeAgents: { label: "Active agents", value: active.length, basis: "observed", formula: "agents with status = deployed", source: "agents table", children: active.slice(0, 25).map((x) => ({ label: x.name, value: 1, basis: "observed" as const })) },
      executions: { label: `Executions (${windowDays}d)`, value: executions, basis: "observed", formula: "count of live runs (dry-run test runs excluded)", source: "agent_runs", children: top((x) => x.runs, undefined) },
      successRate: { label: "Success rate", value: succeeded + failed > 0 ? succeeded / (succeeded + failed) : 0, unit: "pct", basis: "observed", formula: "succeeded ÷ (succeeded + failed + rolled back); cancelled and awaiting approval excluded", children: [
        { label: "Succeeded", value: succeeded, basis: "observed" }, { label: "Failed or rolled back", value: failed, basis: "observed" } ] },
      hoursSaved: { label: `Hours saved (${windowDays}d)`, value: hoursSaved, unit: "hours", basis: "observed", formula: "Σ minutes_saved of succeeded live runs ÷ 60", source: "agent_runs ledger", children: top((x) => x.hoursSaved, "hours") },
      netBenefit: { label: `Net benefit (${windowDays}d)`, value: benefit - operatingCost, unit: "usd", basis: "estimated", formula: "Σ agent financial benefit − Σ operating cost", source: "finance run-ledger valuation; not yet a recorded measurement — record one on an agent's Results tab to make it verified", children: [
        { label: "Financial benefit", value: benefit, unit: "usd", basis: "estimated", children: agents.filter((x) => x.benefit > 0).slice(0, 25).map((x) => x.trees.benefit) },
        { label: "Operating cost", value: operatingCost, unit: "usd", basis: "observed", formula: "Σ monthly cost × months in window" },
      ] },
    },
  };
}
