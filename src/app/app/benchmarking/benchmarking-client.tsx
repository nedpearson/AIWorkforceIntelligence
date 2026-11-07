"use client";
import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Scale, Plus, Trash2, ExternalLink, BookOpen } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Cell, ReferenceLine, LabelList, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, LineChart, Line } from "recharts";
import { Button, Card, Empty, Input, Modal, PageHeader, Select, Table, Td, Th, Textarea, Tooltip } from "@/components/ui";
import { ExportButton, SectionHeader, Segmented, ACCENT_HEX } from "@/components/ui/enterprise";
import { ChartFrame, ChartTip } from "@/components/charts";
import { axisProps, gridProps, C } from "@/components/charts/theme";
import type { Benchmarks, EntityType } from "@/engine/benchmark";
import { METRICS, type MetricKey, type MetricDef } from "@/engine/benchmark.types";
import { fmtNum, fmtUSD, cn } from "@/lib/utils";
import { addBenchmarkDataset, deleteBenchmarkDataset } from "./actions";
import { useTimeZone } from "@/components/time-zone";
import { formatDate } from "@/lib/datetime";

export type DatasetRow = { id: string; name: string; source: string; sourceUrl: string | null; publishedAt: string | null; sampleDescription: string; applicability: string | null; metrics: { key: string; label: string; value: number; unit: string }[]; createdAt: string };
const TYPE_LABEL: Record<EntityType, string> = { department: "Departments", location: "Locations", business_unit: "Business units", client: "Client portfolio" };
const RADAR_LABEL: Record<MetricKey, string> = { laborPerEmployee: "Labor $/emp", repetitiveShare: "Repetitive %", recoverableHrsPerFte: "Recov. h/FTE", automationScoreAvg: "Automation", reworkRate: "Rework", handoffsPerRun: "Hand-offs", realizablePerFte: "Realiz. $/FTE", verifiedPerFte: "Verified $/FTE" };
const PALETTE = [ACCENT_HEX.royal, ACCENT_HEX.purple, ACCENT_HEX.cyan, ACCENT_HEX.gold];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tip = (fn: (p: { active?: boolean; label?: string | number; payload?: { value?: number | string; dataKey?: string | number; color?: string; payload?: Record<string, unknown> }[] }) => React.ReactElement | null) => fn as unknown as any;

export function fmtMetric(m: Pick<MetricDef, "unit">, v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return m.unit === "usd" ? fmtUSD(v) : m.unit === "pct" ? `${(v * 100).toFixed(1)}%` : m.unit === "hours" ? `${fmtNum(v, 2)} h` : fmtNum(v, m.unit === "count" ? 2 : 1);
}
const Q_CLS = ["", "bg-emerald-soft text-emerald-ink", "bg-cyan-soft text-cyan-ink", "bg-gold-soft text-gold-ink", "bg-coral-soft text-coral-ink"];
function QChip({ q, better }: { q: 1 | 2 | 3 | 4 | null; better: MetricDef["better"] }) {
  if (q == null) return null;
  // Colour by desirability: for "lower is better" metrics the top-value quartile is the worst.
  const good = better === "neutral" ? null : better === "higher" ? q : ((5 - q) as 1 | 2 | 3 | 4);
  return <span className={cn("ml-1.5 rounded px-1 text-[10px] font-semibold", good ? Q_CLS[good] : "bg-surface-2 text-ink-2")} title={`Quartile ${q} by value (Q1 = highest 25%)${better === "neutral" ? "" : `; ${better} is better`}`}>Q{q}</span>;
}

function DatasetForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const blank = { name: "", source: "", sourceUrl: "", publishedAt: "", sampleDescription: "", applicability: "" };
  const [f, setF] = React.useState(blank); const [vals, setVals] = React.useState<Partial<Record<MetricKey, string>>>({});
  const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setF(blank); setVals({}); setErr(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const metrics = Object.entries(vals).filter(([, v]) => v !== "" && v != null).map(([key, v]) => { const def = METRICS.find((m) => m.key === key)!; const n = Number(v); return { key, value: def.unit === "pct" ? n / 100 : n }; });
    if (!metrics.length) { setErr("Enter at least one metric value."); return; }
    setBusy(true);
    try { const r = await addBenchmarkDataset({ ...f, metrics }); if (!r.ok) setErr(r.error); else { onClose(); router.refresh(); } } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add an external benchmark dataset" wide>
      <form onSubmit={submit} className="space-y-3" data-testid="bench-form">
        <p className="rounded-lg bg-gold-soft px-3 py-2 text-xs text-gold-ink">Only enter figures from a published, citable source. Every field below is shown next to the benchmark wherever it is used. Never estimate or invent a benchmark.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Dataset name" value={f.name} onChange={set("name")} required minLength={3} data-testid="bench-name" />
          <Input label="Source (publisher)" value={f.source} onChange={set("source")} required data-testid="bench-source" />
          <Input label="Source URL" type="url" value={f.sourceUrl} onChange={set("sourceUrl")} required placeholder="https://" data-testid="bench-url" />
          <Input label="Published date" type="date" value={f.publishedAt} onChange={set("publishedAt")} required data-testid="bench-published" />
        </div>
        <Textarea label="Sample description (who, how many, when)" rows={2} value={f.sampleDescription} onChange={set("sampleDescription")} required minLength={10} data-testid="bench-sample" />
        <Textarea label="Applicability (industry, company size, region)" rows={2} value={f.applicability} onChange={set("applicability")} required minLength={5} data-testid="bench-applicability" />
        <fieldset className="rounded-xl border border-border p-3"><legend className="px-1 text-xs font-semibold text-ink-2">Metric values (fill only those the source reports)</legend>
          <div className="grid gap-2 sm:grid-cols-2">{METRICS.map((m) => <Input key={m.key} label={`${m.label} ${m.unit === "usd" ? "($)" : m.unit === "pct" ? "(%)" : m.unit === "hours" ? "(hrs)" : ""}`} type="number" step="any" value={vals[m.key] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [m.key]: e.target.value }))} data-testid={`bench-metric-${m.key}`} />)}</div>
        </fieldset>
        {err && <p role="alert" className="rounded-lg bg-coral-soft px-3 py-2 text-xs font-medium text-coral-ink" data-testid="bench-error">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} data-testid="bench-submit">Add dataset</Button></div>
      </form>
    </Modal>
  );
}

export function BenchmarkingClient({ bm, datasets, initialType, canManage }: { bm: Benchmarks; datasets: DatasetRow[]; initialType: EntityType; canManage: boolean }) {
  const tz = useTimeZone();
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams();
  const types = (Object.keys(bm.sets) as EntityType[]).filter((k) => (bm.sets[k]?.entities.length ?? 0) > 0);
  const [type, setTypeState] = React.useState<EntityType>(initialType);
  const setType = (t: EntityType) => { setTypeState(t); const q = new URLSearchParams(sp.toString()); q.set("type", t); router.replace(`${pathname}?${q}`, { scroll: false }); };
  const [metric, setMetric] = React.useState<MetricKey>("realizablePerFte");
  const set = bm.sets[type];
  const entities = set?.entities ?? [];
  const [picked, setPicked] = React.useState<string[]>([]);
  React.useEffect(() => { setPicked(entities.slice(0, 3).map((e) => e.id)); }, [type]); // eslint-disable-line react-hooks/exhaustive-deps
  const [formOpen, setFormOpen] = React.useState(false);
  const mdef = METRICS.find((m) => m.key === metric)!;
  const ranked = entities.filter((e) => e.values[metric] != null).map((e) => ({ id: e.id, name: e.name, value: e.values[metric] as number })).sort((a, b) => b.value - a.value);
  const med = set?.stats[metric].median ?? null;
  const radarData = METRICS.map((m) => { const row: Record<string, string | number | null> = { metric: RADAR_LABEL[m.key] }; for (const id of picked) { const n = set?.stats[m.key].normalized[id]; row[id] = n == null ? 0 : Math.min(200, n * 100); } return row; });
  const exportRows = entities.map((e) => ({ entity: e.name, type: TYPE_LABEL[e.type], employees: e.employees, ...Object.fromEntries(METRICS.flatMap((m) => [[m.label, e.values[m.key] ?? ""], [`${m.label} vs median`, set?.stats[m.key].normalized[e.id] ?? ""], [`${m.label} quartile`, set?.stats[m.key].quartile[e.id] ?? ""]])) }));
  const external = datasets.flatMap((d) => d.metrics.filter((m) => m.key === metric).map((m) => ({ d, m })));
  const fmtAxis = (v: number) => (mdef.unit === "usd" ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(v) : mdef.unit === "pct" ? `${Math.round(v * 100)}%` : fmtNum(v, 1));

  return (
    <div className="min-w-0 space-y-2 [contain:inline-size]" data-testid="benchmarking-page">
      <PageHeader hero eyebrow="Intelligence · Business Benchmarking" icon={<Scale size={22} />} title="How each part of the business compares"
        subtitle="Internal benchmarks computed from your own observed data, normalized to the median and ranked into quartiles. External benchmarks appear only when you add a cited, published dataset."
        actions={<ExportButton rows={exportRows} filename={`benchmarks-${type}`} testid="bench-export" />} />

      {!types.length ? <Empty title="Nothing to compare yet" body="Benchmarks need at least one department with analyzed employees. Import your structure and run an observation campaign and the analysis." action={<Button href="/app/onboarding">Open the rollout checklist</Button>} /> : (<>
        <div className="flex flex-wrap items-end gap-3">
          <Segmented testid="bench-type" value={type} onChange={(t) => setType(t)} options={types.map((t) => ({ key: t, label: `${TYPE_LABEL[t]} (${bm.sets[t]!.entities.length})` }))} />
          <div className="w-60"><Select label="Metric" value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)} data-testid="bench-metric">{METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</Select></div>
        </div>
        {entities.length < 2 && <p className="rounded-lg bg-gold-soft px-3 py-2 text-xs text-gold-ink">Only one {TYPE_LABEL[type].toLowerCase().replace(/s$/, "")} has data — quartiles need at least two to compare.</p>}

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartFrame testid="bench-ranked" title={`Ranked: ${mdef.label}`} subtitle={`${mdef.formula}. Dashed line = median${med != null ? ` (${fmtMetric(mdef, med)})` : ""}.`} help={mdef.better === "neutral" ? "Neither higher nor lower is inherently better." : `${mdef.better === "higher" ? "Higher" : "Lower"} is better.`} height={Math.max(180, ranked.length * 34 + 40)}>
            <div className="h-full" role="img" aria-label={`${mdef.label} by ${TYPE_LABEL[type]}: ${ranked.map((r) => `${r.name} ${fmtMetric(mdef, r.value)}`).join("; ")}`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ranked} layout="vertical" margin={{ top: 4, right: 56, left: 4, bottom: 0 }} barCategoryGap="28%">
                  <CartesianGrid {...gridProps} horizontal={false} vertical />
                  <XAxis type="number" {...axisProps} tickFormatter={fmtAxis} />
                  <YAxis type="category" dataKey="name" {...axisProps} width={110} tickFormatter={(v: string) => (v.length > 15 ? v.slice(0, 14) + "…" : v)} />
                  {med != null && <ReferenceLine x={med} stroke={C.ink3} strokeDasharray="4 3" />}
                  {external.map(({ d, m }) => <ReferenceLine key={d.id} x={m.value} stroke={ACCENT_HEX.indigo} strokeWidth={2} label={{ value: d.source.slice(0, 14), fill: ACCENT_HEX.indigo, fontSize: 10, position: "top" }} />)}
                  <RTooltip cursor={{ fill: C.surface2 }} content={tip((p) => <ChartTip active={p.active} label={p.label} rows={(p.payload ?? []).map((x) => ({ name: mdef.label, value: fmtMetric(mdef, Number(x.value)), color: ACCENT_HEX.royal }))} />)} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false}>
                    {ranked.map((r) => <Cell key={r.id} fill={picked.includes(r.id) ? ACCENT_HEX.royal : ACCENT_HEX.cyan} />)}
                    <LabelList dataKey="value" position="right" formatter={(v: unknown) => fmtMetric(mdef, Number(v))} style={{ fill: C.ink2, fontSize: 10 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartFrame>
          <ChartFrame testid="bench-radar" title="Profile vs median" subtitle="Each axis: value ÷ median × 100 (100 = median, capped at 200). Pick up to 4 below." legend={picked.map((id, i) => ({ label: entities.find((e) => e.id === id)?.name ?? id, color: PALETTE[i % 4] }))} height={300}>
            <div className="h-full" role="img" aria-label={`Radar comparing ${picked.map((id) => entities.find((e) => e.id === id)?.name).join(", ")} against the median on ${METRICS.length} metrics`}>
              {picked.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radarData} outerRadius="62%" margin={{ top: 8, right: 28, left: 28, bottom: 8 }}>
                    <PolarGrid stroke={C.border} />
                    <PolarAngleAxis dataKey="metric" tick={{ fill: C.ink2, fontSize: 9 }} />
                    <PolarRadiusAxis domain={[0, 200]} tick={false} axisLine={false} />
                    {picked.map((id, i) => <Radar key={id} dataKey={id} stroke={PALETTE[i % 4]} fill={PALETTE[i % 4]} fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />)}
                  </RadarChart>
                </ResponsiveContainer>
              ) : <p className="pt-16 text-center text-sm text-ink-3">Select entities in the table to compare.</p>}
            </div>
          </ChartFrame>
        </div>

        <SectionHeader accent="royal" title="Comparison table" subtitle="Value · ratio to median · quartile (Q1 = highest 25%; chip colour shows whether that is good). Tick rows to add them to the radar." />
        <Table>
          <thead><tr><Th aria-label="Compare" /><Th>{TYPE_LABEL[type].replace(/s$/, "")}</Th><Th className="text-right">People</Th>{METRICS.map((m) => <Th key={m.key} className="text-right"><span title={`${m.formula}${m.better === "neutral" ? "" : ` · ${m.better} is better`}`}>{m.label}</span></Th>)}</tr></thead>
          <tbody>
            {entities.map((e) => (
              <tr key={e.id} className={cn(picked.includes(e.id) && "bg-royal-soft/30")} data-testid={`bench-row-${e.id}`}>
                <Td><input type="checkbox" aria-label={`Compare ${e.name}`} checked={picked.includes(e.id)} onChange={(ev) => setPicked((p) => ev.target.checked ? [...p, e.id].slice(-4) : p.filter((x) => x !== e.id))} data-testid={`bench-pick-${e.id}`} className="h-4 w-4 accent-[var(--color-royal)]" /></Td>
                <Td className="whitespace-nowrap font-semibold">{e.name}</Td>
                <Td className="text-right tabular">{e.employees}</Td>
                {METRICS.map((m) => { const n = set!.stats[m.key].normalized[e.id]; return (
                  <Td key={m.key} className="whitespace-nowrap text-right tabular">{fmtMetric(m, e.values[m.key])}<QChip q={set!.stats[m.key].quartile[e.id]} better={m.better} />{n != null && <div className="text-[10px] text-ink-3">{n.toFixed(2)}× median</div>}</Td>
                ); })}
              </tr>
            ))}
            <tr className="bg-surface-2/60"><Td /><Td className="font-semibold">Median</Td><Td />{METRICS.map((m) => <Td key={m.key} className="text-right tabular font-semibold">{fmtMetric(m, set!.stats[m.key].median)}</Td>)}</tr>
            <tr><Td /><Td className="font-semibold">Whole organization</Td><Td />{METRICS.map((m) => <Td key={m.key} className="text-right tabular text-ink-2">{fmtMetric(m, bm.orgValues[m.key])}</Td>)}</tr>
          </tbody>
        </Table>
      </>)}

      {bm.snapshots.length > 0 && (<>
        <SectionHeader accent="indigo" title="Over time (evaluation snapshots)" subtitle="Your own progress is the most reliable benchmark." />
        <ChartFrame testid="bench-over-time" title="Transformation score by snapshot" legend={[{ label: "Score", color: ACCENT_HEX.indigo }]} height={200}>
          <div className="h-full" role="img" aria-label={`Score by snapshot: ${bm.snapshots.map((s) => `${s.name} ${s.score == null ? "n/a" : Math.round(s.score)}`).join("; ")}`}>
            <ResponsiveContainer width="100%" height="100%"><LineChart data={bm.snapshots.map((s) => ({ ...s, label: formatDate(s.at, tz, { month: "short", day: "numeric" }) }))} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}><CartesianGrid {...gridProps} /><XAxis dataKey="label" {...axisProps} /><YAxis {...axisProps} domain={[0, 100]} width={32} /><RTooltip content={tip((p) => { const s = p.payload?.[0]?.payload as { name: string; score: number | null; potential: number; verified: number } | undefined; return <ChartTip active={p.active} label={s?.name} rows={s ? [{ name: "Score", value: s.score == null ? "n/a" : fmtNum(s.score, 1) }, { name: "Potential", value: fmtUSD(s.potential) }, { name: "Verified", value: fmtUSD(s.verified) }] : []} />; })} /><Line dataKey="score" stroke={ACCENT_HEX.indigo} strokeWidth={2.5} dot={{ r: 4 }} isAnimationActive={false} /></LineChart></ResponsiveContainer>
          </div>
        </ChartFrame>
      </>)}

      <SectionHeader accent="gold" icon={<BookOpen size={16} />} title="External benchmarks" subtitle="None are bundled. Add a dataset only from a published, citable source — it is always shown with its source, date and sample." action={canManage ? <Button onClick={() => setFormOpen(true)} data-testid="bench-add"><Plus size={15} />Add benchmark dataset</Button> : undefined} />
      {!datasets.length ? <Empty title="No external benchmarks added" body="BridgeBox does not ship industry averages, because unsourced benchmarks mislead. If you have a published study (with URL, publication date and sample), add it and it will appear beside your internal numbers." action={canManage ? <Button variant="secondary" onClick={() => setFormOpen(true)} data-testid="bench-add-empty">Add a cited dataset</Button> : undefined} /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {datasets.map((d) => (
            <Card key={d.id} className="card-hover" data-testid={`dataset-${d.id}`}>
              <div className="flex items-start justify-between gap-2"><div><div className="text-sm font-bold">{d.name}</div><div className="text-xs text-ink-2">{d.source} · published {d.publishedAt ? formatDate(d.publishedAt, tz, { year: "numeric", month: "short", day: "numeric" }) : "—"}</div></div>
                {canManage && <Button size="sm" variant="ghost" aria-label={`Delete ${d.name}`} onClick={async () => { if (confirm(`Delete benchmark dataset “${d.name}”?`)) { await deleteBenchmarkDataset({ id: d.id }); router.refresh(); } }} data-testid={`dataset-delete-${d.id}`}><Trash2 size={14} /></Button>}</div>
              {d.sourceUrl && <a href={d.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 break-all text-xs text-royal-ink hover:underline">{d.sourceUrl}<ExternalLink size={11} /></a>}
              <p className="mt-2 text-xs text-ink-2"><b className="text-ink">Sample:</b> {d.sampleDescription}</p>
              {d.applicability && <p className="mt-1 text-xs text-ink-2"><b className="text-ink">Applies to:</b> {d.applicability}</p>}
              <table className="mt-3 w-full text-xs"><thead><tr className="text-left text-ink-3"><th>Metric</th><th className="text-right">External</th><th className="text-right">Your org <Tooltip text="Whole-organization value computed from your observed data." /></th></tr></thead>
                <tbody>{d.metrics.map((m) => { const def = METRICS.find((x) => x.key === m.key); return <tr key={m.key} className="border-t border-border"><td className="py-1">{m.label}</td><td className="text-right tabular font-semibold text-indigo-ink">{def ? fmtMetric(def, m.value) : m.value}</td><td className="text-right tabular">{def ? fmtMetric(def, bm.orgValues[def.key]) : "—"}</td></tr>; })}</tbody></table>
            </Card>
          ))}
        </div>
      )}
      <DatasetForm open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}
