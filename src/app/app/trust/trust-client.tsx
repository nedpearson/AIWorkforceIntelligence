"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { Card, CardHeader, Button, Badge, Table, Th, Td, Empty } from "@/components/ui";
import type { Role } from "@/lib/rbac";
import { withdrawMyConsent, acknowledgeMyNotice, pauseMyCollector } from "./actions";

export type TrustData = {
  orgName: string; retentionDays: number; notice: { version: string; text: string }; role: Role; blockedApps: readonly string[];
  authorization: { signerName: string; signerTitle: string; signedAt: string; scope: string } | null;
  runningCampaigns: number;
  me: { displayName: string; consent: "acknowledged" | "sent" | "withdrawn" | "missing" | "outdated"; consentVersion: string | null; acknowledgedAt: string | null; withdrawnAt: string | null; method: string | null;
    collectors: { id: string; name: string; status: string; platform: string; lastSeenAt: string | null; pausedUntil: string | null; eventsReceived: number }[];
    campaigns: { id: string; name: string; startsAt: string | null; endsAt: string | null; schedule: { days: number[]; start: string; end: string; tz?: string } | null; titleMode: "hash" | "category" | "none" }[] } | null;
  visibility: { label: string; perm: string; explain: string; roles: Role[] }[];
  roles: Role[];
};

const COLLECTED = [
  ["Which application is in front", "e.g. Excel, QuickBooks, Chrome — the program name only."],
  ["A coarse document category", "e.g. \"invoice\", \"report\", \"ticket\". Derived on your computer from the window title, which is then discarded. Optionally an irreversible hash so repeated documents can be matched; never the title itself."],
  ["How long and when", "Time spent in each app, switches between apps, idle periods — only inside the campaign's schedule."],
  ["Counts, never contents", "Number of fields filled, pastes or clicks in a step. Never what was typed or pasted."],
];
const NEVER = ["Keystrokes or what you type", "Clipboard contents", "Screenshots or screen recording", "Web addresses (URLs) or page contents", "Window titles, file names or document contents", "Emails, chats or messages", "Camera, microphone or location", "Anything from blocked apps (password managers, banking, health, personal messaging)", "Anything outside the campaign's days and hours, or while you are paused"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

export function TrustClient({ data }: { data: TrustData }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState<string | null>(null); const [msg, setMsg] = React.useState<string | null>(null);
  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await fn(); if (!r.ok) setErr(r.error ?? "Something went wrong"); else { setMsg(okMsg); router.refresh(); } } finally { setBusy(false); }
  }
  const me = data.me;
  const anyActive = me?.collectors.some((c) => c.status === "active" || c.status === "offline");
  const anyPaused = me?.collectors.some((c) => c.status === "paused");
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card data-testid="trust-collected">
          <CardHeader title="What is collected" subtitle="Metadata about how work flows between applications. The goal is to find repetitive steps that software could do, not to rate people." />
          <ul className="space-y-2 text-sm">{COLLECTED.map(([t, d]) => <li key={t} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-money" /><div><span className="font-medium">{t}</span> <span className="text-ink-2">— {d}</span></div></li>)}</ul>
        </Card>
        <Card data-testid="trust-never">
          <CardHeader title="What is never collected" subtitle="These are enforced in the collector's code and rejected by the server, not just promised." />
          <ul className="grid gap-1.5 text-sm sm:grid-cols-2">{NEVER.map((t) => <li key={t} className="flex gap-2"><X size={16} className="mt-0.5 shrink-0 text-danger" /><span>{t}</span></li>)}</ul>
          <details className="mt-3 text-xs text-ink-2"><summary className="cursor-pointer">Default blocked apps</summary><p className="mt-1">{data.blockedApps.join(", ")}</p></details>
        </Card>
        <Card className="p-0" data-testid="trust-visibility">
          <div className="px-5 pt-5"><CardHeader title="Who can see what" subtitle={<span>Your role here: <Badge tone="brand">{data.role}</Badge></span>} /></div>
          <Table className="rounded-t-none border-0 shadow-none">
            <thead><tr><Th>Information</Th>{data.roles.map((r) => <Th key={r} className="text-center capitalize">{r}</Th>)}</tr></thead>
            <tbody>{data.visibility.map((v) => (
              <tr key={v.perm} data-testid={`visibility-${v.perm}`}><Td><div className="font-medium">{v.label}</div><div className="text-xs text-ink-2">{v.explain}</div></Td>
                {data.roles.map((r) => <Td key={r} className="text-center">{v.roles.includes(r) ? <Check size={15} className="inline text-money" aria-label="yes" /> : <span className="text-ink-3" aria-label="no">—</span>}</Td>)}</tr>))}</tbody>
          </Table>
        </Card>
        <Card data-testid="trust-retention">
          <CardHeader title="How long it is kept" />
          <p className="text-sm">Raw activity events for {data.orgName} are deleted automatically after <span className="font-semibold" data-testid="retention-days">{data.retentionDays} days</span>. Aggregated workflow findings (no per-person events) are kept for reporting.</p>
          <p className="mt-2 text-sm text-ink-2">{data.authorization ? <>Observation was authorized by <span className="font-medium text-ink">{data.authorization.signerName}</span> ({data.authorization.signerTitle}) on {new Date(data.authorization.signedAt).toLocaleDateString()} for: {data.authorization.scope}.</> : "No authorization has been recorded yet, so no campaign can run."} {data.runningCampaigns ? `${data.runningCampaigns} campaign${data.runningCampaigns > 1 ? "s are" : " is"} currently running.` : "No campaign is currently running."}</p>
        </Card>
      </div>
      <div className="space-y-4">
        <Card data-testid="trust-me">
          <CardHeader title="Your consent" subtitle={me ? me.displayName : undefined} />
          {!me ? <Empty title="Not linked to an employee record" body="Your login isn't tied to a monitored employee, so there is nothing collected about you here. Ask an admin if that's wrong." /> : (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">Status: <span data-testid="my-consent-status" data-value={me.consent}><Badge tone={me.consent === "acknowledged" ? "money" : me.consent === "withdrawn" ? "danger" : me.consent === "sent" ? "info" : "warn"}>{me.consent}</Badge></span>{me.consentVersion && <span className="text-xs text-ink-3">notice v{me.consentVersion}{me.consentVersion !== data.notice.version ? ` (current v${data.notice.version})` : ""}</span>}</div>
              {me.acknowledgedAt && <div className="text-xs text-ink-2">Acknowledged {fmt(me.acknowledgedAt)} via {me.method}</div>}
              {me.withdrawnAt && <div className="text-xs text-ink-2">Withdrawn {fmt(me.withdrawnAt)}</div>}
              <div className="flex flex-wrap gap-2">
                {me.consent === "acknowledged" || me.consent === "sent" ? <Button variant="danger" size="sm" loading={busy} onClick={() => confirm("Withdraw consent? Your collector will be paused immediately and nothing further is recorded until you acknowledge again.") && run(withdrawMyConsent, "Consent withdrawn. Your collector is paused.")} data-testid="withdraw-consent">Withdraw consent & pause my collector</Button>
                  : <Button size="sm" loading={busy} onClick={() => run(acknowledgeMyNotice, "Thanks — consent recorded.")} data-testid="acknowledge-notice">I have read the notice — record my consent</Button>}
              </div>
              <div className="border-t border-border pt-3">
                <div className="mb-1 text-xs font-medium text-ink-2">Your collector{me.collectors.length === 1 ? "" : "s"}</div>
                {!me.collectors.length ? <p className="text-xs text-ink-3" data-testid="my-collectors-empty">No collector is installed for you.</p> : me.collectors.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2 py-1 text-xs" data-testid={`my-collector-${c.id}`}><span>{c.name} <span className="text-ink-3">({c.platform})</span></span><Badge tone={c.status === "active" ? "money" : c.status === "paused" ? "warn" : "neutral"}>{c.status}{c.pausedUntil ? ` until ${new Date(c.pausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</Badge></div>))}
                {!!me.collectors.length && <div className="mt-2 flex flex-wrap gap-2">
                  {anyActive && <><Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => pauseMyCollector({ minutes: 60 }), "Paused for 1 hour.")} data-testid="pause-1h">Pause 1 hour</Button><Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => pauseMyCollector({}), "Paused until you resume.")} data-testid="pause-indefinite">Pause until I resume</Button></>}
                  {anyPaused && <Button size="sm" loading={busy} onClick={() => run(() => pauseMyCollector({ resume: true }), "Resumed.")} data-testid="resume-collector">Resume</Button>}
                </div>}
              </div>
              {err && <p className="text-xs text-danger" role="alert" data-testid="trust-error">{err}</p>}
              {msg && <p className="text-xs text-money" role="status" data-testid="trust-message">{msg}</p>}
            </div>
          )}
        </Card>
        {me && me.campaigns.length > 0 && <Card data-testid="trust-my-campaigns">
          <CardHeader title="Campaigns that include you" />
          <ul className="space-y-2 text-xs">{me.campaigns.map((c) => <li key={c.id}><div className="font-medium text-sm">{c.name}</div><div className="text-ink-2">{c.startsAt ? new Date(c.startsAt).toLocaleDateString() : "open"} → {c.endsAt ? new Date(c.endsAt).toLocaleDateString() : "open"}{c.schedule ? ` · ${c.schedule.days.map((d) => DAYS[d]).join(" ")} ${c.schedule.start}–${c.schedule.end}` : " · any time"} · titles: {c.titleMode}</div></li>)}</ul>
        </Card>}
        <Card data-testid="trust-notice">
          <CardHeader title={`The notice (v${data.notice.version})`} />
          <pre className="whitespace-pre-wrap text-xs text-ink-2">{data.notice.text}</pre>
        </Card>
      </div>
    </div>
  );
}
