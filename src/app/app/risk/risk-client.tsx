"use client";
import * as React from "react";
import Link from "next/link";
import { ShieldAlert, ShieldCheck, Lock, EyeOff, ArrowUpRight } from "lucide-react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip as RTooltip } from "recharts";
import { Card, PageHeader, Table, Td, Th, Tooltip } from "@/components/ui";
import { ExportButton, FilterBar, KpiCard, ScoreRing, SectionHeader, ACCENT_HEX } from "@/components/ui/enterprise";
import { ChartFrame, ChartTip } from "@/components/charts";
import { axisProps } from "@/components/charts/theme";
import type { RiskItem, RiskRegister, Severity } from "@/engine/risk";
import { cn, fmtNum } from "@/lib/utils";
import { useTimeZone } from "@/components/time-zone";
import { formatDateTime } from "@/lib/datetime";

// Same commitments as /app/trust (kept in sync by hand — that file does not export them).
const COLLECTED = ["Which application is in front (program name only)", "A coarse document category derived on-device; the window title is discarded", "Time in each app, switches and idle periods — only inside the campaign schedule", "Counts, never contents (fields filled, pastes, clicks)"];
const NEVER = ["Keystrokes or what you type", "Clipboard contents", "Screenshots or screen recording", "Web addresses (URLs) or page contents", "Window titles, file names or document contents", "Emails, chats or messages", "Camera, microphone or location", "Anything from blocked apps (password managers, banking, health, personal messaging)", "Anything outside the campaign's days and hours, or while paused"];

const SEV_CLS: Record<Severity, string> = { critical: "bg-coral-ink text-white dark:bg-coral dark:text-midnight", high: "bg-coral-soft text-coral-ink", medium: "bg-gold-soft text-gold-ink", low: "bg-royal-soft text-royal-ink", ok: "bg-emerald-soft text-emerald-ink" };
function Sev({ s }: { s: Severity }) { return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide", SEV_CLS[s])}>{s === "ok" ? "controlled" : s}</span>; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tip = (fn: (p: { active?: boolean; label?: string | number; payload?: { value?: number | string }[] }) => React.ReactElement | null) => fn as unknown as any;

function Heatmap({ reg, onPick }: { reg: RiskRegister; onPick: (keys: string[]) => void }) {
  const cell = (l: number, i: number) => reg.heatmap.find((c) => c.likelihood === l && c.impact === i);
  const tone = (l: number, i: number) => { const s = l * i; return s >= 16 ? "bg-coral-ink text-white dark:bg-coral dark:text-midnight" : s >= 9 ? "bg-coral-soft text-coral-ink" : s >= 4 ? "bg-gold-soft text-gold-ink" : "bg-emerald-soft text-emerald-ink"; };
  return (
    <div className="text-[11px]">
      <div role="table" aria-label="Risk heatmap: likelihood (rows) by impact (columns); numbers are open register items" className="grid grid-cols-[2.25rem_repeat(5,minmax(0,1fr))] gap-1">
        {[5, 4, 3, 2, 1].map((l) => (
          <div role="row" key={l} className="contents">
            <div role="rowheader" className="flex items-center justify-end pr-1 font-semibold text-ink-2">L{l}</div>
            {[1, 2, 3, 4, 5].map((i) => { const c = cell(l, i); return (
              <div role="cell" key={i} className="contents"><button disabled={!c} onClick={() => c && onPick(c.keys)} aria-label={`Likelihood ${l}, impact ${i}: ${c?.count ?? 0} open item(s)`} data-testid={`heat-${l}-${i}`}
                className={cn("flex h-9 items-center justify-center sm:h-10 rounded-md font-bold transition", tone(l, i), c ? "ring-2 ring-ink/30 hover:scale-105" : "opacity-50")}>{c?.count ?? ""}</button></div>
            ); })}
          </div>
        ))}
        <div role="row" className="contents"><div role="cell" />{[1, 2, 3, 4, 5].map((i) => <div role="columnheader" key={i} className="text-center font-semibold text-ink-2">I{i}</div>)}</div>
      </div>
      <p className="mt-2 text-ink-3">L = likelihood, I = impact (1–5). Click a cell to filter the register.</p>
    </div>
  );
}

export function RiskClient({ reg, severity }: { reg: RiskRegister; severity: string }) {
  const tz = useTimeZone();
  const [only, setOnly] = React.useState<string[] | null>(null);
  const open = reg.items.filter((i) => i.open);
  const shown = reg.items.filter((i) => (!only || only.includes(i.key)) && (!severity || (severity === "open" ? i.open : i.severity === severity)));
  const count = (s: Severity) => reg.items.filter((i) => i.severity === s).length;
  const exportRows = reg.items.map((i) => ({ severity: i.severity, category: i.category, title: i.title, likelihood: i.likelihood, impact: i.impact, evidence: i.evidence, fix: i.fix, link: i.href }));
  const titleModes = Object.entries(reg.privacy.titleModes);

  return (
    <div className="min-w-0 space-y-2 [contain:inline-size]" data-testid="risk-page">
      <PageHeader hero eyebrow="Transformation · Enterprise Risk & Compliance" icon={<ShieldAlert size={22} />} title="Risk & compliance register"
        subtitle="Computed live from consent records, authorizations, agent policies, credentials, retention, MFA, audit activity and project risks. Every item cites its evidence and links to the fix."
        actions={<ExportButton rows={exportRows} filename="risk-register" testid="risk-export" />} />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card className="flex flex-col items-center justify-center gap-3 p-6 sm:flex-row sm:justify-start" data-testid="risk-score">
          <ScoreRing score={reg.score} size={136} label="Risk posture" sub="higher = safer" />
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-1.5">{(["critical", "high", "medium", "low"] as Severity[]).map((s) => <span key={s} className="inline-flex items-center gap-1"><Sev s={s} /><b className="tabular">{count(s)}</b></span>)}</div>
            <p className="text-xs text-ink-2">{open.length} open of {reg.items.length} controls checked.</p>
            <p className="font-mono text-[11px] text-ink-3">{reg.scoreFormula}</p>
          </div>
        </Card>
        <Card data-testid="risk-heatmap"><div className="mb-2 text-sm font-semibold">Likelihood × impact</div><Heatmap reg={reg} onPick={(k) => setOnly(k)} /></Card>
      </div>

      <SectionHeader accent="coral" title="Risk register" subtitle={only ? <>Filtered to a heatmap cell · <button className="font-semibold text-royal-ink hover:underline" onClick={() => setOnly(null)} data-testid="risk-clear-cell">show all</button></> : "Sorted by severity. Controlled items are shown so the full control set is auditable."} />
      <FilterBar testid="risk-filters" filters={[{ key: "risk", label: "Severity", all: "All items", options: [{ value: "open", label: "Open only" }, { value: "critical", label: "Critical" }, { value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }, { value: "ok", label: "Controlled" }] }]} />
      <Table>
        <thead><tr><Th>Severity</Th><Th>Item</Th><Th>Category</Th><Th className="text-center">L × I</Th><Th>Evidence</Th><Th>Fix</Th></tr></thead>
        <tbody>
          {shown.map((i: RiskItem) => (
            <tr key={i.key} className={cn(i.severity === "critical" && "bg-coral-soft/40")} data-testid={`risk-${i.key}`} data-severity={i.severity}>
              <Td><Sev s={i.severity} /></Td>
              <Td className="min-w-[14rem] font-semibold">{i.title}</Td>
              <Td className="text-xs capitalize text-ink-2">{i.category}</Td>
              <Td className="text-center tabular text-xs">{i.open ? `${i.likelihood} × ${i.impact}` : "—"}</Td>
              <Td className="min-w-[16rem] text-xs text-ink-2">{i.evidence}</Td>
              <Td className="min-w-[12rem] text-xs"><span className="text-ink-2">{i.fix}</span> <Link href={i.href} className="inline-flex items-center font-semibold text-royal-ink hover:underline" data-testid={`risk-fix-${i.key}`}>Fix<ArrowUpRight size={12} /></Link></Td>
            </tr>
          ))}
          {!shown.length && <tr><Td colSpan={6} className="py-8 text-center text-sm text-ink-3">No items match this filter.</Td></tr>}
        </tbody>
      </Table>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <SectionHeader accent="emerald" icon={<Lock size={16} />} title="Privacy controls" subtitle="What the collector records — and never records. Enforced in code, not just policy." action={<Link href="/app/trust" className="text-xs font-semibold text-royal-ink hover:underline">Trust & Privacy page →</Link>} />
          <Card data-testid="privacy-controls">
            <div className="grid gap-4 sm:grid-cols-2">
              <div><div className="mb-1 flex items-center gap-1.5 text-xs font-bold text-emerald-ink"><ShieldCheck size={14} />Collected (metadata only)</div><ul className="space-y-1 text-xs text-ink-2">{COLLECTED.map((c) => <li key={c}>• {c}</li>)}</ul></div>
              <div><div className="mb-1 flex items-center gap-1.5 text-xs font-bold text-coral-ink"><EyeOff size={14} />Never collected</div><ul className="space-y-1 text-xs text-ink-2">{NEVER.map((c) => <li key={c}>• {c}</li>)}</ul></div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs sm:grid-cols-4">
              <div><dt className="text-ink-3">Retention</dt><dd className="font-bold tabular">{reg.privacy.retentionDays} days</dd></div>
              <div><dt className="text-ink-3">Consent</dt><dd className="font-bold tabular">{reg.privacy.consentAcknowledged} / {reg.privacy.employeesObserved} observed</dd></div>
              <div><dt className="text-ink-3">Title handling <Tooltip text="Per campaign: 'category' keeps a coarse category only; 'hash' adds an irreversible hash; 'none' keeps nothing." /></dt><dd className="font-bold">{titleModes.length ? titleModes.map(([m, n]) => `${m} ×${n}`).join(", ") : "default (category)"}</dd></div>
              <div><dt className="text-ink-3">Blocked apps</dt><dd className="font-bold tabular">{reg.privacy.blockedAppsConfigured} configured</dd></div>
            </dl>
          </Card>
        </div>
        <div>
          <SectionHeader accent="indigo" title="Audit activity" subtitle="Audit-log events per day, last 30 days." action={<Link href="/app/settings/audit" className="text-xs font-semibold text-royal-ink hover:underline">Open audit log →</Link>} />
          <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
            <KpiCard label="Audit events (30d)" value={reg.audit.last30d} format={(n) => fmtNum(n)} accent="indigo" testid="audit-count" caption="all audited actions in this org" />
            <ChartFrame testid="audit-sparkline" title="Daily events" height={110}>
              <div className="h-full" role="img" aria-label={`Audit events per day; total ${reg.audit.last30d} in 30 days; peak ${Math.max(0, ...reg.audit.daily.map((d) => d.n))}`}>
                <ResponsiveContainer width="100%" height="100%"><AreaChart data={reg.audit.daily} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}><XAxis dataKey="day" {...axisProps} tickFormatter={(v: string) => v.slice(5)} minTickGap={30} /><YAxis {...axisProps} width={28} allowDecimals={false} /><RTooltip content={tip((p) => <ChartTip active={p.active} label={p.label} rows={(p.payload ?? []).map((x) => ({ name: "Events", value: String(x.value), color: ACCENT_HEX.indigo }))} />)} /><Area dataKey="n" stroke={ACCENT_HEX.indigo} fill={ACCENT_HEX.indigo} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} /></AreaChart></ResponsiveContainer>
              </div>
            </ChartFrame>
          </div>
          <Card className="mt-3 p-0">
            <div className="border-b border-border px-4 py-2 text-xs font-bold">Last admin actions</div>
            {reg.audit.lastAdminActions.length ? <ul className="divide-y divide-border text-xs">{reg.audit.lastAdminActions.map((a, i) => <li key={i} className="flex justify-between gap-2 px-4 py-2"><span className="font-mono">{a.action}</span><span className="whitespace-nowrap text-ink-3">{formatDateTime(a.at, tz)}</span></li>)}</ul> : <p className="px-4 py-3 text-xs text-ink-3">No admin actions recorded yet.</p>}
          </Card>
        </div>
      </div>
    </div>
  );
}
