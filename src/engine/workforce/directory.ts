/**
 * Directory stats — per-AI-employee work summary for profile cards and directory KPIs.
 * Savings figures count LIVE runs only; sandbox runs are shown as demonstrations.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import type { CalcTree } from "@/db/schema";
import { num } from "@/lib/utils";
import type { OrgFinancials } from "@/engine/finance.types";
import { loadedHourlyFor } from "./financials";
import type { AiEmployee } from "./core";

export type CardStats = {
  assignedWorkflows: number; tasksCompleted: number; tasksThisMonth: number; liveRuns: number; sandboxRuns: number; successRate: number | null;
  verifiedHours: number; verifiedHoursThisMonth: number; capacityValue: number; hardSavingsAnnual: number;
  lastActivity: { at: string; text: string } | null;
};
export type DirectoryKpis = { total: number; active: number; tasksThisMonth: number; verifiedHoursThisMonth: number; netBenefitThisMonth: number; trees: Record<"total" | "active" | "tasks" | "hours" | "net", CalcTree> };

export async function directoryStats(orgId: string, emps: AiEmployee[], fin: OrgFinancials, now = new Date()): Promise<{ stats: Record<string, CardStats>; kpis: DirectoryKpis }> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const d = await withTenant(orgId, async (tx) => {
    const runs = await tx.select({ id: schema.skillRuns.id, aiEmployeeId: schema.skillRuns.aiEmployeeId, skillKey: schema.skillRuns.skillKey, mode: schema.skillRuns.mode, status: schema.skillRuns.status, reviewStatus: schema.skillRuns.reviewStatus, output: schema.skillRuns.output, base: schema.skillRuns.manualBaselineMinutes, review: schema.skillRuns.humanReviewMinutes, createdAt: schema.skillRuns.createdAt })
      .from(schema.skillRuns).where(and(eq(schema.skillRuns.orgId, orgId), gte(schema.skillRuns.createdAt, new Date(+now - 366 * 86_400_000)))).orderBy(desc(schema.skillRuns.createdAt));
    const opps = await tx.select({ id: schema.opportunities.id, workflowId: schema.opportunities.workflowId }).from(schema.opportunities).where(eq(schema.opportunities.orgId, orgId));
    const agents = await tx.select({ id: schema.agents.id, monthlyCost: schema.agents.monthlyCost }).from(schema.agents).where(eq(schema.agents.orgId, orgId));
    const ledger = await tx.select({ agentId: schema.savingsLedger.agentId, opportunityId: schema.savingsLedger.opportunityId, tier: schema.savingsLedger.tier, amount: schema.savingsLedger.annualAmount, effectiveFrom: schema.savingsLedger.effectiveFrom, effectiveTo: schema.savingsLedger.effectiveTo })
      .from(schema.savingsLedger).where(and(eq(schema.savingsLedger.orgId, orgId), eq(schema.savingsLedger.status, "approved")));
    return { runs, opps, agents, ledger };
  });
  const stats: Record<string, CardStats> = {};
  let tasksMonth = 0, hoursMonth = 0, valueMonth = 0, costMonth = 0;
  const hoursTreeKids: CalcTree[] = [];
  for (const e of emps) {
    const rs = d.runs.filter((r) => r.aiEmployeeId === e.id && !(r.output as Record<string, unknown> | null)?.blocked);
    const live = rs.filter((r) => r.mode === "live");
    const ok = live.filter((r) => r.status === "succeeded" && r.reviewStatus !== "rejected");
    const okM = ok.filter((r) => r.createdAt >= monthStart);
    const rec = (xs: typeof ok) => xs.reduce((s, r) => s + Math.max(0, num(r.base) - num(r.review)) / 60, 0);
    const wfId = d.opps.find((o) => o.id === e.opportunityId)?.workflowId ?? null;
    const lh = loadedHourlyFor(fin, wfId).value;
    const finished = live.filter((r) => ["succeeded", "failed", "rejected"].includes(r.status));
    const last = rs[0];
    const ledger = d.ledger.filter((l) => (e.agentId && l.agentId === e.agentId) || (e.opportunityId && l.opportunityId === e.opportunityId)).filter((l) => l.tier !== "approved" && +l.effectiveFrom <= +now && (!l.effectiveTo || +l.effectiveTo >= +now));
    stats[e.id] = {
      assignedWorkflows: wfId ? 1 : 0, tasksCompleted: ok.length, tasksThisMonth: okM.length, liveRuns: live.length, sandboxRuns: rs.length - live.length,
      successRate: finished.length ? finished.filter((r) => r.status === "succeeded").length / finished.length : null,
      verifiedHours: rec(ok), verifiedHoursThisMonth: rec(okM), capacityValue: rec(ok) * lh, hardSavingsAnnual: ledger.reduce((s, l) => s + num(l.amount), 0),
      lastActivity: last ? { at: last.createdAt.toISOString(), text: `${last.mode === "sandbox" ? "Sandbox demo" : "Live task"}: ${last.skillKey.replace(/_/g, " ")} — ${last.status.replace(/_/g, " ")}` } : null,
    };
    tasksMonth += okM.length; hoursMonth += rec(okM); valueMonth += rec(okM) * lh;
    const elapsedShare = Math.min(1, (+now - +monthStart) / (30.44 * 86_400_000));
    costMonth += num(d.agents.find((a) => a.id === e.agentId)?.monthlyCost) * elapsedShare;
    if (okM.length) hoursTreeKids.push({ label: `${e.firstName} (${okM.length} live tasks)`, value: rec(okM), unit: "hours", basis: "observed", source: `loaded hourly ${lh.toFixed(2)} USD` });
  }
  const active = emps.filter((e) => e.status === "active").length;
  const net = valueMonth - costMonth;
  return {
    stats,
    kpis: { total: emps.length, active, tasksThisMonth: tasksMonth, verifiedHoursThisMonth: hoursMonth, netBenefitThisMonth: net, trees: {
      total: { label: "AI employees", value: emps.length, basis: "observed", formula: "count of ai_employees rows", children: (["draft", "sandbox", "pilot", "active", "paused", "retired"] as const).map((s) => ({ label: s, value: emps.filter((e) => e.status === s).length, basis: "observed" as const })) },
      active: { label: "Active AI employees", value: active, basis: "observed", formula: "status = active (requires owner/admin + a successful live run)" },
      tasks: { label: "Tasks completed this month", value: tasksMonth, unit: "tasks", basis: "observed", formula: "live skill runs succeeded since the 1st (sandbox excluded)" },
      hours: { label: "Verified hours this month", value: hoursMonth, unit: "hours", basis: "observed", formula: "Σ (manual baseline − human review) over live succeeded runs this month", children: hoursTreeKids },
      net: { label: "Net capacity benefit this month", value: net, unit: "usd", basis: "observed", formula: "verified hours × loaded hourly − linked agent cost (month to date). Capacity, not cash.", children: [
        { label: "Capacity value", value: valueMonth, unit: "usd", basis: "observed" }, { label: "Linked agent cost (month to date)", value: costMonth, unit: "usd", basis: "assumed" },
      ] },
    } },
  };
}
