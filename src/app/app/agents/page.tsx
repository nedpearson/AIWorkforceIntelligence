import { and, desc, eq, gte, sql } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { num } from "@/lib/utils";
import { AgentsList, type AgentRow } from "./agents-list";

export const metadata = { title: "AI Agents" };
export const dynamic = "force-dynamic";

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ status?: string; category?: string }> }) {
  const ctx = await requireCtx("agents:read");
  const sp = await searchParams;
  const since30 = new Date(Date.now() - 30 * 86400_000);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const data = await withTenant(ctx.orgId, async (tx) => {
    const agents = await tx.select().from(schema.agents).where(eq(schema.agents.orgId, ctx.orgId)).orderBy(desc(schema.agents.updatedAt));
    const runStats = await tx.select({
      agentId: schema.agentRuns.agentId, runs: sql<string>`count(*)`, ok: sql<string>`count(*) filter (where ${schema.agentRuns.status} = 'succeeded')`,
      minutes: sql<string>`coalesce(sum(${schema.agentRuns.minutesSaved}) filter (where ${schema.agentRuns.status} = 'succeeded'), 0)`, last: sql<string | null>`max(${schema.agentRuns.createdAt})`,
    }).from(schema.agentRuns).where(and(eq(schema.agentRuns.orgId, ctx.orgId), gte(schema.agentRuns.createdAt, since30))).groupBy(schema.agentRuns.agentId);
    const [month] = await tx.select({ runs: sql<string>`count(*)` }).from(schema.agentRuns).where(and(eq(schema.agentRuns.orgId, ctx.orgId), gte(schema.agentRuns.createdAt, monthStart)));
    const [pending] = await tx.select({ n: sql<string>`count(*)` }).from(schema.approvals).where(and(eq(schema.approvals.orgId, ctx.orgId), eq(schema.approvals.status, "pending")));
    const [verified] = await tx.select({ hours: sql<string>`coalesce(sum(${schema.savingsMeasurements.hoursSaved}), 0)` }).from(schema.savingsMeasurements).where(and(eq(schema.savingsMeasurements.orgId, ctx.orgId), eq(schema.savingsMeasurements.basis, "observed")));
    const [opps] = await tx.select({ n: sql<string>`count(*)` }).from(schema.opportunities).where(eq(schema.opportunities.orgId, ctx.orgId));
    return { agents, runStats, monthRuns: num(month?.runs), pending: num(pending?.n), verifiedHours: num(verified?.hours), opportunities: num(opps?.n) };
  });
  const stats = new Map(data.runStats.map((r) => [r.agentId, r]));
  const rows: AgentRow[] = data.agents.map((a) => {
    const s = stats.get(a.id);
    return { id: a.id, name: a.name, category: a.category, status: a.status, runtime: a.runtime, runs30: num(s?.runs), successRate: num(s?.runs) ? num(s?.ok) / num(s?.runs) : null, minutes30: num(s?.minutes), monthlyCost: num(a.monthlyCost), lastRunAt: a.lastRunAt?.toISOString() ?? (s?.last ? new Date(s.last).toISOString() : null), externalId: a.externalId };
  });
  const kpis = { deployed: rows.filter((r) => r.status === "deployed").length, monthRuns: data.monthRuns, verifiedHours: data.verifiedHours, pending: data.pending };
  return <AgentsList rows={rows} kpis={kpis} canWrite={can(ctx.role, "agents:write")} canApprove={can(ctx.role, "agents:approve")} canCreds={can(ctx.role, "credentials:manage")} initialStatus={sp.status ?? ""} initialCategory={sp.category ?? ""} hasOpportunities={data.opportunities > 0} />;
}
