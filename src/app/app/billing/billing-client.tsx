"use client";
import * as React from "react";
import { CreditCard, Users, Bot, Activity, Cpu, FileText, ExternalLink, Check, AlertTriangle, Radar } from "lucide-react";
import { Button, Card, Empty, PageHeader, Table, Th, Td } from "@/components/ui";
import { KpiCard, SectionHeader, StatusPill, Meter } from "@/components/ui/enterprise";
import { fmtUSD, fmtNum, cn } from "@/lib/utils";
import { startCheckout, openPortal } from "./actions";

type PlanKey = "starter" | "growth" | "enterprise";
export type BillingData = {
  subscription: { plan: PlanKey; status: string; seats: number; agentSlots: number; trialEndsAt: string | null; currentPeriodEnd: string | null; stripeLinked: boolean; stripeCustomer: boolean; monthly: { total: number; base: number; extraSeats: number; extraAgents: number; extraSeatCount: number; extraAgentCount: number } } | null;
  usage: { used: number; seats: number; agentsUsed: number; agentSlots: number; overSeats: boolean; overAgents: boolean } | null;
  invoices: { id: string; stripeInvoiceId: string | null; amountCents: number; currency: string; status: string; periodStart: string | null; periodEnd: string | null; pdfUrl: string | null; createdAt: string }[];
  plans: { key: PlanKey; label: string; priceMonthly: number; seats: number; agents: number; blurb: string }[];
  extraSeatMonthly: number; extraAgentMonthly: number;
  stripe: { configured: boolean; missing: string[] };
  meter: { monitored: number; activeEmployees: number; events30: number; agentRuns30: number; agentRunsOk30: number; analysis30: number; analysisTotal: number; lastAnalysis: string | null };
  checkout: "success" | "canceled" | null;
};
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "—");
const money = (cents: number, cur: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: (cur || "usd").toUpperCase() }).format(cents / 100);

export function BillingClient({ data }: { data: BillingData }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<{ text: string; missing?: string[] } | null>(null);
  const go = async (key: string, fn: () => Promise<{ ok: true; url: string } | { ok: false; error: string; missing?: string[] }>) => {
    setBusy(key); setError(null);
    try { const r = await fn(); if (r.ok) window.location.assign(r.url); else setError({ text: r.error, missing: r.missing }); }
    catch (e) { setError({ text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  };
  const s = data.subscription; const u = data.usage; const m = data.meter;

  return (
    <div data-testid="billing-page">
      <PageHeader hero eyebrow="Administration" icon={<CreditCard size={22} />} title="Subscription & Billing"
        subtitle="Your plan, seat and agent-slot usage, invoices and metered usage — read straight from your subscription record and activity data."
        actions={s?.stripeCustomer ? <Button variant="glass" onClick={() => void go("portal", openPortal)} loading={busy === "portal"} data-testid="billing-portal"><ExternalLink size={15} />Manage billing in Stripe</Button> : undefined} />

      {data.checkout === "success" && <div role="status" className="mb-4 rounded-xl bg-emerald-soft px-4 py-3 text-sm text-emerald-ink" data-testid="checkout-success">Checkout completed in Stripe. Your plan updates here once Stripe&apos;s webhook is received.</div>}
      {data.checkout === "canceled" && <div role="status" className="mb-4 rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-2" data-testid="checkout-canceled">Checkout was canceled — nothing changed.</div>}
      {!data.stripe.configured && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-gold/40 bg-gold-soft px-4 py-3 text-sm text-gold-ink" data-testid="stripe-not-configured">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="min-w-0"><div className="font-semibold">Online payments are not configured on this deployment.</div><div className="mt-0.5">Checkout and the customer portal need these environment variables: {data.stripe.missing.map((v) => <code key={v} className="mx-0.5 inline-block break-all rounded bg-surface px-1.5 py-0.5 text-[11px] text-ink">{v}</code>)}. Plans can still be set by your BridgeBox consultant.</div></div>
        </div>
      )}
      {error && (
        <div role="alert" className="mb-4 rounded-xl bg-coral-soft px-4 py-3 text-sm text-coral-ink" data-testid="billing-error">
          {error.text}{error.missing?.length ? <div className="mt-1">Missing: {error.missing.map((v) => <code key={v} className="mx-0.5 inline-block break-all rounded bg-surface px-1.5 py-0.5 text-[11px] text-ink">{v}</code>)}</div> : null}
        </div>
      )}

      {!s ? (
        <Empty title="No subscription on file" body="This organization has no subscription record yet. Choose a plan below, or ask your BridgeBox consultant to set one up." />
      ) : (
        <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="billing-summary">
          <Card className="card-hover relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-indigo to-purple" />
            <div className="flex items-start justify-between gap-2"><div className="text-[12px] font-semibold text-ink-2">Current plan</div><StatusPill status={s.status} map={{ trialing: "cyan", past_due: "coral", canceled: "midnight", unpaid: "coral" }} /></div>
            <div className="mt-3 font-display text-2xl font-bold text-indigo-ink">{data.plans.find((p) => p.key === s.plan)?.label ?? s.plan}</div>
            <div className="mt-1 text-xs text-ink-2">{fmtUSD(s.monthly.total)}/mo list{s.monthly.extraSeatCount + s.monthly.extraAgentCount > 0 ? ` (incl. ${s.monthly.extraSeatCount} extra seats, ${s.monthly.extraAgentCount} extra agent slots)` : ""}</div>
            <div className="mt-2 text-[11px] text-ink-3">{s.stripeLinked ? "Billed through Stripe" : "Not linked to Stripe — set by your consultant"}</div>
          </Card>
          <Card className="card-hover" data-testid="seat-usage">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-ink-2"><Users size={14} />Seats (monitored employees)</div>
            <div className={cn("mt-3 font-display text-2xl font-bold tabular", u?.overSeats ? "text-coral-ink" : "text-ink")}>{u ? `${u.used} / ${u.seats}` : "—"}</div>
            {u && <div className="mt-2"><Meter value={u.used} max={u.seats} accent={u.overSeats ? "coral" : u.used / Math.max(u.seats, 1) > 0.85 ? "gold" : "emerald"} label="Seats used" /></div>}
            <div className="mt-2 text-[11px] text-ink-3">Employees with an enrolled collector · extra seats {fmtUSD(data.extraSeatMonthly)}/mo each</div>
          </Card>
          <Card className="card-hover" data-testid="agent-usage">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-ink-2"><Bot size={14} />Agent slots</div>
            <div className={cn("mt-3 font-display text-2xl font-bold tabular", u?.overAgents ? "text-coral-ink" : "text-ink")}>{u ? `${u.agentsUsed} / ${u.agentSlots}` : "—"}</div>
            {u && <div className="mt-2"><Meter value={u.agentsUsed} max={u.agentSlots} accent={u.overAgents ? "coral" : "purple"} label="Agent slots used" /></div>}
            <div className="mt-2 text-[11px] text-ink-3">Configured, deployed, paused or errored agents · extra slots {fmtUSD(data.extraAgentMonthly)}/mo each</div>
          </Card>
          <Card className="card-hover">
            <div className="text-[12px] font-semibold text-ink-2">Key dates</div>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-2"><dt className="text-ink-2">Trial ends</dt><dd className="font-semibold tabular" data-testid="trial-end">{date(s.trialEndsAt)}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-2">Current period ends</dt><dd className="font-semibold tabular" data-testid="period-end">{date(s.currentPeriodEnd)}</dd></div>
            </dl>
          </Card>
        </div>
      )}

      <SectionHeader accent="cyan" icon={<Activity size={16} />} title="Usage metering" subtitle="Last 30 days, counted from your organization's data." />
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="usage-meter">
        <KpiCard testid="meter-monitored" label="Monitored employees" value={m.monitored} format={(n) => fmtNum(n)} accent="royal" basis="observed" icon={<Radar size={16} />} caption={`of ${m.activeEmployees} active employees`} />
        <KpiCard testid="meter-events" label="Activity events (30 days)" value={m.events30} format={(n) => fmtNum(n)} accent="cyan" basis="observed" icon={<Activity size={16} />} caption="Metadata events received from collectors" />
        <KpiCard testid="meter-agent-runs" label="Agent runs (30 days)" value={m.agentRuns30} format={(n) => fmtNum(n)} accent="purple" basis="observed" icon={<Bot size={16} />} caption={`${fmtNum(m.agentRunsOk30)} succeeded`} />
        <KpiCard testid="meter-analysis" label="Analysis runs (30 days)" value={m.analysis30} format={(n) => fmtNum(n)} accent="indigo" basis="observed" icon={<Cpu size={16} />} caption={`${fmtNum(m.analysisTotal)} total · last ${date(m.lastAnalysis)}`} />
      </div>

      <SectionHeader accent="indigo" icon={<CreditCard size={16} />} title="Plans" subtitle={`List prices per month. Extra seats ${fmtUSD(data.extraSeatMonthly)}/mo, extra agent slots ${fmtUSD(data.extraAgentMonthly)}/mo.`} />
      <div className="stagger grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="plan-compare">
        {data.plans.map((p) => {
          const current = s?.plan === p.key;
          return (
            <Card key={p.key} className={cn("card-hover relative flex flex-col overflow-hidden", current && "ring-glow-royal")} data-testid={`plan-${p.key}`}>
              {current && <span className="absolute right-3 top-3 rounded-full bg-royal-soft px-2 py-0.5 text-[11px] font-semibold text-royal-ink">Current plan</span>}
              <div className="text-sm font-bold">{p.label}</div>
              <div className="mt-2 font-display text-3xl font-bold tabular">{fmtUSD(p.priceMonthly)}<span className="text-sm font-medium text-ink-2">/mo</span></div>
              <p className="mt-2 text-xs text-ink-2">{p.blurb}</p>
              <ul className="mt-3 space-y-1.5 text-sm">
                <li className="flex items-center gap-2"><Check size={14} className="text-emerald-ink" />{fmtNum(p.seats)} monitored employees</li>
                <li className="flex items-center gap-2"><Check size={14} className="text-emerald-ink" />{fmtNum(p.agents)} AI agent slots</li>
              </ul>
              <div className="mt-auto pt-4">
                <Button className="w-full" variant={current ? "secondary" : "primary"} disabled={busy != null || (current && s?.stripeLinked)} loading={busy === p.key} onClick={() => void go(p.key, () => startCheckout({ plan: p.key }))} data-testid={`checkout-${p.key}`}>
                  {current ? (s?.stripeLinked ? "Your plan" : "Pay for this plan") : `Choose ${p.label}`}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-ink-3">Buttons open a real Stripe Checkout session. When Stripe is not configured you will see exactly which settings are missing — nothing is charged or changed.</p>

      <SectionHeader accent="emerald" icon={<FileText size={16} />} title="Invoices" subtitle="Synced from Stripe." />
      {data.invoices.length === 0 ? (
        <Empty title="No invoices yet" body={s?.stripeLinked ? "Invoices appear here after Stripe issues the first one." : "Invoices appear once this subscription is billed through Stripe."} />
      ) : (
        <Table>
          <thead><tr><Th>Date</Th><Th>Period</Th><Th>Status</Th><Th className="text-right">Amount</Th><Th className="text-right">PDF</Th></tr></thead>
          <tbody>{data.invoices.map((i) => (
            <tr key={i.id} data-testid={`invoice-${i.id}`}>
              <Td className="tabular">{date(i.createdAt)}</Td><Td className="text-ink-2 tabular">{date(i.periodStart)} – {date(i.periodEnd)}</Td>
              <Td><StatusPill status={i.status} map={{ paid: "emerald", open: "gold", void: "midnight", uncollectible: "coral" }} /></Td>
              <Td className="text-right font-semibold tabular">{money(i.amountCents, i.currency)}</Td>
              <Td className="text-right">{i.pdfUrl ? <a href={i.pdfUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-royal-ink hover:underline" data-testid={`invoice-pdf-${i.id}`}>Download<ExternalLink size={12} /></a> : <span className="text-xs text-ink-3">—</span>}</Td>
            </tr>))}</tbody>
        </Table>
      )}
    </div>
  );
}
