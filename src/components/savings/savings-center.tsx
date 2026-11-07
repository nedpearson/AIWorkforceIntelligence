"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PiggyBank, Plus, ShieldCheck, AlertTriangle, XCircle, CheckCircle2, Inbox, ArrowUpRight, Scale } from "lucide-react";
import { BasisChip, Button, Card, Empty, PageHeader, Table, Td, Th, Tooltip } from "@/components/ui";
import { KpiCard, SectionHeader, Segmented, Drawer, ExportButton, FilterBar, StatusPill, type Accent } from "@/components/ui/enterprise";
import { ChartFrame } from "@/components/charts";
import { CalcTreeView } from "@/components/calc-tree";
import type { CalcTree } from "@/db/schema";
import type { SavingsIntelligence, Tier, TierKey, ReconCheck } from "@/engine/savings";
import type { LedgerRow, LinkOptions, TimelinePoint } from "@/app/app/savings/lib";
import { fmtNum, fmtUSD, cn } from "@/lib/utils";
import { SavingsLadder, RealizedTimeline, TIMELINE_LEGEND } from "./savings-charts";
import { SubmitEntryModal } from "./submit-entry-modal";
import { LedgerTable, DecideModal, TierTag, TIER_LABEL } from "./ledger-table";
import { useTimeZone } from "@/components/time-zone";
import { formatDate, formatDateTime } from "@/lib/datetime";

const SHORT: Record<TierKey, string> = {
  potential: "Potential", approved: "Approved", verifiedTime: "Verified time", capacityReleased: "Capacity", costAvoidance: "Avoidance", realizedHard: "Hard", net: "Net",
};
const ONE_LINE: Record<TierKey, string> = {
  potential: "Realistic value of identified opportunities, before implementation.",
  approved: "Business cases finance has formally approved.",
  verifiedTime: "Measured hours saved after deployment, at loaded cost. Time, not cash.",
  capacityReleased: "Verified hours not yet converted into cash savings — available to redeploy.",
  costAvoidance: "Future expense demonstrably avoided. Evidenced and approved.",
  realizedHard: "Confirmed reduction in an actual expense line. Evidenced and approved.",
  net: "Hard savings + avoidance − attributable cost. Money actually kept.",
};
const MOVE: Record<TierKey, { text: string; href?: string; cta?: string }[]> = {
  potential: [{ text: "Observe more departments or extend the campaign window to discover more workflows.", href: "/app/collection?tab=campaigns", cta: "Campaigns" }, { text: "Re-run the analysis after process changes; reject opportunities that are not viable so they leave the total.", href: "/app/opportunities", cta: "Opportunities" }, { text: "Adjust the realization rate and adoption assumptions in the financial model (scenario-sensitive).", href: "/app/finance", cta: "Financial model" }],
  approved: [{ text: "Submit an approved business case for each opportunity finance signs off on.", cta: "Submit entry" }, { text: "Pending entries in the approval inbox count only once an owner or admin approves them." }],
  verifiedTime: [{ text: "Deploy agents for approved opportunities and let them run.", href: "/app/agents", cta: "Agents" }, { text: "Record a measurement from the run ledger, or run a before/after observation campaign.", href: "/app/agents", cta: "Record measurement" }],
  capacityReleased: [{ text: "Grows with verified hours. Shrinks when hours are converted into cost avoidance or realized hard savings (enter hours/yr on those ledger entries)." }, { text: "Redeploying capacity is a management decision; any staffing change requires management and HR/legal review." }],
  costAvoidance: [{ text: "When released capacity lets you avoid a planned expense (e.g. a requisition not opened), submit a cost-avoidance entry with the headcount plan or PO as evidence.", cta: "Submit entry" }],
  realizedHard: [{ text: "When an expense line actually drops (overtime, contractors, vendor fees), submit a realized-hard entry citing the GL or payroll report.", cta: "Submit entry" }, { text: "Only entries in effect today count; future-dated or expired entries are excluded." }],
  net: [{ text: "Increase realized hard savings and cost avoidance (above)." }, { text: "Attributable cost falls with a longer amortization period — change it at the top of this page. Implementation spend comes from transformation projects.", href: "/app/roadmap", cta: "Roadmap" }],
};
const CHECK_ICON = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle };
const CHECK_CLS = { pass: "text-emerald-ink", warn: "text-gold-ink", fail: "text-coral-ink" };

function TierDrawer({ tier, onClose, onSubmit }: { tier: Tier | null; onClose: () => void; onSubmit: () => void }) {
  if (!tier) return null;
  const total = tier.lineage.reduce((s, l) => s + l.amount, 0);
  return (
    <Drawer open onClose={onClose} title={<span className="flex items-center gap-2">{tier.label}<BasisChip basis={tier.basis} /></span>} width="max-w-2xl" testid={`tier-drawer-${tier.key}`}>
      <p className="text-sm text-ink-2">{tier.description}</p>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-display text-3xl font-bold tabular">{fmtUSD(tier.amount)}<span className="text-sm font-medium text-ink-2">/yr</span></span>
        {tier.hours != null && <span className="text-sm text-ink-2 tabular">{fmtNum(tier.hours)} hrs/yr</span>}
      </div>
      <h3 className="mb-2 mt-5 text-sm font-bold">How it is calculated</h3>
      <div className="rounded-xl border border-border p-2" data-testid="tier-calc"><CalcTreeView node={tier.tree} /></div>
      <h3 className="mb-2 mt-5 flex items-center gap-2 text-sm font-bold">Lineage <span className="text-xs font-normal text-ink-3">{tier.lineage.length} source record{tier.lineage.length === 1 ? "" : "s"}</span></h3>
      {tier.lineage.length ? (
        <Table>
          <thead><tr><Th>Source record</Th><Th>Type</Th><Th className="text-right">Amount</Th><Th>Basis</Th><Th aria-label="Link" /></tr></thead>
          <tbody>
            {tier.lineage.map((l) => (
              <tr key={`${l.type}-${l.id}`}>
                <Td className="max-w-[14rem]"><div className="truncate font-medium" title={l.label}>{l.label}</div>{l.hours != null && <div className="text-[11px] text-ink-3 tabular">{fmtNum(l.hours, 1)} hrs{l.type === "opportunity" ? "/wk" : ""}</div>}</Td>
                <Td className="text-xs capitalize">{l.type}{l.status && <div className="text-ink-3">{l.status.replace(/_/g, " ")}</div>}</Td>
                <Td className={cn("text-right tabular font-semibold", l.amount < 0 && "text-coral-ink")}>{fmtUSD(l.amount)}</Td>
                <Td><BasisChip basis={l.basis} /></Td>
                <Td><Link href={l.href} className="inline-flex items-center gap-0.5 text-xs font-semibold text-royal-ink hover:underline" aria-label={`Open ${l.label}`}>Open<ArrowUpRight size={12} /></Link></Td>
              </tr>
            ))}
            <tr className="bg-surface-2/60"><Td className="font-semibold">Σ lineage</Td><Td /><Td className="text-right tabular font-bold">{fmtUSD(total)}</Td><Td colSpan={2} className="text-[11px] text-ink-3">{Math.abs(total - tier.amount) <= 1 ? "Reconciles to the tier" : tier.key === "capacityReleased" ? "Measurements behind the verified hours; capacity subtracts converted hours" : tier.key === "potential" ? "After overlap de-duplication per line" : "See calculation above"}</Td></tr>
          </tbody>
        </Table>
      ) : <Empty title="No source records yet" body="This tier is $0 because nothing feeds it yet. See below for what would move it." />}
      <h3 className="mb-2 mt-5 text-sm font-bold">What would move this number</h3>
      <ul className="space-y-2">
        {MOVE[tier.key].map((m, i) => (
          <li key={i} className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-royal" />
            <span className="flex-1">{m.text}</span>
            {m.href ? <Link href={m.href} className="shrink-0 text-xs font-semibold text-royal-ink hover:underline">{m.cta} →</Link> : m.cta === "Submit entry" ? <button onClick={onSubmit} className="shrink-0 text-xs font-semibold text-royal-ink hover:underline" data-testid={`tier-move-submit-${tier.key}`}>Submit entry →</button> : null}
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

function EntryDrawer({ entry, onClose, canApprove, onDecide }: { entry: LedgerRow | null; onClose: () => void; canApprove: boolean; onDecide: (r: LedgerRow, m: "approve" | "reject") => void }) {
  const tz = useTimeZone();
  if (!entry) return null;
  const dt = (s: string | null, tz: string) => (s ? formatDateTime(s, tz) : "—");
  // effective dates are calendar dates (stored at UTC midnight) — render in UTC so they never shift a day
  const dDate = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "—");
  return (
    <Drawer open onClose={onClose} title="Ledger entry" testid="entry-drawer">
      <div className="flex flex-wrap items-center gap-2"><TierTag tier={entry.tier} /><StatusPill status={entry.status} /><BasisChip basis={entry.basis} /></div>
      <h3 className="mt-2 text-lg font-bold">{entry.title}</h3>
      <div className="mt-1 font-display text-2xl font-bold tabular">{fmtUSD(entry.annualAmount)}<span className="text-sm font-medium text-ink-2">/yr</span>{entry.hoursPerYear != null && <span className="ml-3 text-sm font-medium text-ink-2">{fmtNum(entry.hoursPerYear)} hrs/yr</span>}</div>
      <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
        <dt className="text-ink-2">Department</dt><dd>{entry.departmentName ?? "—"}</dd>
        <dt className="text-ink-2">Opportunity</dt><dd>{entry.opportunity ? <Link className="text-royal-ink hover:underline" href={`/app/opportunities/${entry.opportunity.id}`}>{entry.opportunity.label}</Link> : "—"}</dd>
        <dt className="text-ink-2">Workflow</dt><dd>{entry.workflow ? <Link className="text-royal-ink hover:underline" href={`/app/workflows/${entry.workflow.id}`}>{entry.workflow.label}</Link> : "—"}</dd>
        <dt className="text-ink-2">Project</dt><dd>{entry.project?.label ?? "—"}</dd>
        <dt className="text-ink-2">Agent</dt><dd>{entry.agent ? <Link className="text-royal-ink hover:underline" href={`/app/agents/${entry.agent.id}`}>{entry.agent.label}</Link> : "—"}</dd>
        <dt className="text-ink-2">Effective</dt><dd>{dDate(entry.effectiveFrom)}{entry.effectiveTo ? ` → ${dDate(entry.effectiveTo)}` : ""}</dd>
        <dt className="text-ink-2">Submitted</dt><dd>{entry.submittedBy ?? "—"} · {dt(entry.createdAt, tz)}</dd>
        <dt className="text-ink-2">{entry.status === "rejected" ? "Rejected" : "Approved"}</dt><dd>{entry.approvedBy ? `${entry.approvedBy} · ${dt(entry.approvedAt, tz)}` : "—"}{entry.approvedById && entry.approvedById === entry.submittedById && <span className="ml-2 rounded bg-gold-soft px-1.5 py-0.5 text-[11px] font-semibold text-gold-ink">Self-approved</span>}</dd>
        {entry.rejectionReason && <><dt className="text-ink-2">Reason</dt><dd className="text-coral-ink">{entry.rejectionReason}</dd></>}
      </dl>
      <h4 className="mb-1 mt-4 text-sm font-bold">Evidence</h4>
      {entry.evidence.length ? <ul className="space-y-1 text-sm">{entry.evidence.map((e, i) => <li key={i} className="rounded-lg bg-surface-2 px-3 py-2"><span className="font-semibold capitalize">{e.kind.replace(/_/g, " ")}</span> · <span className="break-all">{e.ref}</span>{e.note && <div className="text-xs text-ink-2">{e.note}</div>}</li>)}</ul> : <p className="text-sm text-ink-3">No evidence attached.</p>}
      {entry.calculation != null && <><h4 className="mb-1 mt-4 text-sm font-bold">Calculation</h4><div className="rounded-xl border border-border p-2"><CalcTreeView node={entry.calculation as CalcTree} /></div></>}
      {canApprove && entry.status === "submitted" && <div className="mt-5 flex gap-2"><Button onClick={() => onDecide(entry, "approve")} data-testid="entry-approve">Approve</Button><Button variant="secondary" onClick={() => onDecide(entry, "reject")} data-testid="entry-reject">Reject</Button></div>}
    </Drawer>
  );
}

function Reconciliation({ checks }: { checks: ReconCheck[] }) {
  const order = { fail: 0, warn: 1, pass: 2 } as const;
  const sorted = [...checks].sort((a, b) => order[a.status] - order[b.status]);
  const fails = checks.filter((c) => c.status === "fail").length; const warns = checks.filter((c) => c.status === "warn").length;
  return (
    <Card className={cn("p-0", fails > 0 && "ring-2 ring-coral/60")} data-testid="reconciliation">
      <div className={cn("flex flex-wrap items-center justify-between gap-2 rounded-t-[var(--radius-card)] px-5 py-3", fails ? "bg-coral-soft" : warns ? "bg-gold-soft" : "bg-emerald-soft")}>
        <span className={cn("flex items-center gap-2 text-sm font-bold", fails ? "text-coral-ink" : warns ? "text-gold-ink" : "text-emerald-ink")}>{fails ? <XCircle size={16} /> : warns ? <AlertTriangle size={16} /> : <ShieldCheck size={16} />}{fails ? `${fails} check${fails === 1 ? "" : "s"} failing — numbers need attention before presenting` : warns ? `All critical checks pass · ${warns} warning${warns === 1 ? "" : "s"}` : "All reconciliation checks pass"}</span>
        <span className="text-xs text-ink-2">{checks.length} checks run on every load</span>
      </div>
      <ul className="divide-y divide-border">
        {sorted.map((c) => { const I = CHECK_ICON[c.status]; return (
          <li key={c.key} className={cn("flex items-start gap-3 px-5 py-3", c.status === "fail" && "bg-coral-soft/40")} data-testid={`check-${c.key}`} data-status={c.status}>
            <I size={18} className={cn("mt-0.5 shrink-0", CHECK_CLS[c.status])} aria-hidden />
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 text-sm font-semibold">{c.label}<StatusPill status={c.status} /></div><div className="mt-0.5 text-xs text-ink-2">{c.detail}</div></div>
          </li>
        ); })}
      </ul>
    </Card>
  );
}

export function SavingsCenter({ si, ledger, pending, ledgerTotal, options, timeline, me, canSubmit, canApprove, entryId, amortizationYears }: {
  si: SavingsIntelligence; ledger: LedgerRow[]; pending: LedgerRow[]; ledgerTotal: number; options: LinkOptions; timeline: TimelinePoint[];
  me: { userId: string; role: string }; canSubmit: boolean; canApprove: boolean; entryId: string | null; amortizationYears: number;
}) {
  const tz = useTimeZone();
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams();
  const [tierKey, setTierKey] = React.useState<TierKey | null>(null);
  const [submitOpen, setSubmitOpen] = React.useState(false);
  const [decide, setDecide] = React.useState<{ r: LedgerRow; m: "approve" | "reject" } | null>(null);
  const findEntry = React.useCallback((id: string) => ledger.find((r) => r.id === id) ?? pending.find((r) => r.id === id) ?? null, [ledger, pending]);
  const [entry, setEntry] = React.useState<LedgerRow | null>(() => (entryId ? findEntry(entryId) : null));
  React.useEffect(() => { if (entryId) setEntry(findEntry(entryId)); }, [entryId, findEntry]);
  const setParam = (k: string, v: string | null) => { const q = new URLSearchParams(sp.toString()); if (v) q.set(k, v); else q.delete(k); router.push(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }); };
  const closeEntry = () => { setEntry(null); if (sp.get("entry")) setParam("entry", null); };

  const tiers = si.order.map((k) => si.tiers[k]);
  const ladder = tiers.map((t) => ({ key: t.key, name: t.label, short: SHORT[t.key], value: t.amount, color: t.color as Accent, basis: t.basis }));
  const pendingRows = pending;
  const allPending = si.pendingApprovals;
  const hasAny = si.tiers.potential.amount > 0 || ledgerTotal > 0 || si.tiers.verifiedTime.amount > 0;
  const exportRows = ledger.map((r) => ({ id: r.id, tier: TIER_LABEL[r.tier], status: r.status, title: r.title, annualAmount: r.annualAmount, hoursPerYear: r.hoursPerYear ?? "", department: r.departmentName ?? "", opportunity: r.opportunity?.label ?? "", workflow: r.workflow?.label ?? "", project: r.project?.label ?? "", agent: r.agent?.label ?? "", evidence: r.evidence.map((e) => `${e.kind}:${e.ref}`).join(" | "), submittedBy: r.submittedBy ?? "", approvedBy: r.approvedBy ?? "", approvedAt: r.approvedAt ?? "", effectiveFrom: r.effectiveFrom, rejectionReason: r.rejectionReason ?? "" }));
  const tierExport = tiers.map((t) => ({ tier: t.label, amount: Math.round(t.amount), hoursPerYear: t.hours != null ? Math.round(t.hours) : "", basis: t.basis, sourceRecords: t.lineage.length }));
  const filters = [
    { key: "savings", label: "Tier", options: [{ value: "approved", label: "Approved" }, { value: "cost_avoidance", label: "Cost avoidance" }, { value: "realized_hard", label: "Realized hard" }], all: "All tiers" },
    { key: "status", label: "Status", options: ["submitted", "approved", "rejected"].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })), all: "All statuses" },
    { key: "dept", label: "Department", options: options.departments.map((d) => ({ value: d.id, label: d.label })) },
    { key: "wf", label: "Workflow", options: options.workflows.map((w) => ({ value: w.id, label: w.label })) },
    ...(options.agents.length ? [{ key: "agent", label: "Agent", options: options.agents.map((a) => ({ value: a.id, label: a.label })) }] : []),
  ];
  const ladderSummary = tiers.map((t) => `${t.label} ${fmtUSD(t.amount)}`).join("; ");
  const lastTimeline = timeline[timeline.length - 1];

  return (
    <div className="min-w-0 space-y-2 [contain:inline-size]" data-testid="savings-center">
      <PageHeader hero eyebrow="Finance & Proof · ROI & Savings Center" icon={<PiggyBank size={22} />} title="Every dollar, traced."
        subtitle="Seven savings tiers that are never mixed — from estimated potential to money actually kept. Every number opens to its calculation and the exact records behind it."
        actions={<>
          <div className="flex items-center gap-2 rounded-xl bg-white/10 px-2 py-1 ring-1 ring-white/20">
            <span className="text-[11px] font-semibold text-slate-200" id="amort-label">Amortize implementation over</span>
            <div aria-labelledby="amort-label" className="[&_button]:text-xs"><Segmented size="sm" testid="amortization" value={String(amortizationYears)} onChange={(v) => setParam("amort", v === "3" ? null : v)} options={[1, 2, 3, 4, 5].map((n) => ({ key: String(n), label: `${n}y` }))} /></div>
          </div>
          {canSubmit && <Button variant="gradient" onClick={() => setSubmitOpen(true)} data-testid="ledger-new"><Plus size={15} />Submit entry</Button>}
        </>}
      />

      {allPending.length > 0 && (
        <Card className="border-purple/40 p-0 ring-glow-purple" data-testid="approval-inbox">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
            <span className="flex items-center gap-2 text-sm font-bold"><Inbox size={16} className="text-purple-ink" />Pending approvals <span className="rounded-full bg-purple-soft px-2 text-xs text-purple-ink">{allPending.length}</span></span>
            <span className="text-xs text-ink-2">{canApprove ? "Owners and admins approve. Approving your own submission is flagged (segregation of duties)." : "Waiting for an owner or admin to approve."}</span>
          </div>
          <ul className="divide-y divide-border">
            {allPending.map((p) => { const row = pendingRows.find((r) => r.id === p.id); return (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3" data-testid={`inbox-${p.id}`}>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><TierTag tier={p.tier as LedgerRow["tier"]} /><span className="truncate text-sm font-semibold">{p.title}</span></div><div className="text-xs text-ink-2">{p.submittedBy ?? "External user"} · {formatDate(p.createdAt, tz)}{p.submittedById === me.userId && <span className="ml-2 font-semibold text-gold-ink">submitted by you</span>}</div></div>
                <span className="tabular text-sm font-bold">{fmtUSD(p.amount)}/yr</span>
                {canApprove && row && <div className="flex gap-1"><Button size="sm" onClick={() => setDecide({ r: row, m: "approve" })} data-testid={`inbox-approve-${p.id}`}>Approve</Button><Button size="sm" variant="secondary" onClick={() => setDecide({ r: row, m: "reject" })} data-testid={`inbox-reject-${p.id}`}>Reject</Button></div>}
              </li>
            ); })}
          </ul>
        </Card>
      )}

      {!hasAny && <Empty title="No savings to trace yet" body="Potential savings appear once the workflow analysis has produced opportunities. Verified and realized tiers follow after agents are deployed and finance approves ledger entries." action={<Button href="/app/onboarding" data-testid="savings-empty-cta">Open the rollout checklist</Button>} />}

      <SectionHeader accent="gold" title="Savings tiers" subtitle="In order of certainty. Click any tier for its calculation, lineage and what would move it." action={<ExportButton rows={tierExport} filename="savings-tiers" testid="export-tiers" />} />
      <div className="stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="tier-cards">
        {tiers.map((t, i) => (
          <KpiCard key={t.key} testid={`tier-${t.key}`} label={`${i + 1}. ${t.label}`} value={t.amount} format={(n) => fmtUSD(n)} accent={t.color as Accent} basis={t.basis} size={t.key === "net" ? "lg" : "md"} onClick={() => setTierKey(t.key)}
            caption={<span className="block"><span className="block">{t.hours != null ? <span className="tabular font-semibold text-ink">{fmtNum(t.hours)} hrs/yr · </span> : null}{ONE_LINE[t.key]}</span></span>} />
        ))}
      </div>
      <p className="text-[11px] text-ink-3">Time saved ≠ payroll cut. Only tiers 5–6 (evidenced and approved) count as money kept. Attributable cost: {fmtUSD(si.attributableCost.total)}/yr (implementation {fmtUSD(si.attributableCost.implementationSpent)} ÷ {amortizationYears} yrs + agent operating {fmtUSD(si.attributableCost.agentOperatingAnnual)} + platform {fmtUSD(si.attributableCost.platformAnnual)}).</p>

      <SectionHeader accent="emerald" title="From potential to proof" subtitle="Tiers are shown side by side, never stacked or added together." />
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartFrame testid="chart-ladder" title="Savings ladder" subtitle="Annual value per tier. Click a bar to drill down." help="Each bar is a separate tier. They are not cumulative — capacity and verified time are time, not cash." height={260}>
          <div className="h-full" role="img" aria-label={`Savings ladder. ${ladderSummary}`}><SavingsLadder rows={ladder} onSelect={(k) => setTierKey(k as TierKey)} /></div>
        </ChartFrame>
        <ChartFrame testid="chart-timeline" title="Realized vs projected" subtitle="Last 12 months, monthly dollars" help="Projected = today's potential run-rate ÷ 12 (an estimate). Verified = measurements prorated by day. Ledger lines = approved entries ÷ 12 while in effect." legend={TIMELINE_LEGEND} height={232}>
          <div className="h-full" role="img" aria-label={`Monthly timeline. Latest month ${lastTimeline?.label}: projected ${fmtUSD(lastTimeline?.projected ?? 0)}, verified ${fmtUSD(lastTimeline?.verified ?? 0)}, approved cases ${fmtUSD(lastTimeline?.ledgerApproved ?? 0)}, realized hard and avoidance ${fmtUSD(lastTimeline?.ledgerHard ?? 0)}.`}><RealizedTimeline rows={timeline} /></div>
        </ChartFrame>
      </div>

      <SectionHeader accent="coral" icon={<Scale size={16} />} title="Reconciliation" subtitle="Automated integrity checks. A failing check means a number on this page should not be presented yet." />
      <Reconciliation checks={si.checks} />

      <SectionHeader accent="indigo" title="Savings ledger" subtitle={<>Human-attested entries: approved cases, cost avoidance and realized hard savings. {ledger.length} of {ledgerTotal} shown. <Tooltip text="Filters apply to this ledger. The tier totals above are always enterprise-wide so they reconcile." /></>}
        action={<div className="flex gap-2"><ExportButton rows={exportRows} filename="savings-ledger" testid="export-ledger" />{canSubmit && <Button onClick={() => setSubmitOpen(true)} data-testid="ledger-new-2"><Plus size={15} />Submit entry</Button>}</div>} />
      <FilterBar filters={filters} testid="ledger-filters" />
      {ledgerTotal === 0 ? (
        <Empty title="The ledger is empty" body={canSubmit ? "When finance approves a business case, or an expense line actually drops, submit an entry with evidence. Approved entries move the approved, cost-avoidance, realized and net tiers." : "Ask an owner, admin or consultant to submit the first entry."} action={canSubmit ? <Button onClick={() => setSubmitOpen(true)} data-testid="ledger-empty-submit"><Plus size={15} />Submit the first entry</Button> : undefined} />
      ) : (
        <LedgerTable rows={ledger} canApprove={canApprove} meId={me.userId} onOpen={(r) => setEntry(r)} onDecide={(r, m) => setDecide({ r, m })} />
      )}

      <TierDrawer tier={tierKey ? si.tiers[tierKey] : null} onClose={() => setTierKey(null)} onSubmit={() => { setTierKey(null); setSubmitOpen(true); }} />
      <EntryDrawer entry={entry} onClose={closeEntry} canApprove={canApprove} onDecide={(r, m) => { closeEntry(); setDecide({ r, m }); }} />
      {canSubmit && <SubmitEntryModal open={submitOpen} onClose={() => setSubmitOpen(false)} options={options} />}
      {decide && <DecideModal entry={decide.r} mode={decide.m} meId={me.userId} onClose={() => setDecide(null)} />}
    </div>
  );
}
