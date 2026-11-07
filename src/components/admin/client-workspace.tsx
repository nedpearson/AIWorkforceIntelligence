"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Badge, Card, CardHeader, Empty, PageHeader, Table, Th, Td, Tooltip, BasisChip, Input } from "@/components/ui";
import { LinkButton } from "@/components/admin/link-button";
import { fmtUSD, fmtNum, fmtPct, fmtHours, cn } from "@/lib/utils";
import type { ClientSummary } from "@/app/admin/_data";
import type { SeatUsage } from "@/engine/billing";
import { openClientApp, bulkEnrollmentCodes, runAnalysisAction, setOpportunityStatus, saveBranding, inviteClientUser, type IssuedCode } from "@/app/admin/clients/[id]/actions";
import { statusTone } from "./portfolio";
import { ProjectsTab, BillingTab, ReportsTab, type ProjectsData, type BillingData, type ReportsData } from "./client-tabs-2";
import { useTimeZone } from "@/components/time-zone";
import { formatDate, formatDateTime, formatTime } from "@/lib/datetime";

export type TabKey = "overview" | "checklist" | "collectors" | "campaigns" | "opportunities" | "projects" | "agents" | "billing" | "reports" | "branding";
export type FinSlice = { employeesAnalyzed: number; totalAnnualLaborAnalyzed: number; hoursObservedPerWeek: number; repetitiveHoursPerWeek: number; hoursRecoverablePerWeek: number; grossAnnualSavings: number; realizableAnnualSavings: number; verifiedAnnualizedSavings: number; verifiedMeasurements: number; implementationCost: number; annualOperatingCost: number; netAnnualSavings: number; roi1y: number; paybackMonths: number | null; deployedAgents: number; opportunityCount: number; basisSummary: { observed: number; estimated: number; assumed: number }; byDepartment: { name: string; employees: number; realizableAnnual: number; verifiedAnnual: number }[] };
export type TabData =
  | { kind: "overview"; fin: FinSlice | null }
  | { kind: "checklist"; noticeCustomized: boolean; consented: number; approved: number }
  | { kind: "collectors"; usage: SeatUsage | null; collectors: { id: string; name: string; status: string; platform: string; lastSeenAt: string | null; events: number; employee: string }[]; unenrolled: number; employees: number }
  | { kind: "campaigns"; events: number; pendingJobs: { id: string; status: string; createdAt: string }[]; campaigns: { id: string; name: string; status: string; startsAt: string | null; endsAt: string | null; employees: number; departments: number }[]; runs: { id: string; status: string; campaignId: string | null; eventsAnalyzed: number; workflowsFound: number; opportunitiesFound: number; createdAt: string; finishedAt: string | null; error: string | null }[] }
  | { kind: "opportunities"; rows: OppRow[] }
  | ({ kind: "projects" } & ProjectsData)
  | { kind: "agents"; usage: SeatUsage | null; pending: number; agents: { id: string; name: string; category: string; status: string; runtime: string; runs30: number; ok30: number; minutes30: number; monthlyCost: number; verifiedDollars: number; verifiedHours: number; deployedAt: string | null; lastRunAt: string | null }[] }
  | ({ kind: "billing" } & BillingData)
  | ({ kind: "reports" } & ReportsData)
  | { kind: "branding"; branding: Branding; consultancyBranding: Branding };
export type OppRow = { id: string; rank: number; title: string; summary: string; type: string; status: string; department: string | null; feasibility: number; risk: number; hours: number; gross: number; realizable: number; impl: number; opex: number; payback: number | null; basis: "observed" | "estimated" | "assumed"; agentId: string | null };
export type Branding = { logoUrl?: string; primaryColor?: string; reportName?: string; footer?: string };
type ClientHead = { id: string; name: string; industry: string | null; isDemo: boolean; timezone: string; branding: Branding };

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" }, { key: "checklist", label: "Onboarding checklist" }, { key: "collectors", label: "Collectors" }, { key: "campaigns", label: "Campaigns" },
  { key: "opportunities", label: "Opportunities" }, { key: "projects", label: "Projects" }, { key: "agents", label: "Agents" }, { key: "billing", label: "Billing" }, { key: "reports", label: "Reports" }, { key: "branding", label: "Branding" },
];

export function useAction() {
  const r = useRouter();
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState<string>(""); const [missing, setMissing] = React.useState<string[]>([]);
  async function run<T extends { ok: boolean }>(fn: () => Promise<T>, opts: { refresh?: boolean } = { refresh: true }): Promise<Extract<T, { ok: true }> | null> {
    setBusy(true); setError(""); setMissing([]);
    try {
      const res = await fn();
      if (!res.ok) { const e = res as unknown as { error: string; missing?: string[] }; setError(e.error); setMissing(e.missing ?? []); return null; }
      if (opts.refresh !== false) r.refresh();
      return res as Extract<T, { ok: true }>;
    } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); return null; }
    finally { setBusy(false); }
  }
  return { busy, error, missing, run, setError };
}
export function ErrorNote({ error, missing, testid }: { error: string; missing?: string[]; testid?: string }) {
  if (!error) return null;
  return <div className="rounded-lg bg-danger-soft p-3 text-xs text-danger" role="alert" data-testid={testid ?? "action-error"}>{error}{missing && missing.length > 0 && <div className="mt-1 font-mono">{missing.join(", ")}</div>}</div>;
}

export function ClientWorkspace({ client, summary, tab, data, viewer }: { client: ClientHead; summary: ClientSummary; tab: TabKey; data: TabData; viewer: { role: string; email: string } }) {
  const r = useRouter(); const a = useAction();
  async function openApp() { const ok = await a.run(() => openClientApp({ clientId: client.id }), { refresh: false }); if (ok) { r.push("/app"); r.refresh(); } }
  return (
    <div data-testid="client-workspace">
      <PageHeader
        title={<span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: client.branding.primaryColor ?? "var(--color-brand)" }} />{client.name}{client.isDemo && <Badge tone="warn">synthetic demo</Badge>}</span>}
        subtitle={<span className="flex flex-wrap items-center gap-2">{client.industry ?? "Industry not set"} · {client.timezone}{summary.plan && <Badge tone="brand">{summary.plan}</Badge>}{summary.subStatus && <Badge tone={statusTone(summary.subStatus)}>{summary.subStatus.replace("_", " ")}</Badge>}{summary.seats > 0 && summary.seatsUsed >= summary.seats && <Badge tone="warn">seats full</Badge>}</span>}
        actions={<><LinkButton variant="secondary" href="/admin" data-testid="back-to-portfolio">All clients</LinkButton><Button onClick={openApp} loading={a.busy} data-testid="open-client-app">Open client app</Button></>}
      />
      <ErrorNote error={a.error} />
      <nav className="mb-5 -mx-4 overflow-x-auto px-4 scrollbar-thin" aria-label="Client sections">
        <div className="flex w-max gap-1 border-b border-border">
          {TABS.map((t) => <Link key={t.key} href={`/admin/clients/${client.id}?tab=${t.key}`} data-testid={`tab-${t.key}`} className={cn("whitespace-nowrap border-b-2 px-3 py-2 text-sm", tab === t.key ? "border-brand font-medium text-brand" : "border-transparent text-ink-2 hover:text-ink")}>{t.label}</Link>)}
        </div>
      </nav>
      {data.kind === "overview" && <OverviewTab fin={data.fin} summary={summary} clientId={client.id} />}
      {data.kind === "checklist" && <ChecklistTab d={data} s={summary} clientId={client.id} />}
      {data.kind === "collectors" && <CollectorsTab d={data} clientId={client.id} />}
      {data.kind === "campaigns" && <CampaignsTab d={data} clientId={client.id} />}
      {data.kind === "opportunities" && <OpportunitiesTab rows={data.rows} clientId={client.id} />}
      {data.kind === "projects" && <ProjectsTab d={data} clientId={client.id} />}
      {data.kind === "agents" && <AgentsTab d={data} />}
      {data.kind === "billing" && <BillingTab d={data} clientId={client.id} />}
      {data.kind === "reports" && <ReportsTab d={data} clientId={client.id} clientName={client.name} />}
      {data.kind === "branding" && <BrandingTab branding={data.branding} consultancyBranding={data.consultancyBranding} clientId={client.id} />}
      <p className="mt-8 text-[11px] text-ink-3">Viewing as {viewer.email} ({viewer.role} at the consultancy). All reads are scoped to this client; mutations are written to the audit log.</p>
    </div>
  );
}

// ---------- Overview ----------
function Stat({ label, value, hint, tone, testid }: { label: string; value: string; hint?: string; tone?: "projected" | "verified" | "money"; testid?: string }) {
  return <div className="card p-4" data-testid={testid}><div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-ink-2">{label}{hint && <Tooltip text={hint} />}</div><div className={cn("mt-1 text-xl font-semibold", tone === "projected" && "text-projected", tone === "verified" && "text-verified", tone === "money" && "text-money")}>{value}</div></div>;
}
function OverviewTab({ fin, summary, clientId }: { fin: FinSlice | null; summary: ClientSummary; clientId: string }) {
  if (!fin || (fin.employeesAnalyzed === 0 && fin.opportunityCount === 0)) return <Empty title="No analysis yet" body={`Next step: ${summary.nextStep}.`} action={<LinkButton href={`/admin/clients/${clientId}?tab=checklist`} data-testid="overview-go-checklist">Open onboarding checklist</LinkButton>} />;
  return (
    <div className="space-y-5" data-testid="overview-tab">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Labor analyzed / yr" value={fmtUSD(fin.totalAnnualLaborAnalyzed, { compact: true })} hint={`${fin.employeesAnalyzed} employees with observed activity, loaded cost`} />
        <Stat label="Repetitive hours / wk" value={fmtHours(fin.repetitiveHoursPerWeek)} hint={`Of ${fmtHours(fin.hoursObservedPerWeek)} observed`} />
        <Stat label="Projected savings / yr" value={fmtUSD(fin.realizableAnnualSavings, { compact: true })} tone="projected" hint={`Gross ${fmtUSD(fin.grossAnnualSavings)} before adoption and realization`} testid="overview-projected" />
        <Stat label="Verified savings / yr" value={fmtUSD(fin.verifiedAnnualizedSavings, { compact: true })} tone="verified" hint={`${fin.verifiedMeasurements} measurement(s), annualized — measured, never mixed with projections`} testid="overview-verified" />
        <Stat label="Implementation" value={fmtUSD(fin.implementationCost, { compact: true })} hint="One-time modelled cost" />
        <Stat label="Operating / yr" value={fmtUSD(fin.annualOperatingCost, { compact: true })} hint="Agent runtime + platform" />
        <Stat label="Net / yr · ROI" value={`${fmtUSD(fin.netAnnualSavings, { compact: true })} · ${fmtPct(fin.roi1y)}`} tone="money" hint={fin.paybackMonths != null ? `Payback ${fin.paybackMonths.toFixed(1)} months` : "No payback computed"} />
        <Stat label="Agents · opportunities" value={`${fin.deployedAgents} · ${fin.opportunityCount}`} hint="Deployed agents · opportunities in scope" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="By department" subtitle="Projected (purple) vs verified (teal) annual savings." />
          {!fin.byDepartment.length ? <p className="text-xs text-ink-2">No departments analyzed yet.</p> : (
            <ul className="space-y-2">{fin.byDepartment.map((d) => { const max = Math.max(1, ...fin.byDepartment.map((x) => x.realizableAnnual)); return (
              <li key={d.name} className="text-xs"><div className="flex justify-between"><span className="font-medium">{d.name} <span className="text-ink-3">· {d.employees}</span></span><span><span className="text-projected">{fmtUSD(d.realizableAnnual, { compact: true })}</span> / <span className="text-verified">{fmtUSD(d.verifiedAnnual, { compact: true })}</span></span></div>
                <div className="mt-1 h-1.5 w-full rounded bg-surface-2"><div className="h-1.5 rounded bg-projected" style={{ width: `${(d.realizableAnnual / max) * 100}%` }} /></div><div className="mt-0.5 h-1.5 w-full rounded bg-surface-2"><div className="h-1.5 rounded bg-verified" style={{ width: `${(d.verifiedAnnual / max) * 100}%` }} /></div></li>); })}</ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Where the numbers come from" subtitle="Share of analytical inputs by evidence basis." />
          <div className="flex flex-wrap gap-2 text-xs">{(["observed", "estimated", "assumed"] as const).map((b) => <span key={b} className="flex items-center gap-1"><BasisChip basis={b} />{fmtNum(fin.basisSummary[b])}</span>)}</div>
          <p className="mt-3 text-xs text-ink-2">Time saved is not payroll removed: projected figures apply adoption and realization rates to observed workflow hours. Verified figures come only from post-deployment measurements.</p>
          <div className="mt-4 rounded-lg bg-surface-2 p-3 text-xs"><span className="font-medium">Next step:</span> {summary.nextStep}</div>
        </Card>
      </div>
    </div>
  );
}

// ---------- Checklist ----------
function ChecklistTab({ d, s, clientId }: { d: Extract<TabData, { kind: "checklist" }>; s: ClientSummary; clientId: string }) {
  const tz = useTimeZone();
  const items: { label: string; done: boolean; detail: string; tab?: TabKey; help: string }[] = [
    { label: "Client admin accepted invitation", done: s.inviteAccepted, detail: s.inviteAccepted ? "An owner or admin is active" : s.pendingInvites ? `${s.pendingInvites} invitation(s) pending` : "No invitation outstanding — send one from Branding → Invite", help: "The client needs at least one owner/admin login before they can sign the authorization." },
    { label: "Signed authorization recorded", done: s.authorizations > 0, detail: `${s.authorizations} authorization(s)`, help: "A named officer authorizes metadata-only observation. Done in the client app under Data Collection → Authorization." },
    { label: "Employee notice reviewed", done: d.noticeCustomized || s.authorizations > 0, detail: d.noticeCustomized ? "Custom notice saved" : "Default notice in use", help: "The notice employees see on first run. The default is fine for most clients." },
    { label: "Employees added", done: s.employees > 0, detail: `${s.employees} employee(s)`, help: "Import a CSV in the wizard or add people in the client app." },
    { label: "Collectors enrolled", done: s.collectorsActive > 0, detail: `${s.collectorsActive} active, ${s.collectorsPending} pending, ${s.collectorsOffline} offline`, tab: "collectors", help: "Each monitored employee runs the collector. Use the bulk enrollment action." },
    { label: "Consent acknowledged", done: d.consented > 0, detail: `${d.consented} employee(s) acknowledged`, help: "Employees acknowledge the notice in the collector or on the Trust page." },
    { label: "Observation campaign", done: s.campaigns > 0, detail: `${s.campaigns} campaign(s), ${s.campaignsRunning} running`, tab: "campaigns", help: "A campaign defines who is observed and when." },
    { label: "Analysis run", done: s.lastAnalysisStatus === "done", detail: s.lastAnalysisAt ? `Last ${formatDateTime(s.lastAnalysisAt, tz)} (${s.lastAnalysisStatus})` : "Never", tab: "campaigns", help: "Turns activity into workflows and ranked opportunities." },
    { label: "Opportunities approved", done: d.approved > 0, detail: `${d.approved} approved of ${s.opportunities}`, tab: "opportunities", help: "Approval moves an opportunity toward an agent build." },
    { label: "Agents deployed", done: s.agentsDeployed > 0, detail: `${s.agentsDeployed} deployed of ${s.agentsTotal}`, tab: "agents", help: "Deployed in the client app under AI Agents." },
    { label: "Savings measured", done: s.measurements > 0, detail: `${s.measurements} measurement(s)`, help: "Verified savings come only from measurements after deployment." },
    { label: "Executive report delivered", done: s.reports > 0, detail: `${s.reports} report(s)`, tab: "reports", help: "White-labelled PDF for the client's leadership." },
  ];
  const done = items.filter((i) => i.done).length;
  return (
    <Card data-testid="checklist-tab">
      <CardHeader title={`Onboarding checklist — ${done} of ${items.length} complete`} subtitle="Live from the client's data. Nothing here is a manual tick box." />
      <div className="mb-4 h-2 w-full rounded bg-surface-2"><div className="h-2 rounded bg-brand" style={{ width: `${(done / items.length) * 100}%` }} /></div>
      <ol className="divide-y divide-border">{items.map((i, idx) => (
        <li key={i.label} className="flex items-start gap-3 py-3 text-sm" data-testid={`checklist-item-${idx}`} data-done={i.done}>
          <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold", i.done ? "bg-money-soft text-money" : "bg-surface-2 text-ink-3")}>{i.done ? "✓" : idx + 1}</span>
          <div className="min-w-0 flex-1"><div className="flex items-center gap-1 font-medium">{i.label}<Tooltip text={i.help} /></div><div className="text-xs text-ink-2">{i.detail}</div></div>
          {i.tab && !i.done && <Button size="sm" variant="secondary" href={`/admin/clients/${clientId}?tab=${i.tab}`}>Go</Button>}
        </li>))}</ol>
    </Card>
  );
}

// ---------- Collectors ----------
function CollectorsTab({ d, clientId }: { d: Extract<TabData, { kind: "collectors" }>; clientId: string }) {
  const tz = useTimeZone();
  const a = useAction(); const [issued, setIssued] = React.useState<{ issued: IssuedCode[]; skippedForSeats: number } | null>(null);
  const counts = { active: 0, pending: 0, offline: 0, paused: 0, revoked: 0 } as Record<string, number>; d.collectors.forEach((c) => { counts[c.status] = (counts[c.status] ?? 0) + 1; });
  const u = d.usage;
  return (
    <div className="space-y-4" data-testid="collectors-tab">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Active" value={fmtNum(counts.active)} /><Stat label="Pending install" value={fmtNum(counts.pending)} /><Stat label="Offline" value={fmtNum(counts.offline)} /><Stat label="Not enrolled" value={fmtNum(d.unenrolled)} hint="Active employees without a collector" />
        <Stat label="Seats" value={u ? `${u.used} / ${u.seats}` : "—"} hint="Monitored employees counted against the plan" testid="collectors-seats" />
      </div>
      {u && u.used >= u.seats && <div className="rounded-lg bg-warn-soft p-3 text-xs text-warn" data-testid="seat-warning">All {u.seats} seats on the {u.plan} plan are in use. Enrolling more employees needs extra seats or a plan upgrade (Billing tab).</div>}
      <Card>
        <CardHeader title="Bulk enrollment" subtitle="Creates one enrollment code per active employee who has no collector yet, up to the remaining seats. Codes are shown once." action={<Button onClick={async () => { const r = await a.run(() => bulkEnrollmentCodes({ clientId })); if (r) setIssued({ issued: r.issued, skippedForSeats: r.skippedForSeats }); }} loading={a.busy} disabled={d.unenrolled === 0} data-testid="bulk-enroll">Create codes for {d.unenrolled} employee(s)</Button>} />
        <ErrorNote error={a.error} />
        {issued && (
          <div data-testid="issued-codes">
            {issued.skippedForSeats > 0 && <p className="mb-2 text-xs text-warn">{issued.skippedForSeats} employee(s) skipped: no seats left.</p>}
            {!issued.issued.length ? <p className="text-xs text-ink-2">No codes were created.</p> : (
              <Table><thead><tr><Th>Employee</Th><Th>Code</Th><Th>Install command</Th></tr></thead><tbody>{issued.issued.map((i) => (
                <tr key={i.collectorId}><Td>{i.employeeName}</Td><Td><code className="font-mono text-xs" data-testid="issued-code">{i.code}</code></Td><Td><code className="block max-w-md truncate font-mono text-[11px] text-ink-2">BRIDGEBOX_URL={i.url} BRIDGEBOX_ENROLL_CODE={i.code} bridgebox-collector</code></Td></tr>))}</tbody></Table>
            )}
            <p className="mt-2 text-xs text-ink-3">Windows: <code>$env:BRIDGEBOX_URL=&quot;…&quot;; $env:BRIDGEBOX_ENROLL_CODE=&quot;…&quot;; bridgebox-collector.exe</code>. See docs/COLLECTOR.md for Intune / Jamf deployment.</p>
          </div>
        )}
      </Card>
      {!d.collectors.length ? <Empty title="No collectors" body={d.employees ? "Use bulk enrollment above to create codes." : "Add employees first (wizard CSV or the client app)."} /> : (
        <Table><thead><tr><Th>Employee</Th><Th>Collector</Th><Th>Status</Th><Th>Platform</Th><Th>Last seen</Th><Th className="text-right">Events</Th></tr></thead><tbody>{d.collectors.map((c) => (
          <tr key={c.id} data-testid={`collector-row-${c.id}`}><Td>{c.employee}</Td><Td>{c.name}</Td><Td><Badge tone={c.status === "active" ? "money" : c.status === "offline" ? "danger" : c.status === "pending" ? "info" : "neutral"}>{c.status}</Badge></Td><Td>{c.platform}</Td><Td>{c.lastSeenAt ? formatDateTime(c.lastSeenAt, tz) : "never"}</Td><Td className="text-right">{fmtNum(c.events)}</Td></tr>))}</tbody></Table>
      )}
    </div>
  );
}

// ---------- Campaigns ----------
function CampaignsTab({ d, clientId }: { d: Extract<TabData, { kind: "campaigns" }>; clientId: string }) {
  const tz = useTimeZone();
  const a = useAction(); const [jobId, setJobId] = React.useState("");
  const run = async (campaignId?: string) => { const r = await a.run(() => runAnalysisAction({ clientId, campaignId })); if (r) setJobId(r.jobId); };
  return (
    <div className="space-y-4" data-testid="campaigns-tab">
      <Card>
        <CardHeader title="Observation campaigns" subtitle={`${fmtNum(d.events)} activity events stored. Campaigns are created in the client app (Data Collection → Campaigns).`} action={<Button onClick={() => run()} loading={a.busy} disabled={d.events === 0} data-testid="run-analysis-all">Run analysis on all data</Button>} />
        <ErrorNote error={a.error} />
        {jobId && <p className="mb-3 text-xs text-money" data-testid="analysis-queued">Analysis queued (job {jobId.slice(0, 8)}). The worker processes it; refresh to see the run.</p>}
        {d.pendingJobs.length > 0 && <p className="mb-3 text-xs text-ink-2" data-testid="analysis-pending">{d.pendingJobs.length} analysis job(s) waiting for the worker (<code>npm run worker</code> or <code>/api/jobs/run</code>): {d.pendingJobs.map((j) => `${j.status} · ${formatTime(j.createdAt, tz)}`).join(", ")}</p>}
        {!d.campaigns.length ? <p className="text-xs text-ink-2">No campaigns yet.</p> : (
          <Table><thead><tr><Th>Name</Th><Th>Status</Th><Th>Window</Th><Th>Scope</Th><Th></Th></tr></thead><tbody>{d.campaigns.map((c) => (
            <tr key={c.id} data-testid={`campaign-row-${c.id}`}><Td className="font-medium">{c.name}</Td><Td><Badge tone={c.status === "running" ? "money" : c.status === "completed" ? "verified" : "neutral"}>{c.status}</Badge></Td><Td className="text-xs">{c.startsAt ? formatDate(c.startsAt, tz) : "—"} → {c.endsAt ? formatDate(c.endsAt, tz) : "—"}</Td><Td className="text-xs">{c.employees} people · {c.departments} depts</Td><Td><Button size="sm" variant="secondary" onClick={() => run(c.id)} loading={a.busy} data-testid={`run-analysis-${c.id}`}>Run analysis</Button></Td></tr>))}</tbody></Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Analysis runs" subtitle="Most recent first." />
        {!d.runs.length ? <p className="text-xs text-ink-2">No analysis has run yet.</p> : (
          <Table><thead><tr><Th>When</Th><Th>Status</Th><Th className="text-right">Events</Th><Th className="text-right">Workflows</Th><Th className="text-right">Opportunities</Th></tr></thead><tbody>{d.runs.map((r) => (
            <tr key={r.id}><Td className="text-xs">{formatDateTime(r.createdAt, tz)}</Td><Td><Badge tone={r.status === "done" ? "money" : r.status === "failed" ? "danger" : "info"}>{r.status}</Badge>{r.error && <span className="ml-2 text-xs text-danger">{r.error}</span>}</Td><Td className="text-right">{fmtNum(r.eventsAnalyzed)}</Td><Td className="text-right">{fmtNum(r.workflowsFound)}</Td><Td className="text-right">{fmtNum(r.opportunitiesFound)}</Td></tr>))}</tbody></Table>
        )}
      </Card>
    </div>
  );
}

// ---------- Opportunities ----------
export function OpportunityTable({ rows, clientId, showClient }: { rows: (OppRow & { clientName?: string; clientId?: string })[]; clientId?: string; showClient?: boolean }) {
  const a = useAction();
  return (
    <>
      <ErrorNote error={a.error} />
      <Table><thead><tr><Th>#</Th>{showClient && <Th>Client</Th>}<Th>Opportunity</Th><Th>Type</Th><Th>Status</Th><Th className="text-right">Hrs/wk</Th><Th className="text-right">Realizable / yr</Th><Th className="text-right">Payback</Th><Th>Basis</Th><Th></Th></tr></thead><tbody>{rows.map((o) => (
        <tr key={o.id} data-testid={`opp-row-${o.id}`}>
          <Td>{o.rank}</Td>{showClient && <Td className="max-w-[12rem] text-xs">{o.clientId ? <Link className="text-brand hover:underline" href={`/admin/clients/${o.clientId}?tab=opportunities`}>{o.clientName}</Link> : o.clientName}</Td>}
          <Td><div className="font-medium">{o.title}</div><div className="max-w-md truncate text-xs text-ink-2">{o.department ? `${o.department} · ` : ""}{o.summary}</div></Td>
          <Td className="text-xs">{o.type.replace(/_/g, " ")}</Td><Td><Badge tone={o.status === "approved" ? "money" : o.status === "deployed" || o.status === "verified" ? "verified" : o.status === "rejected" ? "danger" : "neutral"}>{o.status.replace("_", " ")}</Badge></Td>
          <Td className="text-right">{fmtNum(o.hours, 1)}</Td><Td className="text-right text-projected">{fmtUSD(o.realizable)}</Td><Td className="text-right">{o.payback != null ? `${o.payback.toFixed(1)} mo` : "—"}</Td><Td><BasisChip basis={o.basis} /></Td>
          <Td>{(o.status === "identified" || o.status === "reviewing") && <Button size="sm" onClick={() => a.run(() => setOpportunityStatus({ clientId: clientId ?? o.clientId, opportunityId: o.id, status: "approved" }))} loading={a.busy} data-testid={`approve-${o.id}`}>Approve</Button>}</Td>
        </tr>))}</tbody></Table>
    </>
  );
}
function OpportunitiesTab({ rows, clientId }: { rows: OppRow[]; clientId: string }) {
  const [status, setStatus] = React.useState("");
  const shown = rows.filter((r) => !status || r.status === status);
  if (!rows.length) return <Empty title="No opportunities yet" body="Run an analysis from the Campaigns tab once activity has been collected." action={<Button href={`/admin/clients/${clientId}?tab=campaigns`}>Go to campaigns</Button>} />;
  const total = rows.filter((r) => r.status !== "rejected").reduce((s, r) => s + r.realizable, 0);
  return (
    <div className="space-y-3" data-testid="opportunities-tab">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{rows.length} opportunities · <span className="text-projected">{fmtUSD(total)}</span> realizable per year (projected)</span>
        <select className="h-8 rounded-lg border border-border bg-surface px-2 text-xs" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="opp-status-filter"><option value="">All statuses</option>{["identified", "reviewing", "approved", "in_progress", "deployed", "verified", "rejected"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></div>
      <OpportunityTable rows={shown} clientId={clientId} />
    </div>
  );
}

// ---------- Agents ----------
function AgentsTab({ d }: { d: Extract<TabData, { kind: "agents" }> }) {
  const deployed = d.agents.filter((x) => x.status === "deployed").length;
  const u = d.usage;
  return (
    <div className="space-y-4" data-testid="agents-tab">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Deployed" value={`${deployed} / ${d.agents.length}`} /><Stat label="Agent slots" value={u ? `${u.agentsUsed} / ${u.agentSlots}` : "—"} hint="Configured/deployed agents against the plan allowance" testid="agents-slots" /><Stat label="Pending approvals" value={fmtNum(d.pending)} /><Stat label="Verified $ (all time)" value={fmtUSD(d.agents.reduce((s, x) => s + x.verifiedDollars, 0), { compact: true })} tone="verified" />
      </div>
      {u && u.overAgents && <div className="rounded-lg bg-warn-soft p-3 text-xs text-warn" data-testid="agent-slot-warning">More agents configured than the plan allows ({u.agentsUsed} of {u.agentSlots}). Add agent slots on the Billing tab.</div>}
      {!d.agents.length ? <Empty title="No agents yet" body="Agents are built from approved opportunities in the client app (AI Agents)." /> : (
        <Table><thead><tr><Th>Agent</Th><Th>Category</Th><Th>Status</Th><Th>Runtime</Th><Th className="text-right">Runs (30d)</Th><Th className="text-right">Success</Th><Th className="text-right">Min saved (30d)</Th><Th className="text-right">Verified $</Th><Th className="text-right">Cost / mo</Th></tr></thead><tbody>{d.agents.map((x) => (
          <tr key={x.id} data-testid={`agent-row-${x.id}`}><Td className="font-medium">{x.name}</Td><Td className="text-xs">{x.category.replace(/_/g, " ")}</Td><Td><Badge tone={x.status === "deployed" ? "money" : x.status === "error" ? "danger" : "neutral"}>{x.status}</Badge></Td><Td className="text-xs">{x.runtime}</Td><Td className="text-right">{fmtNum(x.runs30)}</Td><Td className="text-right">{x.runs30 ? fmtPct(x.ok30 / x.runs30) : "—"}</Td><Td className="text-right">{fmtNum(x.minutes30)}</Td><Td className="text-right text-verified">{fmtUSD(x.verifiedDollars)}</Td><Td className="text-right">{fmtUSD(x.monthlyCost)}</Td></tr>))}</tbody></Table>
      )}
    </div>
  );
}

// ---------- Branding ----------
function BrandingTab({ branding, consultancyBranding, clientId }: { branding: Branding; consultancyBranding: Branding; clientId: string }) {
  const a = useAction(); const inv = useAction();
  const [f, setF] = React.useState({ reportName: branding.reportName ?? "", primaryColor: branding.primaryColor ?? "", footer: branding.footer ?? "", logoUrl: branding.logoUrl ?? "" });
  const [saved, setSaved] = React.useState(false);
  const [invite, setInvite] = React.useState({ email: "", role: "admin" }); const [inviteUrl, setInviteUrl] = React.useState("");
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="branding-tab">
      <Card>
        <CardHeader title="White-label branding" subtitle="Used on the client's app header and on every PDF report. Leave blank to use BridgeBox defaults." />
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); setSaved(false); const r = await a.run(() => saveBranding({ clientId, ...f })); if (r) setSaved(true); }}>
          <Input label="Report name" value={f.reportName} onChange={(e) => setF({ ...f, reportName: e.target.value })} placeholder={consultancyBranding.reportName ?? "e.g. Pearson Advisory Workforce Report"} data-testid="branding-report-name" hint="Setting this turns on white-label mode for PDFs." />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Primary color (hex)" value={f.primaryColor} onChange={(e) => setF({ ...f, primaryColor: e.target.value })} placeholder="#0f766e" data-testid="branding-color" />
            <div className="flex items-end pb-1"><span className="h-8 w-8 rounded-lg border border-border" style={{ background: /^#[0-9a-fA-F]{6}$/.test(f.primaryColor) ? f.primaryColor : "var(--color-brand)" }} /></div>
          </div>
          <Input label="Logo URL" value={f.logoUrl} onChange={(e) => setF({ ...f, logoUrl: e.target.value })} placeholder="https://…/logo.png" data-testid="branding-logo" />
          <Input label="Report footer" value={f.footer} onChange={(e) => setF({ ...f, footer: e.target.value })} placeholder="Confidential — prepared for …" data-testid="branding-footer" />
          <ErrorNote error={a.error} />
          {saved && <p className="text-xs text-money" data-testid="branding-saved">Saved.</p>}
          <Button type="submit" loading={a.busy} data-testid="branding-save">Save branding</Button>
        </form>
      </Card>
      <Card>
        <CardHeader title="Invite a client user" subtitle="Creates a one-time invitation link (14 days). Send it yourself — this environment does not send email." />
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const r = await inv.run(() => inviteClientUser({ clientId, email: invite.email, role: invite.role }), { refresh: false }); if (r) setInviteUrl(r.url); }}>
          <Input label="Email" type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} data-testid="invite-email" />
          <label className="block text-sm"><span className="mb-1 block text-xs font-medium text-ink-2">Role</span><select className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })} data-testid="invite-role">{["owner", "admin", "manager", "viewer"].map((r) => <option key={r}>{r}</option>)}</select></label>
          <ErrorNote error={inv.error} />
          {inviteUrl && <div className="rounded-lg bg-surface-2 p-2 font-mono text-[11px] break-all" data-testid="invite-link">{inviteUrl}</div>}
          <Button type="submit" variant="secondary" loading={inv.busy} data-testid="invite-submit">Create invitation link</Button>
        </form>
      </Card>
    </div>
  );
}
