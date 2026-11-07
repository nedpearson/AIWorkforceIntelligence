"use client";
import * as React from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Cell, LabelList, ReferenceLine, ComposedChart, Line } from "recharts";
import { ChartTip } from "@/components/charts";
import { axisProps, gridProps, compactUSD, C } from "@/components/charts/theme";
import { ACCENT_HEX, type Accent } from "@/components/ui/enterprise";
import { fmtUSD } from "@/lib/utils";

// Recharts' tooltip content generic is stricter than our plain tip; narrow once.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tip = (fn: (p: { active?: boolean; label?: string | number; payload?: { name?: string; value?: number | string; color?: string; dataKey?: string | number; payload?: Record<string, unknown> }[] }) => React.ReactElement | null) => fn as unknown as any;

export type LadderRow = { key: string; name: string; short: string; value: number; color: Accent; basis: string };

/** Savings ladder: every tier side by side, from estimated potential down to money actually kept. Tiers are never stacked or summed. */
export function SavingsLadder({ rows, onSelect }: { rows: LadderRow[]; onSelect?: (key: string) => void }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 20, right: 8, left: 0, bottom: 4 }} barCategoryGap="22%">
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="short" {...axisProps} interval={0} tick={{ fill: C.ink2, fontSize: 10 }} angle={-30} textAnchor="end" height={46} />
        <YAxis {...axisProps} tickFormatter={compactUSD} width={54} />
        <ReferenceLine y={0} stroke={C.ink3} />
        <RTooltip cursor={{ fill: C.surface2 }} content={tip((p) => { const d = p.payload?.[0]?.payload as LadderRow | undefined; return <ChartTip active={p.active} label={d?.name} rows={d ? [{ name: `Annual (${d.basis})`, value: fmtUSD(d.value), color: ACCENT_HEX[d.color] }] : []} />; })} />
        <Bar dataKey="value" radius={[5, 5, 0, 0]} maxBarSize={54} isAnimationActive={false} onClick={(d: unknown) => { const k = (d as { payload?: LadderRow })?.payload?.key; if (k && onSelect) onSelect(k); }} style={{ cursor: onSelect ? "pointer" : undefined }}>
          {rows.map((r) => <Cell key={r.key} fill={ACCENT_HEX[r.color]} />)}
          <LabelList dataKey="value" position="top" formatter={(v: unknown) => compactUSD(Number(v))} style={{ fill: C.ink2, fontSize: 10 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export type TimelineRow = { month: string; label: string; projected: number; verified: number; ledgerHard: number; ledgerApproved: number };
const SERIES: { key: keyof TimelineRow; name: string; color: string }[] = [
  { key: "projected", name: "Projected run-rate (potential ÷ 12)", color: ACCENT_HEX.gold },
  { key: "verified", name: "Verified time savings (measured)", color: ACCENT_HEX.cyan },
  { key: "ledgerApproved", name: "Approved business cases (÷ 12)", color: ACCENT_HEX.indigo },
  { key: "ledgerHard", name: "Realized hard + cost avoidance (÷ 12)", color: ACCENT_HEX.emerald },
];
export const TIMELINE_LEGEND = SERIES.map((s) => ({ label: s.name, color: s.color, dashed: s.key === "projected" }));

/** Monthly realized vs projected. Projected is a dashed line (estimate); measured and ledger series are solid. */
export function RealizedTimeline({ rows }: { rows: TimelineRow[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="label" {...axisProps} minTickGap={12} />
        <YAxis {...axisProps} tickFormatter={compactUSD} width={54} />
        <RTooltip content={tip((p) => <ChartTip active={p.active} label={p.label} rows={(p.payload ?? []).map((x) => ({ name: SERIES.find((s) => s.key === x.dataKey)?.name ?? String(x.dataKey), value: fmtUSD(Number(x.value)), color: SERIES.find((s) => s.key === x.dataKey)?.color }))} />)} />
        <Bar dataKey="verified" fill={ACCENT_HEX.cyan} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
        <Line type="monotone" dataKey="projected" stroke={ACCENT_HEX.gold} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        <Line type="stepAfter" dataKey="ledgerApproved" stroke={ACCENT_HEX.indigo} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line type="stepAfter" dataKey="ledgerHard" stroke={ACCENT_HEX.emerald} strokeWidth={2.5} dot={{ r: 2.5, fill: ACCENT_HEX.emerald }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
