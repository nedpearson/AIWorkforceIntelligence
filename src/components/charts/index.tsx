"use client";
/**
 * Shared Recharts wrappers. Each exports a small, responsive chart with plain-English tooltips.
 * Colors come from CSS tokens (see ./theme.ts): projected = purple, verified = teal.
 */
import * as React from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Cell, LineChart, Line, PieChart, Pie, LabelList, ReferenceLine, AreaChart, Area,
} from "recharts";
import { C, axisProps, gridProps, compactUSD, compactNum } from "./theme";
import { ChartTip } from "./chart-frame";
import { fmtUSD, fmtNum } from "@/lib/utils";

export { ChartFrame, ChartTip } from "./chart-frame";
export { C as chartColors } from "./theme";

type TipProps = { active?: boolean; label?: string | number; payload?: { name?: string; value?: number | string; color?: string; fill?: string; dataKey?: string | number; payload?: Record<string, unknown> }[] };
// Recharts' ContentType generic is stricter than our plain-English tip needs; narrow once here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tip = (fn: (p: TipProps) => React.ReactElement | null) => fn as unknown as any;

/* ---------------------------------------------------------------- savings waterfall: gross → realizable → net */
export function SavingsWaterfall({ gross, realizable, net }: { gross: number; realizable: number; net: number }) {
  const data = [
    { key: "gross", name: "Gross", value: gross, fill: C.ink3, note: "Value of all hours that could be recovered" },
    { key: "realizable", name: "Realizable", value: realizable, fill: C.projected, note: "Share that becomes real money (realization rate)" },
    { key: "net", name: "Net", value: Math.max(0, net), fill: C.money, note: "After operating and platform costs" },
  ];
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 18, right: 8, left: 0, bottom: 0 }} barCategoryGap="30%">
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="name" {...axisProps} />
        <YAxis {...axisProps} tickFormatter={compactUSD} width={52} />
        <RTooltip cursor={{ fill: C.surface2 }} content={tip((p) => { const d = p.payload?.[0]?.payload as { name: string; value: number; note: string } | undefined; return <ChartTip active={p.active} label={d?.name} rows={d ? [{ name: d.note, value: fmtUSD(d.value) }] : []} />; })} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.key} fill={d.fill} />)}
          <LabelList dataKey="value" position="top" formatter={(v: unknown) => compactUSD(Number(v))} style={{ fill: C.ink2, fontSize: 11 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ---------------------------------------------------------------- department comparison: repetitive vs recoverable hours */
export function DepartmentHoursBars({ rows }: { rows: { name: string; repetitive: number; recoverable: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 36, left: 4, bottom: 0 }} barCategoryGap="28%" barGap={2}>
        <CartesianGrid {...gridProps} horizontal={false} vertical />
        <XAxis type="number" {...axisProps} tickFormatter={(v) => `${compactNum(v)}h`} />
        <YAxis type="category" dataKey="name" {...axisProps} width={90} />
        <RTooltip cursor={{ fill: C.surface2 }} content={tip((p) => <ChartTip active={p.active} label={p.label} rows={(p.payload ?? []).map((x) => ({ name: x.dataKey === "repetitive" ? "Repetitive hours per week" : "Hours software could take over", value: `${fmtNum(Number(x.value), 1)} hrs/wk`, color: x.fill }))} />)} />
        <Bar dataKey="repetitive" name="Repetitive" fill={C.ink3} radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false} />
        <Bar dataKey="recoverable" name="Recoverable" fill={C.projected} radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false}>
          <LabelList dataKey="recoverable" position="right" formatter={(v: unknown) => `${fmtNum(Number(v), 0)}h`} style={{ fill: C.ink2, fontSize: 10 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ---------------------------------------------------------------- 3-year projection: cumulative net per scenario */
export function ThreeYearLines({ scenarios }: { scenarios: { key: string; label: string; years: { year: number; cumulative: number }[] }[] }) {
  const data = [0, 1, 2, 3].map((y) => { const row: Record<string, number | string> = { year: y === 0 ? "Start" : `Year ${y}` }; for (const s of scenarios) row[s.key] = y === 0 ? 0 : (s.years.find((r) => r.year === y)?.cumulative ?? 0); return row; });
  const color: Record<string, string> = { conservative: C.ink3, expected: C.projected, aggressive: C.brand2 };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="year" {...axisProps} />
        <YAxis {...axisProps} tickFormatter={compactUSD} width={56} />
        <ReferenceLine y={0} stroke={C.ink3} />
        <RTooltip content={tip((p) => <ChartTip active={p.active} label={p.label} rows={(p.payload ?? []).map((x) => ({ name: `${scenarios.find((s) => s.key === x.dataKey)?.label ?? x.dataKey} (cumulative net)`, value: fmtUSD(Number(x.value)), color: x.color }))} />)} />
        {scenarios.map((s) => <Line key={s.key} type="monotone" dataKey={s.key} stroke={color[s.key] ?? C.brand} strokeWidth={s.key === "expected" ? 2.5 : 2} strokeDasharray={s.key === "expected" ? undefined : "4 3"} dot={{ r: 4, fill: color[s.key] ?? C.brand, stroke: C.surface, strokeWidth: 2 }} activeDot={{ r: 5 }} isAnimationActive={false} />)}
      </LineChart>
    </ResponsiveContainer>
  );
}

/* ---------------------------------------------------------------- before/after hours per department */
export function BeforeAfterBars({ rows }: { rows: { name: string; before: number; after: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 16, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%" barGap={2}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="name" {...axisProps} interval={0} tickFormatter={(v: string) => (v.length > 9 ? v.slice(0, 8) + "…" : v)} />
        <YAxis {...axisProps} tickFormatter={(v) => `${compactNum(v)}h`} width={44} />
        <RTooltip cursor={{ fill: C.surface2 }} content={tip((p) => <ChartTip active={p.active} label={p.label} rows={(p.payload ?? []).map((x) => ({ name: x.dataKey === "before" ? "Hours per week today (observed)" : "Hours per week after automation (projected)", value: `${fmtNum(Number(x.value), 1)} hrs/wk`, color: x.fill }))} />)} />
        <Bar dataKey="before" name="Today" fill={C.ink3} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
        <Bar dataKey="after" name="After" fill={C.projected} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ---------------------------------------------------------------- donut: time by app category */
const DONUT_ORDER = [C.brand, C.projected, C.verified, C.warn, C.info, C.money, C.danger, C.ink3];
export function CategoryDonut({ rows }: { rows: { name: string; hours: number }[] }) {
  const sorted = [...rows].sort((a, b) => b.hours - a.hours);
  const top = sorted.slice(0, 7); const rest = sorted.slice(7).reduce((s, r) => s + r.hours, 0);
  const data = rest > 0 ? [...top, { name: "Other", hours: rest }] : top;
  const total = data.reduce((s, r) => s + r.hours, 0) || 1;
  return (
    <div className="flex h-full items-center gap-4">
      <div className="h-full w-1/2 min-w-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="hours" nameKey="name" innerRadius="55%" outerRadius="90%" paddingAngle={2} stroke={C.surface} strokeWidth={2} isAnimationActive={false}>
              {data.map((_, i) => <Cell key={i} fill={DONUT_ORDER[i % DONUT_ORDER.length]} />)}
            </Pie>
            <RTooltip content={tip((p) => { const d = p.payload?.[0]; return <ChartTip active={p.active} rows={d ? [{ name: String(d.name), value: `${fmtNum(Number(d.value), 1)} hrs (${Math.round((Number(d.value) / total) * 100)}%)`, color: d.payload?.fill as string }] : []} />; })} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex-1 space-y-1 text-xs" aria-label="Legend">
        {data.map((d, i) => <li key={d.name} className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-ink-2"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: DONUT_ORDER[i % DONUT_ORDER.length] }} />{d.name}</span><span className="tabular text-ink">{Math.round((d.hours / total) * 100)}%</span></li>)}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------- sparkline: hours per day */
export function HoursSparkline({ rows, color = C.brand }: { rows: { day: string; hours: number }[]; color?: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={rows} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <XAxis dataKey="day" {...axisProps} tickFormatter={(v: string) => v.slice(5)} minTickGap={24} />
        <YAxis {...axisProps} width={36} tickFormatter={(v) => `${fmtNum(Number(v), 1)}h`} />
        <RTooltip content={tip((p) => <ChartTip active={p.active} label={p.label} rows={(p.payload ?? []).map((x) => ({ name: "Active hours", value: `${fmtNum(Number(x.value), 1)} hrs`, color }))} />)} />
        <Area type="monotone" dataKey="hours" stroke={color} strokeWidth={2} fill={color} fillOpacity={0.1} dot={false} activeDot={{ r: 4, stroke: C.surface, strokeWidth: 2 }} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ---------------------------------------------------------------- simple horizontal bars (generic, one series) */
export function SimpleBars({ rows, unit = "hours", color = C.projected }: { rows: { name: string; value: number }[]; unit?: "hours" | "usd"; color?: string }) {
  const f = (v: number) => (unit === "usd" ? compactUSD(v) : `${fmtNum(v, 1)}h`);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 40, left: 4, bottom: 0 }} barCategoryGap="30%">
        <XAxis type="number" {...axisProps} tickFormatter={(v) => f(Number(v))} />
        <YAxis type="category" dataKey="name" {...axisProps} width={110} tickFormatter={(v: string) => (v.length > 16 ? v.slice(0, 15) + "…" : v)} />
        <RTooltip cursor={{ fill: C.surface2 }} content={tip((p) => <ChartTip active={p.active} label={p.label} rows={(p.payload ?? []).map((x) => ({ name: unit === "usd" ? "Amount" : "Hours per week", value: unit === "usd" ? fmtUSD(Number(x.value)) : `${fmtNum(Number(x.value), 1)} hrs/wk`, color }))} />)} />
        <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]} maxBarSize={16} isAnimationActive={false}>
          <LabelList dataKey="value" position="right" formatter={(v: unknown) => f(Number(v))} style={{ fill: C.ink2, fontSize: 10 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
