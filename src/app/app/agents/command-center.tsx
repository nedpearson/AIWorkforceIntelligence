"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Activity, CircleCheck, Clock, DollarSign, TriangleAlert, RotateCcw, Plus, KeyRound, Inbox, Wand2, Plug, CalendarClock, Hand, Workflow, Info } from "lucide-react";
import { Button, Empty, PageHeader } from "@/components/ui";
import { KpiCard, FilterBar, SectionHeader, StatusPill, ExportButton, type FilterDef, type Accent } from "@/components/ui/enterprise";
import { DrilldownModal, type Drill } from "@/components/dashboard/stat-tile";
import { fmtNum, fmtUSD, fmtPct, cn } from "@/lib/utils";
import type { AgentMetrics, FailureAlert, Portfolio, PortfolioKpis } from "@/engine/agents/portfolio";
import { BUSINESS_FUNCTIONS, type BusinessFunction } from "@/engine/agents/templates";
import { retryRun } from "./actions";
import { ago } from "./agents-list";

export const FUNCTION_ACCENT: Record<BusinessFunction, Accent> = { finance: "emerald", sales: "royal", operations: "cyan", customer_service: "purple", hr: "indigo", marketing: "gold" };
const PROVIDER_LABEL: Record<string, string> = { http_bearer: "HTTP API", quickbooks: "QuickBooks", hubspot: "HubSpot", zendesk: "Zendesk", smtp: "SMTP", n8n: "n8n" };

type Props = { portfolio: Portfolio; agents: AgentMetrics[]; kpis: PortfolioKpis; alerts: FailureAlert[]; filterDefs: FilterDef[]; filtered: boolean; pending: number; hasOpportunities: boolean; perms: { write: boolean; approve: boolean; creds: boolean } };

export function CommandCenter({ portfolio, agents, kpis, alerts, filterDefs, filtered, pending, hasOpportunities, perms }: Props) {
  const router = useRouter();
  const [drill, setDrill] = React.useState<{ title: string; drill: Drill } | null>(null);
  const [busy, setBusy] = React.useState(""); const [flash, setFlash] = React.useState<{ ok: boolean; text: string } | null>(null);
  const w = portfolio.windowDays;
  const header = (
    <PageHeader hero eyebrow="Automation" icon={<Bot size={22} className="text-cyan-300" />} title="AI Agent Command Center"
      subtitle={`Every agent's work, reliability and money — from the run ledger (last ${w} days). Test runs are excluded. Time saved is capacity, not a payroll cut.`}
      actions={<>
        {perms.creds && <Button variant="glass" href="/app/agents/credentials" data-testid="agents-credentials"><KeyRound size={15} />Credentials</Button>}
        {perms.approve && <Button variant="glass" href="/app/agents/approvals" data-testid="agents-approvals"><Inbox size={15} />Approvals{pending > 0 && <span className="rounded-full bg-gold px-1.5 text-[10px] font-bold text-midnight">{pending}</span>}</Button>}
        <Button variant="glass" href="/app/automation" data-testid="agents-studio"><Wand2 size={15} />Automation Studio</Button>
        {perms.write && <Button variant="gradient" href="/app/agents/new" data-testid="agents-new"><Plus size={15} />New agent</Button>}
      </>} />
  );
  if (portfolio.agents.length === 0) return (
    <div>{header}
      <Empty title="No agents yet" body={hasOpportunities ? "Pick a template in the Automation Studio, or turn an opportunity into an agent. Every template explains what it does, what it connects to and where a person approves." : "Agents are built from opportunities found in your workflow analysis, or from a template in the Automation Studio."}
        action={<div className="flex flex-wrap justify-center gap-2"><Button variant="secondary" href="/app/opportunities" data-testid="agents-empty-opps">Go to Opportunities</Button>{perms.write && <Button href="/app/automation" data-testid="agents-empty-new">Browse templates</Button>}</div>} />
    </div>
  );
  async function retry(runId: string) {
    setBusy(runId); setFlash(null); const r = await retryRun({ runId }); setBusy("");
    setFlash(r.ok ? { ok: true, text: `Retry started — new run ${r.run.status.replace(/_/g, " ")}` } : { ok: false, text: r.error }); router.refresh();
  }
  const exportRows = agents.map((a) => ({ agent: a.name, function: BUSINESS_FUNCTIONS.find((f) => f.key === a.fn)?.label ?? a.fn, status: a.status, workflows: a.workflows.map((x) => x.name).join("; "), runs: a.runs, succeeded: a.succeeded, failed: a.failed, human_interventions: a.humanInterventions, hours_saved: Number(a.hoursSaved.toFixed(2)), loaded_hourly: Number(a.hourly.toFixed(2)), benefit_usd: Math.round(a.benefit), operating_cost_usd: Math.round(a.operatingCost), net_benefit_usd: Math.round(a.netBenefit), roi_pct: a.roi == null ? "" : Math.round(a.roi * 100), connected_systems: a.connectedSystems.join("; "), last_success: a.lastSuccessAt ?? "" }));
  const groups = BUSINESS_FUNCTIONS.map((f) => ({ f, list: agents.filter((a) => a.fn === f.key) })).filter((g) => g.list.length);
  return (
    <div className="space-y-5">
      {header}
      {flash && <div className={cn("rounded-xl px-3 py-2 text-xs", flash.ok ? "bg-emerald-soft text-emerald-ink" : "bg-coral-soft text-coral-ink")} role="status" data-testid="agents-flash">{flash.text}</div>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5 stagger">
        <KpiCard testid="kpi-active" label="Active agents" value={kpis.activeAgents} format={(n) => fmtNum(n)} accent="cyan" icon={<Bot size={16} />} caption={`of ${kpis.totalAgents} ${filtered ? "shown" : "total"}`}
          onClick={() => setDrill({ title: "Active agents", drill: { tree: kpis.trees.activeAgents, meaning: "Agents currently deployed. Paused, draft and retired agents are not counted." } })} />
        <KpiCard testid="kpi-executions" label="Executions" value={kpis.executions} format={(n) => fmtNum(n)} accent="royal" icon={<Activity size={16} />} caption={`last ${w} days · test runs excluded`}
          onClick={() => setDrill({ title: "Executions", drill: { tree: kpis.trees.executions, meaning: "Every live run started in the window, whatever its outcome. Dry runs from the test environment are never counted." } })} />
        <KpiCard testid="kpi-success" label="Success rate" value={kpis.successRate} format={(n) => fmtPct(n, 0)} accent={kpis.successRate != null && kpis.successRate < 0.8 ? "coral" : "emerald"} basis="observed" icon={<CircleCheck size={16} />} emptyText="no finished runs" caption={`${kpis.succeeded} ok · ${kpis.failed} failed`}
          onClick={() => setDrill({ title: "Success rate", drill: { tree: kpis.trees.successRate, meaning: "Share of finished runs that succeeded. Runs a person rejected (cancelled) or still waiting for approval are left out." } })} />
        <KpiCard testid="kpi-hours" label="Hours saved" value={kpis.hoursSaved} format={(n) => fmtNum(n, 1)} accent="emerald" basis="observed" icon={<Clock size={16} />} caption={`run ledger · last ${w} days`}
          onClick={() => setDrill({ title: "Hours saved", drill: { tree: kpis.trees.hoursSaved, meaning: "Minutes saved by each succeeded run, from the run ledger. Per-run minutes are the agent's expectation unless the run reports its own; a recorded measurement makes them verified." } })} />
        <KpiCard testid="kpi-net" label="Net benefit" value={kpis.netBenefit} format={(n) => fmtUSD(n, { compact: true })} accent="gold" basis="estimated" icon={<DollarSign size={16} />} caption={`${fmtUSD(kpis.benefit, { compact: true })} benefit − ${fmtUSD(kpis.operatingCost, { compact: true })} cost`}
          onClick={() => setDrill({ title: "Net benefit", drill: { tree: kpis.trees.netBenefit, meaning: "Hours saved valued at the loaded hourly cost of the people who did this work (the finance engine's run-ledger method), minus what the agents cost to run. Projected until recorded as a measurement; capacity freed is not a payroll reduction." } })} />
      </div>

      <FilterBar filters={filterDefs} testid="agents-filter" extra={<><span className="text-xs text-ink-3" data-testid="agents-count">{agents.length} of {portfolio.agents.length}</span><span className="ml-auto"><ExportButton rows={exportRows} filename="agents" testid="agents-export" /></span></>} />

      <SectionHeader accent="coral" icon={<TriangleAlert size={16} />} title="Failure alerts" subtitle="Agents with failed or rolled-back runs in the last 7 days, or failing several times in a row." id="alerts" />
      {alerts.length === 0 ? <div className="card flex items-center gap-3 p-4 text-sm text-ink-2" data-testid="alerts-empty"><CircleCheck size={18} className="text-emerald-ink" />No failures in the last 7 days{filtered ? " for these filters" : ""}.</div> : (
        <div className="grid gap-3 md:grid-cols-2 stagger" data-testid="alerts">
          {alerts.map((al) => (
            <div key={al.agentId} className="card relative overflow-hidden p-4" data-testid={`alert-${al.agentId}`}>
              <div className="absolute inset-y-0 left-0 w-1 bg-coral" />
              <div className="flex flex-wrap items-start justify-between gap-2 pl-1">
                <div className="min-w-0">
                  <Link href={`/app/agents/${al.agentId}?tab=runs`} className="font-semibold text-ink hover:underline">{al.agentName}</Link>
                  <div className="mt-0.5 flex flex-wrap gap-1.5 text-[11px]">
                    {al.consecutiveFailures > 0 && <span className="rounded-full bg-coral-soft px-2 py-0.5 font-semibold text-coral-ink">{al.consecutiveFailures} in a row</span>}
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 font-semibold text-ink-2">{al.failures7d} in 7 days</span>
                    {al.lastFailedAt && <span className="text-ink-3" suppressHydrationWarning>last {ago(al.lastFailedAt)}</span>}
                  </div>
                  {al.lastError && <p className="mt-1.5 line-clamp-2 break-words font-mono text-[11px] text-coral-ink">{al.lastError}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  {al.lastFailedRunId && perms.write && <Button size="sm" variant="secondary" onClick={() => retry(al.lastFailedRunId!)} loading={busy === al.lastFailedRunId} data-testid={`alert-retry-${al.agentId}`}><RotateCcw size={13} />Retry</Button>}
                  <Button size="sm" variant="ghost" href={`/app/agents/${al.agentId}?tab=runs`} data-testid={`alert-open-${al.agentId}`}>Runs</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {agents.length === 0 ? <Empty title="No agents match these filters" body="Clear a filter to see more agents." /> : groups.map(({ f, list }) => (
        <section key={f.key} data-testid={`agents-group-${f.key}`}>
          <SectionHeader accent={FUNCTION_ACCENT[f.key]} title={f.label} subtitle={`${list.length} agent${list.length === 1 ? "" : "s"} · ${fmtNum(list.reduce((s, a) => s + a.hoursSaved, 0), 1)} h saved · ${fmtUSD(list.reduce((s, a) => s + a.netBenefit, 0), { compact: true })} net (${w}d)`} />
          <div className="grid gap-3 xl:grid-cols-2 stagger">{list.map((a) => <AgentCard key={a.id} a={a} w={w} onDrill={(t, d) => setDrill({ title: t, drill: d })} />)}</div>
        </section>
      ))}
      <p className="text-[11px] text-ink-3">Financial benefit = hours saved × loaded hourly cost of the people who perform the linked workflow (the finance engine&apos;s run-ledger valuation). Operating cost = monthly cost × months in the window. Becomes verified only when recorded as a measurement on an agent&apos;s Results tab.</p>
      {drill && <DrilldownModal open onClose={() => setDrill(null)} title={drill.title} drill={drill.drill} />}
    </div>
  );
}

function Metric({ label, value, tone, hint, onClick, testid }: { label: string; value: React.ReactNode; tone?: string; hint?: string; onClick?: () => void; testid?: string }) {
  const inner = <><div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{label}{hint && <span title={hint} aria-label={hint} role="img" className="inline-flex"><Info size={11} className="text-ink-3" /></span>}</div><div className={cn("mt-0.5 text-sm font-bold tabular", tone ?? "text-ink")}>{value}</div></>;
  return onClick ? <button type="button" onClick={onClick} className="rounded-lg p-1.5 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo" data-testid={testid}>{inner}</button> : <div className="p-1.5" data-testid={testid}>{inner}</div>;
}

function AgentCard({ a, w, onDrill }: { a: AgentMetrics; w: number; onDrill: (title: string, d: Drill) => void }) {
  const net = a.netBenefit;
  return (
    <div className="card card-hover p-4" data-testid={`agent-row-${a.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/app/agents/${a.id}`} className="flex items-center gap-2 text-[15px] font-bold text-ink hover:underline" data-testid={`agent-link-${a.id}`}><Bot size={15} className="shrink-0 text-cyan-ink" /><span className="truncate">{a.name}</span></Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-3">
            <span>{a.categoryLabel}</span><span>· {a.runtime}</span>
            {a.workflows.length > 0 && <span className="inline-flex items-center gap-1">· <Workflow size={11} />{a.workflows.map((x) => x.name).join(", ")}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5"><StatusPill status={a.status} />{a.consecutiveFailures > 0 && <span className="rounded-full bg-coral-soft px-2 py-0.5 text-[11px] font-semibold text-coral-ink">{a.consecutiveFailures}× failing</span>}</div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-1">
        <Metric label="Tasks done" value={fmtNum(a.tasksCompleted)} hint={`Succeeded live runs in the last ${w} days.`} />
        <Metric label="Ok / failed" value={<><span className="text-emerald-ink">{a.succeeded}</span><span className="text-ink-3"> / </span><span className={a.failed ? "text-coral-ink" : "text-ink-3"}>{a.failed}</span></>} />
        <Metric label="Approvals" value={<span className="inline-flex items-center gap-1"><Hand size={12} className="text-ink-3" />{a.humanInterventions}</span>} hint="Human interventions: approval decisions made by a person on this agent's runs in the window." />
        <Metric label="Hours saved" value={fmtNum(a.hoursSaved, 1)} tone="text-emerald-ink" onClick={() => onDrill(`${a.name} — benefit`, { tree: a.trees.benefit, meaning: "Hours saved by succeeded runs × the loaded hourly cost of the people who did this work." })} testid={`agent-hours-${a.id}`} />
        <Metric label="Benefit" value={fmtUSD(a.benefit, { compact: true })} tone="text-gold-ink" onClick={() => onDrill(`${a.name} — benefit`, { tree: a.trees.benefit, meaning: "Hours saved by succeeded runs × the loaded hourly cost of the people who did this work." })} testid={`agent-benefit-${a.id}`} />
        <Metric label="Net ROI" value={<>{fmtUSD(net, { compact: true })}{a.roi != null && <span className="ml-1 text-[10px] font-semibold text-ink-3">{a.roi >= 0 ? "+" : ""}{Math.round(a.roi * 100)}%</span>}</>} tone={net >= 0 ? "text-emerald-ink" : "text-coral-ink"}
          onClick={() => onDrill(`${a.name} — net benefit`, { tree: a.trees.net, meaning: "Financial benefit minus operating cost in the window. ROI % = net ÷ operating cost." })} testid={`agent-net-${a.id}`} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-3 text-[11px] text-ink-2">
        <span className="inline-flex items-center gap-1"><DollarSign size={12} className="text-ink-3" />cost {fmtUSD(a.operatingCost)}</span>
        <span className="inline-flex flex-wrap items-center gap-1"><Plug size={12} className="text-ink-3" />{a.connectedSystems.length ? a.connectedSystems.map((s) => <span key={s} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-medium">{PROVIDER_LABEL[s] ?? s}</span>) : <span className="text-ink-3">no systems connected</span>}</span>
        <span className="inline-flex items-center gap-1" suppressHydrationWarning><CircleCheck size={12} className="text-ink-3" />last success {ago(a.lastSuccessAt)}</span>
        {a.schedule && <span className="inline-flex items-center gap-1" suppressHydrationWarning><CalendarClock size={12} className="text-ink-3" />{a.schedule.description}{a.schedule.nextRunAt && ` · next ${new Date(a.schedule.nextRunAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`}</span>}
      </div>
    </div>
  );
}
