import { and, desc, eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { ApprovalsInbox } from "./approvals-inbox";

export const metadata = { title: "Approvals" };
export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const ctx = await requireCtx("agents:read");
  const rows = await withTenant(ctx.orgId, (tx) => tx.select({ ap: schema.approvals, agentName: schema.agents.name })
    .from(schema.approvals).innerJoin(schema.agents, eq(schema.agents.id, schema.approvals.agentId))
    .where(and(eq(schema.approvals.orgId, ctx.orgId))).orderBy(desc(schema.approvals.createdAt)).limit(200));
  const approvals = rows.map(({ ap, agentName }) => ({ id: ap.id, runId: ap.runId, agentId: ap.agentId, agentName, nodeId: ap.nodeId, status: ap.status, requestedAction: ap.requestedAction, payload: ap.payload ?? {}, createdAt: ap.createdAt.toISOString(), expiresAt: ap.expiresAt?.toISOString() ?? null, decisionNote: ap.decisionNote, decidedAt: ap.decidedAt?.toISOString() ?? null }));
  return <ApprovalsInbox approvals={approvals} canApprove={can(ctx.role, "agents:approve")} />;
}
