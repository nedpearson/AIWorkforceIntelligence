/**
 * Measurement — turns the run ledger and observed activity into verified savings rows.
 * `recordSavingsFromRunLedger` lives in src/engine/finance.ts (finance engine). It is imported lazily so this
 * module loads even before that file exists; tests inject a stub through `deps`.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import type { CalcTree } from "@/db/schema";

export type Period = { start: Date; end: Date };
export type RecordSavingsFn = (orgId: string, agentId: string, periodStart: Date, periodEnd: Date) => Promise<unknown>;

async function loadRecordSavings(): Promise<RecordSavingsFn> {
  try {
    // @ts-ignore — finance.ts is authored by the finance engine owner; resolved at runtime.
    const mod = (await import("@/engine/finance")) as { recordSavingsFromRunLedger?: RecordSavingsFn };
    if (typeof mod.recordSavingsFromRunLedger === "function") return mod.recordSavingsFromRunLedger;
    throw new Error("recordSavingsFromRunLedger not exported");
  } catch (e) {
    throw new Error(`Finance engine not available (src/engine/finance.ts: ${e instanceof Error ? e.message : String(e)}) — measurement cannot be recorded yet.`);
  }
}

/** Record verified savings for an agent over a period from its run ledger (delegates the math to the finance engine). */
export async function measureAgent(orgId: string, agentId: string, period: Period, deps: { recordSavingsFromRunLedger?: RecordSavingsFn } = {}) {
  if (!(period.end > period.start)) throw new Error("period end must be after start");
  const fn = deps.recordSavingsFromRunLedger ?? (await loadRecordSavings());
  const result = await fn(orgId, agentId, period.start, period.end);
  const summary = await runLedgerSummary(orgId, agentId, period);
  return { result, summary };
}

/** Observed run ledger totals for a period (no money — that is the finance engine's job). */
export async function runLedgerSummary(orgId: string, agentId: string, period: Period) {
  const rows = await withTenant(orgId, (tx) => tx.select({ status: schema.agentRuns.status, minutesSaved: schema.agentRuns.minutesSaved, humanMinutes: schema.agentRuns.humanMinutes })
    .from(schema.agentRuns).where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.agentId, agentId), gte(schema.agentRuns.createdAt, period.start), lt(schema.agentRuns.createdAt, period.end))));
  const n = (v: unknown) => (v == null ? 0 : Number(v) || 0);
  const succeeded = rows.filter((r) => r.status === "succeeded");
  const minutesSaved = succeeded.reduce((s, r) => s + n(r.minutesSaved), 0);
  const humanMinutes = rows.reduce((s, r) => s + n(r.humanMinutes), 0);
  return { runs: rows.length, succeeded: succeeded.length, failed: rows.filter((r) => ["failed", "rolled_back"].includes(r.status)).length, minutesSaved, humanMinutes, netMinutes: minutesSaved - humanMinutes, hoursSaved: (minutesSaved - humanMinutes) / 60 };
}

/**
 * Before/after comparison: observed hours per week spent on a workflow by the employees who performed it,
 * in the apps the workflow uses, for an equal-length window before and after `deployedAt`.
 * Basis is "observed" (collector events) but the attribution to the workflow is by app + employee, which is
 * stated in the tree so the reader knows what was counted.
 */
export async function beforeAfterComparison(orgId: string, workflowId: string, deployedAt: Date, now = new Date()): Promise<CalcTree> {
  return withTenant(orgId, async (tx) => {
    const [wf] = await tx.select().from(schema.workflows).where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.orgId, orgId))).limit(1);
    if (!wf) throw new Error("workflow not found");
    const links = await tx.select({ employeeId: schema.workflowEmployees.employeeId }).from(schema.workflowEmployees).where(and(eq(schema.workflowEmployees.orgId, orgId), eq(schema.workflowEmployees.workflowId, workflowId)));
    const employeeIds = links.length ? links.map((l) => l.employeeId) : (wf.evidence?.employeeIds ?? []);
    const apps = Array.from(new Set((wf.steps ?? []).map((s) => s.app))).filter(Boolean);
    const afterMs = Math.max(now.getTime() - deployedAt.getTime(), 86400_000);
    const beforeStart = new Date(deployedAt.getTime() - afterMs);
    const weeks = afterMs / (7 * 86400_000);
    const sum = async (from: Date, to: Date) => {
      if (!employeeIds.length || !apps.length) return { ms: 0, events: 0 };
      const [r] = await tx.select({ ms: sql<string>`coalesce(sum(${schema.activityEvents.durationMs}), 0)`, events: sql<string>`count(*)` }).from(schema.activityEvents)
        .where(and(eq(schema.activityEvents.orgId, orgId), inArray(schema.activityEvents.employeeId, employeeIds), inArray(schema.activityEvents.app, apps), gte(schema.activityEvents.ts, from), lt(schema.activityEvents.ts, to)));
      return { ms: Number(r?.ms ?? 0), events: Number(r?.events ?? 0) };
    };
    const before = await sum(beforeStart, deployedAt);
    const after = await sum(deployedAt, now);
    const hb = before.ms / 3600_000 / weeks, ha = after.ms / 3600_000 / weeks;
    const saved = hb - ha;
    const basis: CalcTree["basis"] = before.events + after.events > 0 ? "observed" : "assumed";
    const src = `Collector events for ${employeeIds.length} employee(s) in ${apps.join(", ") || "no apps"}; equal ${weeks.toFixed(1)}-week windows either side of ${deployedAt.toISOString().slice(0, 10)}`;
    return {
      label: "Hours per week recovered (before vs after deployment)", value: saved, unit: "hours", basis, formula: "hours/wk before − hours/wk after", source: src,
      children: [
        { label: "Hours per week before deployment", value: hb, unit: "hours", basis, formula: `${(before.ms / 3600_000).toFixed(1)} h over ${weeks.toFixed(1)} wk (${before.events} events)`, source: `${beforeStart.toISOString().slice(0, 10)} → ${deployedAt.toISOString().slice(0, 10)}` },
        { label: "Hours per week after deployment", value: ha, unit: "hours", basis, formula: `${(after.ms / 3600_000).toFixed(1)} h over ${weeks.toFixed(1)} wk (${after.events} events)`, source: `${deployedAt.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}` },
        { label: "Workflow hours per week at discovery", value: Number(wf.hoursPerWeek), unit: "hours", basis: wf.basis, source: "Workflow record (analysis engine)" },
      ],
    };
  });
}
