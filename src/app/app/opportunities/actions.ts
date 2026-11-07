"use server";
/** Server actions for /app/opportunities. zod-validated, permission-checked (opportunities:write), tenant-scoped, audited. */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";

type Result = { ok: true; status: string } | { ok: false; error: string };
const Input = z.object({ id: z.string().uuid(), action: z.enum(["approve", "reject", "reopen", "review"]), note: z.string().max(500).optional() });

/** Allowed transitions. Deployed/verified opportunities are owned by their agent and cannot be changed here. */
const NEXT: Record<"approve" | "reject" | "reopen" | "review", { from: string[]; to: "approved" | "rejected" | "identified" | "reviewing" }> = {
  approve: { from: ["identified", "reviewing", "rejected"], to: "approved" },
  reject: { from: ["identified", "reviewing", "approved"], to: "rejected" },
  reopen: { from: ["rejected", "approved"], to: "identified" },
  review: { from: ["identified"], to: "reviewing" },
};

export async function setOpportunityStatus(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("opportunities:write");
  const p = Input.safeParse(raw); if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
  const { id, action, note } = p.data; const t = NEXT[action];
  try {
    const result = await withTenant(ctx.orgId, async (tx) => {
      const [o] = await tx.select({ id: schema.opportunities.id, status: schema.opportunities.status, title: schema.opportunities.title }).from(schema.opportunities).where(and(eq(schema.opportunities.id, id), eq(schema.opportunities.orgId, ctx.orgId))).limit(1);
      if (!o) throw new Error("opportunity not found in this organization");
      if (!t.from.includes(o.status)) throw new Error(`cannot ${action} an opportunity that is ${o.status.replace("_", " ")}`);
      await tx.update(schema.opportunities).set({ status: t.to, updatedAt: new Date() }).where(and(eq(schema.opportunities.id, id), eq(schema.opportunities.orgId, ctx.orgId)));
      return { from: o.status, title: o.title };
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: `opportunity.${action}`, entityType: "opportunity", entityId: id, details: { from: result.from, to: t.to, note: note ?? null, title: result.title } });
    revalidatePath("/app/opportunities"); revalidatePath(`/app/opportunities/${id}`); revalidatePath("/app"); revalidatePath("/app/onboarding");
    return { ok: true, status: t.to };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
