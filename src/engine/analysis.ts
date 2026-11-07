/**
 * Analysis engine — orchestrates mining + scoring against the database.
 * System job: uses the admin `db` handle, always filters by orgId.
 *
 * Re-running for the same org replaces previous workflows/opportunities, but opportunities that are being worked
 * (status ≠ identified) are preserved: matched by workflow signature and updated in place.
 */
import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { Evidence, OrgSettings } from "@/db/schema";
import { DEFAULTS, loadedHourlyCost, opportunityEconomics } from "./costing";
import {
  type MiningEvent, type TaskInstance, type WorkflowMetrics, type Cluster,
  mineEmployee, clusterInstances, workflowMetrics, nameWorkflow, observedWeeksFromDays, dayKey, isIdle, isNoise, MIN_INSTANCES_PER_WORKFLOW, sequenceSimilarity, CLUSTER_THRESHOLD,
} from "./mining";
import {
  detectFlags, repetitionScore, automationScore, complexity, findDuplicates, crossDepartmentNote, opportunityType, agentCategory,
  riskScore, feasibilityScore, automationPct, rankValue, apiFriendliness, type Flags,
} from "./scoring";

export type RunAnalysisOpts = { orgId: string; campaignId?: string; windowStart?: Date; windowEnd?: Date };
export type RunAnalysisResult = { runId: string; eventsAnalyzed: number; workflowsFound: number; opportunitiesFound: number };

const ASSUMED_HOURLY = 35; // used only when an employee has no cost data at all
const EVENT_PAGE = 20000;

type Emp = { id: string; departmentId: string | null; hourly: number; hourlyBasis: "observed" | "estimated" | "assumed" };
type Prepared = {
  cluster: Cluster; m: WorkflowMetrics; name: string; flags: Flags; rep: number; auto: number; departmentId: string | null; departmentNames: string[];
  notes: string[]; evidence: Evidence; duplicateOfKey: string | null;
};

export async function runAnalysis(opts: RunAnalysisOpts): Promise<RunAnalysisResult> {
  const { orgId } = opts;
  const [run] = await db.insert(schema.analysisRuns).values({ orgId, campaignId: opts.campaignId ?? null, status: "running", windowStart: opts.windowStart ?? null, windowEnd: opts.windowEnd ?? null, startedAt: new Date() }).returning({ id: schema.analysisRuns.id });
  try {
    const result = await analyze(opts, run.id);
    return result;
  } catch (e) {
    await db.update(schema.analysisRuns).set({ status: "failed", error: e instanceof Error ? e.message : String(e), finishedAt: new Date() }).where(and(eq(schema.analysisRuns.id, run.id), eq(schema.analysisRuns.orgId, orgId)));
    throw e;
  }
}

async function analyze(opts: RunAnalysisOpts, runId: string): Promise<RunAnalysisResult> {
  const { orgId } = opts;
  // ---- 1. load org, employees, departments, integrations ----
  const [org] = await db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (!org) throw new Error("org not found");
  const settings: OrgSettings = org.settings ?? {};
  const benefits = settings.benefitsLoadPct ?? DEFAULTS.benefitsLoadPct;
  const weeksPerYear = settings.workWeeksPerYear ?? DEFAULTS.workWeeksPerYear;
  const empRows = await db.select({ id: schema.employees.id, departmentId: schema.employees.departmentId, loaded: schema.employees.loadedHourlyCost, base: schema.employees.baseAnnualCost, costBasis: schema.employees.costBasis, hpw: schema.employees.hoursPerWeek }).from(schema.employees).where(eq(schema.employees.orgId, orgId));
  const emps = new Map<string, Emp>();
  for (const e of empRows) {
    let hourly = Number(e.loaded ?? 0); let basis: Emp["hourlyBasis"] = e.costBasis;
    if (!hourly && e.base) { hourly = loadedHourlyCost(Number(e.base), benefits, Number(e.hpw ?? 40) || 40, weeksPerYear).value; basis = "estimated"; }
    if (!hourly) { hourly = ASSUMED_HOURLY; basis = "assumed"; }
    emps.set(e.id, { id: e.id, departmentId: e.departmentId, hourly, hourlyBasis: basis });
  }
  const deptRows = await db.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, orgId));
  const deptName = new Map(deptRows.map((d) => [d.id, d.name]));
  const integ = await db.select({ provider: schema.integrations.provider, status: schema.integrations.status }).from(schema.integrations).where(eq(schema.integrations.orgId, orgId));
  const integrationConnected = integ.some((i) => i.status === "connected" && (i.provider === "n8n" || i.provider === "power_automate" || i.provider === "uipath"));

  // ---- 2. stream events per employee → task instances ----
  const instances: TaskInstance[] = [];
  const activeDays = new Set<string>();
  const appMs = new Map<string, number>();
  let eventsAnalyzed = 0, activeMs = 0, idleMs = 0, noiseMs = 0, sessionsTotal = 0, instanceMs = 0;
  let observedFrom = Infinity, observedTo = -Infinity;
  for (const empId of emps.keys()) {
    const events = await loadEmployeeEvents(opts, empId);
    if (!events.length) continue;
    eventsAnalyzed += events.length;
    for (const e of events) {
      if (isIdle(e)) { if (e.type === "idle_start") idleMs += e.durationMs; continue; }
      activeDays.add(dayKey(e.ts)); activeMs += e.durationMs;
      if (e.ts < observedFrom) observedFrom = e.ts; if (e.ts + e.durationMs > observedTo) observedTo = e.ts + e.durationMs;
      if (isNoise(e)) noiseMs += e.durationMs; else appMs.set(e.app, (appMs.get(e.app) ?? 0) + e.durationMs);
    }
    const mined = mineEmployee(events);
    sessionsTotal += mined.length;
    for (const i of mined) { instances.push(i); instanceMs += i.durationMs; }
  }
  const observedWeeks = observedWeeksFromDays(activeDays);

  // ---- 3. cluster → workflows ----
  const clusters = clusterInstances(instances).filter((c) => c.instances.length >= MIN_INSTANCES_PER_WORKFLOW);
  const prepared: Prepared[] = clusters.map((cluster) => {
    const m = workflowMetrics(cluster, observedWeeks);
    const flags = detectFlags(m);
    const rep = repetitionScore(m).score;
    const auto = automationScore(m, flags).score;
    // modal department of performers (weighted by runs)
    const deptRuns = new Map<string, number>(); const deptNames: string[] = [];
    for (const es of m.employees) { const d = emps.get(es.employeeId)?.departmentId ?? null; if (d) { deptRuns.set(d, (deptRuns.get(d) ?? 0) + es.runs); deptNames.push(deptName.get(d) ?? d); } }
    const departmentId = Array.from(deptRuns.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const notes: string[] = [...flags.reasons];
    const xdept = crossDepartmentNote(deptNames); if (xdept) notes.push(xdept);
    if (cluster.variantCount > 1) notes.push(`${cluster.variantCount} step-sequence variants merged (≥${Math.round(CLUSTER_THRESHOLD * 100)}% overlap); ${Math.round(m.canonicalShare * 100)}% of runs follow the canonical sequence.`);
    const eventIds: number[] = []; for (const inst of cluster.instances) { if (eventIds.length >= 200) break; eventIds.push(inst.eventIds[0]); }
    const evidence: Evidence = { eventIds, sampleSize: cluster.instances.length, observedFrom: new Date(m.observedFrom).toISOString(), observedTo: new Date(m.observedTo).toISOString(), employeeIds: m.employeeIds, notes };
    return { cluster, m, name: nameWorkflow(m), flags, rep, auto, departmentId, departmentNames: deptNames, notes, evidence, duplicateOfKey: null };
  });
  // duplicate work across workflows (≥80% token overlap)
  const dupPairs = findDuplicates(prepared.map((p) => ({ key: p.cluster.signature, tokens: p.cluster.canonical, hoursPerWeek: p.m.hoursPerWeek, departmentIds: p.departmentId ? [p.departmentId] : [] })));
  for (const pair of dupPairs) { const p = prepared.find((x) => x.cluster.signature === pair.smaller)!; p.duplicateOfKey = pair.larger; p.notes.push(`Duplicate work: ${pair.reason}.`); }

  // ---- 4. persist (transaction): workflows, workflow_employees, opportunities, preserve worked opportunities ----
  let workflowsFound = 0, opportunitiesFound = 0;
  await db.transaction(async (tx) => {
    const oldWfs = await tx.select({ id: schema.workflows.id, signature: schema.workflows.signature, steps: schema.workflows.steps }).from(schema.workflows).where(eq(schema.workflows.orgId, orgId));
    const oldWfSig = new Map(oldWfs.map((w) => [w.id, w.signature]));
    const preservedOpps = await tx.select().from(schema.opportunities).where(and(eq(schema.opportunities.orgId, orgId), ne(schema.opportunities.status, "identified")));

    // insert workflows
    const idBySig = new Map<string, string>();
    for (const p of prepared) {
      const [row] = await tx.insert(schema.workflows).values({
        orgId, departmentId: p.departmentId, name: p.name, description: describeWorkflow(p),
        signature: p.cluster.signature, steps: p.m.steps, processMap: p.m.processMap,
        avgDurationMin: p.m.avgDurationMin.toFixed(2), runsPerWeek: p.m.runsPerWeek.toFixed(2), hoursPerWeek: p.m.hoursPerWeek.toFixed(2),
        employeeCount: p.m.employeeIds.length, repetitionScore: p.rep.toFixed(2), automationScore: p.auto.toFixed(2),
        reworkRate: p.m.reworkRate.toFixed(4), handoffCount: p.m.handoffCount, isManual: true,
        requiresJudgment: p.flags.requiresJudgment, regulatoryFlag: p.flags.regulatoryFlag, basis: "observed", evidence: p.evidence, analysisRunId: runId,
      }).returning({ id: schema.workflows.id });
      idBySig.set(p.cluster.signature, row.id);
      workflowsFound++;
      await tx.insert(schema.workflowEmployees).values(p.m.employees.map((es) => ({ orgId, workflowId: row.id, employeeId: es.employeeId, runsPerWeek: es.runsPerWeek.toFixed(2), hoursPerWeek: es.hoursPerWeek.toFixed(2), avgDurationMin: es.avgDurationMin.toFixed(2) })));
    }
    for (const p of prepared) if (p.duplicateOfKey) await tx.update(schema.workflows).set({ duplicateOfWorkflowId: idBySig.get(p.duplicateOfKey) ?? null }).where(and(eq(schema.workflows.id, idBySig.get(p.cluster.signature)!), eq(schema.workflows.orgId, orgId)));

    // match preserved (worked) opportunities to new workflows by signature (exact, else ≥70% similar)
    const keepOldWfIds = new Set<string>();
    const preservedByNewWf = new Map<string, typeof preservedOpps[number]>();
    for (const opp of preservedOpps) {
      const sig = opp.workflowId ? oldWfSig.get(opp.workflowId) : undefined;
      let match: Prepared | undefined = sig ? prepared.find((p) => p.cluster.signature === sig) : undefined;
      if (!match && sig) { let best = 0; for (const p of prepared) { const s = sequenceSimilarity(sig.split(">"), p.cluster.canonical); if (s >= CLUSTER_THRESHOLD && s > best) { best = s; match = p; } } }
      if (match) {
        preservedByNewWf.set(match.cluster.signature, opp);
        // re-point to the new workflow row NOW, before the old row is deleted (FK cascade would otherwise remove the opportunity)
        await tx.update(schema.opportunities).set({ workflowId: idBySig.get(match.cluster.signature)! }).where(and(eq(schema.opportunities.id, opp.id), eq(schema.opportunities.orgId, orgId)));
      } else if (opp.workflowId) keepOldWfIds.add(opp.workflowId); // workflow no longer observed; keep its row so the worked opportunity survives
    }
    // delete superseded workflows (cascades workflow_employees + identified opportunities)
    const toDelete = oldWfs.map((w) => w.id).filter((id) => !keepOldWfIds.has(id));
    if (toDelete.length) await tx.delete(schema.workflows).where(and(eq(schema.workflows.orgId, orgId), inArray(schema.workflows.id, toDelete)));
    // orphans: identified opportunities with no workflow
    await tx.delete(schema.opportunities).where(and(eq(schema.opportunities.orgId, orgId), eq(schema.opportunities.status, "identified"), sql`${schema.opportunities.workflowId} is null`));

    // opportunities
    type OppDraft = { p: Prepared; values: Omit<typeof schema.opportunities.$inferInsert, "rank"> & { rank: number }; rankValue: number; preserved?: typeof preservedOpps[number] };
    const drafts: OppDraft[] = [];
    for (const p of prepared) {
      const isDup = !!p.duplicateOfKey;
      if (p.auto < 35 && !isDup) continue;
      const type = opportunityType(p.m, p.auto, p.flags, isDup);
      const cx = complexity(p.m, p.flags);
      const pct = automationPct(p.auto);
      let wsum = 0, hsum = 0; let anyAssumed = false;
      for (const es of p.m.employees) { const emp = emps.get(es.employeeId); const h = emp?.hourly ?? ASSUMED_HOURLY; wsum += h * es.hoursPerWeek; hsum += es.hoursPerWeek; if (!emp || emp.hourlyBasis === "assumed") anyAssumed = true; }
      const avgHourly = hsum ? wsum / hsum : ASSUMED_HOURLY;
      const econ = opportunityEconomics({ type, hoursPerWeek: p.m.hoursPerWeek, automationPct: pct, avgLoadedHourly: avgHourly, employeeCount: p.m.employeeIds.length, complexity: cx, adoptionRate: settings.adoptionRate, realizationRate: settings.realizationRate, weeksPerYear, basisHours: "observed" });
      const api = apiFriendliness(p.m);
      const feasibility = feasibilityScore(p.auto, api, integrationConnected);
      const risk = riskScore({ regulatoryFlag: p.flags.regulatoryFlag, requiresJudgment: p.flags.requiresJudgment, employeeCount: p.m.employeeIds.length, handoffRate: p.m.handoffRate });
      const category = agentCategory(p.m);
      const evidence: Evidence = { ...p.evidence, notes: [...(p.evidence.notes ?? []), ...(anyAssumed ? [`Loaded hourly cost assumed at $${ASSUMED_HOURLY}/h for at least one performer (no cost data).`] : [])] };
      const summary = summarize(p, type, pct, econ.hoursRecoverablePerWeek, econ.grossAnnualSavings, econ.realizableAnnualSavings, avgHourly, settings, isDup);
      drafts.push({
        p, rankValue: rankValue(econ.realizableAnnualSavings, feasibility, risk), preserved: preservedByNewWf.get(p.cluster.signature),
        values: {
          orgId, workflowId: idBySig.get(p.cluster.signature)!, departmentId: p.departmentId, title: oppTitle(type, p.name), summary, type, rank: 0,
          feasibility: feasibility.toFixed(2), risk: risk.toFixed(2), automationPct: pct.toFixed(4),
          hoursRecoverablePerWeek: econ.hoursRecoverablePerWeek.toFixed(2), grossAnnualSavings: econ.grossAnnualSavings.toFixed(2), realizableAnnualSavings: econ.realizableAnnualSavings.toFixed(2),
          implementationCost: econ.implementationCost.toFixed(2), annualOperatingCost: econ.annualOperatingCost.toFixed(2), paybackMonths: econ.paybackMonths == null ? null : Math.min(econ.paybackMonths, 9999).toFixed(1),
          recommendedAgentCategory: category, requiresHumanJudgment: p.flags.requiresJudgment, regulatoryFlag: p.flags.regulatoryFlag, basis: "estimated", calculation: econ.tree, evidence,
        },
      });
    }
    drafts.sort((a, b) => b.rankValue - a.rankValue);
    let rank = 0;
    for (const d of drafts) {
      rank++; d.values.rank = rank;
      if (d.preserved) {
        // keep status/title/type (being worked); refresh numbers + evidence + workflow link
        const { title: _t, type: _ty, ...rest } = d.values; void _t; void _ty;
        await tx.update(schema.opportunities).set({ ...rest, updatedAt: new Date() }).where(and(eq(schema.opportunities.id, d.preserved.id), eq(schema.opportunities.orgId, orgId)));
      } else {
        await tx.insert(schema.opportunities).values(d.values);
      }
      opportunitiesFound++;
    }
    // preserved opportunities whose workflow vanished: bump their rank after the fresh ones so they still sort
    const stale = preservedOpps.filter((o) => o.workflowId && keepOldWfIds.has(o.workflowId));
    for (const o of stale) { rank++; await tx.update(schema.opportunities).set({ rank }).where(and(eq(schema.opportunities.id, o.id), eq(schema.opportunities.orgId, orgId))); }

    // ---- 5. run summary ----
    const totalHoursPerWeek = activeMs / 3600000 / observedWeeks;
    const repetitiveHoursPerWeek = prepared.filter((p) => p.rep >= 50).reduce((s, p) => s + p.m.hoursPerWeek, 0);
    const workflowHoursPerWeek = prepared.reduce((s, p) => s + p.m.hoursPerWeek, 0);
    const topApps = Array.from(appMs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([app, ms]) => ({ app, hoursPerWeek: round2(ms / 3600000 / observedWeeks), share: round4(activeMs ? ms / activeMs : 0) }));
    const summary = {
      basis: "observed",
      observedFrom: Number.isFinite(observedFrom) ? new Date(observedFrom).toISOString() : null,
      observedTo: Number.isFinite(observedTo) ? new Date(observedTo).toISOString() : null,
      observedWeeks: round2(observedWeeks), activeDays: activeDays.size, employeesObserved: emps.size,
      totalHoursPerWeek: round2(totalHoursPerWeek),
      workflowHoursPerWeek: round2(workflowHoursPerWeek),
      repetitiveHoursPerWeek: round2(repetitiveHoursPerWeek),
      adHocHoursPerWeek: round2(Math.max(0, (activeMs - instanceMsOf(prepared)) / 3600000 / observedWeeks)),
      idleShare: round4(activeMs + idleMs ? idleMs / (activeMs + idleMs) : 0),
      noiseShare: round4(activeMs ? noiseMs / activeMs : 0),
      taskSessions: sessionsTotal, sessionsClustered: prepared.reduce((s, p) => s + p.cluster.instances.length, 0), sessionHoursPerWeek: round2(instanceMs / 3600000 / observedWeeks),
      topApps,
      duplicatePairs: dupPairs.length,
      topWorkflows: prepared.slice().sort((a, b) => b.m.hoursPerWeek - a.m.hoursPerWeek).slice(0, 5).map((p) => ({ name: p.name, hoursPerWeek: round2(p.m.hoursPerWeek), automationScore: round2(p.auto) })),
    };
    await tx.update(schema.analysisRuns).set({ status: "done", eventsAnalyzed, workflowsFound, opportunitiesFound, summary, finishedAt: new Date() }).where(and(eq(schema.analysisRuns.id, runId), eq(schema.analysisRuns.orgId, orgId)));
  });
  return { runId, eventsAnalyzed, workflowsFound, opportunitiesFound };
}

function instanceMsOf(prepared: Prepared[]): number { let ms = 0; for (const p of prepared) for (const i of p.cluster.instances) ms += i.durationMs; return ms; }
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Page through one employee's events ordered by ts (bounded memory per employee). */
async function loadEmployeeEvents(opts: RunAnalysisOpts, employeeId: string): Promise<MiningEvent[]> {
  const out: MiningEvent[] = [];
  let lastId = -1; let lastTs: Date | null = null;
  for (;;) {
    const conds = [eq(schema.activityEvents.orgId, opts.orgId), eq(schema.activityEvents.employeeId, employeeId)];
    if (opts.campaignId) conds.push(eq(schema.activityEvents.campaignId, opts.campaignId));
    if (opts.windowStart) conds.push(gte(schema.activityEvents.ts, opts.windowStart));
    if (opts.windowEnd) conds.push(lte(schema.activityEvents.ts, opts.windowEnd));
    if (lastTs) conds.push(sql`(${schema.activityEvents.ts}, ${schema.activityEvents.id}) > (${lastTs}, ${lastId})`);
    const rows = await db.select({ id: schema.activityEvents.id, ts: schema.activityEvents.ts, type: schema.activityEvents.type, app: schema.activityEvents.app, appCategory: schema.activityEvents.appCategory, titleCategory: schema.activityEvents.titleCategory, titleHash: schema.activityEvents.titleHash, durationMs: schema.activityEvents.durationMs, meta: schema.activityEvents.meta })
      .from(schema.activityEvents).where(and(...conds)).orderBy(asc(schema.activityEvents.ts), asc(schema.activityEvents.id)).limit(EVENT_PAGE);
    for (const r of rows) out.push({ id: r.id, employeeId, ts: r.ts.getTime(), type: r.type, app: r.app, appCategory: r.appCategory ?? "", titleCategory: r.titleCategory ?? "", titleHash: r.titleHash, durationMs: r.durationMs, meta: r.meta });
    if (rows.length < EVENT_PAGE) break;
    lastTs = rows[rows.length - 1].ts; lastId = rows[rows.length - 1].id;
  }
  return out;
}

function describeWorkflow(p: Prepared): string {
  const m = p.m;
  return `Observed ${m.instanceCount} runs by ${m.employeeIds.length} ${m.employeeIds.length === 1 ? "person" : "people"} (${Array.from(new Set(p.departmentNames)).join(", ") || "no department"}), avg ${m.avgDurationMin.toFixed(1)} min, ${m.runsPerWeek.toFixed(1)} runs/week ≈ ${m.hoursPerWeek.toFixed(1)} hrs/week. Steps: ${m.steps.map((s) => `${s.app} ${s.action}`).join(" → ")}.`;
}
const TYPE_LABEL: Record<string, string> = { ai_agent: "AI agent", rpa: "RPA bot", conventional_automation: "Integration / scripted automation", process_change: "Process redesign", role_consolidation: "Role consolidation" };
function oppTitle(type: string, wfName: string): string { return `${TYPE_LABEL[type] ?? type}: ${wfName.replace(/\s*\(.*\)$/, "")}`; }

function summarize(p: Prepared, type: string, pct: number, hrsRecoverable: number, gross: number, realizable: number, avgHourly: number, settings: OrgSettings, isDup: boolean): string {
  const m = p.m; const weeks = (m.instanceCount / Math.max(m.runsPerWeek, 0.01));
  const people = m.employeeIds.length;
  const entryStep = m.steps.slice().sort((a, b) => b.share - a.share).find((s) => s.action.includes("data entry") || s.action.includes("copy paste"));
  const structured = Math.round(((m.typeShare.data_entry ?? 0) + (m.typeShare.copy_paste ?? 0) + (m.typeShare.form_submit ?? 0)) * 100);
  const parts: string[] = [];
  parts.push(`Observed ${m.instanceCount} runs over ${weeks.toFixed(1)} weeks by ${people} ${people === 1 ? "person" : "people"}, avg ${m.avgDurationMin.toFixed(1)} min (${m.hoursPerWeek.toFixed(1)} hrs/week in total).`);
  if (entryStep) parts.push(`${Math.round(entryStep.share * 100)}% of the time is ${entryStep.action.includes("copy") ? "copying data" : "structured entry"} into ${entryStep.app}; ${structured}% of all time is structured entry, paste or submit.`);
  if (m.pasteSteps > 0 && m.distinctApps >= 2) parts.push(`Data is re-keyed or pasted between ${m.distinctApps} applications (${m.apps.join(", ")}) — a swivel-chair pattern.`);
  if (m.reworkRate > 0) parts.push(`${Math.round(m.reworkRate * 100)}% of runs showed rework (repeated steps).`);
  if (m.handoffCount > 0) parts.push(`${m.handoffCount} handoffs to another person were observed.`);
  if (p.flags.requiresJudgment) parts.push(`This work requires human judgment (${p.flags.reasons.find((r) => r.includes("judgment") || r.includes("reading")) ?? "flagged"}); only the surrounding clerical steps are candidates.`);
  if (p.flags.regulatoryFlag) parts.push(`Regulatory sensitivity: ${p.flags.regulatoryFlag} — keep a human approval step.`);
  if (isDup) parts.push(`This is duplicate work of a larger workflow; consolidate rather than automate twice.`);
  parts.push(`Recommended: ${TYPE_LABEL[type] ?? type}. Estimated ${Math.round(pct * 100)}% of the workflow time is automatable; at ${Math.round((settings.adoptionRate ?? DEFAULTS.adoptionRate) * 100)}% adoption that recovers ~${hrsRecoverable.toFixed(1)} hrs/week, worth $${Math.round(gross).toLocaleString("en-US")}/yr gross at an average loaded cost of $${avgHourly.toFixed(0)}/h, of which $${Math.round(realizable).toLocaleString("en-US")}/yr is realizable at a ${Math.round((settings.realizationRate ?? DEFAULTS.realizationRate) * 100)}% realization rate. Hours are observed; savings are estimated.`);
  return parts.join(" ");
}
