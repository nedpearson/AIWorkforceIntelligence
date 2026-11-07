"use client";
/**
 * AI Opportunity Center visualizations: priority matrix (value vs effort), bubble chart (feasibility × realizable $,
 * size = hours, color = type) and department × type heatmap. Every chart has a text alternative and a keyboard path.
 * Categorical palette (validated, light + dark): purple, cyan, royal, gold, emerald — fixed order by type.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip as RTooltip, ReferenceLine, ReferenceArea, Cell } from "recharts";
import { axisProps, compactUSD } from "@/components/charts/theme";
import { ChartTip } from "@/components/charts";
import { ACCENT_HEX } from "@/components/ui/enterprise";
import { OPP_TYPE_LABEL } from "@/components/dashboard/opportunity-card";
import { cn, fmtUSD, fmtNum } from "@/lib/utils";
import type { CenterRow } from "./opportunity-center";

export const TYPE_ORDER = ["ai_agent", "rpa", "conventional_automation", "process_change", "role_consolidation"] as const;
export const TYPE_HEX: Record<string, string> = { ai_agent: ACCENT_HEX.purple, rpa: ACCENT_HEX.cyan, conventional_automation: ACCENT_HEX.royal, process_change: ACCENT_HEX.gold, role_consolidation: ACCENT_HEX.emerald };
export const QUAD = {
  quick_win: { label: "Quick wins", hex: ACCENT_HEX.emerald, help: "High value, low effort — do these first." },
  strategic: { label: "Strategic bets", hex: ACCENT_HEX.royal, help: "High value, high effort — plan and fund deliberately." },
  fill_in: { label: "Fill-ins", hex: ACCENT_HEX.gold, help: "Low value, low effort — batch them when capacity allows." },
  reconsider: { label: "Reconsider", hex: ACCENT_HEX.coral, help: "Low value, high effort — revisit the approach or skip." },
} as const;
type QuadKey = keyof typeof QUAD;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const grid = { stroke: "var(--color-border)" };

export function PriorityMatrix({ rows, splits }: { rows: CenterRow[]; splits: { value: number; effort: number } }) {
  const router = useRouter();
  const data = rows.map((r) => ({ ...r, x: r.effortScore, y: r.valueScore, z: 1 }));
  const byQuad = (q: QuadKey) => rows.filter((r) => r.quadrant === q);
  const summary = (Object.keys(QUAD) as QuadKey[]).map((q) => `${QUAD[q].label}: ${byQuad(q).length}`).join(", ");
  return (
    <div className="card p-5" data-testid="opp-matrix">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div><h3 className="text-sm font-semibold">Priority matrix</h3><p className="text-xs text-ink-2">Value (financial-impact factor) vs effort (100 − implementation-effort factor). Split lines at the organization median. Click a point to open its report.</p></div>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-2" aria-label="Legend">{(Object.keys(QUAD) as QuadKey[]).map((q) => <li key={q} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: QUAD[q].hex }} />{QUAD[q].label}</li>)}</ul>
      </div>
      <div className="h-[340px] w-full" role="img" aria-label={`Priority matrix of ${rows.length} opportunities. ${summary}.`}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 12, right: 16, bottom: 22, left: 0 }}>
            <CartesianGrid {...grid} />
            <ReferenceArea x1={0} x2={splits.effort} y1={splits.value} y2={100} fill={ACCENT_HEX.emerald} fillOpacity={0.06} label={{ value: "Quick wins", position: "insideTopLeft", fill: "var(--color-ink-2)", fontSize: 11 }} />
            <ReferenceArea x1={splits.effort} x2={100} y1={splits.value} y2={100} fill={ACCENT_HEX.royal} fillOpacity={0.05} label={{ value: "Strategic bets", position: "insideTopRight", fill: "var(--color-ink-2)", fontSize: 11 }} />
            <ReferenceArea x1={0} x2={splits.effort} y1={0} y2={splits.value} fill={ACCENT_HEX.gold} fillOpacity={0.05} label={{ value: "Fill-ins", position: "insideBottomLeft", fill: "var(--color-ink-2)", fontSize: 11 }} />
            <ReferenceArea x1={splits.effort} x2={100} y1={0} y2={splits.value} fill={ACCENT_HEX.coral} fillOpacity={0.05} label={{ value: "Reconsider", position: "insideBottomRight", fill: "var(--color-ink-2)", fontSize: 11 }} />
            <ReferenceLine x={splits.effort} stroke="var(--color-ink-3)" strokeDasharray="4 3" />
            <ReferenceLine y={splits.value} stroke="var(--color-ink-3)" strokeDasharray="4 3" />
            <XAxis type="number" dataKey="x" domain={[-4, 104]} ticks={[0, 25, 50, 75, 100]} {...axisProps} label={{ value: "Effort →", position: "insideBottom", offset: -12, fill: "var(--color-ink-2)", fontSize: 11 }} />
            <YAxis type="number" dataKey="y" domain={[-4, 104]} ticks={[0, 25, 50, 75, 100]} {...axisProps} width={36} label={{ value: "Value →", angle: -90, position: "insideLeft", offset: 12, fill: "var(--color-ink-2)", fontSize: 11 }} />
            <ZAxis type="number" dataKey="z" range={[180, 180]} />
            <RTooltip cursor={{ strokeDasharray: "3 3" }} content={((p: Any) => { const d = p.payload?.[0]?.payload as (CenterRow & { x: number; y: number }) | undefined; return <ChartTip active={p.active} label={d?.title} rows={d ? [{ name: "Quadrant", value: QUAD[d.quadrant as QuadKey].label, color: QUAD[d.quadrant as QuadKey].hex }, { name: "Realizable / yr", value: fmtUSD(d.realizableAnnualSavings) }, { name: "Value · effort", value: `${fmtNum(d.y, 0)} · ${fmtNum(d.x, 0)}` }, { name: "Score", value: `${Math.round(d.score ?? 0)}/100` }] : []} />; }) as Any} />
            <Scatter data={data} onClick={((p: Any) => { const id = p?.payload?.id ?? p?.id; if (id) router.push(`/app/opportunities/${id}`); }) as Any} cursor="pointer" isAnimationActive={false}>
              {data.map((d) => <Cell key={d.id} fill={QUAD[d.quadrant as QuadKey].hex} stroke="var(--color-surface)" strokeWidth={2} />)}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(QUAD) as QuadKey[]).map((q) => (
          <div key={q} className="rounded-xl border border-border p-3" data-testid={`opp-quadrant-${q}`}>
            <div className="flex items-center gap-2 text-xs font-bold"><span className="h-2.5 w-2.5 rounded-full" style={{ background: QUAD[q].hex }} />{QUAD[q].label}<span className="ml-auto rounded-full bg-surface-2 px-1.5 text-[10px] text-ink-2">{byQuad(q).length}</span></div>
            <p className="mt-0.5 text-[11px] text-ink-3">{QUAD[q].help}</p>
            <ul className="mt-2 space-y-1">{byQuad(q).slice(0, 5).map((r) => <li key={r.id}><Link href={`/app/opportunities/${r.id}`} className="flex justify-between gap-2 text-xs text-ink hover:text-royal-ink hover:underline"><span className="truncate">{r.title}</span><span className="tabular text-gold-ink">{fmtUSD(r.realizableAnnualSavings, { compact: true })}</span></Link></li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OpportunityBubbles({ rows }: { rows: CenterRow[] }) {
  const router = useRouter();
  const types = TYPE_ORDER.filter((t) => rows.some((r) => r.type === t));
  return (
    <div className="card p-5" data-testid="opp-bubbles">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div><h3 className="text-sm font-semibold">Feasibility vs value</h3><p className="text-xs text-ink-2">x = automation feasibility, y = realizable savings per year, bubble size = hours recoverable per week, color = type.</p></div>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-2" aria-label="Legend">{types.map((t) => <li key={t} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: TYPE_HEX[t] }} />{OPP_TYPE_LABEL[t]}</li>)}</ul>
      </div>
      <div className="h-[340px] w-full" role="img" aria-label={`Bubble chart of ${rows.length} opportunities by feasibility and realizable savings.`}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 12, right: 16, bottom: 22, left: 4 }}>
            <CartesianGrid {...grid} />
            <XAxis type="number" dataKey="feasibility" domain={[0, 100]} {...axisProps} label={{ value: "Feasibility →", position: "insideBottom", offset: -12, fill: "var(--color-ink-2)", fontSize: 11 }} />
            <YAxis type="number" dataKey="realizableAnnualSavings" domain={[0, (max: number) => Math.ceil(max * 1.15)]} {...axisProps} tickFormatter={compactUSD} width={56} />
            <ZAxis type="number" dataKey="hoursRecoverablePerWeek" range={[60, 900]} />
            <RTooltip content={((p: Any) => { const d = p.payload?.[0]?.payload as CenterRow | undefined; return <ChartTip active={p.active} label={d?.title} rows={d ? [{ name: OPP_TYPE_LABEL[d.type] ?? d.type, value: "", color: TYPE_HEX[d.type] }, { name: "Realizable / yr", value: fmtUSD(d.realizableAnnualSavings) }, { name: "Feasibility", value: `${Math.round(d.feasibility)}/100` }, { name: "Hours / wk", value: fmtNum(d.hoursRecoverablePerWeek, 1) }] : []} />; }) as Any} />
            {types.map((t) => <Scatter key={t} name={OPP_TYPE_LABEL[t]} data={rows.filter((r) => r.type === t)} fill={TYPE_HEX[t]} fillOpacity={0.75} stroke="var(--color-surface)" strokeWidth={2} cursor="pointer" isAnimationActive={false} onClick={((p: Any) => { const id = p?.payload?.id ?? p?.id; if (id) router.push(`/app/opportunities/${id}`); }) as Any} />)}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <DataTable rows={rows} />
    </div>
  );
}

/** Text alternative / keyboard path for the charts. */
function DataTable({ rows }: { rows: CenterRow[] }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer font-semibold text-royal-ink">Show as table</summary>
      <div className="mt-2 overflow-x-auto scrollbar-thin"><table className="w-full"><thead><tr className="text-left text-ink-2"><th className="py-1 pr-3">Opportunity</th><th className="py-1 pr-3 text-right">Feasibility</th><th className="py-1 pr-3 text-right">Realizable / yr</th><th className="py-1 text-right">Hrs / wk</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id} className="border-t border-border"><td className="py-1 pr-3"><Link className="text-royal-ink hover:underline" href={`/app/opportunities/${r.id}`}>{r.title}</Link></td><td className="py-1 pr-3 text-right tabular">{Math.round(r.feasibility)}</td><td className="py-1 pr-3 text-right tabular">{fmtUSD(r.realizableAnnualSavings)}</td><td className="py-1 text-right tabular">{fmtNum(r.hoursRecoverablePerWeek, 1)}</td></tr>)}</tbody></table></div>
    </details>
  );
}

export function OpportunityHeatmap({ rows, departments }: { rows: CenterRow[]; departments: { id: string; name: string }[] }) {
  const types = TYPE_ORDER.filter((t) => rows.some((r) => r.type === t));
  const cell = (dept: string, type: string) => rows.filter((r) => (r.departmentId ?? "") === dept && r.type === type && r.inScope);
  const max = Math.max(1, ...departments.flatMap((d) => types.map((t) => cell(d.id, t).reduce((s, r) => s + r.realizableAnnualSavings, 0))));
  return (
    <div className="card p-5" data-testid="opp-heatmap">
      <h3 className="text-sm font-semibold">Where the money is</h3>
      <p className="mb-3 text-xs text-ink-2">Realizable savings per year by department and opportunity type. Darker = more value. Select a cell to filter the list.</p>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[520px] table-fixed border-separate border-spacing-1 text-xs" aria-label="Heatmap of realizable savings by department and type">
          <thead><tr><th className="w-36 text-left font-semibold text-ink-2">Department</th>{types.map((t) => <th key={t} className="px-1 text-center font-semibold text-ink-2">{OPP_TYPE_LABEL[t]}</th>)}<th className="text-right font-semibold text-ink-2">Total</th></tr></thead>
          <tbody>
            {departments.map((d) => {
              const tot = types.reduce((s, t) => s + cell(d.id, t).reduce((a, r) => a + r.realizableAnnualSavings, 0), 0);
              return (
                <tr key={d.id || "none"}>
                  <th scope="row" className="whitespace-nowrap pr-2 text-left font-medium text-ink">{d.name}</th>
                  {types.map((t) => {
                    const items = cell(d.id, t); const v = items.reduce((s, r) => s + r.realizableAnnualSavings, 0); const k = v / max;
                    return (
                      <td key={t} className="p-0">
                        {items.length ? (
                          <Link href={`?${new URLSearchParams({ ...(d.id ? { dept: d.id } : {}), type: t }).toString()}`} scroll={false} data-testid={`heat-${d.id || "none"}-${t}`} aria-label={`${d.name}, ${OPP_TYPE_LABEL[t]}: ${fmtUSD(v)} per year across ${items.length} opportunities`}
                            className={cn("block rounded-lg px-2 py-2.5 text-center font-semibold tabular ring-1 ring-inset ring-border transition hover:ring-2 hover:ring-royal", k > 0.55 ? "text-white" : "text-ink")}
                            style={{ background: `color-mix(in oklab, ${ACCENT_HEX.gold} ${Math.round(12 + k * 78)}%, ${k > 0.55 ? "#7c2d12" : "var(--color-surface)"})` }}>
                            {fmtUSD(v, { compact: true })}<span className="block text-[10px] font-normal opacity-80">{items.length} opp{items.length === 1 ? "" : "s"}</span>
                          </Link>
                        ) : <div className="rounded-lg bg-surface-2/60 px-2 py-2.5 text-center text-ink-3">—</div>}
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap pl-2 text-right font-semibold tabular text-gold-ink">{fmtUSD(tot, { compact: true })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
