"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle, Radar, Sparkles } from "lucide-react";
import type { CalcTree } from "@/db/schema";
import type { OrgFinancials } from "@/engine/finance.types";
import { Badge, BasisChip, Button, Card, CardHeader, Empty, PageHeader, Tooltip } from "@/components/ui";
import { StatTile, type Drill } from "@/components/dashboard/stat-tile";
import { ChartFrame, SavingsWaterfall, DepartmentHoursBars, ThreeYearLines, BeforeAfterBars, chartColors as C } from "@/components/charts";
import { fmtUSD, fmtNum, fmtPct, cn } from "@/lib/utils";
import type { Progress, Step } from "@/app/app/onboarding/progress";

export type ExecData = {
  fin: Omit<OrgFinancials, "byEmployee"> & { byEmployee?: never };
  wasted: { value: number; tree: CalcTree };
  progress: Progress;
  steps: Step[];
  role: string;
  canWriteAgents: boolean;
  canManageCollection: boolean;
};

const TYPE_LABEL: Record<string, string> = { ai_agent: "AI agent", rpa: "RPA bot", conventional_automation: "Integration", process_change: "Process change", role_consolidation: "Consolidation" };

export function ExecutiveSummary({ data }: { data: ExecData }) {
  const { fin, wasted, progress, steps } = data;
  const noAnalysis = !progress.analysisRun && fin.opportunityCount === 0 && fin.hoursObservedPerWeek === 0;
  const d = (tree: CalcTree, meaning: string): Drill => ({ tree, meaning });
  const payback = fin.paybackMonths == null ? "—" : fin.paybackMonths > 60 ? "> 5 yrs" : `${fmtNum(fin.paybackMonths, 1)} mo`;
  const next = steps.find((s) => !s.done);
  const topOpps = fin.opportunities.filter((o) => o.status !== "rejected").slice(0, 5);
  const deptRows = fin.byDepartment.filter((x) => x.hoursPerWeek > 0 || x.recoverableHoursPerWeek > 0).slice(0, 8);

  return (
    <div className="space-y-6" data-testid="executive-summary">
      <PageHeader title="Executive Summary" subtitle={`What your team spends on repetitive work, what AI could take over, and what has actually been saved. Computed ${new Date(fin.computedAt).toLocaleString()} · ${fin.scenarios[fin.scenario].label} scenario.`}
        actions={<><Button variant="secondary" href="/app/onboarding" data-testid="exec-onboarding">Rollout checklist</Button><Button variant="secondary" href="/app/reports" data-testid="exec-reports">Reports</Button></>} />

      {noAnalysis && (
        <Empty title="No analysis yet" body="Once collectors have observed a few weeks of work and you run the analysis, this page fills in with real numbers. Nothing here is a placeholder." action={<Button href={next?.href ?? "/app/onboarding"} data-testid="exec-empty-cta">{next?.cta ?? "Open the rollout checklist"}</Button>} />
      )}

      {/* Hero row */}
      <div className="grid gap-3 md:grid-cols-3">
        <StatTile size="lg" testid="kpi-wasted" label="Spent on automatable work today" value={fmtUSD(wasted.value)} basis="estimated" tone="ink"
          caption="Per year, in salary and benefits, on repetitive work that software could do."
          hint="Loaded cost of all the hours your people spend each week on workflows that have an automation opportunity, annualized. This is what the work costs today, before any automation."
          drill={d(wasted.tree, "This is the yearly payroll cost of the repetitive, automatable workflows we observed — hours per week on each workflow, times the working weeks in a year, times what those people cost per hour including benefits. It is the size of the prize, not a promise of savings.")} />
        <StatTile size="lg" testid="kpi-achievable" label="Realistically achievable per year" value={fmtUSD(fin.realizableAnnualSavings)} basis="estimated" tone="projected"
          caption="Projected savings after adoption and realization rates. Time saved ≠ payroll cut."
          hint="Only part of recovered time turns into money: people adopt the automation gradually, and freed time becomes value only when it is reassigned, avoids a hire or covers attrition. This number already applies those discounts."
          drill={d(fin.trees.realizableSavings, "Of the gross value of recoverable hours, this is the share we expect to actually show up as money — after assuming not every run goes through the automation (adoption rate) and that only some freed time becomes avoided hiring, reassigned revenue work or attrition backfill (realization rate).")} />
        <StatTile size="lg" testid="kpi-verified" label="Verified so far" value={fin.verifiedMeasurements > 0 ? fmtUSD(fin.verifiedAnnualizedSavings) : "—"} basis="observed" tone="verified"
          caption={fin.verifiedMeasurements > 0 ? `${fin.verifiedMeasurements} measurement${fin.verifiedMeasurements === 1 ? "" : "s"} · ${fmtNum(fin.verifiedHoursSaved, 0)} hours actually saved` : <span>No deployments measured yet → <Link href={fin.opportunityCount > 0 ? "/app/opportunities" : "/app/agents/new"} className="font-medium text-verified underline" data-testid="kpi-verified-cta">Deploy an agent</Link></span>}
          hint="Measured after deployment from the agent run ledger or before/after observation, annualized. Kept separate from projections at all times."
          drill={d(fin.trees.verifiedSavings, fin.verifiedMeasurements > 0 ? "Savings that have been measured from real agent runs or a before/after comparison, scaled to a full year. These are facts, not forecasts." : "Nothing has been measured yet. Once an agent is deployed and a measurement is recorded, this number fills in from real data and is never mixed with projections.")} />
      </div>

      {/* Second row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile testid="kpi-labor" label="Annual labor analyzed" value={fmtUSD(fin.totalAnnualLaborAnalyzed, { compact: true })} caption={`${fin.employeesAnalyzed} people with observed activity`} basis={fin.trees.totalLabor.basis} hint="Salary plus benefits load for every employee whose activity was observed."
          drill={d(fin.trees.totalLabor, "The total yearly cost (salary + benefits) of the people whose work we observed. It is the denominator for everything else on this page.")} />
        <StatTile testid="kpi-repetitive" label="Repetitive hours / week" value={fmtNum(fin.repetitiveHoursPerWeek, 0)} caption={`${fmtPct(fin.repetitiveSharePct)} of ${fmtNum(fin.hoursObservedPerWeek, 0)} observed hrs/wk`} basis="observed" hint="Hours per week in workflows that are done the same way over and over (repetition score 50+)."
          drill={d(fin.trees.repetitiveHours, "Hours per week spent in workflows the analysis found to be highly repetitive — same steps, same apps, many times a week. Not all of it can be automated; the next tile says how much can.")} />
        <StatTile testid="kpi-recoverable" label="Recoverable hours / week" value={fmtNum(fin.hoursRecoverablePerWeek, 0)} caption="Hours software could take over" basis="estimated" tone="projected" hint="Workflow hours × share of each workflow that automation removes × expected adoption."
          drill={d(fin.trees.recoverableHours, "Of the repetitive hours, this is how many software could realistically take over each week, after allowing for the parts that still need a person and for gradual adoption.")} />
        <StatTile testid="kpi-cost" label="Cost to implement + run" value={<span>{fmtUSD(fin.implementationCost, { compact: true })} <span className="text-base text-ink-2">+ {fmtUSD(fin.annualOperatingCost, { compact: true })}/yr</span></span>} caption="One-time setup + yearly operating" basis="estimated" hint="Setup = consulting hours and tooling per opportunity. Operating = monthly platform/model/runtime fees × 12."
          drill={d({ ...fin.trees.implementationCost, children: [...(fin.trees.implementationCost.children ?? []), fin.trees.operatingCost] }, "What it costs to build the automations (one-time) and keep them running (every year). Both are deducted before we call anything 'net'.")} />
        <StatTile testid="kpi-net" label="Net annual savings" value={fmtUSD(fin.netAnnualSavings, { compact: true })} caption="Realizable − operating − platform fee" basis="estimated" tone={fin.netAnnualSavings >= 0 ? "money" : "warn"}
          drill={d(fin.trees.netSavings, "Realizable savings minus everything it costs to keep the automations running for a year. This is the number to compare against the one-time setup cost.")} />
        <StatTile testid="kpi-roi" label="First-year ROI" value={fmtPct(fin.roi1y)} caption="(net − setup) ÷ setup" basis="estimated" tone={fin.roi1y >= 0 ? "money" : "warn"} hint="Return on the one-time setup cost in the first 12 months. 100% means the setup pays for itself twice over in year one."
          drill={d(fin.trees.roi, "How much the first year returns on the setup investment. Above 0% means the automations pay for themselves within the year; the 3-year chart below shows the longer view.")} />
        <StatTile testid="kpi-payback" label="Payback" value={payback} caption={fin.paybackMonths == null ? "Not reached at current net" : "Months to recover setup cost"} basis="estimated"
          drill={d(fin.trees.payback, "How many months of net savings it takes to earn back the one-time setup cost.")} />
        <StatTile testid="kpi-completion" label="Automation completion" value={fmtPct(fin.automationCompletionPct)} caption={`${fin.deployedAgents} of ${fin.opportunityCount} opportunities deployed`} basis="observed" tone="verified" hint="Verified annualized savings ÷ realizable projected savings. Deployment completion = deployed agents ÷ opportunities."
          drill={d(fin.trees.automationCompletion, "How far along you are: the share of the projected savings that has already been verified from real measurements, plus how many opportunities have a deployed agent.")} />
      </div>

      {/* Charts */}
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartFrame testid="chart-waterfall" title="From gross to net" subtitle="Why the headline number shrinks — and why that is honest." help="Gross = value of every recoverable hour. Realizable = after adoption and realization rates. Net = after yearly operating and platform costs." legend={[{ label: "Gross", color: C.ink3 }, { label: "Realizable (projected)", color: C.projected }, { label: "Net (projected)", color: C.money }]}>
          <SavingsWaterfall gross={fin.grossAnnualSavings} realizable={fin.realizableAnnualSavings} net={fin.netAnnualSavings} />
        </ChartFrame>
        <ChartFrame testid="chart-departments" title="Where the repetitive work is" subtitle="Hours per week by department: repetitive vs. what software could take over." legend={[{ label: "Repetitive hrs/wk (observed)", color: C.ink3 }, { label: "Recoverable hrs/wk (projected)", color: C.projected }]} action={<Link href="/app/departments" className="text-xs text-brand hover:underline">All departments →</Link>}>
          {deptRows.length ? <DepartmentHoursBars rows={deptRows.map((r) => ({ name: r.name, repetitive: r.repetitiveHoursPerWeek, recoverable: r.recoverableHoursPerWeek }))} /> : <p className="p-4 text-xs text-ink-3">No department data yet.</p>}
        </ChartFrame>
        <ChartFrame testid="chart-three-year" title="Three-year outlook" subtitle="Cumulative net savings under three sets of assumptions. Year 1 includes setup cost and a ramp-up." help="Conservative: slower adoption, lower realization, 30% higher costs. Aggressive: the opposite. Expected is what the rest of this page uses." legend={[{ label: "Conservative", color: C.ink3, dashed: true }, { label: "Expected", color: C.projected }, { label: "Aggressive", color: C.brand2, dashed: true }]} action={<Link href="/app/finance" className="text-xs text-brand hover:underline">Adjust assumptions →</Link>}>
          <ThreeYearLines scenarios={(["conservative", "expected", "aggressive"] as const).map((k) => ({ key: k, label: fin.scenarios[k].label, years: fin.scenarios[k].threeYear.years }))} />
        </ChartFrame>
        <ChartFrame testid="chart-before-after" title="Hours per week, before and after" subtitle="Observed workflow hours today vs. projected hours once automations are live." legend={[{ label: "Today (observed)", color: C.ink3 }, { label: "After automation (projected)", color: C.projected }]}>
          {deptRows.length ? <BeforeAfterBars rows={deptRows.map((r) => ({ name: r.name, before: r.hoursPerWeek, after: Math.max(0, r.hoursPerWeek - r.recoverableHoursPerWeek) }))} /> : <p className="p-4 text-xs text-ink-3">No department data yet.</p>}
        </ChartFrame>
      </div>

      {/* Top opportunities + next actions + monitoring */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2" data-testid="top-opps">
          <CardHeader title="Top opportunities" subtitle="Ranked by realizable savings, feasibility and risk." action={<Link href="/app/opportunities" className="text-xs text-brand hover:underline">All opportunities →</Link>} />
          {topOpps.length === 0 ? <p className="text-xs text-ink-3">No opportunities yet. Run the analysis to find them.</p> : (
            <ol className="divide-y divide-border">
              {topOpps.map((o, i) => (
                <li key={o.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center" data-testid={`top-opp-${o.id}`}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink-2">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <Link href={`/app/opportunities/${o.id}`} className="block truncate text-sm font-medium text-ink hover:text-brand hover:underline">{o.title}</Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-2">
                      <Badge tone="neutral">{TYPE_LABEL[o.type] ?? o.type}</Badge>
                      <span>{o.departmentName ?? "—"}</span>·<span className="tabular">{fmtNum(o.hoursRecoverablePerWeek, 1)} hrs/wk</span>·<span>payback {o.paybackMonths == null ? "n/a" : `${fmtNum(o.paybackMonths, 0)} mo`}</span>
                      <Badge tone={o.feasibility >= 66 ? "money" : o.feasibility >= 40 ? "warn" : "danger"}>feasibility {Math.round(o.feasibility)}</Badge>
                      <Badge tone={o.risk < 34 ? "money" : o.risk < 66 ? "warn" : "danger"}>risk {Math.round(o.risk)}</Badge>
                      {o.deployed && <Badge tone="verified">deployed</Badge>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
                    <span className="tabular text-sm font-semibold text-projected">{fmtUSD(o.realizableAnnualSavings, { compact: true })}<span className="text-[10px] font-normal text-ink-3">/yr</span></span>
                    {data.canWriteAgents && !o.deployed && <Button size="sm" variant="secondary" href={`/app/agents/new?opportunityId=${o.id}`} data-testid={`automate-${o.id}`}><Sparkles size={13} />Automate this</Button>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <div className="space-y-3">
          <Card data-testid="next-actions">
            <CardHeader title="Next actions" subtitle={`${steps.filter((s) => s.done).length} of ${steps.length} rollout steps done`} action={<Link href="/app/onboarding" className="text-xs text-brand hover:underline">Checklist →</Link>} />
            <ol className="space-y-2">
              {steps.filter((s) => !s.done).slice(0, 3).map((s, i) => (
                <li key={s.key} className={cn("rounded-lg border p-3", i === 0 ? "border-brand/50 bg-brand-soft/30" : "border-border")} data-testid={`next-action-${s.key}`}>
                  <div className="flex items-start gap-2"><Circle size={15} className="mt-0.5 shrink-0 text-ink-3" /><div className="min-w-0 flex-1"><div className="text-sm font-medium text-ink">{s.title}</div><p className="mt-0.5 text-xs text-ink-2">{s.body}</p><Link href={s.href} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">{s.cta}<ArrowRight size={12} /></Link></div></div>
                </li>
              ))}
              {steps.every((s) => s.done) && <li className="flex items-center gap-2 text-sm text-money"><CheckCircle2 size={16} />Everything is set up. Keep measuring and re-run the analysis each quarter.</li>}
            </ol>
          </Card>
          <Link href="/app/collection" className="card block p-4 transition hover:border-brand/50 hover:shadow-pop" data-testid="monitoring-health">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-ink"><Radar size={14} className="text-brand" />Monitoring health<Tooltip text="Collectors are the small programs on employee computers that record which apps are used and for how long — never what is typed or shown." /></div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div><dt className="text-ink-3">Collectors</dt><dd className="tabular text-sm font-semibold text-ink">{progress.collectorsActive}<span className="text-ink-3">/{progress.collectorsTotal}</span></dd></div>
              <div><dt className="text-ink-3">Last event</dt><dd className="text-sm font-semibold text-ink">{progress.lastEventAt ? ago(progress.lastEventAt) : "never"}</dd></div>
              <div><dt className="text-ink-3">Campaign</dt><dd className="text-sm font-semibold capitalize text-ink">{progress.campaign?.status ?? "none"}</dd></div>
            </dl>
            <div className="mt-2 text-[11px] text-ink-3">{progress.events24h > 0 ? `${fmtNum(progress.events24h)} events in the last 24h` : "No events in the last 24h"} · Basis mix: <BasisChip basis="observed" /> {fin.basisSummary.observed} · <BasisChip basis="estimated" /> {fin.basisSummary.estimated} · <BasisChip basis="assumed" /> {fin.basisSummary.assumed}</div>
          </Link>
        </div>
      </div>
    </div>
  );
}

function ago(iso: string) { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return "just now"; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 48) return `${h} h ago`; return `${Math.round(h / 24)} d ago`; }
