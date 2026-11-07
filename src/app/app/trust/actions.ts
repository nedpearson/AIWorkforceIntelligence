"use server";
/** Employee self-service actions on the Trust & Privacy page. Operate only on ctx.employeeId — never on a submitted id. */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { withdrawAndPause, acknowledgeFromWeb } from "../collection/consent-lib";

type Result = { ok: true } | { ok: false; error: string };
const revalidate = () => { revalidatePath("/app/trust"); revalidatePath("/app/collection"); };

export async function withdrawMyConsent(): Promise<Result> {
  const ctx = await requireCtx("self:read");
  if (!ctx.employeeId) return { ok: false, error: "Your login is not linked to an employee record, so there is nothing to withdraw." };
  await withdrawAndPause(ctx.orgId, ctx.employeeId, ctx.userId, "employee");
  revalidate(); return { ok: true };
}
export async function acknowledgeMyNotice(): Promise<Result> {
  const ctx = await requireCtx("self:read");
  if (!ctx.employeeId) return { ok: false, error: "Your login is not linked to an employee record." };
  await acknowledgeFromWeb(ctx.orgId, ctx.employeeId, ctx.userId);
  revalidate(); return { ok: true };
}
const PauseInput = z.object({ minutes: z.number().int().min(15).max(7 * 24 * 60).optional(), resume: z.boolean().optional() });
export async function pauseMyCollector(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("self:read");
  if (!ctx.employeeId) return { ok: false, error: "Your login is not linked to an employee record." };
  const p = PauseInput.safeParse(raw); if (!p.success) return { ok: false, error: "invalid" };
  const employeeId = ctx.employeeId;
  const n = await withTenant(ctx.orgId, async (tx) => {
    const rows = p.data.resume
      ? await tx.update(schema.collectors).set({ status: "active", pausedUntil: null, updatedAt: new Date() }).where(and(eq(schema.collectors.orgId, ctx.orgId), eq(schema.collectors.employeeId, employeeId), eq(schema.collectors.status, "paused"))).returning({ id: schema.collectors.id })
      : await tx.update(schema.collectors).set({ status: "paused", pausedUntil: p.data.minutes ? new Date(Date.now() + p.data.minutes * 60_000) : null, updatedAt: new Date() }).where(and(eq(schema.collectors.orgId, ctx.orgId), eq(schema.collectors.employeeId, employeeId))).returning({ id: schema.collectors.id });
    return rows.length;
  });
  if (!n) return { ok: false, error: p.data.resume ? "No paused collector found for you." : "No collector is installed for you yet." };
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: p.data.resume ? "collector.resumed" : "collector.paused", entityType: "employee", entityId: employeeId, details: { by: "employee", minutes: p.data.minutes, collectors: n } });
  revalidate(); return { ok: true };
}
