import { desc, eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { requireConsultant, listClients } from "../_lib";
import { stripeConfig, planMonthly, mrr, seatUsage, PLANS, EXTRA_SEAT_MONTHLY, EXTRA_AGENT_MONTHLY } from "@/engine/billing";
import { DEFAULTS } from "@/engine/costing";
import { BillingOverview, type BillingClientRow } from "@/components/admin/billing-overview";

export const metadata = { title: "Billing — Consulting Portal" };
export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const { consultancy } = await requireConsultant();
  const clients = await listClients(consultancy.id);
  const rows: BillingClientRow[] = [];
  const invoices: (typeof schema.invoices.$inferSelect & { clientName: string })[] = [];
  for (const c of clients) {
    const r = await withTenant(c.id, async (tx) => {
      const [sub] = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, c.id)).limit(1);
      const inv = await tx.select().from(schema.invoices).where(eq(schema.invoices.orgId, c.id)).orderBy(desc(schema.invoices.createdAt)).limit(12);
      return { sub, inv };
    });
    const usage = await seatUsage(c.id);
    const monthly = r.sub ? planMonthly(r.sub.plan, r.sub.seats, r.sub.agentSlots).total : 0;
    rows.push({ clientId: c.id, clientName: c.name, plan: r.sub?.plan ?? null, status: r.sub?.status ?? "none", seats: r.sub?.seats ?? 0, seatsUsed: usage?.used ?? 0, agentSlots: r.sub?.agentSlots ?? 0, agentsUsed: usage?.agentsUsed ?? 0, monthly, stripeLinked: !!r.sub?.stripeSubscriptionId, trialEndsAt: r.sub?.trialEndsAt?.toISOString() ?? null, currentPeriodEnd: r.sub?.currentPeriodEnd?.toISOString() ?? null, agentsDeployed: usage?.agentsUsed ?? 0 });
    for (const i of r.inv) invoices.push({ ...i, clientName: c.name });
  }
  invoices.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const cfg = stripeConfig();
  return <BillingOverview rows={rows} mrr={mrr(rows)} trialMonthly={rows.filter((r) => r.status === "trialing").reduce((s, r) => s + r.monthly, 0)} stripe={cfg.ok ? { configured: true, missing: [] } : { configured: false, missing: cfg.missing }} canChange={["owner", "admin"].includes(consultancy.role)}
    invoices={invoices.slice(0, 50).map((i) => ({ id: i.id, clientName: i.clientName, clientId: i.orgId, amountCents: i.amountCents, currency: i.currency, status: i.status, createdAt: i.createdAt.toISOString(), periodStart: i.periodStart?.toISOString() ?? null, periodEnd: i.periodEnd?.toISOString() ?? null, pdfUrl: i.pdfUrl }))}
    economics={{ plans: PLANS, extraSeat: EXTRA_SEAT_MONTHLY, extraAgent: EXTRA_AGENT_MONTHLY, perAgentCost: DEFAULTS.perAgentMonthly }} />;
}
