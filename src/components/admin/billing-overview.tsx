"use client";
import * as React from "react";
import Link from "next/link";
import { Button, Badge, Card, CardHeader, Empty, PageHeader, Table, Th, Td, Tooltip } from "@/components/ui";
import { fmtUSD, cn } from "@/lib/utils";
import { syncAllStripe, type SyncAllResult } from "@/app/admin/billing/actions";
import { StripeNotice } from "./client-tabs-2";
import { statusTone } from "./portfolio";

export type BillingClientRow = { clientId: string; clientName: string; plan: string | null; status: string; seats: number; seatsUsed: number; agentSlots: number; agentsUsed: number; monthly: number; stripeLinked: boolean; trialEndsAt: string | null; currentPeriodEnd: string | null; agentsDeployed: number };
type Invoice = { id: string; clientName: string; clientId: string; amountCents: number; currency: string; status: string; createdAt: string; periodStart: string | null; periodEnd: string | null; pdfUrl: string | null };
type Economics = { plans: Record<string, { label: string; priceMonthly: number; seats: number; agents: number }>; extraSeat: number; extraAgent: number; perAgentCost: number };

export function BillingOverview({ rows, mrr, trialMonthly, stripe, invoices, economics, canChange }: { rows: BillingClientRow[]; mrr: number; trialMonthly: number; stripe: { configured: boolean; missing: string[] }; invoices: Invoice[]; economics: Economics; canChange: boolean }) {
  const [busy, setBusy] = React.useState(false); const [res, setRes] = React.useState<SyncAllResult | null>(null);
  const agentCost = rows.reduce((s, r) => s + r.agentsDeployed, 0) * economics.perAgentCost;
  async function sync() { setBusy(true); setRes(await syncAllStripe()); setBusy(false); }
  return (
    <div data-testid="billing-page">
      <PageHeader title="Billing" subtitle="Subscriptions, seats and invoices across every client." actions={<Button onClick={sync} loading={busy} disabled={!stripe.configured} data-testid="sync-all-stripe">Sync with Stripe</Button>} />
      <div className="space-y-4">
        <StripeNotice stripe={stripe} />
        {res && !res.ok && <div className="rounded-lg bg-danger-soft p-3 text-xs text-danger" data-testid="sync-error">{res.error}{res.missing?.length ? <div className="mt-1 font-mono">{res.missing.join(", ")}</div> : null}</div>}
        {res && res.ok && <div className="rounded-lg bg-surface-2 p-3 text-xs" data-testid="sync-result">Synced {res.synced.length} client(s).{res.skipped.length > 0 && <ul className="mt-1">{res.skipped.map((s) => <li key={s.client}>{s.client}: {s.reason}</li>)}</ul>}</div>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="MRR" value={fmtUSD(mrr)} hint="Active and past-due subscriptions at list price. Trials excluded." testid="mrr" />
          <Stat label="Trial pipeline / mo" value={fmtUSD(trialMonthly)} hint="List price of subscriptions still trialing" />
          <Stat label="Modelled agent cost / mo" value={fmtUSD(agentCost)} hint={`${fmtUSD(economics.perAgentCost)} per deployed agent (costing.ts DEFAULTS.perAgentMonthly)`} />
          <Stat label="Gross margin / mo" value={fmtUSD(mrr - agentCost)} hint="MRR minus modelled agent cost. Consulting hours are billed separately." />
        </div>
        {!rows.length ? <Empty title="No clients yet" action={<Button href="/admin/clients/new">Add client</Button>} /> : (
          <Table><thead><tr><Th>Client</Th><Th>Plan</Th><Th>Status</Th><Th>Seats</Th><Th>Agent slots</Th><Th className="text-right">Monthly</Th><Th>Stripe</Th><Th>Renews / trial ends</Th><Th></Th></tr></thead><tbody>{rows.map((r) => (
            <tr key={r.clientId} data-testid={`billing-row-${r.clientId}`}>
              <Td><Link className="font-medium text-brand hover:underline" href={`/admin/clients/${r.clientId}?tab=billing`}>{r.clientName}</Link></Td><Td className="capitalize">{r.plan ?? "—"}</Td><Td><Badge tone={statusTone(r.status)}>{r.status.replace("_", " ")}</Badge></Td>
              <Td className={cn(r.seats > 0 && r.seatsUsed >= r.seats && "text-warn font-medium")}>{r.seatsUsed} / {r.seats}{r.seats > 0 && r.seatsUsed >= r.seats && <span className="ml-1 text-[10px] uppercase">full</span>}</Td><Td className={cn(r.agentsUsed > r.agentSlots && "text-warn font-medium")}>{r.agentsUsed} / {r.agentSlots}</Td>
              <Td className="text-right">{fmtUSD(r.monthly)}</Td><Td className="text-xs">{r.stripeLinked ? <Badge tone="money">linked</Badge> : <Badge tone="neutral">local</Badge>}</Td><Td className="text-xs">{(r.status === "trialing" ? r.trialEndsAt : r.currentPeriodEnd) ? new Date((r.status === "trialing" ? r.trialEndsAt : r.currentPeriodEnd)!).toLocaleDateString() : "—"}</Td>
              <Td>{canChange && <Button size="sm" variant="secondary" href={`/admin/clients/${r.clientId}?tab=billing`}>Manage</Button>}</Td></tr>))}</tbody></Table>
        )}
        <Card>
          <CardHeader title="Price list" subtitle={`Extra seat ${fmtUSD(economics.extraSeat)}/mo · extra agent slot ${fmtUSD(economics.extraAgent)}/mo · modelled cost per deployed agent ${fmtUSD(economics.perAgentCost)}/mo. Full economics in docs/BILLING.md.`} />
          <div className="grid gap-3 sm:grid-cols-3">{Object.entries(economics.plans).map(([k, p]) => <div key={k} className="rounded-lg border border-border p-3 text-sm"><div className="font-semibold">{p.label}</div><div className="text-lg font-semibold">{fmtUSD(p.priceMonthly)}<span className="text-xs font-normal text-ink-3">/mo</span></div><div className="text-xs text-ink-2">{p.seats} seats · {p.agents} agents · {fmtUSD(p.priceMonthly / p.seats, {})}/seat</div></div>)}</div>
        </Card>
        <Card>
          <CardHeader title="Recent invoices" subtitle="Across all clients, from Stripe only." />
          {!invoices.length ? <p className="text-xs text-ink-2" data-testid="invoices-empty">No invoices yet. Invoices arrive through the Stripe webhook or a sync.</p> : (
            <Table><thead><tr><Th>Client</Th><Th>Date</Th><Th>Period</Th><Th>Status</Th><Th className="text-right">Amount</Th><Th></Th></tr></thead><tbody>{invoices.map((i) => (
              <tr key={i.id}><Td className="text-xs"><Link className="text-brand hover:underline" href={`/admin/clients/${i.clientId}?tab=billing`}>{i.clientName}</Link></Td><Td className="text-xs">{new Date(i.createdAt).toLocaleDateString()}</Td><Td className="text-xs">{i.periodStart ? new Date(i.periodStart).toLocaleDateString() : "—"} → {i.periodEnd ? new Date(i.periodEnd).toLocaleDateString() : "—"}</Td><Td><Badge tone={i.status === "paid" ? "money" : i.status === "open" ? "warn" : "neutral"}>{i.status}</Badge></Td><Td className="text-right">{fmtUSD(i.amountCents / 100)} <span className="text-xs uppercase text-ink-3">{i.currency}</span></Td><Td>{i.pdfUrl && <a className="text-xs text-brand hover:underline" href={i.pdfUrl} target="_blank" rel="noreferrer">PDF</a>}</Td></tr>))}</tbody></Table>
          )}
        </Card>
      </div>
    </div>
  );
}
function Stat({ label, value, hint, testid }: { label: string; value: string; hint?: string; testid?: string }) {
  return <div className="card p-4" data-testid={testid}><div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-ink-2">{label}{hint && <Tooltip text={hint} />}</div><div className="mt-1 text-xl font-semibold">{value}</div></div>;
}
