"use client";
import * as React from "react";
import Link from "next/link";
import { BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, Legend, CartesianGrid } from "recharts";
import { Button, Badge, Card, CardHeader, Empty, PageHeader, Tooltip } from "@/components/ui";
import { LinkButton } from "@/components/admin/link-button";
import { fmtUSD, fmtNum } from "@/lib/utils";
import type { ClientSummary } from "@/app/admin/_data";
import { useTimeZone } from "@/components/time-zone";
import { formatDate } from "@/lib/datetime";

const PROJECTED = "var(--color-projected)", VERIFIED = "var(--color-verified)";
export function statusTone(s: string | null): "money" | "warn" | "danger" | "neutral" | "info" {
  return s === "active" ? "money" : s === "trialing" ? "info" : s === "past_due" ? "warn" : s === "canceled" || s === "unpaid" ? "danger" : "neutral";
}
const short = (n: string) => n.replace(/\s*\(Synthetic Demo\)\s*/i, "").slice(0, 18);

export function Portfolio({ rows, consultancyName }: { rows: ClientSummary[]; consultancyName: string }) {
  const totals = rows.reduce((a, r) => ({ projected: a.projected + r.projected, verified: a.verified + r.verified, employees: a.employees + r.employees, agents: a.agents + r.agentsDeployed, monthly: a.monthly + (r.subStatus === "active" || r.subStatus === "past_due" ? r.monthly : 0), collectors: a.collectors + r.collectorsActive }), { projected: 0, verified: 0, employees: 0, agents: 0, monthly: 0, collectors: 0 });
  const chart = rows.map((r) => ({ name: short(r.name), Projected: Math.round(r.projected), Verified: Math.round(r.verified) }));
  return (
    <div data-testid="admin-portfolio">
      <PageHeader title="Client portfolio" subtitle={`${consultancyName} — every client you manage, where each one stands, and what to do next.`} actions={<LinkButton href="/admin/clients/new" data-testid="add-client">Add client</LinkButton>} />
      {!rows.length ? <Empty title="No clients yet" body="Add your first client to create their workspace, start a 14-day trial and send the admin an invitation." action={<LinkButton href="/admin/clients/new" data-testid="add-client-empty">Add client</LinkButton>} /> : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6" data-testid="portfolio-totals">
            <Stat label="Clients" value={fmtNum(rows.length)} />
            <Stat label="Monitored employees" value={fmtNum(totals.employees)} hint="Employee records across all clients" />
            <Stat label="Collectors online" value={fmtNum(totals.collectors)} />
            <Stat label="Projected savings / yr" value={fmtUSD(totals.projected, { compact: true })} tone="projected" hint="Realizable annual savings across all clients (modelled, not measured)" />
            <Stat label="Verified savings / yr" value={fmtUSD(totals.verified, { compact: true })} tone="verified" hint="Measured post-deployment savings, annualized" />
            <Stat label="Monthly recurring revenue" value={fmtUSD(totals.monthly)} hint="Active and past-due subscriptions only; trials are excluded" />
          </div>
          <Card className="mb-6" data-testid="portfolio-chart">
            <CardHeader title="Projected vs verified savings by client" subtitle="Purple = projected (modelled). Teal = verified (measured after deployment)." />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--color-ink-2)" }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v: number) => fmtUSD(v, { compact: true })} tick={{ fontSize: 11, fill: "var(--color-ink-2)" }} axisLine={false} tickLine={false} width={64} />
                  <RTooltip formatter={(v) => fmtUSD(Number(v))} contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} cursor={{ fill: "var(--color-surface-2)" }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Projected" fill={PROJECTED} radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={56} />
                  <Bar dataKey="Verified" fill={VERIFIED} radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={56} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="client-cards">
            {rows.map((r) => <ClientCard key={r.id} r={r} />)}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "projected" | "verified" }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-ink-2">{label}{hint && <Tooltip text={hint} />}</div>
      <div className={"mt-1 text-xl font-semibold " + (tone === "projected" ? "text-projected" : tone === "verified" ? "text-verified" : "")}>{value}</div>
    </div>
  );
}

function ClientCard({ r }: { r: ClientSummary }) {
  const tz = useTimeZone();
  const seatWarn = r.seats > 0 && r.seatsUsed >= r.seats;
  return (
    <Link href={`/admin/clients/${r.id}`} className="card block p-5 transition hover:border-brand" data-testid={`client-card-${r.id}`}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.branding.primaryColor ?? "var(--color-brand)" }} /><h3 className="truncate text-sm font-semibold">{r.name}</h3></div>
          <p className="mt-0.5 text-xs text-ink-2">{r.industry ?? "Industry not set"}{r.isDemo && " · synthetic demo"}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {r.plan && <Badge tone="brand">{r.plan}</Badge>}
          {r.subStatus && <Badge tone={statusTone(r.subStatus)}>{r.subStatus.replace("_", " ")}</Badge>}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <Row k="Seats" v={`${r.seatsUsed} / ${r.seats}`} warn={seatWarn} />
        <Row k="Employees" v={fmtNum(r.employees)} />
        <Row k="Collectors" v={`${r.collectorsActive} active${r.collectorsOffline ? `, ${r.collectorsOffline} offline` : ""}${r.collectorsPending ? `, ${r.collectorsPending} pending` : ""}`} warn={r.collectorsOffline > 0} />
        <Row k="Last analysis" v={r.lastAnalysisAt ? formatDate(r.lastAnalysisAt, tz) : "never"} />
        <Row k="Projected / yr" v={fmtUSD(r.projected, { compact: true })} cls="text-projected" />
        <Row k="Verified / yr" v={fmtUSD(r.verified, { compact: true })} cls="text-verified" />
        <Row k="Agents deployed" v={`${r.agentsDeployed} / ${r.agentsTotal}`} />
        <Row k="Opportunities" v={fmtNum(r.opportunities)} />
      </dl>
      <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs"><span className="font-medium text-ink-2">Next step: </span><span data-testid="client-next-step">{r.nextStep}</span></div>
    </Link>
  );
}
function Row({ k, v, warn, cls }: { k: string; v: string; warn?: boolean; cls?: string }) {
  return <div className="flex flex-col"><dt className="text-ink-3">{k}</dt><dd className={"font-medium " + (warn ? "text-warn" : cls ?? "")}>{v}</dd></div>;
}
