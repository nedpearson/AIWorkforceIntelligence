import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { num } from "@/lib/utils";
import { getTemplate } from "@/engine/agents/templates";
import { resolveConfig } from "@/engine/agents/n8n";
import { beforeAfterComparison } from "@/engine/agents/measure";
import { computeAgentPortfolio } from "@/engine/agents/portfolio";
import { AgentDetail, type RunRow, type ApprovalRow, type MeasurementRow, type VersionRow } from "./agent-detail";
import type { CalcTree } from "@/db/schema";

export const metadata = { title: "Agent" };
export const dynamic = "force-dynamic";

export default async function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireCtx("agents:read");
  const { id } = await params; const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await withTenant(ctx.orgId, async (tx) => {
    const [agent] = await tx.select().from(schema.agents).where(and(eq(schema.agents.id, id), eq(schema.agents.orgId, ctx.orgId))).limit(1);
    if (!agent) return null;
    const opp = agent.opportunityId ? (await tx.select().from(schema.opportunities).where(and(eq(schema.opportunities.id, agent.opportunityId), eq(schema.opportunities.orgId, ctx.orgId))).limit(1))[0] ?? null : null;
    const runs = await tx.select({ id: schema.agentRuns.id, status: schema.agentRuns.status, trigger: schema.agentRuns.trigger, startedAt: schema.agentRuns.startedAt, finishedAt: schema.agentRuns.finishedAt, createdAt: schema.agentRuns.createdAt, minutesSaved: schema.agentRuns.minutesSaved, humanMinutes: schema.agentRuns.humanMinutes, error: schema.agentRuns.error, currentNodeId: schema.agentRuns.currentNodeId }).from(schema.agentRuns).where(and(eq(schema.agentRuns.agentId, id), eq(schema.agentRuns.orgId, ctx.orgId))).orderBy(desc(schema.agentRuns.createdAt)).limit(100);
    const approvals = await tx.select().from(schema.approvals).where(and(eq(schema.approvals.agentId, id), eq(schema.approvals.orgId, ctx.orgId))).orderBy(desc(schema.approvals.createdAt)).limit(50);
    const measurements = await tx.select().from(schema.savingsMeasurements).where(and(eq(schema.savingsMeasurements.agentId, id), eq(schema.savingsMeasurements.orgId, ctx.orgId))).orderBy(desc(schema.savingsMeasurements.periodEnd)).limit(24);
    const creds = await tx.select({ id: schema.credentials.id, name: schema.credentials.name, provider: schema.credentials.provider }).from(schema.credentials).where(eq(schema.credentials.orgId, ctx.orgId));
    const [n8nRow] = await tx.select({ status: schema.integrations.status, lastError: schema.integrations.lastError }).from(schema.integrations).where(and(eq(schema.integrations.orgId, ctx.orgId), eq(schema.integrations.provider, "n8n"))).limit(1);
    const versions = await tx.select({ id: schema.agentVersions.id, version: schema.agentVersions.version, definition: schema.agentVersions.definition, approvalPolicy: schema.agentVersions.approvalPolicy, note: schema.agentVersions.note, createdAt: schema.agentVersions.createdAt, createdBy: schema.agentVersions.createdBy, createdByName: schema.users.name, createdByEmail: schema.users.email })
      .from(schema.agentVersions).leftJoin(schema.users, eq(schema.users.id, schema.agentVersions.createdBy))
      .where(and(eq(schema.agentVersions.agentId, id), eq(schema.agentVersions.orgId, ctx.orgId))).orderBy(desc(schema.agentVersions.version)).limit(200);
    return { agent, opp, runs, approvals, measurements, creds, n8nRow, versions };
  });
  if (!data) notFound();
  const { agent } = data;
  let beforeAfter: CalcTree | null = null;
  if (agent.workflowId && agent.deployedAt) { try { beforeAfter = await beforeAfterComparison(ctx.orgId, agent.workflowId, agent.deployedAt); } catch { beforeAfter = null; } }
  const t = getTemplate(agent.templateKey);
  const runs: RunRow[] = data.runs.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, createdAt: r.createdAt.toISOString(), startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null, minutesSaved: r.minutesSaved == null ? null : num(r.minutesSaved), humanMinutes: num(r.humanMinutes), error: r.error, currentNodeId: r.currentNodeId }));
  const approvals: ApprovalRow[] = data.approvals.map((a) => ({ id: a.id, runId: a.runId, nodeId: a.nodeId, status: a.status, requestedAction: a.requestedAction, payload: a.payload ?? {}, createdAt: a.createdAt.toISOString(), expiresAt: a.expiresAt?.toISOString() ?? null, decisionNote: a.decisionNote, decidedAt: a.decidedAt?.toISOString() ?? null }));
  const measurements: MeasurementRow[] = data.measurements.map((m) => ({ id: m.id, periodStart: m.periodStart.toISOString(), periodEnd: m.periodEnd.toISOString(), method: m.method, runs: m.runs, hoursSaved: num(m.hoursSaved), dollarsSaved: num(m.dollarsSaved), costIncurred: num(m.costIncurred), basis: m.basis, calculation: m.calculation }));
  const n8nConfigured = !!(await resolveConfig(ctx.orgId));
  const pf = await computeAgentPortfolio(ctx.orgId, { windowDays: 30 });
  const metrics = pf.agents.find((x) => x.id === agent.id) ?? null;
  const versions: VersionRow[] = data.versions.map((v) => ({ id: v.id, version: v.version, definition: v.definition, approvalPolicy: v.approvalPolicy ?? null, note: v.note, createdAt: v.createdAt.toISOString(), by: v.createdByName ?? v.createdByEmail ?? (v.createdBy ? "user" : "system") }));
  return (
    <AgentDetail
      agent={{ id: agent.id, name: agent.name, category: agent.category, templateKey: agent.templateKey, status: agent.status, runtime: agent.runtime, externalId: agent.externalId, definition: agent.definition, credentialIds: agent.credentialIds ?? [], approvalPolicy: agent.approvalPolicy ?? { mode: "sensitive_only" }, expectedMinutesSavedPerRun: num(agent.expectedMinutesSavedPerRun), baselineMinutesPerRun: num(agent.baselineMinutesPerRun), monthlyCost: num(agent.monthlyCost), deployedAt: agent.deployedAt?.toISOString() ?? null, lastRunAt: agent.lastRunAt?.toISOString() ?? null, workflowId: agent.workflowId }}
      template={t ? { description: t.description, requiredCredentials: t.requiredCredentials, exampleInput: (t.definition.nodes[0]?.config?.example as Record<string, unknown>) ?? {} } : null}
      opportunity={data.opp ? { id: data.opp.id, title: data.opp.title, status: data.opp.status, realizable: num(data.opp.realizableAnnualSavings), calculation: data.opp.calculation, basis: data.opp.basis } : null}
      runs={runs} approvals={approvals} measurements={measurements} beforeAfter={beforeAfter} credentials={data.creds}
      n8n={{ configured: n8nConfigured, status: data.n8nRow?.status ?? "not_configured", lastError: data.n8nRow?.lastError ?? null }}
      perms={{ write: can(ctx.role, "agents:write"), approve: can(ctx.role, "agents:approve") }} initialTab={sp.tab ?? "overview"}
      versions={versions} metrics={metrics} windowDays={pf.windowDays} timezone={pf.timezone} />
  );
}
