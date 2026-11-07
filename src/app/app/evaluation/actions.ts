"use server";
/** Evaluation snapshots: save (live computation frozen as JSON), mark presented / approved. analysis:run + audited. */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { computeEvaluation } from "@/engine/evaluation";

type Result = { ok: true; id: string } | { ok: false; error: string };

export async function saveEvaluationSnapshot(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("analysis:run");
  const p = z.object({ name: z.string().trim().min(3, "Name must be at least 3 characters").max(120) }).safeParse(raw);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
  try {
    const ev = await computeEvaluation(ctx.orgId);
    const steps = Object.fromEntries(ev.steps.map((s) => [s.key, { done: s.done, note: s.evidence, ...(s.done ? { at: ev.computedAt } : {}) }]));
    const snapshot = { ...ev.snapshot, dimensionDetail: ev.dimensions.map((d) => ({ key: d.key, label: d.label, score: d.score, weight: d.weight, confidence: d.confidence.level, inputs: d.inputs, missingEvidence: d.missingEvidence })) };
    const [row] = await withTenant(ctx.orgId, (tx) => tx.insert(schema.evaluations).values({ orgId: ctx.orgId, name: p.data.name, status: "in_progress", steps, snapshot, createdBy: ctx.userId }).returning({ id: schema.evaluations.id }));
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "evaluation.snapshot_saved", entityType: "evaluation", entityId: row.id, details: { name: p.data.name, score: ev.score } });
    revalidatePath("/app/evaluation"); revalidatePath("/app/benchmarking");
    return { ok: true, id: row.id };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

const NEXT: Record<"presented" | "approved", string[]> = { presented: ["in_progress"], approved: ["presented"] };
export async function setEvaluationStatus(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("analysis:run");
  const p = z.object({ id: z.string().uuid(), status: z.enum(["presented", "approved"]) }).safeParse(raw);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
  if (p.data.status === "approved" && ctx.role !== "owner" && ctx.role !== "admin") return { ok: false, error: "Only an owner or admin of this organization can approve an evaluation" };
  try {
    const from = await withTenant(ctx.orgId, async (tx) => {
      const [r] = await tx.select({ status: schema.evaluations.status }).from(schema.evaluations).where(and(eq(schema.evaluations.id, p.data.id), eq(schema.evaluations.orgId, ctx.orgId))).limit(1);
      if (!r) throw new Error("evaluation not found");
      if (!NEXT[p.data.status].includes(r.status)) throw new Error(`cannot mark a ${r.status.replace("_", " ")} evaluation as ${p.data.status}`);
      await tx.update(schema.evaluations).set({ status: p.data.status, updatedAt: new Date() }).where(and(eq(schema.evaluations.id, p.data.id), eq(schema.evaluations.orgId, ctx.orgId)));
      return r.status;
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: `evaluation.${p.data.status}`, entityType: "evaluation", entityId: p.data.id, details: { from } });
    revalidatePath("/app/evaluation");
    return { ok: true, id: p.data.id };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
