"use client";
/**
 * Executive Command Center (/app) — the product's first impression.
 * Every number comes from the ExecutiveModel (finance + savings engines) and opens its CalcTree / lineage.
 */
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity, ArrowRight, Bot, Briefcase, Building2, CalendarClock, CheckCircle2, Clock, Coins, Gauge, Layers, Lightbulb, MessageSquareText, PiggyBank,
  Presentation, Rocket, Route, Settings2, Sparkles, Target, TrendingUp, Wallet,
} from "lucide-react";
import type { ExecutiveModel } from "@/engine/exports";
import type { TierKey } from "@/engine/savings";
import { Badge, BasisChip, Button, Table, Td, Th, Tooltip } from "@/components/ui";
import { FilterBar, InsightCard, KpiCard, Meter, SectionHeader, StatusPill } from "@/components/ui/enterprise";
import { cn } from "@/lib/utils";
import { CONFIDENCE_RULE, PRIORITY_RULE, SECTION_KEYS, TYPE_LABEL, fmtValue, type CommandSectionKey } from "./format";
import { DrillDrawer, OpportunityHeatmap, SavingsWaterfall, type Drill } from "./widgets";
import { CustomizeDrawer, ExportMenu, HeroSegmented, SavedViews, type SavedView } from "./controls";
import { useTimeZone } from "@/components/time-zone";
import { formatDateTime } from "@/lib/datetime";

export type CommandProps = {
  model: ExecutiveModel;
  deptFilter: string[] | null;
  period: "30" | "90" | "365";
  layout: { hidden: string[]; order: string[] };
  views: SavedView[];
  activeViewId: string | null;
  perms: { canPdf: boolean; canWriteAgents: boolean };
};

const usd = (v: number) => fmtValue(v, "usdCompact");
const PRIORITY_TONE = { High: "gold", Medium: "indigo", Low: "neutral", None: "neutral" } as const;
const CONF_TONE = { High: "emerald", Medium: "gold", Low: "coral" } as const;

export function CommandCenter({ model: m, deptFilter, period, layout, views, activeViewId, perms }: CommandProps) {
  const tz = useTimeZone();
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams();
  const [pending, start] = React.useTransition();
  const [drill, setDrill] = React.useState<Drill | null>(null);
  const [customize, setCustomize] = React.useState(false);
  const f = m.fin; const s = m.savings; const scenario = m.overrides.scenario;
  const inFilter = React.useCallback((id: string | null) => !deptFilter || (id != null && deptFilter.includes(id)), [deptFilter]);

  const setParam = (k: string, v: string | null, extra?: Record<string, string | null>) => {
    const q = new URLSearchParams(sp.toString()); const all = { [k]: v, ...(extra ?? {}) };
    for (const [key, val] of Object.entries(all)) { if (val) q.set(key, val); else q.delete(key); }
    q.delete("view");
    start(() => router.push(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }));
  };
  const setPeriod = (p: string) => { const to = new Date(); const from = new Date(to.getTime() - Number(p) * 86_400_000); setParam("period", p, { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }); };
  const currentFilters = Object.fromEntries(["bu", "dept", "loc", "scenario", "period", "from", "to"].flatMap((k) => (sp.get(k) ? [[k, sp.get(k)!]] : []))) as Record<string, string>;
  // Only pin a scenario the user picked: with none, the page shows the saved financial model and the exports must too
  // (sending scenario=expected applied the preset instead and the workbook disagreed with the KPIs on screen).
  const pickedScenario = sp.get("scenario") ? scenario : undefined;
  const exportQuery = new URLSearchParams({ ...(pickedScenario ? { scenario: pickedScenario } : {}), ...(m.overrides.periodStart ? { from: m.overrides.periodStart.slice(0, 10) } : {}), ...(m.overrides.periodEnd ? { to: m.overrides.periodEnd.slice(0, 10) } : {}) }).toString();

  // ---------- drills ----------
  const oppLineage = f.opportunities.map((o) => ({ label: o.title, href: `/app/opportunities/${o.id}`, amount: o.grossAnnualSavings, hours: o.hoursRecoverablePerWeek, basis: "estimated" as const, status: o.status }));
  const drills = {
    labor: (): Drill => ({ key: "labor", title: "Annual labor expense", value: m.headline.laborExpense.value, format: "usd", accent: "royal", basis: m.headline.laborExpense.basis, tree: m.headline.laborExpense.tree, meaning: `The yearly cost — salary plus a ${fmtValue(f.assumptions.benefitsLoadPct, "pct")} benefits load — of the ${f.employeesAnalyzed} people whose work was observed. It is shown by department only; individual pay is never displayed here.`, lineageTitle: "By department", lineage: m.departments.filter((d) => d.departmentId && d.laborAnnual > 0).map((d) => ({ label: d.name, href: `/app/departments/${d.departmentId}`, amount: d.laborAnnual, basis: m.headline.laborExpense.basis })) }),
    opportunity: (): Drill => ({ key: "opportunity", title: "Automation opportunity", value: f.grossAnnualSavings, format: "usd", accent: "gold", basis: "estimated", tree: f.trees.grossSavings, meaning: "The gross yearly value of every hour software could take over across the automatable workflows — before adoption and realization discounts. It is the size of the prize, not a promise of savings.", lineageTitle: "Opportunities", lineage: oppLineage }),
    net: (): Drill => ({ key: "net", title: "Projected net savings", value: f.netAnnualSavings, format: "usd", accent: "gold", basis: "estimated", tree: f.trees.netSavings, meaning: `Realizable savings (after ${fmtValue(f.assumptions.adoptionRate, "pct")} adoption and ${fmtValue(f.assumptions.realizationRate, "pct")} realization) minus the yearly cost of running the automations and the platform. Projected, not verified. Time saved is capacity — not a payroll cut.`, lineageTitle: "Opportunities (realizable)", lineage: s.tiers.potential.lineage }),
    verified: (): Drill => ({ key: "verified", title: "Verified savings", value: m.headline.verified.measurements > 0 ? m.headline.verified.value : null, format: "usd", accent: "emerald", basis: "observed", tree: m.headline.verified.tree, meaning: m.headline.verified.measurements > 0 ? `Measured after deployment from ${m.headline.verified.measurements} measurement${m.headline.verified.measurements === 1 ? "" : "s"} (run ledger or before/after observation) in the selected period, annualized. Never mixed with projections.` : "Nothing has been measured in this period. Once an agent is deployed and a measurement is recorded from its run ledger, this fills in with observed numbers — kept separate from every projection.", lineageTitle: "Measurements", lineage: s.tiers.verifiedTime.lineage, cta: m.headline.verified.measurements > 0 ? { label: "Open ROI & Savings Center", href: "/app/savings" } : { label: f.deployedAgents ? "Record a measurement" : "Deploy an AI agent", href: f.deployedAgents ? "/app/agents" : "/app/agents/new" } }),
    hours: (): Drill => ({ key: "hours", title: "Recoverable hours per week", value: f.hoursRecoverablePerWeek, format: "hours", accent: "cyan", basis: "estimated", tree: f.trees.recoverableHours, meaning: "Hours per week software could realistically take over, after allowing for steps that still need a person and for gradual adoption. This is capacity to redeploy; any staffing or role change requires management and HR/legal review.", lineageTitle: "Opportunities", lineage: oppLineage.map((o) => ({ ...o, amount: o.hours })) }),
    roi: (): Drill => ({ key: "roi", title: "Estimated first-year ROI", value: f.roi1y, format: "pct", accent: "indigo", basis: "estimated", tree: f.trees.roi, meaning: "What the first year returns on the one-time implementation investment. Above 0% means the automations pay for themselves within the year." }),
    payback: (): Drill => ({ key: "payback", title: "Payback period", value: f.paybackMonths, format: "months", accent: "indigo", basis: "estimated", tree: f.trees.payback, meaning: f.paybackMonths == null ? "Payback is not reached at the current projected net savings." : "Months of projected net savings needed to earn back the one-time implementation cost." }),
    opex: (): Drill => ({ key: "opex", title: "Entered annual operating expense", value: m.opex.total, format: "usd", accent: "midnight", basis: "assumed", tree: m.opex.tree, meaning: "Annual labor analyzed plus the non-labor department overhead your team entered (software, facilities, etc.). Overhead is not observed — each row shows the basis it was entered with.", lineageTitle: "Department overhead (entered)", lineage: m.opex.rows.map((r) => ({ label: r.name, href: `/app/departments/${r.departmentId}`, amount: r.overhead, basis: r.basis })) }),
    tier: (k: TierKey): Drill => { const t = s.tiers[k]; return { key: `tier-${k}`, title: t.label, value: t.amount, format: "usd", accent: k === "net" ? (t.amount >= 0 ? "emerald" : "coral") : t.color, basis: t.basis, tree: t.tree, meaning: t.description, lineageTitle: "Lineage", lineage: t.lineage }; },
  };

  // ---------- filtered collections ----------
  const depts = m.departments.filter((d) => (d.departmentId || d.realizableAnnual > 0) && inFilter(d.departmentId));
  const heatRows = m.heatmap.rows.filter((r) => inFilter(r.departmentId));
  const heatMax = Math.max(0, ...heatRows.flatMap((r) => Object.values(r.cells).map((c) => c.value)));
  const recs = m.recommendations.filter((r) => inFilter(r.departmentId)).slice(0, 10);
  const filterOpts = [
    ...(m.filters.businessUnits.length ? [{ key: "bu", label: "Business unit", options: m.filters.businessUnits.map((b) => ({ value: b.id, label: b.name })) }] : []),
    { key: "dept", label: "Department", options: m.filters.departments.map((d) => ({ value: d.id, label: d.name })) },
    ...(m.filters.locations.length ? [{ key: "loc", label: "Location", all: "All locations", options: m.filters.locations.map((l) => ({ value: l.id, label: l.name })) }] : []),
  ];
  const verifiedEmpty = m.headline.verified.measurements === 0;
  const noData = f.employeesAnalyzed === 0 && f.opportunityCount === 0;

  // ---------- sections ----------
  const sections: Record<CommandSectionKey, React.ReactNode> = {
    financials: (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 stagger" data-testid="cmd-primary">
        <KpiCard size="lg" testid="kpi-labor" label="Annual Labor Expense" accent="royal" icon={<Wallet size={16} />} value={f.totalAnnualLaborAnalyzed} format={usd} basis={m.headline.laborExpense.basis} caption={`${f.employeesAnalyzed} employees analyzed`} onClick={() => setDrill(drills.labor())} emptyText="No cost data" />
        <KpiCard size="lg" testid="kpi-opportunity" label="Automation Opportunity" accent="gold" icon={<Lightbulb size={16} />} value={f.grossAnnualSavings} format={usd} basis="estimated" caption="Gross value of automatable work / yr" onClick={() => setDrill(drills.opportunity())} />
        <KpiCard size="lg" testid="kpi-net" label="Projected Net Savings" accent="gold" icon={<TrendingUp size={16} />} value={f.opportunityCount ? f.netAnnualSavings : null} emptyText={<span className="text-xl sm:text-2xl">No projection yet</span>} format={usd} basis="estimated" caption={f.opportunityCount ? `${usd(f.realizableAnnualSavings)} realizable − run costs` : "Appears once opportunities are identified"} onClick={() => setDrill(drills.net())} />
        <KpiCard size="lg" testid="kpi-verified" label="Verified Savings" accent="emerald" icon={<CheckCircle2 size={16} />} value={verifiedEmpty ? null : m.headline.verified.value} format={usd} basis="observed" emptyText={<span className="text-xl sm:text-2xl">Not yet measured</span>}
          caption={verifiedEmpty ? (f.deployedAgents ? "Record a measurement to verify" : "Deploy an agent, then measure it") : `${m.headline.verified.measurements} measurement${m.headline.verified.measurements === 1 ? "" : "s"} · ${fmtValue(m.headline.verified.hours, "hours")} saved`} onClick={() => setDrill(drills.verified())} />
      </div>
    ),
    secondary: (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 stagger" data-testid="cmd-secondary">
          <KpiCard testid="kpi-hours" label="Recoverable hours / week" accent="cyan" icon={<Clock size={15} />} value={f.hoursRecoverablePerWeek} format={(v) => fmtValue(v, "hours")} basis="estimated" caption={`${fmtValue(f.hoursRecoverablePerWeek * f.assumptions.workWeeksPerYear, "hours")} / yr capacity`} onClick={() => setDrill(drills.hours())} />
          <KpiCard testid="kpi-agents" label="Active AI agents" accent="purple" icon={<Bot size={15} />} value={f.deployedAgents} format={(v) => fmtValue(v, "count")} basis="observed" caption={`${m.tracker.agents} built · ${f.opportunityCount} opportunities`} href="/app/agents" />
          <KpiCard testid="kpi-roi" label="Estimated ROI (yr 1)" accent="indigo" icon={<Target size={15} />} value={f.opportunityCount ? f.roi1y : null} format={(v) => fmtValue(v, "pct")} basis="estimated" caption="(net − implementation) ÷ implementation" onClick={() => setDrill(drills.roi())} />
          <KpiCard testid="kpi-payback" label="Payback" accent="indigo" icon={<CalendarClock size={15} />} value={f.paybackMonths} format={(v) => fmtValue(v, "months")} basis="estimated" emptyText={f.opportunityCount ? "Not reached" : "—"} caption={`${usd(f.implementationCost)} to implement`} onClick={() => setDrill(drills.payback())} />
        </div>
        <div className={cn("grid gap-3", m.opex.show ? "lg:grid-cols-3" : "lg:grid-cols-2")}>
          {m.opex.show && (
            <button type="button" onClick={() => setDrill(drills.opex())} className="card card-hover p-4 text-left" data-testid="kpi-opex">
              <div className="flex items-center justify-between gap-2"><span className="text-[12px] font-semibold text-ink-2">Entered operating expense / yr</span><BasisChip basis="assumed" /></div>
              <div className="mt-1.5 font-display text-2xl font-bold tabular">{fmtValue(m.opex.total, "usdCompact")}</div>
              <div className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between text-ink-2"><span>Labor analyzed</span><span className="tabular font-semibold text-ink">{usd(f.totalAnnualLaborAnalyzed)}</span></div>
                <div className="flex justify-between text-ink-2"><span>Department overhead · {m.opex.rows.length} depts</span><span className="tabular font-semibold text-ink">{usd(m.opex.overheadTotal)}</span></div>
              </div>
              <div className="mt-2 text-[11px] font-semibold text-royal-ink">Basis per department →</div>
            </button>
          )}
          {f.opportunityCount === 0 ? <div className={cn("card flex items-center justify-center p-4 text-center text-xs text-ink-2", !m.opex.show && "lg:col-span-2")} data-testid="kpi-projection-empty">3- and 5-year projections appear once automation opportunities are identified — no costs are projected before then.</div> : (["three", "five"] as const).map((k) => {
            const years = k === "three" ? m.fiveYear.years.slice(0, 3) : m.fiveYear.years; const total = years[years.length - 1]?.cumulative ?? 0;
            const maxAbs = Math.max(1, ...years.map((y) => Math.abs(y.cumulative)));
            return (
              <div key={k} className="card p-4" data-testid={`kpi-projection-${k}`}>
                <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2">{k === "three" ? "3-year" : "5-year"} cumulative net<Tooltip text={m.fiveYear.assumptions.join(" ")} /></span><BasisChip basis="estimated" /></div>
                <div className={cn("mt-1.5 font-display text-2xl font-bold tabular", total >= 0 ? "text-gold-ink" : "text-coral-ink")}>{usd(total)}</div>
                <div className="mt-2 flex h-12 items-end gap-1.5" role="img" aria-label={`Cumulative net by year: ${years.map((y) => `year ${y.year} ${usd(y.cumulative)}`).join(", ")}`}>
                  {years.map((y) => <div key={y.year} className="flex flex-1 flex-col items-center gap-0.5"><div className={cn("w-full rounded-t", y.cumulative >= 0 ? "bg-gold/80" : "bg-coral/70")} style={{ height: `${Math.max(4, (Math.abs(y.cumulative) / maxAbs) * 40)}px` }} /><span className="text-[9px] text-ink-3">Y{y.year}</span></div>)}
                </div>
                <div className="mt-1 text-[11px] text-ink-3">{k === "five" ? `NPV ${usd(m.fiveYear.npv)} · years 4–5 at year-3 run rate` : `3-yr ROI ${fmtValue(f.threeYear.roi3y, "pct")} · ${f.assumptions.rampMonths}-month ramp`}</div>
              </div>
            );
          })}
        </div>
      </div>
    ),
    viz: (
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="card min-w-0 p-5" data-testid="cmd-waterfall">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div><h3 className="flex items-center gap-1.5 text-sm font-bold">Savings waterfall<Tooltip text="Seven tiers from the Savings Intelligence Engine, never mixed: projected potential → finance-approved → verified time → capacity released / cost avoidance / realized hard savings → net savings kept after attributable cost. Click any bar for its calculation and source records." /></h3><p className="text-xs text-ink-2">From projected potential to money actually kept</p></div>
            <Link href="/app/savings" className="text-xs font-semibold text-royal-ink hover:underline">ROI & Savings →</Link>
          </div>
          {f.opportunityCount === 0 && s.tiers.verifiedTime.amount === 0 && s.tiers.realizedHard.amount === 0 && s.tiers.costAvoidance.amount === 0
            ? <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-ink-2" data-testid="waterfall-empty">No savings yet. Potential appears after the analysis finds opportunities; verified and realized tiers follow deployment and finance approval.</p>
            : <SavingsWaterfall tiers={s.tiers} order={s.order} onOpen={(k) => setDrill(drills.tier(k))} />}
          {s.tiers.potential.amount > 0 && s.tiers.approved.amount === 0 && s.tiers.verifiedTime.amount === 0 && <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">Only <b className="text-gold-ink">potential</b> savings exist so far. Approved, verified and realized tiers fill in as business cases are approved and deployed agents are measured — nothing is assumed.</p>}
        </div>
        <div className="card min-w-0 p-5" data-testid="cmd-heatmap">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div><h3 className="flex items-center gap-1.5 text-sm font-bold">AI automation opportunity heatmap<Tooltip text="Realizable annual savings (after adoption, realization and overlap de-duplication) by department and opportunity type. Darker gold = larger. Click a cell to open those opportunities." /></h3><p className="text-xs text-ink-2">Realizable $ / yr by department × opportunity type</p></div>
            <Link href="/app/opportunities" className="text-xs font-semibold text-royal-ink hover:underline">All opportunities →</Link>
          </div>
          <OpportunityHeatmap types={m.heatmap.types} rows={heatRows} max={heatMax} />
        </div>
      </div>
    ),
    departments: depts.length === 0 ? <EmptyBlock title="No departments in this view" body={deptFilter ? "No departments match the current filters." : "Add departments and observe work to see department intelligence."} href={deptFilter ? "/app" : "/app/departments"} cta={deptFilter ? "Clear filters" : "Departments"} /> : (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 stagger" data-testid="cmd-departments">
        {depts.slice(0, 12).map((d) => {
          const body = (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><div className="truncate text-sm font-bold">{d.name}</div><div className="text-[11px] text-ink-3">{d.employees} people · {d.opportunities} opportunit{d.opportunities === 1 ? "y" : "ies"}</div></div>
                <span title={PRIORITY_RULE}><Badge tone={PRIORITY_TONE[d.priority]}>{d.priority === "None" ? "—" : d.priority}</Badge></span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div><div className="text-ink-3">Labor expense</div><div className="tabular text-sm font-semibold">{usd(d.laborAnnual)}</div></div>
                <div><div className="text-ink-3">Expected savings</div><div className="tabular text-sm font-semibold text-gold-ink">{usd(d.realizableAnnual)}</div></div>
              </div>
              <div className="mt-3">
                <div className="mb-1 flex justify-between text-[11px]"><span className="text-ink-3">Automation potential</span><span className="tabular font-semibold text-cyan-ink">{fmtValue(d.automationPotentialPct, "pct")}</span></div>
                <Meter value={d.automationPotentialPct * 100} accent="cyan" label={`${d.name} automation potential`} />
              </div>
              {d.verifiedAnnual > 0 && <div className="mt-2 text-[11px] font-semibold text-emerald-ink">{usd(d.verifiedAnnual)} verified</div>}
            </>
          );
          return d.departmentId
            ? <Link key={d.departmentId} href={`/app/departments/${d.departmentId}`} className="card card-hover block p-4" data-testid={`dept-card-${d.departmentId}`}>{body}</Link>
            : <div key="unassigned" className="card p-4" data-testid="dept-card-unassigned">{body}</div>;
        })}
      </div>
    ),
    recommendations: recs.length === 0 ? <EmptyBlock title="No recommendations yet" body={deptFilter ? "No opportunities in the filtered departments." : "Recommendations appear once the analysis identifies automatable workflows."} href={deptFilter ? "/app" : "/app/opportunities"} cta={deptFilter ? "Clear filters" : "AI Opportunity Center"} /> : (
      <Table className="shadow-none">
        <thead><tr><Th>#</Th><Th>Opportunity</Th><Th className="text-right">Est. annual benefit</Th><Th className="text-right">Implementation</Th><Th className="text-right">ROI (yr 1)</Th><Th><span className="inline-flex items-center gap-1">Confidence<Tooltip text={CONFIDENCE_RULE} /></span></Th><Th className="text-right">Actions</Th></tr></thead>
        <tbody data-testid="cmd-recommendations">
          {recs.map((r) => (
            <tr key={r.id} className="hover:bg-surface-2/50" data-testid={`rec-${r.id}`}>
              <Td className="text-xs font-bold text-ink-3">{r.rank}</Td>
              <Td className="min-w-[220px]"><div className="font-semibold">{r.title}</div><div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-2"><Badge tone={r.type === "ai_agent" ? "purple" : "cyan"}>{TYPE_LABEL[r.type] ?? r.type}</Badge>{r.departmentName ?? "Unassigned"}{r.overlapRemoved > 0 && <span title="Shares a workflow with another opportunity; scaled down so totals never double count" className="text-indigo-ink">· overlap adj.</span>}{r.deployed && <StatusPill status="deployed" />}</div></Td>
              <Td className="text-right tabular font-semibold text-gold-ink">{usd(r.realizableAnnual)}</Td>
              <Td className="text-right tabular">{usd(r.implementationCost)}</Td>
              <Td className={cn("text-right tabular font-semibold", r.roi1y >= 0 ? "text-indigo-ink" : "text-coral-ink")}>{fmtValue(r.roi1y, "pct")}</Td>
              <Td><span title={`${CONFIDENCE_RULE} This estimate: ${r.sampleSize} observed occurrences.`}><Badge tone={CONF_TONE[r.confidence]}>{r.confidence}</Badge></span><span className="ml-1.5 text-[11px] text-ink-3 tabular">n={r.sampleSize}</span></Td>
              <Td className="text-right"><div className="flex justify-end gap-1.5">
                <Button size="sm" variant="secondary" href={`/app/opportunities/${r.id}`} data-testid={`rec-view-${r.id}`}>View analysis</Button>
                {perms.canWriteAgents && !r.deployed && <Button size="sm" variant="gradient" href={`/app/agents/new?opportunityId=${r.id}`} data-testid={`rec-automate-${r.id}`}><Sparkles size={13} />Automate</Button>}
              </div></Td>
            </tr>
          ))}
        </tbody>
      </Table>
    ),
    tracker: <Tracker m={m} />,
    insights: m.insights.length === 0 ? <EmptyBlock title="No insights yet" body="Insights are generated from your data once workflows and opportunities exist." href="/app/onboarding" cta="Rollout checklist" /> : (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 stagger" data-testid="cmd-insights">
        {m.insights.map((i) => <InsightCard key={i.key} title={i.title} body={i.body} accent={i.accent} evidence={i.evidence} />)}
      </div>
    ),
  };
  const SECTION_META: Record<CommandSectionKey, { title: string; subtitle?: string; accent: "royal" | "gold" | "cyan" | "purple" | "emerald" | "indigo" | "coral"; icon: React.ReactNode; action?: React.ReactNode } | null> = {
    financials: null, secondary: null,
    viz: { title: "Savings & opportunity intelligence", subtitle: "Click any bar or cell to drill into calculations and source records", accent: "gold", icon: <Layers size={16} /> },
    departments: { title: "Department intelligence", subtitle: deptFilter ? `${depts.length} department${depts.length === 1 ? "" : "s"} match the filters` : "Labor, automation potential and expected savings by department", accent: "royal", icon: <Building2 size={16} />, action: <Link href="/app/departments" className="text-xs font-semibold text-royal-ink hover:underline">All departments →</Link> },
    recommendations: { title: "AI recommendations", subtitle: "Ranked by realizable annual benefit", accent: "purple", icon: <Sparkles size={16} />, action: <Link href="/app/opportunities" className="text-xs font-semibold text-royal-ink hover:underline">AI Opportunity Center →</Link> },
    tracker: { title: "Transformation tracker", subtitle: "From identified to verified", accent: "emerald", icon: <Route size={16} />, action: <Link href="/app/roadmap" className="text-xs font-semibold text-royal-ink hover:underline">Roadmap →</Link> },
    insights: { title: "Insight center", subtitle: "Generated deterministically from your data — every insight cites its evidence", accent: "indigo", icon: <Activity size={16} /> },
  };
  const order = [...layout.order.filter((k) => SECTION_KEYS.includes(k as CommandSectionKey)), ...SECTION_KEYS.filter((k) => !layout.order.includes(k))] as CommandSectionKey[];
  const visible = order.filter((k) => !layout.hidden.includes(k));

  return (
    <div className={cn("space-y-6 overflow-x-clip [overflow-clip-margin:16px] transition-opacity", pending && "opacity-60")} data-testid="executive-summary" aria-busy={pending}>
      {/* ---------------- hero ---------------- */}
      <section className="bg-hero relative overflow-hidden rounded-[22px] px-5 py-6 text-white shadow-[var(--shadow-lift)] sm:px-8 sm:py-8" data-testid="cmd-hero">
        <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(245,158,11,.28),transparent_70%)]" />
        <div className="pointer-events-none absolute -bottom-28 left-1/3 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(16,185,129,.16),transparent_70%)]" />
        <div className="relative flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[.16em] text-cyan-300"><Gauge size={14} />Executive command center{m.org.isDemo && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] tracking-wide text-slate-200 ring-1 ring-white/20">Synthetic demo data</span>}</div>
            <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-[2.1rem] sm:leading-tight">Enterprise Transformation Command Center</h1>
            <p className="mt-1 text-sm text-slate-300"><span className="font-semibold text-white">{m.org.name}</span> · computed <span>{formatDateTime(m.computedAt, tz, { dateStyle: "medium", timeStyle: "short" })}</span></p>
            {f.opportunityCount > 0 && (
              <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-slate-200" data-testid="cmd-headline">
                AI can return <b className="text-gold">{usd(f.realizableAnnualSavings)}/yr</b> in realizable value — <b className="text-cyan-300">{fmtValue(f.hoursRecoverablePerWeek, "hours")}/wk</b> of capacity across {f.opportunityCount} opportunities.{" "}
                {verifiedEmpty ? <span className="text-slate-300">Nothing is verified yet; every figure is labelled projected or verified.</span> : <><b className="text-emerald">{usd(m.headline.verified.value)}/yr</b> is already verified.</>}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 xl:justify-end">
            <Button variant="glass" href="/app/assistant" data-testid="cmd-advisor"><MessageSquareText size={15} />AI Advisor</Button>
            <Button variant="gradient" href={`/present${scenario !== "expected" ? `?scenario=${scenario}` : ""}`} data-testid="cmd-present"><Presentation size={15} />Present</Button>
            <ExportMenu query={exportQuery} scenario={pickedScenario} canPdf={perms.canPdf} />
          </div>
        </div>
        <div className="relative mt-6 flex flex-col gap-4 border-t border-white/10 pt-5 lg:flex-row lg:flex-wrap lg:items-end lg:justify-between">
          <div className="flex flex-wrap gap-4">
            <HeroSegmented label="Verified-savings period" testid="cmd-period" value={period} onChange={setPeriod} options={[{ key: "30", label: "30 days" }, { key: "90", label: "90 days" }, { key: "365", label: "12 months" }]} />
            <HeroSegmented label="Scenario" testid="cmd-scenario" value={scenario} onChange={(v) => setParam("scenario", v === "expected" ? null : v)} options={[{ key: "conservative", label: "Conservative" }, { key: "expected", label: "Expected" }, { key: "aggressive", label: "Aggressive" }]} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SavedViews views={views} currentFilters={currentFilters} activeId={activeViewId} layout={layout} />
            <Button variant="glass" size="sm" className="h-9" onClick={() => setCustomize(true)} data-testid="cmd-customize"><Settings2 size={14} />Customize</Button>
          </div>
        </div>
      </section>

      {noData && <SetupBanner m={m} />}

      <FilterBar filters={filterOpts} testid="cmd-filters" extra={deptFilter ? <span className="text-[11px] text-ink-3">Filters apply to departments, heatmap and recommendations; headline KPIs stay enterprise-wide.</span> : undefined} />

      {visible.map((k) => {
        const meta = SECTION_META[k];
        return (
          <section key={k} data-testid={`cmd-section-${k}`} aria-label={meta?.title ?? COMMAND_LABEL[k]}>
            {meta && <SectionHeader title={meta.title} subtitle={meta.subtitle} accent={meta.accent} icon={meta.icon} action={meta.action} />}
            {sections[k]}
          </section>
        );
      })}
      {visible.length < SECTION_KEYS.length && <p className="text-center text-xs text-ink-3">{SECTION_KEYS.length - visible.length} section{SECTION_KEYS.length - visible.length === 1 ? " is" : "s are"} hidden. <button className="font-semibold text-royal-ink hover:underline" onClick={() => setCustomize(true)} data-testid="cmd-show-hidden">Customize</button></p>}

      <p className="pb-2 text-center text-[11px] text-ink-3">Gold = projected opportunity · Emerald = verified · Time saved is capacity, not a payroll cut — any staffing or role change requires management and HR/legal review.</p>

      <DrillDrawer drill={drill} onClose={() => setDrill(null)} />
      <CustomizeDrawer open={customize} onClose={() => setCustomize(false)} layout={layout} views={views} />
    </div>
  );
}

const COMMAND_LABEL: Record<CommandSectionKey, string> = { financials: "Primary financial cards", secondary: "Capacity, agents, ROI and projections", viz: "Savings and opportunity intelligence", departments: "Department intelligence", recommendations: "AI recommendations", tracker: "Transformation tracker", insights: "Insight center" };

function EmptyBlock({ title, body, href, cta }: { title: string; body: string; href: string; cta: string }) {
  return <div className="card flex flex-col items-center gap-2 px-6 py-8 text-center"><p className="text-sm font-semibold">{title}</p><p className="max-w-md text-xs text-ink-2">{body}</p><Button size="sm" variant="secondary" href={href}>{cta}<ArrowRight size={13} /></Button></div>;
}

function SetupBanner({ m }: { m: ExecutiveModel }) {
  return (
    <div className="card relative overflow-hidden p-5" data-testid="cmd-setup">
      <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-royal to-purple" />
      <div className="flex items-start gap-3 pl-1">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-royal-soft text-royal-ink"><Rocket size={17} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold">Your command center fills in from real data</h2>
          <p className="mt-0.5 text-xs text-ink-2">Nothing on this page is a placeholder. Complete these steps and every figure below populates automatically.</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {m.gaps.map((g) => <li key={g.key}><Link href={g.href} className="flex items-start gap-2 rounded-xl border border-border p-3 hover:border-royal/50 hover:bg-surface-2" data-testid={`cmd-gap-${g.key}`}><span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-surface-3" /><span><span className="block text-sm font-semibold">{g.title}</span><span className="text-xs text-ink-2">{g.body}</span></span></Link></li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Tracker({ m }: { m: ExecutiveModel }) {
  const f = m.fin; const t = m.tracker;
  const statuses = ["proposed", "approved", "in_progress", "live", "measuring", "closed"];
  const stages = [
    { label: "Identified", value: f.opportunityCount, icon: <Lightbulb size={15} />, tone: "bg-gold-soft text-gold-ink", href: "/app/opportunities" },
    { label: "Approved", value: t.approvedOpportunities, icon: <CheckCircle2 size={15} />, tone: "bg-indigo-soft text-indigo-ink", href: "/app/opportunities?status=approved" },
    { label: "Agents deployed", value: t.deployedAgents, icon: <Bot size={15} />, tone: "bg-purple-soft text-purple-ink", href: "/app/agents" },
    { label: "Verified results", value: t.measurements, icon: <PiggyBank size={15} />, tone: "bg-emerald-soft text-emerald-ink", href: "/app/savings" },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-3" data-testid="cmd-tracker">
      <div className="card p-5 lg:col-span-2">
        <h3 className="text-sm font-bold">Pipeline</h3>
        <ol className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {stages.map((s, i) => (
            <li key={s.label} className="relative">
              <Link href={s.href} className="block rounded-xl border border-border p-3 transition hover:border-royal/40 hover:bg-surface-2" data-testid={`tracker-${s.label.toLowerCase().replace(/\s+/g, "-")}`}>
                <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg", s.tone)}>{s.icon}</span>
                <div className="mt-2 font-display text-2xl font-bold tabular">{s.value}</div>
                <div className="text-xs text-ink-2">{s.label}</div>
              </Link>
              {i < stages.length - 1 && <ArrowRight size={14} className="absolute -right-2.5 top-1/2 hidden -translate-y-1/2 text-ink-3 md:block" />}
            </li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
          <span>Verified: <b className="tabular text-emerald-ink">{t.measurements ? fmtValue(t.verifiedAnnual, "usdCompact") + "/yr" : "not yet measured"}</b></span>
          <span>Approved ledger entries: <b className="tabular text-ink">{t.ledgerApproved}</b></span>
          <Link href="/app/savings" className="font-semibold text-royal-ink hover:underline">Savings ledger →</Link>
        </div>
      </div>
      <div className="card p-5">
        <div className="flex items-center justify-between"><h3 className="text-sm font-bold">Projects by status</h3><Briefcase size={15} className="text-ink-3" /></div>
        {t.projects.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-border p-4 text-center"><p className="text-xs text-ink-2">No transformation projects yet.</p><Link href="/app/roadmap" className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-royal-ink hover:underline" data-testid="tracker-roadmap">Plan on the roadmap<ArrowRight size={12} /></Link></div>
        ) : (
          <ul className="mt-3 space-y-2">
            {statuses.filter((s) => t.projectsByStatus[s]).map((s) => <li key={s} className="flex items-center justify-between"><StatusPill status={s} /><span className="tabular text-sm font-bold">{t.projectsByStatus[s]}</span></li>)}
            <li className="border-t border-border pt-2 text-xs text-ink-2"><Coins size={12} className="mr-1 inline" />Spent {fmtValue(t.projects.reduce((a, p) => a + p.spent, 0), "usdCompact")} of {fmtValue(t.projects.reduce((a, p) => a + p.budget, 0), "usdCompact")} budget</li>
          </ul>
        )}
      </div>
    </div>
  );
}
