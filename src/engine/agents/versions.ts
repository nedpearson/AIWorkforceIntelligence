/**
 * Agent definition versions — immutable `agent_versions` rows written on every definition save, settings save that
 * changes the approval policy, deploy and rollback. Enables a structural diff between any two versions and a rollback
 * that itself becomes a new version (history is never rewritten).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant, type TenantDb } from "@/db/tenant";
import { audit } from "@/lib/audit";
import type { AgentDefinition, ApprovalPolicy } from "@/db/schema";

export type AgentVersionRow = typeof schema.agentVersions.$inferSelect;

/**
 * Insert version n+1 inside the caller's transaction. If the agent has no versions yet (created before versioning
 * existed) and `previous` is given, that prior state is first stored as v1 "baseline" so the change stays diffable.
 */
export async function recordVersionTx(tx: TenantDb, p: { orgId: string; agentId: string; definition: AgentDefinition; approvalPolicy?: ApprovalPolicy | null; note: string; createdBy?: string | null; previous?: { definition: AgentDefinition; approvalPolicy?: ApprovalPolicy | null } }): Promise<number> {
  // Serialize concurrent writers for this agent (unique index on agent_id, version is the backstop).
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${p.agentId}))`);
  const [cur] = await tx.select({ v: sql<number>`coalesce(max(${schema.agentVersions.version}), 0)::int` }).from(schema.agentVersions).where(and(eq(schema.agentVersions.orgId, p.orgId), eq(schema.agentVersions.agentId, p.agentId)));
  let v = Number(cur?.v ?? 0);
  if (v === 0 && p.previous) {
    v = 1;
    await tx.insert(schema.agentVersions).values({ orgId: p.orgId, agentId: p.agentId, version: v, definition: p.previous.definition, approvalPolicy: p.previous.approvalPolicy ?? null, note: "baseline (state before version history was enabled)", createdBy: null });
  }
  v += 1;
  await tx.insert(schema.agentVersions).values({ orgId: p.orgId, agentId: p.agentId, version: v, definition: p.definition, approvalPolicy: p.approvalPolicy ?? null, note: p.note.slice(0, 500), createdBy: p.createdBy ?? null });
  return v;
}

export async function listVersions(orgId: string, agentId: string): Promise<AgentVersionRow[]> {
  return withTenant(orgId, (tx) => tx.select().from(schema.agentVersions).where(and(eq(schema.agentVersions.orgId, orgId), eq(schema.agentVersions.agentId, agentId))).orderBy(desc(schema.agentVersions.version)));
}

/** Restore definition + approval policy from version `version`; records a new version "rollback to vN". Audited. */
export async function rollbackToVersion(orgId: string, agentId: string, version: number, userId: string | null): Promise<{ newVersion: number }> {
  const r = await withTenant(orgId, async (tx) => {
    const [agent] = await tx.select().from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId))).limit(1);
    if (!agent) throw new Error("agent not found");
    if (agent.status === "retired") throw new Error("agent is retired");
    const [target] = await tx.select().from(schema.agentVersions).where(and(eq(schema.agentVersions.orgId, orgId), eq(schema.agentVersions.agentId, agentId), eq(schema.agentVersions.version, version))).limit(1);
    if (!target) throw new Error(`version ${version} not found`);
    const approvalPolicy = target.approvalPolicy ?? agent.approvalPolicy ?? { mode: "sensitive_only" as const };
    await tx.update(schema.agents).set({ definition: target.definition, approvalPolicy, updatedAt: new Date() }).where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)));
    const newVersion = await recordVersionTx(tx, { orgId, agentId, definition: target.definition, approvalPolicy, note: `rollback to v${version}`, createdBy: userId, previous: { definition: agent.definition, approvalPolicy: agent.approvalPolicy } });
    return { newVersion };
  });
  await audit({ orgId, actorUserId: userId, action: "agent.version.rollback", entityType: "agent", entityId: agentId, details: { toVersion: version, newVersion: r.newVersion } });
  return r;
}

export { diffDefinitions, type DefinitionDiff, type FieldChange } from "./versions-diff";
