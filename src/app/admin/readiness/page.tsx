import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { ShieldCheck, ShieldAlert, ShieldQuestion, Ban } from "lucide-react";
import { getConsultant } from "../_lib";
import { gateMfaForPage } from "@/lib/session";
import { canSeeReadiness } from "@/engine/readiness/access";
import { computeReadiness, type GateStatus, type Overall } from "@/engine/readiness/gates";
import { runLiveChecks, loadEvidence, loadFindings } from "@/engine/readiness/live";
import { Badge, Card, CardHeader, PageHeader, Table, Th, Td, type Tone } from "@/components/ui";
import { formatDateTime } from "@/lib/datetime";

export const metadata = { title: "Production readiness — Consulting Portal" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATUS: Record<GateStatus, { label: string; tone: Tone }> = {
  pass: { label: "Pass", tone: "verified" }, fail: { label: "Fail", tone: "danger" }, blocked: { label: "Blocked", tone: "warn" }, not_verified: { label: "Not verified", tone: "coral" },
};
const OVERALL: Record<Overall, { tone: Tone; icon: React.ReactNode; text: string }> = {
  GO: { tone: "verified", icon: <ShieldCheck size={18} />, text: "Every gate passes on live checks and recorded evidence." },
  "CONDITIONAL GO": { tone: "warn", icon: <ShieldQuestion size={18} />, text: "Every critical gate passes; the gates listed under Conditions are not yet verified." },
  "NO-GO": { tone: "danger", icon: <Ban size={18} />, text: "At least one gate fails or a critical gate is not verified. See Blockers." },
};
const SEV_TONE: Record<string, Tone> = { critical: "danger", high: "danger", medium: "warn", low: "info", info: "neutral" };

/**
 * Production Readiness Command Center. Platform owner / consultancy owner only (404 otherwise — re-checked here,
 * the layout check is UX). Status = live checks at request time + recorded evidence; nothing is hard-coded and
 * this page has no buttons that record anything (`npm run readiness:record` does).
 */
export default async function ReadinessPage() {
  const c = await getConsultant();
  if (!c || !canSeeReadiness({ email: c.ctx.email, consultancyRole: c.consultancy.role })) notFound();
  await gateMfaForPage(c.ctx);
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") || host?.startsWith("127.") ? "http" : "https");
  const [live, evidence, findings] = await Promise.all([runLiveChecks({ origin: host ? `${proto}://${host}` : null }), loadEvidence(), loadFindings()]);
  const r = computeReadiness(live, evidence, findings);
  const tz = c.consultancy.timezone;
  const rc = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const ov = OVERALL[r.overall];
  const counts = r.gates.reduce<Record<GateStatus, number>>((a, g) => ({ ...a, [g.status]: a[g.status] + 1 }), { pass: 0, fail: 0, blocked: 0, not_verified: 0 });
  return (
    <div className="space-y-6" data-testid="readiness-page">
      <PageHeader title="Production readiness" eyebrow="Release gates" subtitle="Live checks run when this page loads; everything else comes from evidence recorded with npm run readiness:record. A gate without evidence is Not verified." />
      <Card data-testid="readiness-overall">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={ov.tone} className="gap-1 px-3 py-1 text-sm">{ov.icon}<span data-testid="readiness-decision">{r.overall}</span></Badge>
          <p className="text-sm text-ink-2">{ov.text}</p>
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[180px_1fr]">
          <dt className="text-ink-3">Release-candidate commit</dt><dd data-testid="readiness-rc"><code>{rc ?? "unknown — VERCEL_GIT_COMMIT_SHA not set (local build)"}</code></dd>
          <dt className="text-ink-3">Environment</dt><dd>{process.env.VERCEL_ENV ?? (process.env.NODE_ENV === "production" ? "production build (not Vercel)" : "development")}</dd>
          <dt className="text-ink-3">Gates</dt><dd>{counts.pass} pass · {counts.fail} fail · {counts.blocked} blocked · {counts.not_verified} not verified (of {r.gates.length})</dd>
          <dt className="text-ink-3">Checked at</dt><dd>{formatDateTime(new Date(), tz, { dateStyle: "medium", timeStyle: "medium" })}</dd>
        </dl>
      </Card>

      {r.blockers.length > 0 && (
        <Card data-testid="readiness-blockers">
          <CardHeader title={`Blockers (${r.blockers.length})`} subtitle="Failing gates and critical gates that are not passing." />
          <ul className="space-y-2 text-sm">{r.blockers.map((g) => <li key={g.key} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3"><span className="font-semibold">{g.title}</span><span className="text-ink-2">{g.reason}</span><span className="text-xs text-ink-3">Owner: {g.owner} · Next: {g.nextAction}</span></li>)}</ul>
        </Card>
      )}
      {r.conditions.length > 0 && (
        <Card data-testid="readiness-conditions">
          <CardHeader title={`Conditions (${r.conditions.length})`} subtitle="Non-critical gates that are not passing." />
          <ul className="space-y-1 text-xs text-ink-2">{r.conditions.map((g) => <li key={g.key}><span className="font-semibold text-ink">{g.title}:</span> {g.reason} — {g.owner}: {g.nextAction}</li>)}</ul>
        </Card>
      )}

      <section aria-labelledby="gates-h">
        <h2 id="gates-h" className="mb-2 text-sm font-semibold">Release gates</h2>
        <Table>
          <thead><tr><Th>Gate</Th><Th>Status</Th><Th>Why</Th><Th>Live checks</Th><Th>Latest evidence</Th></tr></thead>
          <tbody>{r.gates.map((g) => (
            <tr key={g.key} data-testid={`gate-${g.key}`}>
              <Td className="min-w-[200px]"><div className="font-medium">{g.title}{g.critical && <span className="ml-1 text-[10px] uppercase text-ink-3">critical</span>}</div><div className="text-[11px] text-ink-3">{g.description}</div></Td>
              <Td><Badge tone={STATUS[g.status].tone}>{STATUS[g.status].label}</Badge></Td>
              <Td className="min-w-[180px] text-xs text-ink-2">{g.reason}</Td>
              <Td className="min-w-[200px] text-xs">{g.liveChecks.length ? <ul className="space-y-0.5">{g.liveChecks.map((l) => <li key={l.key} className="flex gap-1">{l.ok ? <ShieldCheck size={12} className="mt-0.5 shrink-0 text-emerald-ink" aria-label="ok" /> : <ShieldAlert size={12} className="mt-0.5 shrink-0 text-coral-ink" aria-label="failed" />}<span><span className="font-medium">{l.label}</span> — {l.detail}</span></li>)}</ul> : <span className="text-ink-3">—</span>}</Td>
              <Td className="min-w-[220px] text-xs">{g.evidence ? <div><div>{g.evidence.status.toUpperCase()} · {g.evidence.environment} · <code>{g.evidence.commitSha.slice(0, 7)}</code></div><div className="text-ink-3">{formatDateTime(g.evidence.recordedAt, tz, { dateStyle: "medium", timeStyle: "short" })} by {g.evidence.recordedBy}</div><div className="mt-0.5 break-all font-mono text-[10px] text-ink-2">{g.evidence.command}</div><div className="mt-0.5 text-ink-2">{g.evidence.evidence}</div></div> : <span className="text-ink-3">none recorded</span>}</Td>
            </tr>))}</tbody>
        </Table>
      </section>

      <section aria-labelledby="findings-h">
        <h2 id="findings-h" className="mb-2 text-sm font-semibold">Security findings register</h2>
        {!findings || !findings.length ? <Card><p className="text-sm text-ink-2" data-testid="findings-empty">The register is empty in this database. Sync it with <code>npm run readiness:record -- --sync-findings</code>.</p></Card> : (
          <Table>
            <thead><tr><Th>ID</Th><Th>Severity</Th><Th>Status</Th><Th>Finding</Th><Th>Owner / next action</Th></tr></thead>
            <tbody>{[...findings].sort((a, b) => a.id.localeCompare(b.id)).map((f) => (
              <tr key={f.id} data-testid={`finding-${f.id}`}>
                <Td className="font-mono text-xs">{f.id}</Td>
                <Td><Badge tone={SEV_TONE[f.severity] ?? "neutral"}>{f.severity}</Badge></Td>
                <Td><Badge tone={f.status === "open" ? "coral" : f.status === "accepted" ? "neutral" : "verified"}>{f.status}</Badge></Td>
                <Td className="min-w-[240px] text-xs"><div className="font-medium">{f.title}</div><div className="text-ink-3">{f.component}</div></Td>
                <Td className="min-w-[200px] text-xs text-ink-2">{f.owner}: {f.nextAction}</Td>
              </tr>))}</tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
