"use client";
import * as React from "react";
import Link from "next/link";
import { BarChart3, DollarSign, Users, Clock, Repeat, Shuffle, Building2, Info } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, LineChart, Line, Cell } from "recharts";
import type { BusinessIntel, ExpenseRow } from "@/engine/business-intel";
import type { CalcTree } from "@/db/schema";
import { Button, Empty, PageHeader } from "@/components/ui";
import { KpiCard, SectionHeader, Segmented, FilterBar, ACCENT_HEX } from "@/components/ui/enterprise";
import { CategoryDonut, SimpleBars, ChartTip } from "@/components/charts";
import { axisProps, gridProps, compactUSD, C } from "@/components/charts/theme";
import { DataViewCard } from "@/components/process/data-view-card";
import { DrillDrawer, DateRangeFilter } from "@/components/process/drill";
import { fmtUSD, fmtNum, fmtPct } from "@/lib/utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tip = (fn: (p: { active?: boolean; label?: string | number; payload?: { dataKey?: string | number; value?: number | string; color?: string; fill?: string; payload?: Record<string, unknown> }[] }) => React.ReactElement | null) => fn as unknown as any;
const LABOR = ACCENT_HEX.royal, OVERHEAD = "var(--color-ink-3)";
const usd = (v: unknown) => fmtUSD(Number(v));
const hrs = (v: unknown) => `${fmtNum(Number(v), 1)} hrs`;
const pct = (v: unknown) => fmtPct(Number(v), 1);

type DrillKey = keyof BusinessIntel["trees"];

function ExpenseBars({ rows, layout = "horizontal" }: { rows: ExpenseRow[]; layout?: "horizontal" | "vertical" }) {
  const vertical = layout === "vertical";
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout={vertical ? "vertical" : "horizontal"} margin={{ top: 8, right: 12, left: 4, bottom: 0 }} barCategoryGap="28%">
        <CartesianGrid {...gridProps} horizontal={!vertical} vertical={vertical} />
        {vertical ? <><XAxis type="number" {...axisProps} tickFormatter={compactUSD} /><YAxis type="category" dataKey="name" {...axisProps} width={112} tickFormatter={(v: string) => (v.length > 16 ? v.slice(0, 15) + "…" : v)} /></>
          : <><XAxis dataKey="name" {...axisProps} interval={0} tickFormatter={(v: string) => (v.length > 14 ? v.slice(0, 13) + "…" : v)} /><YAxis {...axisProps} tickFormatter={compactUSD} width={56} /></>}
        <RTooltip cursor={{ fill: C.surface2 }} content={tip((p) => <ChartTip active={p.active} label={p.label} rows={(p.payload ?? []).map((x) => ({ name: x.dataKey === "labor" ? "Labor expense (loaded)" : "Department overhead (entered)", value: fmtUSD(Number(x.value)), color: x.fill }))} />)} />
        <Bar dataKey="labor" stackId="a" fill={LABOR} maxBarSize={vertical ? 18 : 56} isAnimationActive={false} />
        <Bar dataKey="overhead" stackId="a" fill={OVERHEAD} radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={vertical ? 18 : 56} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function BusinessClient({ bi, canManageStructure }: { bi: BusinessIntel; canManageStructure: boolean }) {
  const [drill, setDrill] = React.useState<DrillKey | null>(null);
  const [expenseBy, setExpenseBy] = React.useState<"bu" | "loc">(bi.byBusinessUnit.length > 1 || bi.byLocation.length <= 1 ? "bu" : "loc");
  const [timeBy, setTimeBy] = React.useState<"category" | "activity">("category");
  const a = bi.activity;
  const filters = [
    { key: "bu", label: "Business unit", all: "All business units", options: bi.options.businessUnits.map((b) => ({ value: b.id, label: b.name })) },
    { key: "loc", label: "Location", all: "All locations", options: bi.options.locations.map((l) => ({ value: l.id, label: l.name })) },
    { key: "dept", label: "Department", all: "All departments", options: bi.options.departments.map((d) => ({ value: d.id, label: d.name })) },
  ];
  const header = (
    <PageHeader hero eyebrow="Command" icon={<BarChart3 size={22} />} title="Business Intelligence"
      subtitle="How the organization performs: where labor and overhead go, how time is spent across applications, and how evenly work is spread — all from your own records and observed activity."
      actions={canManageStructure ? <Button variant="glass" href="/app/settings/structure" data-testid="biz-structure-link"><Building2 size={15} />Locations & business units</Button> : undefined} />
  );
  const filterBar = <FilterBar filters={filters} testid="biz-filters" extra={<DateRangeFilter testid="biz-filters" />} />;

  if (bi.headcount === 0) return (
    <div data-testid="business-page">{header}{filterBar}
      <Empty title={bi.filtered ? "No employees match these filters" : "No employees yet"} body={bi.filtered ? "Clear a filter, or assign employees to this business unit / location in Settings → Structure." : "Add employees and enroll desktop collectors to see business performance."}
        action={<div className="flex flex-wrap justify-center gap-2">{bi.filtered && <Button variant="secondary" href="/app/business" data-testid="biz-empty-clear">Clear filters</Button>}<Button href={bi.filtered ? "/app/settings/structure" : "/app/onboarding"} data-testid="biz-empty-cta">{bi.filtered ? "Open Structure" : "Open the rollout checklist"}</Button></div>} />
    </div>
  );

  const expenseRows = expenseBy === "bu" ? bi.byBusinessUnit : bi.byLocation;
  const deptRows = bi.byDepartment.filter((r) => r.entered > 0 || r.headcount > 0);
  const timeRows = timeBy === "category" ? a.byCategory : a.byActivity;
  const histRows = bi.workload.histogram;
  const tree = drill ? (bi.trees[drill] as CalcTree) : null;
  const noActivity = a.events === 0;

  return (
    <div data-testid="business-page">
      {header}
      {filterBar}

      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6" data-testid="biz-kpis">
        <KpiCard testid="kpi-labor" label="Labor expense (annual, loaded)" value={bi.laborAnnual} format={(n) => fmtUSD(n)} accent="royal" basis={bi.trees.labor.basis} icon={<DollarSign size={16} />} caption={`${bi.employeesAnalyzed} analyzed employees`} onClick={() => setDrill("labor")} />
        <KpiCard testid="kpi-opex" label="Entered operating expense" value={bi.enteredOpexAnnual} format={(n) => fmtUSD(n)} accent="indigo" basis={bi.trees.enteredOpex.basis} icon={<Building2 size={16} />} caption={`Labor + overhead entered on ${bi.departmentsWithOverhead}/${bi.departmentsInScope} depts`} hint="Not total company opex — only labor and the overhead entered per department." onClick={() => setDrill("enteredOpex")} />
        <KpiCard testid="kpi-headcount" label="Headcount" value={bi.headcount} format={(n) => fmtNum(n)} accent="midnight" basis="observed" icon={<Users size={16} />} caption="Active employee records" onClick={() => setDrill("headcount")} />
        <KpiCard testid="kpi-hours" label="Observed hours / week" value={noActivity ? null : a.hoursPerWeek} format={(n) => fmtNum(n, 1)} accent="royal" basis="observed" icon={<Clock size={16} />} caption={noActivity ? "No activity in range" : `${fmtNum(a.activeDays)} active days · idle ${fmtPct(a.idleShare, 1)}`} onClick={() => setDrill("hoursPerWeek")} />
        <KpiCard testid="kpi-repetitive" label="Repetitive share" value={bi.repetitive.sharePct} format={(n) => fmtPct(n, 1)} accent="gold" basis="observed" icon={<Repeat size={16} />} caption={`${fmtNum(bi.repetitive.hoursPerWeek, 1)} hrs/wk on repetitive workflows`} onClick={() => setDrill("repetitive")} />
        <KpiCard testid="kpi-switches" label="Context switches / hour" value={noActivity ? null : a.contextSwitches.perHour} format={(n) => fmtNum(n, 1)} accent="coral" basis={a.contextSwitches.basis} icon={<Shuffle size={16} />} caption={a.contextSwitches.method === "derived_app_changes" ? "Derived from app changes" : "From app_switch events"} onClick={() => setDrill("contextSwitches")} />
      </div>
      <p className="mt-2 flex items-start gap-1.5 text-[11px] text-ink-3"><Info size={12} className="mt-0.5 shrink-0" />Labor and overhead are annual figures and are not narrowed by the date range; hours, apps and trends are. Entered operating expense is labor plus the overhead you entered per department — it is not total company opex unless finance data is imported.</p>

      <SectionHeader accent="royal" title="Where the money goes" subtitle="Loaded labor (finance engine) and department overhead you entered, by business unit, location and department." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DataViewCard testid="chart-expense" title={expenseBy === "bu" ? "Expense by business unit" : "Expense by location"} subtitle="Stacked: labor + entered overhead" filename={`expense-by-${expenseBy}`}
          legend={[{ label: "Labor (loaded)", color: LABOR }, { label: "Overhead (entered)", color: OVERHEAD }]}
          summary={`Entered expense by ${expenseBy === "bu" ? "business unit" : "location"}: ${expenseRows.map((r) => `${r.name} ${fmtUSD(r.entered)}`).join(", ")}`}
          rows={expenseRows.map((r) => ({ name: r.name, headcount: r.headcount, labor: r.labor, overhead: r.overhead, entered: r.entered }))}
          columns={[{ key: "name", label: expenseBy === "bu" ? "Business unit" : "Location" }, { key: "headcount", label: "People", align: "right" }, { key: "labor", label: "Labor", align: "right", format: usd }, { key: "overhead", label: "Overhead", align: "right", format: usd }, { key: "entered", label: "Entered expense", align: "right", format: usd }]}
          action={<Segmented size="sm" testid="expense-by" value={expenseBy} onChange={setExpenseBy} options={[{ key: "bu", label: "BU" }, { key: "loc", label: "Location" }]} />}>
          <ExpenseBars rows={expenseRows} />
        </DataViewCard>
        <DataViewCard testid="chart-dept-expense" title="Department labor vs overhead" subtitle="Click View data for headcount and totals" filename="department-expense" height={Math.max(240, deptRows.length * 34)}
          legend={[{ label: "Labor (loaded)", color: LABOR }, { label: "Overhead (entered)", color: OVERHEAD }]}
          summary={`Department expense: ${deptRows.map((r) => `${r.name} labor ${fmtUSD(r.labor)}, overhead ${fmtUSD(r.overhead)}`).join("; ")}`}
          rows={deptRows.map((r) => ({ name: r.name, headcount: r.headcount, labor: r.labor, overhead: r.overhead, entered: r.entered, overheadBasis: r.overhead > 0 ? r.overheadBasis : "—" }))}
          columns={[{ key: "name", label: "Department" }, { key: "headcount", label: "People", align: "right" }, { key: "labor", label: "Labor", align: "right", format: usd }, { key: "overhead", label: "Overhead", align: "right", format: usd }, { key: "overheadBasis", label: "Overhead basis" }, { key: "entered", label: "Total", align: "right", format: usd }]}>
          <ExpenseBars rows={deptRows} layout="vertical" />
        </DataViewCard>
      </div>

      <SectionHeader accent="cyan" title="How time is spent" subtitle={noActivity ? "No observed activity in this range." : `${fmtNum(a.events)} observed events · ${fmtNum(a.activeHours, 0)} active hours`} />
      {noActivity ? (
        <Empty title="No observed activity for this selection" body="Widen the date range, or enroll desktop collectors for these employees." action={<Button href="/app/collection" data-testid="biz-collectors-cta">Open Desktop Collectors</Button>} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <DataViewCard testid="chart-time" title={timeBy === "category" ? "Time by application category" : "Time by activity type"} subtitle="Share of active (non-idle) time" filename={`time-by-${timeBy}`}
              summary={`Time allocation: ${timeRows.slice(0, 8).map((r) => `${r.name} ${fmtPct(r.share)}`).join(", ")}`}
              rows={timeRows.map((r) => ({ name: r.name, hours: r.hours, share: r.share }))}
              columns={[{ key: "name", label: timeBy === "category" ? "Category" : "Activity" }, { key: "hours", label: "Hours", align: "right", format: hrs }, { key: "share", label: "Share", align: "right", format: pct }]}
              action={<Segmented size="sm" testid="time-by" value={timeBy} onChange={setTimeBy} options={[{ key: "category", label: "Category" }, { key: "activity", label: "Activity" }]} />}>
              <CategoryDonut rows={timeRows.map((r) => ({ name: r.name, hours: r.hours }))} />
            </DataViewCard>
            <DataViewCard testid="chart-apps" title="Top applications" subtitle="Active hours in the selected range" filename="top-applications" height={Math.max(240, a.topApps.length * 26)}
              summary={`Top applications by hours: ${a.topApps.slice(0, 6).map((r) => `${r.name} ${fmtNum(r.hours, 1)} hours`).join(", ")}`}
              rows={a.topApps.map((r) => ({ name: r.name, hours: r.hours, share: r.share }))}
              columns={[{ key: "name", label: "Application" }, { key: "hours", label: "Hours", align: "right", format: hrs }, { key: "share", label: "Share", align: "right", format: pct }]}>
              <SimpleBars rows={a.topApps.map((r) => ({ name: r.name, value: r.hours }))} color={ACCENT_HEX.cyan} />
            </DataViewCard>
          </div>

          <SectionHeader accent="gold" title="Trends & workload" subtitle="Weekly hours with the share spent on steps of repetitive workflows, and how evenly hours are spread across people." />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <DataViewCard testid="chart-weekly" title="Weekly trend" subtitle="Active hours (left) · repetitive share (right)" filename="weekly-trend"
              legend={[{ label: "Active hours", color: LABOR }, { label: "Repetitive share", color: ACCENT_HEX.gold }]}
              help="Repetitive share here = time on steps that belong to workflows with a repetition score ≥ 50, as a share of active time that week."
              summary={`Weekly active hours: ${bi.weekly.map((w) => `week of ${w.week} ${fmtNum(w.hours, 0)} hours, ${fmtPct(w.repetitiveShare)} repetitive`).join("; ")}`}
              rows={bi.weekly.map((w) => ({ week: w.week, hours: w.hours, repetitiveHours: w.repetitiveHours, repetitiveShare: w.repetitiveShare }))}
              columns={[{ key: "week", label: "Week of" }, { key: "hours", label: "Active hours", align: "right", format: hrs }, { key: "repetitiveHours", label: "Repetitive hours", align: "right", format: hrs }, { key: "repetitiveShare", label: "Repetitive share", align: "right", format: pct }]}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={bi.weekly} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="week" {...axisProps} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis yAxisId="h" {...axisProps} width={44} tickFormatter={(v) => `${fmtNum(Number(v), 0)}h`} />
                  <YAxis yAxisId="s" orientation="right" {...axisProps} width={40} domain={[0, 1]} tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`} />
                  <RTooltip content={tip((p) => <ChartTip active={p.active} label={`Week of ${p.label}`} rows={(p.payload ?? []).map((x) => ({ name: x.dataKey === "hours" ? "Active hours" : "Repetitive share", value: x.dataKey === "hours" ? `${fmtNum(Number(x.value), 1)} hrs` : fmtPct(Number(x.value), 1), color: x.color }))} />)} />
                  <Line yAxisId="h" type="monotone" dataKey="hours" stroke={LABOR} strokeWidth={2.5} dot={{ r: 3, fill: LABOR }} isAnimationActive={false} />
                  <Line yAxisId="s" type="monotone" dataKey="repetitiveShare" stroke={ACCENT_HEX.gold} strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3, fill: ACCENT_HEX.gold }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </DataViewCard>
            <DataViewCard testid="chart-workload" title="Workload distribution" subtitle={`Observed hrs/week per employee · median ${fmtNum(bi.workload.p50, 1)} · p90 ${fmtNum(bi.workload.p90, 1)}`} filename="workload-distribution"
              help="Each employee's observed active hours divided by their own observed weeks (active days ÷ 5). Collectors only see computer activity, so this is not total working time."
              summary={`Workload histogram: ${histRows.map((h) => `${h.bucket} hours per week: ${h.employees} employees`).join(", ")}. Median ${fmtNum(bi.workload.p50, 1)}, 90th percentile ${fmtNum(bi.workload.p90, 1)}.`}
              rows={[...histRows.map((h) => ({ bucket: `${h.bucket} hrs/wk`, employees: h.employees })), { bucket: "p25 / p50 / p75 / p90", employees: `${fmtNum(bi.workload.p25, 1)} / ${fmtNum(bi.workload.p50, 1)} / ${fmtNum(bi.workload.p75, 1)} / ${fmtNum(bi.workload.p90, 1)}` }]}
              columns={[{ key: "bucket", label: "Observed hours per week" }, { key: "employees", label: "Employees", align: "right" }]}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={histRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="12%">
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="bucket" {...axisProps} />
                  <YAxis {...axisProps} width={32} allowDecimals={false} />
                  <RTooltip cursor={{ fill: C.surface2 }} content={tip((p) => <ChartTip active={p.active} label={`${p.label} hrs/wk`} rows={(p.payload ?? []).map((x) => ({ name: "Employees", value: String(x.value), color: LABOR }))} />)} />
                  <Bar dataKey="employees" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                    {histRows.map((h) => <Cell key={h.bucket} fill={h.from >= bi.workload.p90 && bi.workload.p90 > 0 ? ACCENT_HEX.coral : LABOR} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </DataViewCard>
          </div>
          <p className="mt-2 text-[11px] text-ink-3">Workload figures describe observed computer activity for capacity planning. They are not a performance rating; any staffing change needs management and HR/legal review.</p>
        </>
      )}

      <div className="mt-8 flex flex-wrap gap-2">
        <Link href="/app/process-mining" className="text-xs font-semibold text-royal-ink hover:underline" data-testid="biz-link-process">Open Process Mining →</Link>
        <Link href="/app/finance" className="text-xs font-semibold text-royal-ink hover:underline" data-testid="biz-link-finance">Open Financial Intelligence →</Link>
      </div>

      <DrillDrawer tree={tree} onClose={() => setDrill(null)} note={drill === "enteredOpex" || drill === "overhead" ? <>Overhead is entered per department in <Link className="font-semibold text-royal-ink underline" href="/app/settings/structure">Settings → Structure</Link>. Labor comes from the finance engine (loaded cost = base × (1 + benefits load)).</> : undefined} />
    </div>
  );
}
