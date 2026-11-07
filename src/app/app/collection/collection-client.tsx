"use client";
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, Button, Badge, Input, Select, Textarea, Modal, Tooltip, Empty, Table, Th, Td } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { CollectorConfig } from "@/db/schema";
import { recordAuthorization, saveNotice, sendConsentRequest, withdrawConsentForEmployee, createEnrollmentCode, collectorAction, upsertCampaign, setCampaignStatus, runAnalysisNow } from "./actions";
import { useTimeZone } from "@/components/time-zone";
import { formatDateTime, formatDate, formatCount } from "@/lib/datetime";
import { ViewerTime } from "@/components/time-zone";

export type CollectionData = {
  orgTimezone: string; retentionDays: number; notice: { version: string; text: string }; appUrl: string;
  authorization: { id: string; signerName: string; signerTitle: string; scope: string; documentText: string; signedAt: string; expiresAt: string | null } | null;
  departments: { id: string; name: string }[];
  employees: { id: string; displayName: string; title: string | null; departmentId: string | null; departmentName: string | null; isActive: boolean; consent: "acknowledged" | "sent" | "withdrawn" | "missing" | "outdated"; consentAt: string | null; withdrawnAt: string | null }[];
  collectors: { id: string; name: string; employeeId: string | null; employeeName: string | null; platform: string; status: "pending" | "active" | "paused" | "revoked" | "offline"; version: string | null; lastSeenAt: string | null; lastEventAt: string | null; eventsReceived: number; pausedUntil: string | null; config: CollectorConfig; createdAt: string }[];
  health: { active: number; offline: number; pending: number; paused: number; revoked: number; events24h: number };
  campaigns: { id: string; name: string; description: string | null; status: "draft" | "scheduled" | "running" | "paused" | "completed" | "archived"; startsAt: string | null; endsAt: string | null; departmentIds: string[]; employeeIds: string[]; config: CollectorConfig; events: number;
    lastRun: { status: string; finishedAt: string | null; eventsAnalyzed: number; workflowsFound: number; opportunitiesFound: number; error: string | null } | null;
    lastJob: { status: string; createdAt: string; error: string | null } | null }[];
};

const TABS = [["authorization", "Authorization"], ["consent", "Notice & consent"], ["collectors", "Collectors"], ["campaigns", "Campaigns"]] as const;
type Tab = (typeof TABS)[number][0];
const fmtTs = (s: string | null | undefined, tz: string) => (s ? formatDateTime(s, tz) : "—");
const ago = (s: string | null) => { if (!s) return "never"; const m = Math.round((Date.now() - new Date(s).getTime()) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function CollectionClient({ data, initialTab }: { data: CollectionData; initialTab?: string }) {
  const [tab, setTab] = React.useState<Tab>((TABS.some(([k]) => k === initialTab) ? initialTab : "authorization") as Tab);
  const gates = { authorization: !!data.authorization, consent: data.employees.some((e) => e.consent === "acknowledged"), collectors: data.collectors.some((c) => c.status === "active"), campaigns: data.campaigns.some((c) => c.status === "running") };
  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1" role="tablist" data-testid="collection-tabs">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} data-testid={`tab-${k}`} onClick={() => setTab(k)} className={cn("flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm", tab === k ? "bg-brand-soft font-medium text-brand" : "text-ink-2 hover:bg-surface-2")}>
            <span className={cn("h-2 w-2 rounded-full", gates[k] ? "bg-money" : "bg-warn")} aria-hidden />{label}
          </button>
        ))}
      </div>
      {tab === "authorization" && <AuthorizationTab data={data} />}
      {tab === "consent" && <ConsentTab data={data} />}
      {tab === "collectors" && <CollectorsTab data={data} />}
      {tab === "campaigns" && <CampaignsTab data={data} />}
    </div>
  );
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  async function run<T extends { ok: true } | { ok: false; error: string }>(fn: () => Promise<T>): Promise<Extract<T, { ok: true }> | null> {
    setBusy(true); setErr(null);
    try { const r = await fn(); if (!r.ok) { setErr((r as { error?: string }).error ?? "Something went wrong"); return null; } router.refresh(); return r as Extract<T, { ok: true }>; }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(false); }
  }
  return { busy, err, run, setErr };
}
const ErrorLine = ({ err }: { err: string | null }) => (err ? <p className="text-xs text-danger" role="alert" data-testid="action-error">{err}</p> : null);

// ---------------- Authorization ----------------
const DEFAULT_AUTH_TEXT = `I authorize BridgeBox to collect metadata-only workplace activity (foreground application, coarse document category, durations and counts; never keystrokes, clipboard, screenshots, URLs, window titles or message content) from the employees and departments in scope, for the purpose of identifying repetitive work that could be automated. Employees will receive the notice shown on the Data Collection page and may pause or withdraw at any time. Data is retained for the organization's configured retention period and is not used for individual performance evaluation.`;
function AuthorizationTab({ data }: { data: CollectionData }) {
  const tz = useTimeZone();
  const a = useAction();
  const [f, setF] = React.useState({ signerName: "", signerTitle: "", scope: "All departments", documentText: DEFAULT_AUTH_TEXT, expiresAt: "" });
  if (data.authorization) {
    const au = data.authorization;
    return (
      <Card data-testid="authorization-card">
        <CardHeader title="Signed authorization on file" subtitle={`Signed ${fmtTs(au.signedAt, tz)}${au.expiresAt ? ` · expires ${fmtTs(au.expiresAt, tz)}` : ""}`} action={<Badge tone="money">Authorized</Badge>} />
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-ink-3">Signed by</dt><dd className="font-medium" data-testid="auth-signer">{au.signerName}</dd><dd className="text-xs text-ink-2">{au.signerTitle}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-ink-3">Scope</dt><dd data-testid="auth-scope">{au.scope}</dd></div>
        </dl>
        <details className="mt-4 text-sm"><summary className="cursor-pointer text-ink-2">Authorization text</summary><pre className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-xs">{au.documentText}</pre></details>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Record the signed authorization" subtitle="An owner or officer must authorize observation before any campaign can start. This is stored with the signer's name, title and the exact text." />
      <form className="space-y-3" data-testid="authorization-form" onSubmit={async (e) => { e.preventDefault(); await a.run(() => recordAuthorization({ ...f, expiresAt: f.expiresAt || undefined })); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Signer name" required value={f.signerName} onChange={(e) => setF({ ...f, signerName: e.target.value })} data-testid="auth-signer-name" />
          <Input label="Signer title" required placeholder="e.g. Owner, CFO" value={f.signerTitle} onChange={(e) => setF({ ...f, signerTitle: e.target.value })} data-testid="auth-signer-title" />
          <Input label="Scope" required value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} hint="Departments or roles covered" data-testid="auth-scope-input" />
          <Input label="Expires (optional)" type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} data-testid="auth-expires" />
        </div>
        <Textarea label="Authorization text" rows={7} value={f.documentText} onChange={(e) => setF({ ...f, documentText: e.target.value })} data-testid="auth-text" />
        <ErrorLine err={a.err} />
        <Button type="submit" loading={a.busy} data-testid="auth-submit">Record authorization</Button>
      </form>
    </Card>
  );
}

// ---------------- Notice & consent ----------------
function ConsentTab({ data }: { data: CollectionData }) {
  const tz = useTimeZone();
  const a = useAction();
  const [text, setText] = React.useState(data.notice.text);
  const [bump, setBump] = React.useState(true);
  const tone: Record<CollectionData["employees"][number]["consent"], "money" | "info" | "danger" | "warn" | "neutral"> = { acknowledged: "money", sent: "info", withdrawn: "danger", outdated: "warn", missing: "neutral" };
  const counts = data.employees.reduce((m, e) => ({ ...m, [e.consent]: (m[e.consent] ?? 0) + 1 }), {} as Record<string, number>);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={<span className="flex items-center gap-2">Employee notice <Badge tone="neutral">v{data.notice.version}</Badge><Tooltip text="Shown to every employee the first time the collector runs and on the Trust & Privacy page. Changing the text bumps the version and asks everyone to re-acknowledge." /></span>} subtitle="Plain English. Say what is collected, what is never collected, and how to pause or withdraw." />
        <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} data-testid="notice-text" />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={bump} onChange={(e) => setBump(e.target.checked)} data-testid="notice-bump" />Bump version (employees re-acknowledge)</label>
          <Button size="sm" loading={a.busy} disabled={text === data.notice.text} onClick={() => a.run(() => saveNotice({ text, bumpVersion: bump }))} data-testid="notice-save">Save notice</Button>
          <ErrorLine err={a.err} />
        </div>
      </Card>
      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5"><CardHeader className="mb-2" title="Consent by employee" subtitle={`${counts.acknowledged ?? 0} acknowledged · ${counts.sent ?? 0} sent · ${counts.withdrawn ?? 0} withdrawn · ${(counts.missing ?? 0) + (counts.outdated ?? 0)} missing/outdated`} />
          {data.employees.some((e) => e.consent === "missing" || e.consent === "outdated") && <Button size="sm" variant="secondary" loading={a.busy} data-testid="consent-send-all" onClick={async () => { for (const e of data.employees.filter((x) => x.consent === "missing" || x.consent === "outdated")) await sendConsentRequest({ employeeId: e.id }); await a.run(async () => ({ ok: true })); }}>Send to all missing</Button>}
        </div>
        {!data.employees.length ? <div className="p-5"><Empty title="No employees yet" body="Add people under People before requesting consent." action={<Button href="/app/employees" size="sm" data-testid="consent-go-employees">Go to People</Button>} /></div> : (
          <Table className="rounded-t-none border-0 shadow-none">
            <thead><tr><Th>Employee</Th><Th>Department</Th><Th>Consent</Th><Th>When</Th><Th className="text-right">Actions</Th></tr></thead>
            <tbody>{data.employees.map((e) => (
              <tr key={e.id} data-testid={`consent-row-${e.id}`}>
                <Td><div className="font-medium">{e.displayName}</div><div className="text-xs text-ink-2">{e.title ?? ""}</div></Td>
                <Td>{e.departmentName ?? "—"}</Td>
                <Td><Badge tone={tone[e.consent]}>{e.consent}</Badge></Td>
                <Td className="text-xs text-ink-2">{e.consent === "withdrawn" ? fmtTs(e.withdrawnAt, tz) : fmtTs(e.consentAt, tz)}</Td>
                <Td className="text-right"><div className="flex justify-end gap-1">
                  {e.consent !== "acknowledged" && e.consent !== "sent" && <Button size="sm" variant="secondary" loading={a.busy} onClick={() => a.run(() => sendConsentRequest({ employeeId: e.id }))} data-testid={`consent-send-${e.id}`}>Send notice</Button>}
                  {(e.consent === "acknowledged" || e.consent === "sent") && <Button size="sm" variant="ghost" loading={a.busy} onClick={() => confirm(`Withdraw consent for ${e.displayName}? Their collector will be paused.`) && a.run(() => withdrawConsentForEmployee({ employeeId: e.id }))} data-testid={`consent-withdraw-${e.id}`}>Withdraw</Button>}
                </div></Td>
              </tr>))}</tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ---------------- Collectors ----------------
function CollectorsTab({ data }: { data: CollectionData }) {
  const tz = useTimeZone();
  const a = useAction();
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState({ employeeId: data.employees[0]?.id ?? "", name: "" });
  const [issued, setIssued] = React.useState<{ code: string; url: string; collectorId: string } | null>(null);
  const tone: Record<string, "money" | "warn" | "danger" | "neutral" | "info"> = { active: "money", paused: "warn", offline: "danger", revoked: "neutral", pending: "info" };
  const h = data.health;
  const cmd = (code: string, url: string) => ({
    sh: `BRIDGEBOX_URL=${url} BRIDGEBOX_ENROLL_CODE=${code} bridgebox-collector`,
    ps: `$env:BRIDGEBOX_URL="${url}"; $env:BRIDGEBOX_ENROLL_CODE="${code}"; bridgebox-collector.exe`,
    dev: `BRIDGEBOX_URL=${url} BRIDGEBOX_ENROLL_CODE=${code} npm run collector:dev -- --simulate`,
  });
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="monitoring-health">
        {([["Active", h.active, "money"], ["Offline", h.offline, "danger"], ["Paused", h.paused, "warn"], ["Pending install", h.pending, "info"], ["Revoked", h.revoked, "neutral"], ["Events (24h)", h.events24h, "brand"]] as const).map(([l, v, t]) => (
          <Card key={l} className="p-4" data-testid={`health-${l.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "")}`}><div className="text-xs text-ink-2">{l}</div><div className="mt-1 flex items-center gap-2 text-xl font-semibold"><span>{formatCount(v)}</span>{v > 0 && l !== "Events (24h)" && <Badge tone={t}>{l === "Active" ? "ok" : l.toLowerCase()}</Badge>}</div></Card>
        ))}
      </div>
      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5"><CardHeader className="mb-2" title="Desktop collectors" subtitle="One per employee computer. Offline = no heartbeat for 15 minutes." />
          <Button size="sm" onClick={() => { setIssued(null); setOpen(true); }} disabled={!data.employees.length} data-testid="collector-create-code">Create enrollment code</Button></div>
        {!data.collectors.length ? <div className="p-5"><Empty title="No collectors yet" body="Create an enrollment code for an employee, then run the installer on their computer. See docs/COLLECTOR.md for Intune / Jamf / GPO deployment." action={<Button size="sm" onClick={() => setOpen(true)} disabled={!data.employees.length} data-testid="collector-create-code-empty">Create enrollment code</Button>} /></div> : (
          <Table className="rounded-t-none border-0 shadow-none">
            <thead><tr><Th>Name</Th><Th>Employee</Th><Th>Platform</Th><Th>Status</Th><Th>Version</Th><Th>Last seen</Th><Th className="text-right">Events</Th><Th>Paused</Th><Th className="text-right">Actions</Th></tr></thead>
            <tbody>{data.collectors.map((c) => (
              <tr key={c.id} data-testid={`collector-row-${c.id}`}>
                <Td className="font-medium">{c.name}</Td><Td>{c.employeeName ?? <span className="text-ink-3">unassigned</span>}</Td><Td className="capitalize">{c.platform}</Td>
                <Td><Badge tone={tone[c.status]}>{c.status}</Badge></Td><Td className="text-xs">{c.version ?? "—"}</Td>
                <Td className="text-xs text-ink-2" title={fmtTs(c.lastSeenAt, tz)}>{c.lastSeenAt ? <ViewerTime dateTime={c.lastSeenAt}>{ago(c.lastSeenAt)}</ViewerTime> : "never"}</Td><Td className="text-right tabular-nums">{formatCount(c.eventsReceived)}</Td>
                <Td className="text-xs text-ink-2">{c.pausedUntil ? `until ${fmtTs(c.pausedUntil, tz)}` : c.status === "paused" ? "indefinitely" : "—"}</Td>
                <Td className="text-right"><div className="flex justify-end gap-1">
                  {c.status !== "revoked" && c.status !== "pending" && (c.status === "paused"
                    ? <Button size="sm" variant="secondary" loading={a.busy} onClick={() => a.run(() => collectorAction({ collectorId: c.id, action: "resume" }))} data-testid={`collector-resume-${c.id}`}>Resume</Button>
                    : <Button size="sm" variant="secondary" loading={a.busy} onClick={() => a.run(() => collectorAction({ collectorId: c.id, action: "pause" }))} data-testid={`collector-pause-${c.id}`}>Pause</Button>)}
                  {c.status !== "revoked" && <Button size="sm" variant="ghost" loading={a.busy} onClick={() => confirm(`Revoke ${c.name}? The device will need a new enrollment code.`) && a.run(() => collectorAction({ collectorId: c.id, action: "revoke" }))} data-testid={`collector-revoke-${c.id}`}>Revoke</Button>}
                </div></Td>
              </tr>))}</tbody>
          </Table>
        )}
        <div className="px-5 pb-4"><ErrorLine err={a.err} /></div>
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={issued ? "Enrollment code (shown once)" : "Create enrollment code"}>
        {issued ? (
          <div className="space-y-3 text-sm" data-testid="enrollment-issued">
            <p className="text-ink-2">Give this one-time code to the employee or your IT admin. It expires in 7 days and can be used once.</p>
            <div className="rounded-lg bg-surface-2 p-3 text-center font-mono text-lg tracking-widest" data-testid="enrollment-code">{issued.code}</div>
            {([["macOS / Linux", cmd(issued.code, issued.url).sh], ["Windows PowerShell", cmd(issued.code, issued.url).ps], ["Developer (simulated, no real sampling)", cmd(issued.code, issued.url).dev]] as const).map(([l, c]) => (
              <div key={l}><div className="mb-1 text-xs font-medium text-ink-2">{l}</div><pre className="overflow-x-auto rounded-lg bg-ink p-3 text-xs text-white" data-testid={`install-cmd-${l.split(" ")[0].toLowerCase()}`}>{c}</pre></div>
            ))}
            <p className="text-xs text-ink-3">The employee sees the notice on first run and must accept it; managed installs can pass <code>--accept-notice</code> only after the notice has been delivered through HR.</p>
            <Button size="sm" onClick={() => setOpen(false)} data-testid="enrollment-done">Done</Button>
          </div>
        ) : (
          <form className="space-y-3" data-testid="enrollment-form" onSubmit={async (e) => { e.preventDefault(); const r = await a.run(() => createEnrollmentCode(f)); if (r) setIssued({ code: r.code, url: r.url, collectorId: r.collectorId }); }}>
            <Select label="Employee" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })} data-testid="enrollment-employee">{data.employees.map((e) => <option key={e.id} value={e.id}>{e.displayName}{e.consent !== "acknowledged" ? ` (consent: ${e.consent})` : ""}</option>)}</Select>
            <Input label="Device name" placeholder="e.g. Dana's laptop" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="enrollment-name" />
            <ErrorLine err={a.err} />
            <Button type="submit" loading={a.busy} data-testid="enrollment-submit">Generate code</Button>
          </form>
        )}
      </Modal>
    </div>
  );
}

// ---------------- Campaigns ----------------
type CampaignForm = { id?: string; name: string; description: string; startsAt: string; endsAt: string; departmentIds: string[]; employeeIds: string[]; useSchedule: boolean; days: number[]; start: string; end: string; titleMode: "hash" | "category" | "none"; blockedApps: string };
const emptyForm = (): CampaignForm => ({ name: "", description: "", startsAt: localDate(new Date()), endsAt: localDate(new Date(Date.now() + 14 * 86400_000)), departmentIds: [], employeeIds: [], useSchedule: true, days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", titleMode: "hash", blockedApps: "" });
function CampaignsTab({ data }: { data: CollectionData }) {
  const tz = useTimeZone();
  const a = useAction();
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState<CampaignForm>(emptyForm());
  const tone: Record<string, "money" | "warn" | "neutral" | "info" | "verified" | "projected"> = { running: "money", paused: "warn", draft: "neutral", scheduled: "info", completed: "verified", archived: "neutral" };
  const edit = (c: CollectionData["campaigns"][number]) => { setF({ id: c.id, name: c.name, description: c.description ?? "", startsAt: c.startsAt?.slice(0, 10) ?? "", endsAt: c.endsAt?.slice(0, 10) ?? "", departmentIds: c.departmentIds, employeeIds: c.employeeIds, useSchedule: !!c.config.schedule, days: c.config.schedule?.days ?? [1, 2, 3, 4, 5], start: c.config.schedule?.start ?? "08:00", end: c.config.schedule?.end ?? "18:00", titleMode: c.config.titleMode ?? "hash", blockedApps: (c.config.blockedApps ?? []).join(", ") }); setOpen(true); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await a.run(() => upsertCampaign({ id: f.id, name: f.name, description: f.description || undefined, startsAt: f.startsAt ? new Date(f.startsAt + "T00:00:00").toISOString() : undefined, endsAt: f.endsAt ? new Date(f.endsAt + "T23:59:59").toISOString() : undefined, departmentIds: f.departmentIds, employeeIds: f.employeeIds, schedule: f.useSchedule ? { days: f.days, start: f.start, end: f.end } : undefined, titleMode: f.titleMode, blockedApps: f.blockedApps.split(",").map((s) => s.trim()).filter(Boolean) }));
    if (r) setOpen(false);
  };
  const scopeLabel = (c: CollectionData["campaigns"][number]) => { const d = c.departmentIds.map((id) => data.departments.find((x) => x.id === id)?.name).filter(Boolean); const e = c.employeeIds.length; return !d.length && !e ? "Whole organization" : [d.join(", "), e ? `${e} ${e === 1 ? "person" : "people"}` : ""].filter(Boolean).join(" + "); };
  return (
    <div className="space-y-4">
      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5"><CardHeader className="mb-2" title="Observation campaigns" subtitle={<span className="flex items-center gap-1">Collectors only record inside a running campaign's dates and daily schedule. <Tooltip text="Title mode controls what the collector keeps about window titles: hash = coarse category + irreversible hash (best workflow detection); category = coarse category only; none = app and timing only." /></span>} />
          <Button size="sm" onClick={() => { setF(emptyForm()); setOpen(true); }} data-testid="campaign-create">New campaign</Button></div>
        {!data.campaigns.length ? <div className="p-5"><Empty title="No campaigns yet" body="Create a 2–4 week campaign for one department to start. Nothing is collected until a campaign is running." action={<Button size="sm" onClick={() => { setF(emptyForm()); setOpen(true); }} data-testid="campaign-create-empty">Create campaign</Button>} /></div> : (
          <Table className="rounded-t-none border-0 shadow-none">
            <thead><tr><Th>Name</Th><Th>Status</Th><Th>Dates</Th><Th>Scope</Th><Th>Schedule</Th><Th>Titles</Th><Th className="text-right">Events</Th><Th>Last analysis</Th><Th className="text-right">Actions</Th></tr></thead>
            <tbody>{data.campaigns.map((c) => (
              <tr key={c.id} data-testid={`campaign-row-${c.id}`}>
                <Td><button className="font-medium text-brand hover:underline" onClick={() => edit(c)} data-testid={`campaign-edit-${c.id}`}>{c.name}</button>{c.description && <div className="max-w-xs truncate text-xs text-ink-2">{c.description}</div>}</Td>
                <Td><Badge tone={tone[c.status]}>{c.status}</Badge></Td>
                <Td className="text-xs">{c.startsAt ? formatDate(c.startsAt, tz) : "open"} → {c.endsAt ? formatDate(c.endsAt, tz) : "open"}</Td>
                <Td className="text-xs">{scopeLabel(c)}</Td>
                <Td className="text-xs">{c.config.schedule ? `${c.config.schedule.days.map((d) => DAYS[d]).join(" ")} ${c.config.schedule.start}–${c.config.schedule.end}` : "any time"}</Td>
                <Td className="text-xs">{c.config.titleMode ?? "hash"}</Td>
                <Td className="text-right tabular-nums">{formatCount(c.events)}</Td>
                <Td className="text-xs" data-testid={`campaign-analysis-${c.id}`}>
                  {c.lastJob && c.lastJob.status !== "done" ? <span className="text-ink-2">job {c.lastJob.status}{c.lastJob.status === "failed" && c.lastJob.error ? ` — ${c.lastJob.error.split("\n")[0].slice(0, 80)}` : ""}</span>
                    : c.lastRun ? <span><Badge tone={c.lastRun.status === "done" ? "verified" : c.lastRun.status === "failed" ? "warn" : "info"}>{c.lastRun.status}</Badge> <span className="text-ink-2">{c.lastRun.status === "done" ? `${c.lastRun.workflowsFound} workflows · ${c.lastRun.opportunitiesFound} opportunities` : c.lastRun.error ? c.lastRun.error.slice(0, 80) : ""}</span></span>
                    : <span className="text-ink-3">never</span>}
                </Td>
                <Td className="text-right"><div className="flex justify-end gap-1">
                  {(c.status === "draft" || c.status === "scheduled" || c.status === "paused") && <Button size="sm" loading={a.busy} onClick={() => a.run(() => setCampaignStatus({ id: c.id, status: "running" }))} data-testid={`campaign-start-${c.id}`}>{c.status === "paused" ? "Resume" : "Start"}</Button>}
                  {c.status === "running" && <Button size="sm" variant="secondary" loading={a.busy} onClick={() => a.run(() => setCampaignStatus({ id: c.id, status: "paused" }))} data-testid={`campaign-pause-${c.id}`}>Pause</Button>}
                  {(c.status === "running" || c.status === "paused") && <Button size="sm" variant="ghost" loading={a.busy} onClick={() => a.run(() => setCampaignStatus({ id: c.id, status: "completed" }))} data-testid={`campaign-complete-${c.id}`}>Complete</Button>}
                  {c.events > 0 && c.status !== "draft" && <Button size="sm" variant="secondary" loading={a.busy} onClick={() => a.run(() => runAnalysisNow({ campaignId: c.id }))} data-testid={`campaign-analyze-${c.id}`}>Run analysis now</Button>}
                </div></Td>
              </tr>))}</tbody>
          </Table>
        )}
        <div className="px-5 pb-4"><ErrorLine err={a.err} /></div>
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={f.id ? "Edit campaign" : "New campaign"} wide>
        <form className="space-y-4" onSubmit={submit} data-testid="campaign-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="campaign-name" />
            <Select label="Window titles" value={f.titleMode} onChange={(e) => setF({ ...f, titleMode: e.target.value as CampaignForm["titleMode"] })} data-testid="campaign-titlemode"><option value="hash">Category + irreversible hash (recommended)</option><option value="category">Category only</option><option value="none">Nothing about titles</option></Select>
            <Input label="Starts" type="date" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} data-testid="campaign-starts" />
            <Input label="Ends" type="date" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} data-testid="campaign-ends" />
          </div>
          <Textarea label="Description (optional)" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} data-testid="campaign-description" />
          <div className="grid gap-3 sm:grid-cols-2">
            <MultiSelect label="Departments" items={data.departments.map((d) => ({ id: d.id, label: d.name }))} value={f.departmentIds} onChange={(v) => setF({ ...f, departmentIds: v })} testid="campaign-departments" hint="Leave both empty for the whole organization." />
            <MultiSelect label="Specific people" items={data.employees.map((e) => ({ id: e.id, label: `${e.displayName}${e.consent !== "acknowledged" ? ` (no consent)` : ""}` }))} value={f.employeeIds} onChange={(v) => setF({ ...f, employeeIds: v })} testid="campaign-employees" />
          </div>
          <div className="rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.useSchedule} onChange={(e) => setF({ ...f, useSchedule: e.target.checked })} data-testid="campaign-use-schedule" />Only observe on these days and hours ({data.orgTimezone})</label>
            {f.useSchedule && <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="flex gap-1">{DAYS.map((d, i) => <button type="button" key={d} onClick={() => setF({ ...f, days: f.days.includes(i) ? f.days.filter((x) => x !== i) : [...f.days, i].sort() })} className={cn("h-8 w-10 rounded-md border text-xs", f.days.includes(i) ? "border-brand bg-brand-soft text-brand" : "border-border text-ink-2")} data-testid={`campaign-day-${i}`}>{d}</button>)}</div>
              <Input label="From" type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} className="w-32" data-testid="campaign-start-time" />
              <Input label="To" type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} className="w-32" data-testid="campaign-end-time" />
            </div>}
          </div>
          <Input label="Extra blocked apps (comma-separated)" value={f.blockedApps} onChange={(e) => setF({ ...f, blockedApps: e.target.value })} hint="Password managers, banking, health and personal messaging apps are always blocked." data-testid="campaign-blocked" />
          <ErrorLine err={a.err} />
          <div className="flex gap-2"><Button type="submit" loading={a.busy} data-testid="campaign-submit">{f.id ? "Save changes" : "Create campaign"}</Button><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button></div>
        </form>
      </Modal>
    </div>
  );
}

function MultiSelect({ label, items, value, onChange, testid, hint }: { label: string; items: { id: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; testid: string; hint?: string }) {
  return (
    <div className="text-sm">
      <div className="mb-1 text-xs font-medium text-ink-2">{label}</div>
      <div className="max-h-40 overflow-y-auto rounded-lg border border-border p-2" data-testid={testid}>
        {!items.length && <div className="text-xs text-ink-3">None available</div>}
        {items.map((it) => <label key={it.id} className="flex items-center gap-2 py-0.5 text-xs"><input type="checkbox" checked={value.includes(it.id)} onChange={(e) => onChange(e.target.checked ? [...value, it.id] : value.filter((x) => x !== it.id))} data-testid={`${testid}-${it.id}`} />{it.label}</label>)}
      </div>
      {hint && <div className="mt-1 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}
