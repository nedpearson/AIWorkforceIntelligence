"use server";
/** Server actions for /app/agents/**. Every mutation: zod-validated, permission-checked, tenant-scoped, audited. */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { can } from "@/lib/rbac";
import { getTemplate } from "@/engine/agents/templates";
import { validateDefinition } from "@/engine/agents/definition";
import { startRun, resumeRun, type RunResult } from "@/engine/agents/runner";
import { checkConnection, pushWorkflow, pullExecutionsIntoRunLedger, triggerViaWebhook } from "@/engine/agents/n8n";
import { measureAgent } from "@/engine/agents/measure";
import type { ApprovalPolicy, AgentDefinition } from "@/db/schema";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): Result<never> => ({ ok: false, error });
const uuid = z.string().uuid();
const revalidate = (id?: string) => { revalidatePath("/app/agents"); revalidatePath("/app/agents/approvals"); if (id) revalidatePath(`/app/agents/${id}`); };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const ApprovalPolicySchema = z.object({ mode: z.enum(["none", "sensitive_only", "all"]), approverRole: z.enum(["admin", "manager", "owner"]).optional(), timeoutHours: z.number().int().min(1).max(720).optional() });
const CreateAgentInput = z.object({
  templateKey: z.string().min(1), name: z.string().min(2).max(120), opportunityId: uuid.optional().nullable(), workflowId: uuid.optional().nullable(),
  credentialIds: z.array(uuid).max(20).default([]), approvalPolicy: ApprovalPolicySchema.default({ mode: "sensitive_only" }),
  schedule: z.string().max(120).optional().nullable(), runtime: z.enum(["internal", "n8n"]).default("internal"),
});
export async function createAgent(raw: unknown): Promise<Result<{ id: string }>> {
  const ctx = await requireCtx("agents:write");
  const p = CreateAgentInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid");
  const t = getTemplate(p.data.templateKey); if (!t) return fail("unknown template");
  const d = p.data;
  try {
    const id = await withTenant(ctx.orgId, async (tx) => {
      // Links must belong to this org (RLS enforces, we also check so the error is readable).
      let workflowId = d.workflowId ?? null;
      if (d.opportunityId) {
        const [opp] = await tx.select({ id: schema.opportunities.id, workflowId: schema.opportunities.workflowId }).from(schema.opportunities).where(and(eq(schema.opportunities.id, d.opportunityId), eq(schema.opportunities.orgId, ctx.orgId))).limit(1);
        if (!opp) throw new Error("opportunity not found in this organization");
        workflowId ??= opp.workflowId;
      }
      if (d.credentialIds.length) {
        const rows = await tx.select({ id: schema.credentials.id }).from(schema.credentials).where(eq(schema.credentials.orgId, ctx.orgId));
        const have = new Set(rows.map((r) => r.id));
        if (d.credentialIds.some((c) => !have.has(c))) throw new Error("one of the credentials does not belong to this organization");
      }
      const definition: AgentDefinition = { ...t.definition, ...(d.schedule ? { schedule: d.schedule } : {}) };
      const [row] = await tx.insert(schema.agents).values({
        orgId: ctx.orgId, opportunityId: d.opportunityId ?? null, workflowId, name: d.name, category: t.category, templateKey: t.key, status: "configured", runtime: d.runtime,
        definition, credentialIds: d.credentialIds, approvalPolicy: d.approvalPolicy as ApprovalPolicy, expectedMinutesSavedPerRun: String(t.expectedMinutesSavedPerRun), baselineMinutesPerRun: String(t.baselineMinutesPerRun), monthlyCost: String(t.monthlyCost), createdBy: ctx.userId,
      }).returning({ id: schema.agents.id });
      if (d.opportunityId) await tx.update(schema.opportunities).set({ agentId: row.id, status: "in_progress", updatedAt: new Date() }).where(and(eq(schema.opportunities.id, d.opportunityId), eq(schema.opportunities.orgId, ctx.orgId)));
      return row.id;
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "agent.created", entityType: "agent", entityId: id, details: { templateKey: t.key, runtime: d.runtime, opportunityId: d.opportunityId } });
    revalidate(id); return { ok: true, id };
  } catch (e) { return fail(msg(e)); }
}

const UpdateDefinitionInput = z.object({ agentId: uuid, definition: z.unknown() });
export async function updateAgentDefinition(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("agents:write");
  const p = UpdateDefinitionInput.safeParse(raw); if (!p.success) return fail("invalid input");
  const v = validateDefinition(p.data.definition); if (!v.ok) return fail(v.errors.slice(0, 3).join("; "));
  const n = await withTenant(ctx.orgId, (tx) => tx.update(schema.agents).set({ definition: v.definition, updatedAt: new Date() }).where(and(eq(schema.agents.id, p.data.agentId), eq(schema.agents.orgId, ctx.orgId))).returning({ id: schema.agents.id }));
  if (!n.length) return fail("agent not found");
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "agent.definition.updated", entityType: "agent", entityId: p.data.agentId, details: { nodes: v.definition.nodes.length, edges: v.definition.edges.length } });
  revalidate(p.data.agentId); return { ok: true };
}

const UpdateSettingsInput = z.object({ agentId: uuid, name: z.string().min(2).max(120).optional(), credentialIds: z.array(uuid).max(20).optional(), approvalPolicy: ApprovalPolicySchema.optional(), runtime: z.enum(["internal", "n8n"]).optional() });
export async function updateAgentSettings(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("agents:write");
  const p = UpdateSettingsInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid");
  const { agentId, ...patch } = p.data;
  const n = await withTenant(ctx.orgId, (tx) => tx.update(schema.agents).set({ ...patch, approvalPolicy: patch.approvalPolicy as ApprovalPolicy | undefined, updatedAt: new Date() }).where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, ctx.orgId))).returning({ id: schema.agents.id }));
  if (!n.length) return fail("agent not found");
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "agent.settings.updated", entityType: "agent", entityId: agentId, details: patch });
  revalidate(agentId); return { ok: true };
}

const StatusInput = z.object({ agentId: uuid, status: z.enum(["deployed", "paused", "retired"]) });
export async function setAgentStatus(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("agents:write");
  const p = StatusInput.safeParse(raw); if (!p.success) return fail("invalid input");
  const { agentId, status } = p.data;
  const n = await withTenant(ctx.orgId, async (tx) => {
    const [cur] = await tx.select({ deployedAt: schema.agents.deployedAt, opportunityId: schema.agents.opportunityId }).from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, ctx.orgId))).limit(1);
    if (!cur) return 0;
    await tx.update(schema.agents).set({ status, deployedAt: status === "deployed" ? (cur.deployedAt ?? new Date()) : cur.deployedAt, updatedAt: new Date() }).where(eq(schema.agents.id, agentId));
    if (cur.opportunityId && status === "deployed") await tx.update(schema.opportunities).set({ status: "deployed", updatedAt: new Date() }).where(and(eq(schema.opportunities.id, cur.opportunityId), eq(schema.opportunities.orgId, ctx.orgId)));
    return 1;
  });
  if (!n) return fail("agent not found");
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: `agent.${status}`, entityType: "agent", entityId: agentId });
  revalidate(agentId); return { ok: true };
}

const RunNowInput = z.object({ agentId: uuid, input: z.record(z.string(), z.unknown()).default({}) });
export async function runAgentNow(raw: unknown): Promise<Result<{ run: RunResult }>> {
  const ctx = await requireCtx("agents:write");
  const p = RunNowInput.safeParse(raw); if (!p.success) return fail("input must be a JSON object");
  try {
    const [agent] = await withTenant(ctx.orgId, (tx) => tx.select().from(schema.agents).where(and(eq(schema.agents.id, p.data.agentId), eq(schema.agents.orgId, ctx.orgId))).limit(1));
    if (!agent) return fail("agent not found");
    if (agent.runtime === "n8n") {
      const r = await triggerViaWebhook(ctx.orgId, agent, p.data.input);
      if (!r.ok) return fail(r.reason);
      await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "agent.n8n.triggered", entityType: "agent", entityId: agent.id, details: { status: r.status } });
      const pulled = await pullExecutionsIntoRunLedger(ctx.orgId, agent.id);
      revalidate(agent.id);
      return { ok: true, run: { runId: "", status: "queued", error: pulled.ok ? null : pulled.reason } };
    }
    const run = await startRun({ orgId: ctx.orgId, agentId: agent.id, trigger: "manual", input: p.data.input, actorUserId: ctx.userId });
    revalidate(agent.id); return { ok: true, run };
  } catch (e) { return fail(msg(e)); }
}

const RetryInput = z.object({ runId: uuid });
export async function retryRun(raw: unknown): Promise<Result<{ run: RunResult }>> {
  const ctx = await requireCtx("agents:write");
  const p = RetryInput.safeParse(raw); if (!p.success) return fail("invalid input");
  const [prev] = await withTenant(ctx.orgId, (tx) => tx.select({ agentId: schema.agentRuns.agentId, input: schema.agentRuns.input, status: schema.agentRuns.status }).from(schema.agentRuns).where(and(eq(schema.agentRuns.id, p.data.runId), eq(schema.agentRuns.orgId, ctx.orgId))).limit(1));
  if (!prev) return fail("run not found");
  if (!["failed", "rolled_back", "cancelled"].includes(prev.status)) return fail("only failed, rolled-back or cancelled runs can be retried");
  try {
    const run = await startRun({ orgId: ctx.orgId, agentId: prev.agentId, trigger: "retry", input: prev.input ?? {}, actorUserId: ctx.userId });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "agent.run.retry", entityType: "agent_run", entityId: run.runId, details: { of: p.data.runId } });
    revalidate(prev.agentId); return { ok: true, run };
  } catch (e) { return fail(msg(e)); }
}

/** Run detail for the drawer (polled while running). */
export async function getRun(raw: unknown): Promise<Result<{ run: typeof schema.agentRuns.$inferSelect; approvals: (typeof schema.approvals.$inferSelect)[] }>> {
  const ctx = await requireCtx("agents:read");
  const p = RetryInput.safeParse(raw); if (!p.success) return fail("invalid input");
  const r = await withTenant(ctx.orgId, async (tx) => {
    const [run] = await tx.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.id, p.data.runId), eq(schema.agentRuns.orgId, ctx.orgId))).limit(1);
    if (!run) return null;
    const approvals = await tx.select().from(schema.approvals).where(and(eq(schema.approvals.runId, run.id), eq(schema.approvals.orgId, ctx.orgId))).orderBy(desc(schema.approvals.createdAt));
    return { run, approvals };
  });
  return r ? { ok: true, ...r } : fail("run not found");
}

const DecideInput = z.object({ approvalId: uuid, decision: z.enum(["approved", "rejected"]), note: z.string().max(2000).optional() });
export async function decideApproval(raw: unknown): Promise<Result<{ run: RunResult }>> {
  const ctx = await requireCtx("agents:approve");
  const p = DecideInput.safeParse(raw); if (!p.success) return fail("invalid input");
  const [ap] = await withTenant(ctx.orgId, (tx) => tx.select({ runId: schema.approvals.runId, agentId: schema.approvals.agentId, status: schema.approvals.status }).from(schema.approvals).where(and(eq(schema.approvals.id, p.data.approvalId), eq(schema.approvals.orgId, ctx.orgId))).limit(1));
  if (!ap) return fail("approval not found");
  if (ap.status !== "pending") return fail(`already ${ap.status}`);
  const [agent] = await withTenant(ctx.orgId, (tx) => tx.select({ approvalPolicy: schema.agents.approvalPolicy }).from(schema.agents).where(eq(schema.agents.id, ap.agentId)).limit(1));
  const need = agent?.approvalPolicy?.approverRole;
  if (need && !can(ctx.role, "org:manage") && ctx.role !== need) return fail(`this agent requires a ${need} to approve`);
  try {
    const run = await resumeRun(ap.runId, p.data.approvalId, p.data.decision, ctx.userId, p.data.note, ctx.orgId);
    revalidate(ap.agentId); return { ok: true, run };
  } catch (e) { return fail(msg(e)); }
}

export async function checkN8n(): Promise<Result<{ baseUrl?: string; source?: string }>> {
  const ctx = await requireCtx("agents:read");
  const r = await checkConnection(ctx.orgId);
  return r.ok ? { ok: true, baseUrl: r.baseUrl, source: r.source } : fail(r.reason);
}
const AgentIdInput = z.object({ agentId: uuid });
export async function pushAgentToN8n(raw: unknown): Promise<Result<{ externalId: string; created: boolean }>> {
  const ctx = await requireCtx("agents:write");
  const p = AgentIdInput.safeParse(raw); if (!p.success) return fail("invalid input");
  const [agent] = await withTenant(ctx.orgId, (tx) => tx.select().from(schema.agents).where(and(eq(schema.agents.id, p.data.agentId), eq(schema.agents.orgId, ctx.orgId))).limit(1));
  if (!agent) return fail("agent not found");
  const r = await pushWorkflow(ctx.orgId, agent);
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: r.ok ? "agent.n8n.pushed" : "agent.n8n.push_failed", entityType: "agent", entityId: agent.id, details: r.ok ? { externalId: r.externalId, created: r.created } : { reason: r.reason } });
  revalidate(agent.id);
  return r.ok ? { ok: true, externalId: r.externalId, created: r.created } : fail(r.reason);
}
export async function pullN8nRuns(raw: unknown): Promise<Result<{ imported: number; updated: number }>> {
  const ctx = await requireCtx("agents:write");
  const p = AgentIdInput.safeParse(raw); if (!p.success) return fail("invalid input");
  const r = await pullExecutionsIntoRunLedger(ctx.orgId, p.data.agentId);
  if (r.ok) await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "agent.n8n.pulled", entityType: "agent", entityId: p.data.agentId, details: { imported: r.imported, updated: r.updated } });
  revalidate(p.data.agentId);
  return r.ok ? { ok: true, imported: r.imported, updated: r.updated } : fail(r.reason);
}

const MeasureInput = z.object({ agentId: uuid, periodStart: z.string(), periodEnd: z.string() });
export async function recordMeasurement(raw: unknown): Promise<Result<{ summary: Record<string, number> }>> {
  const ctx = await requireCtx("agents:write");
  const p = MeasureInput.safeParse(raw); if (!p.success) return fail("invalid input");
  const start = new Date(p.data.periodStart), end = new Date(p.data.periodEnd);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return fail("invalid dates");
  try {
    const r = await measureAgent(ctx.orgId, p.data.agentId, { start, end });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "agent.measured", entityType: "agent", entityId: p.data.agentId, details: { periodStart: start.toISOString(), periodEnd: end.toISOString(), ...r.summary } });
    revalidate(p.data.agentId); return { ok: true, summary: r.summary };
  } catch (e) { return fail(msg(e)); }
}
