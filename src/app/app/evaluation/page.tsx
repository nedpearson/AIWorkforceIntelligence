import { desc, eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { computeEvaluation, type EvaluationSnapshot } from "@/engine/evaluation";
import { EvaluationClient, type SnapshotRow } from "./evaluation-client";

export const metadata = { title: "Business Evaluation" };
export const dynamic = "force-dynamic";

export default async function EvaluationPage() {
  const ctx = await requireCtx("workflows:read");
  const [ev, rows] = await Promise.all([
    computeEvaluation(ctx.orgId),
    withTenant(ctx.orgId, (tx) => tx.select().from(schema.evaluations).where(eq(schema.evaluations.orgId, ctx.orgId)).orderBy(desc(schema.evaluations.createdAt))),
  ]);
  const snapshots: SnapshotRow[] = rows.filter((r) => r.snapshot).map((r) => ({ id: r.id, name: r.name, status: r.status, createdAt: r.createdAt.toISOString(), snapshot: r.snapshot as unknown as EvaluationSnapshot }));
  return <EvaluationClient ev={ev} snapshots={snapshots} canWrite={can(ctx.role, "analysis:run")} canApprove={can(ctx.role, "analysis:run") && (ctx.role === "owner" || ctx.role === "admin")} />;
}
