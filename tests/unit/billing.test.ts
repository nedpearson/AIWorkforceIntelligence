/**
 * Billing engine tests with a mocked Stripe (no network). Requires DATABASE_URL → bridgebox_f.
 *   DATABASE_URL=postgresql://bridgebox:bridgebox@localhost:5432/bridgebox_f npx vitest run tests/unit/billing.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import Stripe from "stripe";
import { db, schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import {
  PLANS, EXTRA_SEAT_MONTHLY, EXTRA_AGENT_MONTHLY, planMonthly, stripeConfig, planForPrice, mapStripeStatus, subscriptionPatchFromStripe, invoiceRowFromStripe,
  createCheckoutSession, createPortalSession, syncSubscriptionFromStripe, verifyWebhook, handleStripeEvent, seatUsage, assertSeatAvailable, SeatLimitError, mrr,
} from "@/engine/billing";

const T = Date.now();
const ENV = { STRIPE_SECRET_KEY: "sk_test_fake_key_for_unit_tests", STRIPE_WEBHOOK_SECRET: "whsec_test_secret", STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_GROWTH: "price_growth", STRIPE_PRICE_ENTERPRISE: "price_enterprise", STRIPE_PRICE_EXTRA_SEAT: "price_seat", STRIPE_PRICE_EXTRA_AGENT: "price_agent" };
const PRICES = { starter: "price_starter", growth: "price_growth", enterprise: "price_enterprise", extraSeat: "price_seat", extraAgent: "price_agent" };
const ids = { org: "", org2: "", e1: "", e2: "", e3: "" };
let evCounter = 0;
function evt(type: string, object: object): Stripe.Event {
  return { id: `evt_${T}_${++evCounter}`, object: "event", api_version: "2025-01-01", created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 0, request: null, type, data: { object } } as unknown as Stripe.Event;
}
function stripeSub(over: Partial<Record<string, unknown>> = {}, items: { price: string; quantity?: number }[] = [{ price: "price_growth" }]): Stripe.Subscription {
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  return { id: `sub_${T}`, object: "subscription", customer: `cus_${T}`, status: "active", metadata: { orgId: ids.org, plan: "growth" }, trial_end: null, items: { object: "list", data: items.map((i, n) => ({ id: `si_${n}`, object: "subscription_item", price: { id: i.price, object: "price" }, quantity: i.quantity ?? 1, current_period_end: end, current_period_start: end - 30 * 86400 })) }, ...over } as unknown as Stripe.Subscription;
}
function stripeInvoice(over: Partial<Record<string, unknown>> = {}): Stripe.Invoice {
  const now = Math.floor(Date.now() / 1000);
  return { id: `in_${T}_${evCounter}`, object: "invoice", customer: `cus_${T}`, status: "paid", currency: "usd", amount_due: 149900, amount_paid: 149900, period_start: now - 30 * 86400, period_end: now, invoice_pdf: "https://pay.stripe.com/invoice/test.pdf", hosted_invoice_url: null, metadata: {}, parent: { type: "subscription_details", subscription_details: { subscription: `sub_${T}`, metadata: { orgId: ids.org } } }, lines: { object: "list", data: [{ id: "il_1", object: "line_item", description: "Growth plan", amount: 149900, quantity: 1 }] }, ...over } as unknown as Stripe.Invoice;
}

beforeAll(async () => {
  Object.assign(process.env, ENV);
  const [org] = await db.insert(schema.organizations).values({ name: `Billing Co ${T}`, slug: `billing-${T}`, kind: "client", isDemo: true }).returning();
  const [org2] = await db.insert(schema.organizations).values({ name: `Other Co ${T}`, slug: `billing2-${T}`, kind: "client", isDemo: true }).returning();
  ids.org = org.id; ids.org2 = org2.id;
  await withTenant(org.id, async (tx) => {
    await tx.insert(schema.subscriptions).values({ orgId: org.id, plan: "starter", status: "trialing", seats: 2, agentSlots: 1, trialEndsAt: new Date(Date.now() + 86_400_000) });
    const emp = async (n: string) => (await tx.insert(schema.employees).values({ orgId: org.id, displayName: n }).returning())[0].id;
    ids.e1 = await emp("E1"); ids.e2 = await emp("E2"); ids.e3 = await emp("E3");
    await tx.insert(schema.collectors).values({ orgId: org.id, employeeId: ids.e1, name: "c1", platform: "simulated", tokenHash: `t1-${T}`, status: "active" });
    await tx.insert(schema.collectors).values({ orgId: org.id, employeeId: ids.e1, name: "c1b", platform: "simulated", tokenHash: `t1b-${T}`, status: "offline" }); // same employee → one seat
    await tx.insert(schema.collectors).values({ orgId: org.id, employeeId: ids.e3, name: "c3", platform: "simulated", tokenHash: `t3-${T}`, status: "revoked" }); // revoked → no seat
  });
  await withTenant(org2.id, (tx) => tx.insert(schema.subscriptions).values({ orgId: org2.id, plan: "enterprise", status: "active", seats: 250, agentSlots: 50 }));
});
afterAll(async () => {
  await db.delete(schema.jobs).where(and(eq(schema.jobs.kind, "stripe_event"), sql`${schema.jobs.payload}->>'eventId' like ${`evt_${T}_%`}`));
  await db.delete(schema.organizations).where(inArray(schema.organizations.id, [ids.org, ids.org2]));
});

describe("pricing", () => {
  it("plans and add-ons match the price list", () => {
    expect(PLANS.starter).toMatchObject({ priceMonthly: 499, seats: 10, agents: 3 });
    expect(PLANS.growth).toMatchObject({ priceMonthly: 1499, seats: 50, agents: 10 });
    expect(PLANS.enterprise).toMatchObject({ priceMonthly: 4999, seats: 250, agents: 50 });
    expect(EXTRA_SEAT_MONTHLY).toBe(19); expect(EXTRA_AGENT_MONTHLY).toBe(149);
    expect(planMonthly("starter", 10, 3).total).toBe(499);
    expect(planMonthly("starter", 15, 5)).toMatchObject({ total: 499 + 5 * 19 + 2 * 149, extraSeatCount: 5, extraAgentCount: 2 });
    expect(planMonthly("growth", 20, 1).total).toBe(1499); // below allowance is not discounted
    expect(mrr([{ status: "active", monthly: 499 }, { status: "trialing", monthly: 1499 }, { status: "past_due", monthly: 4999 }, { status: "canceled", monthly: 10 }])).toBe(5498);
  });
  it("stripeConfig reports exactly what is missing and never fakes", () => {
    const r = stripeConfig({} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.missing).toEqual(["STRIPE_SECRET_KEY", "STRIPE_PRICE_STARTER", "STRIPE_PRICE_GROWTH", "STRIPE_PRICE_ENTERPRISE"]); expect(r.reason).toContain("STRIPE_SECRET_KEY"); }
    const partial = stripeConfig({ STRIPE_SECRET_KEY: "sk", STRIPE_PRICE_STARTER: "a" } as unknown as NodeJS.ProcessEnv);
    expect(!partial.ok && partial.missing).toEqual(["STRIPE_PRICE_GROWTH", "STRIPE_PRICE_ENTERPRISE"]);
    const ok = stripeConfig(ENV as unknown as NodeJS.ProcessEnv);
    expect(ok.ok).toBe(true);
    expect(planForPrice("price_growth", PRICES)).toBe("growth"); expect(planForPrice("price_x", PRICES)).toBeNull();
  });
  it("maps Stripe statuses conservatively", () => {
    expect(mapStripeStatus("trialing")).toBe("trialing"); expect(mapStripeStatus("active")).toBe("active"); expect(mapStripeStatus("past_due")).toBe("past_due");
    expect(mapStripeStatus("canceled")).toBe("canceled"); expect(mapStripeStatus("incomplete_expired")).toBe("canceled"); expect(mapStripeStatus("paused")).toBe("canceled");
    expect(mapStripeStatus("unpaid")).toBe("unpaid"); expect(mapStripeStatus("incomplete")).toBe("unpaid"); expect(mapStripeStatus("weird")).toBe("unpaid");
  });
  it("subscriptionPatchFromStripe derives plan/seats/agent slots from price ids and quantities", () => {
    const p = subscriptionPatchFromStripe(stripeSub({}, [{ price: "price_growth" }, { price: "price_seat", quantity: 7 }, { price: "price_agent", quantity: 2 }]), PRICES);
    expect(p).toMatchObject({ plan: "growth", seats: 57, agentSlots: 12, status: "active", stripeSubscriptionId: `sub_${T}`, stripeCustomerId: `cus_${T}` });
    expect(p.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
    const meta = subscriptionPatchFromStripe(stripeSub({ metadata: { orgId: ids.org, plan: "starter", seats: "14", agentSlots: "1" } }, [{ price: "price_unknown" }]), PRICES);
    expect(meta).toMatchObject({ plan: "starter", seats: 14, agentSlots: 3 }); // metadata fallback; never below allowance
    const row = invoiceRowFromStripe(stripeInvoice(), ids.org);
    expect(row).toMatchObject({ orgId: ids.org, amountCents: 149900, status: "paid", currency: "usd", pdfUrl: "https://pay.stripe.com/invoice/test.pdf", lineItems: [{ description: "Growth plan", amountCents: 149900, qty: 1 }] });
    expect(invoiceRowFromStripe(stripeInvoice({ status: "open", amount_paid: 0 }), ids.org).amountCents).toBe(149900);
  });
});

describe("checkout / portal / sync (mocked Stripe)", () => {
  it("returns ok:false with the missing env when Stripe is not configured", async () => {
    const saved = process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_SECRET_KEY;
    const r = await createCheckoutSession(ids.org, "growth", { successUrl: "http://x/s", cancelUrl: "http://x/c" });
    expect(r).toMatchObject({ ok: false, missing: ["STRIPE_SECRET_KEY"] });
    expect(!r.ok && r.reason).toMatch(/STRIPE_SECRET_KEY/);
    expect(await createPortalSession(ids.org, "http://x")).toMatchObject({ ok: false, missing: ["STRIPE_SECRET_KEY"] });
    expect(await syncSubscriptionFromStripe(ids.org)).toMatchObject({ ok: false });
    process.env.STRIPE_SECRET_KEY = saved;
  });
  it("creates a checkout session with the right line items and metadata", async () => {
    const cfg = stripeConfig(); if (!cfg.ok) throw new Error("config");
    const create = vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => ({ id: "cs_test_1", url: "https://checkout.stripe.com/c/cs_test_1", ...params }));
    cfg.stripe.checkout.sessions.create = create as never;
    const r = await createCheckoutSession(ids.org, "starter", { successUrl: "http://x/s", cancelUrl: "http://x/c", seats: 13, agentSlots: 4, customerEmail: "owner@x.test" });
    expect(r).toMatchObject({ ok: true, url: "https://checkout.stripe.com/c/cs_test_1", sessionId: "cs_test_1" });
    const params = create.mock.calls[0][0];
    expect(params.mode).toBe("subscription");
    expect(params.line_items).toEqual([{ price: "price_starter", quantity: 1 }, { price: "price_seat", quantity: 3 }, { price: "price_agent", quantity: 1 }]);
    expect(params.metadata).toEqual({ orgId: ids.org, plan: "starter", seats: "13", agentSlots: "4" });
    expect(params.subscription_data?.metadata).toEqual(params.metadata);
    expect(params.client_reference_id).toBe(ids.org); expect(params.customer_email).toBe("owner@x.test");
    const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, ids.org), eq(schema.auditLog.action, "billing.checkout_started")));
    expect(audits).toHaveLength(1);
  });
  it("surfaces Stripe API errors instead of faking success", async () => {
    const cfg = stripeConfig(); if (!cfg.ok) throw new Error("config");
    cfg.stripe.checkout.sessions.create = vi.fn(async () => { throw new Error("No such price: price_starter"); }) as never;
    const r = await createCheckoutSession(ids.org, "starter", { successUrl: "http://x/s", cancelUrl: "http://x/c" });
    expect(r).toMatchObject({ ok: false }); expect(!r.ok && r.reason).toMatch(/No such price/);
  });
  it("portal needs a Stripe customer; sync needs a Stripe subscription", async () => {
    expect(await createPortalSession(ids.org, "http://x")).toMatchObject({ ok: false, reason: expect.stringMatching(/no Stripe customer/) });
    expect(await syncSubscriptionFromStripe(ids.org)).toMatchObject({ ok: false, reason: expect.stringMatching(/not linked/) });
  });
});

describe("webhook", () => {
  it("verifies signatures with STRIPE_WEBHOOK_SECRET (generateTestHeaderString) and rejects tampering", () => {
    const stripe = new Stripe(ENV.STRIPE_SECRET_KEY);
    const payload = JSON.stringify(evt("customer.subscription.updated", stripeSub()));
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: ENV.STRIPE_WEBHOOK_SECRET });
    const ok = verifyWebhook(payload, header); expect(ok.ok).toBe(true); if (ok.ok) expect(ok.event.type).toBe("customer.subscription.updated");
    const bad = verifyWebhook(payload + " ", header); expect(bad).toMatchObject({ ok: false, status: 400 });
    const wrongSecret = verifyWebhook(payload, stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" })); expect(wrongSecret).toMatchObject({ ok: false, status: 400 });
    expect(verifyWebhook(payload, null)).toMatchObject({ ok: false, status: 400 });
    expect(verifyWebhook(payload, header, { ...ENV, STRIPE_WEBHOOK_SECRET: "" } as unknown as NodeJS.ProcessEnv)).toMatchObject({ ok: false, status: 503 });
    expect(verifyWebhook(payload, header, {} as NodeJS.ProcessEnv)).toMatchObject({ ok: false, status: 503 });
  });
  it("checkout.session.completed links customer + subscription and activates the plan", async () => {
    const e = evt("checkout.session.completed", { id: "cs_1", object: "checkout.session", customer: `cus_${T}`, subscription: `sub_${T}`, client_reference_id: ids.org, metadata: { orgId: ids.org, plan: "growth", seats: "55", agentSlots: "10" } });
    const out = await handleStripeEvent(e, PRICES);
    expect(out).toMatchObject({ handled: true, duplicate: false, orgId: ids.org });
    const [sub] = await withTenant(ids.org, (tx) => tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, ids.org)));
    expect(sub).toMatchObject({ plan: "growth", status: "active", seats: 55, agentSlots: 10, stripeCustomerId: `cus_${T}`, stripeSubscriptionId: `sub_${T}` });
    // idempotent on event id
    const again = await handleStripeEvent(e, PRICES);
    expect(again).toMatchObject({ handled: false, duplicate: true });
    const marks = await db.select().from(schema.jobs).where(and(eq(schema.jobs.kind, "stripe_event"), sql`${schema.jobs.payload}->>'eventId' = ${e.id}`));
    expect(marks).toHaveLength(1); expect(marks[0].status).toBe("done");
  });
  it("customer.subscription.updated syncs status, period end and seat add-ons; deleted cancels", async () => {
    const upd = await handleStripeEvent(evt("customer.subscription.updated", stripeSub({ status: "past_due", metadata: {} }, [{ price: "price_growth" }, { price: "price_seat", quantity: 10 }])), PRICES);
    expect(upd.handled).toBe(true);
    let [sub] = await withTenant(ids.org, (tx) => tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, ids.org)));
    expect(sub).toMatchObject({ status: "past_due", plan: "growth", seats: 60, agentSlots: 10 }); expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
    const del = await handleStripeEvent(evt("customer.subscription.deleted", stripeSub({ status: "canceled", metadata: {} })), PRICES);
    expect(del.handled).toBe(true);
    [sub] = await withTenant(ids.org, (tx) => tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, ids.org)));
    expect(sub.status).toBe("canceled");
    // the other org is untouched
    const [other] = await withTenant(ids.org2, (tx) => tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, ids.org2)));
    expect(other).toMatchObject({ plan: "enterprise", status: "active", stripeSubscriptionId: null });
  });
  it("invoice.paid upserts the invoice (idempotent on invoice id) and reactivates; payment_failed marks past_due", async () => {
    await handleStripeEvent(evt("customer.subscription.updated", stripeSub({ status: "unpaid", metadata: {} })), PRICES);
    const inv = stripeInvoice();
    const paid = await handleStripeEvent(evt("invoice.paid", inv), PRICES); expect(paid.handled).toBe(true);
    let rows = await withTenant(ids.org, (tx) => tx.select().from(schema.invoices).where(eq(schema.invoices.orgId, ids.org)));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ stripeInvoiceId: inv.id, amountCents: 149900, status: "paid", pdfUrl: "https://pay.stripe.com/invoice/test.pdf" });
    let [sub] = await withTenant(ids.org, (tx) => tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, ids.org)));
    expect(sub.status).toBe("active");
    // same invoice delivered under a new event id → update, not duplicate row
    await handleStripeEvent(evt("invoice.paid", { ...inv, amount_paid: 150000 }), PRICES);
    rows = await withTenant(ids.org, (tx) => tx.select().from(schema.invoices).where(eq(schema.invoices.orgId, ids.org)));
    expect(rows).toHaveLength(1); expect(rows[0].amountCents).toBe(150000);
    const failed = await handleStripeEvent(evt("invoice.payment_failed", stripeInvoice({ id: `in_fail_${T}`, status: "open", amount_paid: 0 })), PRICES);
    expect(failed.handled).toBe(true);
    [sub] = await withTenant(ids.org, (tx) => tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, ids.org)));
    expect(sub.status).toBe("past_due");
    rows = await withTenant(ids.org, (tx) => tx.select().from(schema.invoices).where(eq(schema.invoices.orgId, ids.org)));
    expect(rows).toHaveLength(2); expect(rows.find((r) => r.stripeInvoiceId === `in_fail_${T}`)!.status).toBe("open");
  });
  it("ignores unknown orgs and unrelated event types without throwing", async () => {
    const unknown = await handleStripeEvent(evt("customer.subscription.updated", stripeSub({ id: "sub_nobody", customer: "cus_nobody", metadata: {} })), PRICES);
    expect(unknown).toMatchObject({ handled: false, duplicate: false, orgId: null });
    const other = await handleStripeEvent(evt("charge.succeeded", { id: "ch_1" }), PRICES);
    expect(other).toMatchObject({ handled: false, note: "ignored charge.succeeded" });
  });
  it("sync pulls subscription + invoices through the Stripe client", async () => {
    const cfg = stripeConfig(); if (!cfg.ok) throw new Error("config");
    cfg.stripe.subscriptions.retrieve = vi.fn(async () => stripeSub({ status: "active", metadata: {} }, [{ price: "price_enterprise" }])) as never;
    cfg.stripe.invoices.list = vi.fn(async () => ({ data: [stripeInvoice({ id: `in_sync_${T}` })] })) as never;
    const r = await syncSubscriptionFromStripe(ids.org);
    expect(r).toMatchObject({ ok: true, status: "active", invoices: 1 });
    const [sub] = await withTenant(ids.org, (tx) => tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, ids.org)));
    expect(sub).toMatchObject({ plan: "enterprise", seats: 250, agentSlots: 50, status: "active" });
    const rows = await withTenant(ids.org, (tx) => tx.select().from(schema.invoices).where(eq(schema.invoices.orgId, ids.org)));
    expect(rows.some((x) => x.stripeInvoiceId === `in_sync_${T}`)).toBe(true);
  });
});

describe("seats", () => {
  it("counts distinct seated employees (non-revoked collectors) and enforces the limit", async () => {
    await withTenant(ids.org, (tx) => tx.update(schema.subscriptions).set({ seats: 2, agentSlots: 1 }).where(eq(schema.subscriptions.orgId, ids.org)));
    let u = await seatUsage(ids.org);
    expect(u).toMatchObject({ seats: 2, used: 1, remaining: 1, overSeats: false });
    await expect(assertSeatAvailable(ids.org, ids.e2)).resolves.toMatchObject({ used: 1 });
    await withTenant(ids.org, (tx) => tx.insert(schema.collectors).values({ orgId: ids.org, employeeId: ids.e2, name: "c2", platform: "simulated", tokenHash: `t2-${T}`, status: "pending" }));
    u = await seatUsage(ids.org); expect(u).toMatchObject({ used: 2, remaining: 0 });
    await expect(assertSeatAvailable(ids.org, ids.e3)).rejects.toThrow(SeatLimitError);
    await expect(assertSeatAvailable(ids.org, ids.e3)).rejects.toThrow(/2 of 2 monitored employees/);
    await expect(assertSeatAvailable(ids.org)).rejects.toThrow(SeatLimitError);
    // re-enrolling an already seated employee does not need a seat
    await expect(assertSeatAvailable(ids.org, ids.e1)).resolves.toMatchObject({ used: 2 });
    // an org without a subscription row is not blocked
    const [free] = await db.insert(schema.organizations).values({ name: `Free ${T}`, slug: `free-${T}`, kind: "client", isDemo: true }).returning();
    expect(await seatUsage(free.id)).toBeNull(); expect(await assertSeatAvailable(free.id)).toBeNull();
    await db.delete(schema.organizations).where(eq(schema.organizations.id, free.id));
  });
});
