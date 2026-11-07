import { and, eq, gte, sql } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { num } from "@/lib/utils";
import { seatUsage, latestInvoices, stripeConfig, planMonthly, PLANS, PLAN_KEYS, EXTRA_SEAT_MONTHLY, EXTRA_AGENT_MONTHLY } from "@/engine/billing";
import { BillingClient, type BillingData } from "./billing-client";

export const metadata = { title: "Subscription & Billing" };
export const dynamic = "force-dynamic";

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const ctx = await requireCtx("org:billing");
  const sp = await searchParams;
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [usage, invoices, meter] = await Promise.all([
    seatUsage(ctx.orgId),
    latestInvoices(ctx.orgId, 24),
    withTenant(ctx.orgId, async (tx) => {
      const [sub] = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, ctx.orgId)).limit(1);
      const [ev] = await tx.select({ n: sql<string>`count(*)` }).from(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, ctx.orgId), gte(schema.activityEvents.ts, since)));
      const [runs] = await tx.select({ n: sql<string>`count(*)`, ok: sql<string>`count(*) filter (where ${schema.agentRuns.status} = 'succeeded')` }).from(schema.agentRuns).where(and(eq(schema.agentRuns.orgId, ctx.orgId), gte(schema.agentRuns.createdAt, since)));
      const [an] = await tx.select({ n: sql<string>`count(*) filter (where ${schema.analysisRuns.createdAt} >= ${since.toISOString()})`, total: sql<string>`count(*)`, last: sql<string | null>`max(${schema.analysisRuns.finishedAt})` }).from(schema.analysisRuns).where(eq(schema.analysisRuns.orgId, ctx.orgId));
      const [emp] = await tx.select({ n: sql<string>`count(*)` }).from(schema.employees).where(and(eq(schema.employees.orgId, ctx.orgId), eq(schema.employees.isActive, true)));
      return { sub, events30: num(ev?.n), agentRuns30: num(runs?.n), agentRunsOk30: num(runs?.ok), analysis30: num(an?.n), analysisTotal: num(an?.total), lastAnalysis: an?.last ? new Date(an.last).toISOString() : null, activeEmployees: num(emp?.n) };
    }),
  ]);
  const cfg = stripeConfig();
  const sub = meter.sub;
  const data: BillingData = {
    subscription: sub ? { plan: sub.plan, status: sub.status, seats: sub.seats, agentSlots: sub.agentSlots, trialEndsAt: sub.trialEndsAt?.toISOString() ?? null, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, stripeLinked: !!sub.stripeSubscriptionId, stripeCustomer: !!sub.stripeCustomerId, monthly: planMonthly(sub.plan, sub.seats, sub.agentSlots) } : null,
    usage: usage ? { used: usage.used, seats: usage.seats, agentsUsed: usage.agentsUsed, agentSlots: usage.agentSlots, overSeats: usage.overSeats, overAgents: usage.overAgents } : null,
    invoices: invoices.map((i) => ({ id: i.id, stripeInvoiceId: i.stripeInvoiceId, amountCents: i.amountCents, currency: i.currency, status: i.status, periodStart: i.periodStart?.toISOString() ?? null, periodEnd: i.periodEnd?.toISOString() ?? null, pdfUrl: i.pdfUrl, createdAt: i.createdAt.toISOString() })),
    plans: PLAN_KEYS.map((k) => ({ key: k, ...PLANS[k] })),
    extraSeatMonthly: EXTRA_SEAT_MONTHLY, extraAgentMonthly: EXTRA_AGENT_MONTHLY,
    stripe: cfg.ok ? { configured: true, missing: [] } : { configured: false, missing: cfg.missing },
    meter: { monitored: usage?.used ?? 0, activeEmployees: meter.activeEmployees, events30: meter.events30, agentRuns30: meter.agentRuns30, agentRunsOk30: meter.agentRunsOk30, analysis30: meter.analysis30, analysisTotal: meter.analysisTotal, lastAnalysis: meter.lastAnalysis },
    checkout: sp.checkout === "success" || sp.checkout === "canceled" ? sp.checkout : null,
  };
  return <BillingClient data={data} />;
}
