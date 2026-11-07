/**
 * Billing engine — plans, seat limits and the Stripe integration.
 *
 *  - PLANS / EXTRA_SEAT_MONTHLY / EXTRA_AGENT_MONTHLY   → our list prices (docs/BILLING.md has the economics)
 *  - planMonthly(plan, seats, agentSlots)               → what we bill per month for a subscription row
 *  - stripeConfig()                                     → { ok, stripe, prices } or { ok:false, missing[] } — never fakes
 *  - createCheckoutSession / createPortalSession        → real Stripe calls; return { ok:false, reason, missing } when not configured
 *  - syncSubscriptionFromStripe(orgId)                  → pull subscription + invoices for one org
 *  - verifyWebhook(rawBody, signature)                  → stripe.webhooks.constructEvent with STRIPE_WEBHOOK_SECRET
 *  - handleStripeEvent(event)                           → idempotent (event id stored in `jobs` kind `stripe_event`)
 *  - seatUsage(orgId) / assertSeatAvailable(orgId)      → seat enforcement; call assertSeatAvailable from the
 *                                                          collection enrollment path (createEnrollmentCode) and /api/collect/enroll.
 *
 * Subscription/invoice rows are tenant-scoped and written through withTenant(). Looking a Stripe id up to find
 * the org (webhooks arrive without a tenant) uses the admin handle — the same sanctioned pattern as collector tokens.
 * Never import "server-only" here (tests + scripts).
 */
import Stripe from "stripe";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { num } from "@/lib/utils";
import { DEFAULTS } from "./costing";

export type PlanKey = "starter" | "growth" | "enterprise";
export const PLANS: Record<PlanKey, { label: string; priceMonthly: number; seats: number; agents: number; blurb: string }> = {
  starter: { label: "Starter", priceMonthly: 499, seats: 10, agents: 3, blurb: "One department, up to 10 monitored employees and 3 agents." },
  growth: { label: "Growth", priceMonthly: 1499, seats: 50, agents: 10, blurb: "Whole-company observation for up to 50 employees and 10 agents." },
  enterprise: { label: "Enterprise", priceMonthly: 4999, seats: 250, agents: 50, blurb: "Multi-site, up to 250 employees and 50 agents." },
};
export const EXTRA_SEAT_MONTHLY = 19;
export const EXTRA_AGENT_MONTHLY = 149;
export const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];

/** Monthly list price for a subscription row: base plan + extra seats + extra agent slots above the plan allowance. */
export function planMonthly(plan: PlanKey, seats: number, agentSlots: number): { total: number; base: number; extraSeats: number; extraAgents: number; extraSeatCount: number; extraAgentCount: number } {
  const p = PLANS[plan];
  const extraSeatCount = Math.max(0, seats - p.seats);
  const extraAgentCount = Math.max(0, agentSlots - p.agents);
  const extraSeats = extraSeatCount * EXTRA_SEAT_MONTHLY, extraAgents = extraAgentCount * EXTRA_AGENT_MONTHLY;
  return { total: p.priceMonthly + extraSeats + extraAgents, base: p.priceMonthly, extraSeats, extraAgents, extraSeatCount, extraAgentCount };
}
/** Our modelled cost to serve (from costing.ts DEFAULTS): per-agent runtime cost is the only variable cost we model. */
export function costToServe(agentsDeployed: number): { perAgentMonthly: number; agentsMonthly: number } {
  return { perAgentMonthly: DEFAULTS.perAgentMonthly, agentsMonthly: agentsDeployed * DEFAULTS.perAgentMonthly };
}

// ---------- configuration ----------
export type StripePrices = Record<PlanKey, string> & { extraSeat?: string; extraAgent?: string };
export type StripeConfig = { ok: true; stripe: Stripe; prices: StripePrices; webhookSecret: string | null } | { ok: false; missing: string[]; reason: string };
const PRICE_ENV: Record<PlanKey, string> = { starter: "STRIPE_PRICE_STARTER", growth: "STRIPE_PRICE_GROWTH", enterprise: "STRIPE_PRICE_ENTERPRISE" };
let cached: { key: string; stripe: Stripe } | null = null;
export function stripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  const missing: string[] = [];
  if (!env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  for (const k of PLAN_KEYS) if (!env[PRICE_ENV[k]]) missing.push(PRICE_ENV[k]);
  if (missing.length) return { ok: false, missing, reason: `Stripe is not configured. Set ${missing.join(", ")} in .env (see docs/BILLING.md).` };
  const key = env.STRIPE_SECRET_KEY!;
  if (!cached || cached.key !== key) cached = { key, stripe: new Stripe(key, { typescript: true }) };
  const prices: StripePrices = { starter: env.STRIPE_PRICE_STARTER!, growth: env.STRIPE_PRICE_GROWTH!, enterprise: env.STRIPE_PRICE_ENTERPRISE!, extraSeat: env.STRIPE_PRICE_EXTRA_SEAT || undefined, extraAgent: env.STRIPE_PRICE_EXTRA_AGENT || undefined };
  return { ok: true, stripe: cached.stripe, prices, webhookSecret: env.STRIPE_WEBHOOK_SECRET || null };
}
export function planForPrice(priceId: string | null | undefined, prices: StripePrices): PlanKey | null {
  if (!priceId) return null;
  for (const k of PLAN_KEYS) if (prices[k] === priceId) return k;
  return null;
}

export type BillingResult<T> = ({ ok: true } & T) | { ok: false; reason: string; missing?: string[] };

async function loadSubscription(orgId: string) {
  return withTenant(orgId, async (tx) => (await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, orgId)).limit(1))[0] ?? null);
}
async function loadOrg(orgId: string) {
  return withTenant(orgId, async (tx) => (await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1))[0] ?? null);
}

// ---------- checkout / portal ----------
export async function createCheckoutSession(orgId: string, plan: PlanKey, opts: { successUrl: string; cancelUrl: string; seats?: number; agentSlots?: number; actorUserId?: string | null; customerEmail?: string }): Promise<BillingResult<{ url: string; sessionId: string }>> {
  const cfg = stripeConfig(); if (!cfg.ok) return { ok: false, reason: cfg.reason, missing: cfg.missing };
  if (!PLANS[plan]) return { ok: false, reason: "Unknown plan" };
  const sub = await loadSubscription(orgId); const org = await loadOrg(orgId);
  if (!org) return { ok: false, reason: "Organization not found" };
  const seats = Math.max(PLANS[plan].seats, opts.seats ?? sub?.seats ?? PLANS[plan].seats);
  const agentSlots = Math.max(PLANS[plan].agents, opts.agentSlots ?? sub?.agentSlots ?? PLANS[plan].agents);
  const pm = planMonthly(plan, seats, agentSlots);
  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: cfg.prices[plan], quantity: 1 }];
  if (pm.extraSeatCount > 0) { if (!cfg.prices.extraSeat) return { ok: false, reason: "Extra seats need STRIPE_PRICE_EXTRA_SEAT in .env", missing: ["STRIPE_PRICE_EXTRA_SEAT"] }; line_items.push({ price: cfg.prices.extraSeat, quantity: pm.extraSeatCount }); }
  if (pm.extraAgentCount > 0) { if (!cfg.prices.extraAgent) return { ok: false, reason: "Extra agent slots need STRIPE_PRICE_EXTRA_AGENT in .env", missing: ["STRIPE_PRICE_EXTRA_AGENT"] }; line_items.push({ price: cfg.prices.extraAgent, quantity: pm.extraAgentCount }); }
  try {
    const session = await cfg.stripe.checkout.sessions.create({
      mode: "subscription", line_items, success_url: opts.successUrl, cancel_url: opts.cancelUrl,
      client_reference_id: orgId, customer: sub?.stripeCustomerId ?? undefined, customer_email: sub?.stripeCustomerId ? undefined : opts.customerEmail,
      metadata: { orgId, plan, seats: String(seats), agentSlots: String(agentSlots) },
      subscription_data: { metadata: { orgId, plan, seats: String(seats), agentSlots: String(agentSlots) } },
      allow_promotion_codes: true,
    });
    if (!session.url) return { ok: false, reason: "Stripe did not return a checkout URL" };
    await audit({ orgId, actorUserId: opts.actorUserId ?? null, action: "billing.checkout_started", entityType: "subscription", entityId: sub?.id, details: { plan, seats, agentSlots, sessionId: session.id } });
    return { ok: true, url: session.url, sessionId: session.id };
  } catch (e) { return { ok: false, reason: `Stripe error: ${e instanceof Error ? e.message : String(e)}` }; }
}

export async function createPortalSession(orgId: string, returnUrl: string, actorUserId?: string | null): Promise<BillingResult<{ url: string }>> {
  const cfg = stripeConfig(); if (!cfg.ok) return { ok: false, reason: cfg.reason, missing: cfg.missing };
  const sub = await loadSubscription(orgId);
  if (!sub?.stripeCustomerId) return { ok: false, reason: "This client has no Stripe customer yet. Start a checkout first." };
  try {
    const s = await cfg.stripe.billingPortal.sessions.create({ customer: sub.stripeCustomerId, return_url: returnUrl });
    await audit({ orgId, actorUserId: actorUserId ?? null, action: "billing.portal_opened", entityType: "subscription", entityId: sub.id });
    return { ok: true, url: s.url };
  } catch (e) { return { ok: false, reason: `Stripe error: ${e instanceof Error ? e.message : String(e)}` }; }
}

// ---------- mapping ----------
export function mapStripeStatus(s: Stripe.Subscription.Status | string): typeof schema.subscriptions.$inferSelect["status"] {
  switch (s) {
    case "trialing": return "trialing";
    case "active": return "active";
    case "past_due": return "past_due";
    case "canceled": case "incomplete_expired": case "paused": return "canceled";
    case "unpaid": case "incomplete": return "unpaid";
    default: return "unpaid";
  }
}
function periodEndOf(sub: Stripe.Subscription): Date | null {
  const ends = sub.items?.data?.map((i) => i.current_period_end).filter((n): n is number => typeof n === "number") ?? [];
  return ends.length ? new Date(Math.max(...ends) * 1000) : null;
}
function idOf(x: string | { id: string } | null | undefined): string | null { return x == null ? null : typeof x === "string" ? x : x.id; }

/** Translate a Stripe subscription into our row fields. Pure, so the webhook tests can assert it. */
export function subscriptionPatchFromStripe(sub: Stripe.Subscription, prices: StripePrices): Partial<typeof schema.subscriptions.$inferInsert> {
  const items = sub.items?.data ?? [];
  const planItem = items.find((i) => planForPrice(i.price?.id, prices));
  const plan = planForPrice(planItem?.price?.id, prices) ?? ((sub.metadata?.plan as PlanKey | undefined) && PLANS[sub.metadata!.plan as PlanKey] ? (sub.metadata!.plan as PlanKey) : null);
  const extraSeatQty = prices.extraSeat ? items.filter((i) => i.price?.id === prices.extraSeat).reduce((a, i) => a + (i.quantity ?? 0), 0) : 0;
  const extraAgentQty = prices.extraAgent ? items.filter((i) => i.price?.id === prices.extraAgent).reduce((a, i) => a + (i.quantity ?? 0), 0) : 0;
  const patch: Partial<typeof schema.subscriptions.$inferInsert> = {
    stripeSubscriptionId: sub.id, stripeCustomerId: idOf(sub.customer), status: mapStripeStatus(sub.status),
    currentPeriodEnd: periodEndOf(sub), trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null, updatedAt: new Date(),
  };
  if (plan) {
    patch.plan = plan;
    const metaSeats = Number(sub.metadata?.seats); const metaAgents = Number(sub.metadata?.agentSlots);
    patch.seats = extraSeatQty > 0 ? PLANS[plan].seats + extraSeatQty : Number.isFinite(metaSeats) && metaSeats > 0 ? Math.max(PLANS[plan].seats, metaSeats) : PLANS[plan].seats;
    patch.agentSlots = extraAgentQty > 0 ? PLANS[plan].agents + extraAgentQty : Number.isFinite(metaAgents) && metaAgents > 0 ? Math.max(PLANS[plan].agents, metaAgents) : PLANS[plan].agents;
  }
  return patch;
}
export function invoiceRowFromStripe(inv: Stripe.Invoice, orgId: string): typeof schema.invoices.$inferInsert {
  return {
    orgId, stripeInvoiceId: inv.id, amountCents: inv.status === "paid" ? inv.amount_paid : inv.amount_due, currency: inv.currency ?? "usd", status: inv.status ?? "draft",
    periodStart: inv.period_start ? new Date(inv.period_start * 1000) : null, periodEnd: inv.period_end ? new Date(inv.period_end * 1000) : null,
    lineItems: (inv.lines?.data ?? []).map((l) => ({ description: l.description ?? "", amountCents: l.amount, qty: l.quantity ?? 1 })),
    pdfUrl: inv.invoice_pdf ?? inv.hosted_invoice_url ?? null,
  };
}
function invoiceSubscriptionId(inv: Stripe.Invoice): string | null {
  const p = inv.parent?.subscription_details?.subscription; return idOf(p ?? null);
}

/** Find the org that owns a Stripe customer/subscription. Admin handle: cross-tenant by nature. */
async function orgForStripe(p: { subscriptionId?: string | null; customerId?: string | null; metadataOrgId?: string | null }): Promise<string | null> {
  if (p.metadataOrgId && /^[0-9a-f-]{36}$/i.test(p.metadataOrgId)) return p.metadataOrgId;
  if (p.subscriptionId) { const [r] = await db.select({ orgId: schema.subscriptions.orgId }).from(schema.subscriptions).where(eq(schema.subscriptions.stripeSubscriptionId, p.subscriptionId)).limit(1); if (r) return r.orgId; }
  if (p.customerId) { const [r] = await db.select({ orgId: schema.subscriptions.orgId }).from(schema.subscriptions).where(eq(schema.subscriptions.stripeCustomerId, p.customerId)).limit(1); if (r) return r.orgId; }
  return null;
}
async function upsertSubscription(orgId: string, patch: Partial<typeof schema.subscriptions.$inferInsert>) {
  await withTenant(orgId, async (tx) => {
    const [existing] = await tx.select({ id: schema.subscriptions.id }).from(schema.subscriptions).where(eq(schema.subscriptions.orgId, orgId)).limit(1);
    if (existing) await tx.update(schema.subscriptions).set(patch).where(eq(schema.subscriptions.orgId, orgId));
    else {
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<typeof schema.subscriptions.$inferInsert>;
      await tx.insert(schema.subscriptions).values({ orgId, plan: patch.plan ?? "starter", status: patch.status ?? "trialing", seats: patch.seats ?? PLANS.starter.seats, agentSlots: patch.agentSlots ?? PLANS.starter.agents, ...defined });
    }
  });
}
async function upsertInvoice(row: typeof schema.invoices.$inferInsert) {
  await withTenant(row.orgId, async (tx) => {
    const [existing] = row.stripeInvoiceId ? await tx.select({ id: schema.invoices.id }).from(schema.invoices).where(and(eq(schema.invoices.orgId, row.orgId), eq(schema.invoices.stripeInvoiceId, row.stripeInvoiceId))).limit(1) : [];
    if (existing) await tx.update(schema.invoices).set({ amountCents: row.amountCents, currency: row.currency, status: row.status, periodStart: row.periodStart, periodEnd: row.periodEnd, lineItems: row.lineItems, pdfUrl: row.pdfUrl }).where(eq(schema.invoices.id, existing.id));
    else await tx.insert(schema.invoices).values(row);
  });
}

// ---------- sync ----------
export async function syncSubscriptionFromStripe(orgId: string, actorUserId?: string | null): Promise<BillingResult<{ status: string; invoices: number }>> {
  const cfg = stripeConfig(); if (!cfg.ok) return { ok: false, reason: cfg.reason, missing: cfg.missing };
  const sub = await loadSubscription(orgId);
  if (!sub?.stripeSubscriptionId) return { ok: false, reason: "This client is not linked to a Stripe subscription yet." };
  try {
    const remote = await cfg.stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    const patch = subscriptionPatchFromStripe(remote, cfg.prices);
    await upsertSubscription(orgId, patch);
    const list = await cfg.stripe.invoices.list({ subscription: sub.stripeSubscriptionId, limit: 24 });
    for (const inv of list.data) await upsertInvoice(invoiceRowFromStripe(inv, orgId));
    await audit({ orgId, actorUserId: actorUserId ?? null, action: "billing.synced", entityType: "subscription", entityId: sub.id, details: { status: patch.status, invoices: list.data.length } });
    return { ok: true, status: String(patch.status), invoices: list.data.length };
  } catch (e) { return { ok: false, reason: `Stripe error: ${e instanceof Error ? e.message : String(e)}` }; }
}

// ---------- webhook ----------
export function verifyWebhook(rawBody: string | Buffer, signature: string | null, env: NodeJS.ProcessEnv = process.env): { ok: true; event: Stripe.Event } | { ok: false; status: number; reason: string } {
  const cfg = stripeConfig(env); if (!cfg.ok) return { ok: false, status: 503, reason: cfg.reason };
  if (!cfg.webhookSecret) return { ok: false, status: 503, reason: "STRIPE_WEBHOOK_SECRET is not set" };
  if (!signature) return { ok: false, status: 400, reason: "Missing stripe-signature header" };
  try { return { ok: true, event: cfg.stripe.webhooks.constructEvent(rawBody, signature, cfg.webhookSecret) }; }
  catch (e) { return { ok: false, status: 400, reason: `Signature verification failed: ${e instanceof Error ? e.message : String(e)}` }; }
}

export type WebhookOutcome = { handled: boolean; duplicate: boolean; orgId: string | null; note: string };
/** Idempotent: the Stripe event id is recorded in `jobs` (kind `stripe_event`) and a repeat delivery is a no-op. */
export async function handleStripeEvent(event: Stripe.Event, prices?: StripePrices): Promise<WebhookOutcome> {
  const cfg = stripeConfig();
  const priceMap: StripePrices = prices ?? (cfg.ok ? cfg.prices : { starter: process.env.STRIPE_PRICE_STARTER ?? "", growth: process.env.STRIPE_PRICE_GROWTH ?? "", enterprise: process.env.STRIPE_PRICE_ENTERPRISE ?? "", extraSeat: process.env.STRIPE_PRICE_EXTRA_SEAT, extraAgent: process.env.STRIPE_PRICE_EXTRA_AGENT });
  const [seen] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.kind, "stripe_event"), sql`${schema.jobs.payload}->>'eventId' = ${event.id}`)).limit(1);
  if (seen) return { handled: false, duplicate: true, orgId: null, note: "already processed" };

  let orgId: string | null = null; let note = "ignored"; let handled = false;
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      orgId = await orgForStripe({ metadataOrgId: s.metadata?.orgId ?? s.client_reference_id, customerId: idOf(s.customer) });
      if (orgId) {
        const plan = (s.metadata?.plan as PlanKey | undefined) && PLANS[s.metadata!.plan as PlanKey] ? (s.metadata!.plan as PlanKey) : undefined;
        const patch: Partial<typeof schema.subscriptions.$inferInsert> = { stripeCustomerId: idOf(s.customer), stripeSubscriptionId: idOf(s.subscription), status: "active", updatedAt: new Date() };
        if (plan) { patch.plan = plan; patch.seats = Math.max(PLANS[plan].seats, Number(s.metadata?.seats) || 0); patch.agentSlots = Math.max(PLANS[plan].agents, Number(s.metadata?.agentSlots) || 0); }
        await upsertSubscription(orgId, patch); handled = true; note = `checkout completed → ${plan ?? "plan unchanged"}`;
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      orgId = await orgForStripe({ subscriptionId: sub.id, customerId: idOf(sub.customer), metadataOrgId: sub.metadata?.orgId });
      if (orgId) {
        const patch = subscriptionPatchFromStripe(sub, priceMap);
        if (event.type === "customer.subscription.deleted") patch.status = "canceled";
        await upsertSubscription(orgId, patch); handled = true; note = `subscription ${event.type.split(".").pop()} → ${patch.status}`;
      }
      break;
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      orgId = await orgForStripe({ subscriptionId: invoiceSubscriptionId(inv), customerId: idOf(inv.customer), metadataOrgId: inv.metadata?.orgId ?? inv.parent?.subscription_details?.metadata?.orgId });
      if (orgId) {
        await upsertInvoice(invoiceRowFromStripe(inv, orgId));
        if (event.type === "invoice.payment_failed") await upsertSubscription(orgId, { status: "past_due", updatedAt: new Date() });
        else if (event.type === "invoice.paid") { const cur = await loadSubscription(orgId); if (cur && (cur.status === "past_due" || cur.status === "unpaid")) await upsertSubscription(orgId, { status: "active", updatedAt: new Date() }); }
        handled = true; note = `${event.type} ${inv.id}`;
      }
      break;
    }
    default: note = `ignored ${event.type}`;
  }
  await db.insert(schema.jobs).values({ kind: "stripe_event", orgId, payload: { eventId: event.id, type: event.type }, status: "done", attempts: 1, lockedAt: new Date(), result: { handled, note } });
  await audit({ orgId, actorType: "system", action: "billing.webhook", entityType: "stripe_event", entityId: event.id, details: { type: event.type, handled, note } });
  return { handled, duplicate: false, orgId, note };
}

// ---------- seats ----------
export type SeatUsage = { plan: PlanKey; status: string; seats: number; used: number; remaining: number; agentSlots: number; agentsUsed: number; agentsRemaining: number; overSeats: boolean; overAgents: boolean; trialEndsAt: Date | null; currentPeriodEnd: Date | null; stripeLinked: boolean };
/** Seats = employees with a non-revoked collector (monitored employees). Agent slots = agents not retired. */
export async function seatUsage(orgId: string): Promise<SeatUsage | null> {
  return withTenant(orgId, async (tx) => {
    const [sub] = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, orgId)).limit(1);
    if (!sub) return null;
    const [c] = await tx.select({ n: sql<string>`count(distinct ${schema.collectors.employeeId})` }).from(schema.collectors).where(and(eq(schema.collectors.orgId, orgId), inArray(schema.collectors.status, ["pending", "active", "paused", "offline"])));
    const [a] = await tx.select({ n: sql<string>`count(*)` }).from(schema.agents).where(and(eq(schema.agents.orgId, orgId), inArray(schema.agents.status, ["configured", "deployed", "paused", "error"])));
    const used = num(c?.n), agentsUsed = num(a?.n);
    return { plan: sub.plan, status: sub.status, seats: sub.seats, used, remaining: Math.max(0, sub.seats - used), agentSlots: sub.agentSlots, agentsUsed, agentsRemaining: Math.max(0, sub.agentSlots - agentsUsed), overSeats: used > sub.seats, overAgents: agentsUsed > sub.agentSlots, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd, stripeLinked: !!sub.stripeSubscriptionId };
  });
}
export class SeatLimitError extends Error { constructor(public usage: SeatUsage) { super(`Seat limit reached: ${usage.used} of ${usage.seats} monitored employees on the ${PLANS[usage.plan].label} plan. Add seats ($${EXTRA_SEAT_MONTHLY}/seat/mo) or upgrade.`); } }
/** Throws SeatLimitError when enrolling one more employee would exceed the plan. Call before creating a collector for a NEW employee. */
export async function assertSeatAvailable(orgId: string, employeeId?: string): Promise<SeatUsage | null> {
  const u = await seatUsage(orgId);
  if (!u) return null;
  if (employeeId) {
    const already = await withTenant(orgId, async (tx) => (await tx.select({ id: schema.collectors.id }).from(schema.collectors).where(and(eq(schema.collectors.orgId, orgId), eq(schema.collectors.employeeId, employeeId), inArray(schema.collectors.status, ["pending", "active", "paused", "offline"]))).limit(1)).length > 0);
    if (already) return u; // re-enrolling an already-seated employee does not consume a seat
  }
  if (u.used >= u.seats) throw new SeatLimitError(u);
  return u;
}

// ---------- portfolio ----------
export type PortfolioBilling = { orgId: string; plan: PlanKey; status: string; seats: number; agentSlots: number; monthly: number; stripeLinked: boolean; trialEndsAt: Date | null; currentPeriodEnd: Date | null };
/** MRR across a set of client orgs (only active + past_due count toward MRR; trials are listed but excluded). */
export function mrr(rows: { status: string; monthly: number }[]): number {
  return rows.filter((r) => r.status === "active" || r.status === "past_due").reduce((a, r) => a + r.monthly, 0);
}
export async function latestInvoices(orgId: string, limit = 12) {
  return withTenant(orgId, (tx) => tx.select().from(schema.invoices).where(eq(schema.invoices.orgId, orgId)).orderBy(desc(schema.invoices.createdAt)).limit(limit));
}
