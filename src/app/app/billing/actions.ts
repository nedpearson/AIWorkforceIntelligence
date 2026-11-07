"use server";
/** Server actions for /app/billing. `org:billing` permission; Stripe calls go through the billing engine, which never fakes success. */
import { z } from "zod";
import { requireCtx } from "@/lib/session";
import { audit } from "@/lib/audit";
import { createCheckoutSession, createPortalSession, PLAN_KEYS, type PlanKey } from "@/engine/billing";

type Result = { ok: true; url: string } | { ok: false; error: string; missing?: string[] };
const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");

export async function startCheckout(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("org:billing");
  const p = z.object({ plan: z.enum(PLAN_KEYS as [PlanKey, ...PlanKey[]]) }).safeParse(raw);
  if (!p.success) return { ok: false, error: "Unknown plan" };
  const base = appUrl();
  const r = await createCheckoutSession(ctx.orgId, p.data.plan, { successUrl: `${base}/app/billing?checkout=success`, cancelUrl: `${base}/app/billing?checkout=canceled`, actorUserId: ctx.userId, customerEmail: ctx.email ?? undefined });
  if (!r.ok) { await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "billing.checkout_blocked", entityType: "subscription", details: { plan: p.data.plan, reason: r.reason, missing: r.missing ?? [] } }); return { ok: false, error: r.reason, missing: r.missing }; }
  return { ok: true, url: r.url };
}

export async function openPortal(): Promise<Result> {
  const ctx = await requireCtx("org:billing");
  const r = await createPortalSession(ctx.orgId, `${appUrl()}/app/billing`, ctx.userId);
  if (!r.ok) { await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "billing.portal_blocked", entityType: "subscription", details: { reason: r.reason, missing: r.missing ?? [] } }); return { ok: false, error: r.reason, missing: r.missing }; }
  return { ok: true, url: r.url };
}
