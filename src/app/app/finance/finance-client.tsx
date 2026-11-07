"use client";
import * as React from "react";
import { Download, RotateCcw, Save, SlidersHorizontal, ChevronDown, ChevronUp } from "lucide-react";
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip, Legend, ReferenceLine } from "recharts";
import { Badge, BasisChip, Button, Card, CardHeader, Modal, PageHeader, Table, Th, Td, Tooltip, Empty } from "@/components/ui";
import { CalcTreeView } from "@/components/calc-tree";
import type { CalcTree, FinancialAssumptions } from "@/db/schema";
import type { OrgFinancials } from "@/engine/finance";
import { SCENARIOS, type ScenarioKey } from "@/engine/costing";
import { cn, fmtUSD, fmtPct, fmtHours, fmtNum } from "@/lib/utils";
import { recompute, saveDefaultModel, type RecomputeResult } from "./actions";
import type { OpportunityOption } from "./lib";

type SliderKey = "automationPct" | "adoptionRate" | "realizationRate" | "benefitsLoadPct" | "consultingHourly" | "perAgentMonthly" | "platformFeeMonthly" | "rampMonths" | "discountRate" | "workWeeksPerYear";
type Sliders = Pick<FinancialAssumptions, SliderKey>;
const SLIDER_KEYS: SliderKey[] = ["automationPct", "adoptionRate", "realizationRate", "benefitsLoadPct", "consultingHourly", "perAgentMonthly", "platformFeeMonthly", "rampMonths", "discountRate", "workWeeksPerYear"];

const SLIDERS: { key: SliderKey; label: string; min: number; max: number; step: number; kind: "pct" | "mult" | "usd" | "int"; why: string }[] = [
  { key: "automationPct", label: "Automation multiplier", min: 0.3, max: 1.2, step: 0.05, kind: "mult", why: "Scales how much of each workflow the analysis believes can be automated. 1.0× trusts the analysis; below 1 is more cautious, above 1 assumes better tooling than modelled." },
  { key: "adoptionRate", label: "Adoption rate", min: 0, max: 1, step: 0.05, kind: "pct", why: "Share of eligible work that actually goes through the automation once it exists. People keep doing some runs by hand; this prevents counting hours that will not be saved." },
  { key: "realizationRate", label: "Realization rate", min: 0, max: 1, step: 0.05, kind: "pct", why: "Share of freed hours that becomes real money (avoided hires, backfilled attrition, redeployed to revenue work). Time saved is not the same as payroll cut." },
  { key: "benefitsLoadPct", label: "Benefits & taxes load", min: 0, max: 1, step: 0.01, kind: "pct", why: "Employer taxes and benefits added on top of base pay to get the true loaded cost of an hour of work." },
  { key: "consultingHourly", label: "Consulting rate ($/h)", min: 50, max: 500, step: 5, kind: "usd", why: "What implementation effort costs per hour. Each opportunity type has a base number of hours; this prices them." },
  { key: "perAgentMonthly", label: "Per-agent fee ($/mo)", min: 0, max: 1000, step: 5, kind: "usd", why: "Platform, model and runtime cost per deployed AI agent, charged monthly. Drives the operating cost of AI-agent opportunities." },
  { key: "platformFeeMonthly", label: "Platform base fee ($/mo)", min: 0, max: 5000, step: 25, kind: "usd", why: "The subscription base fee, deducted from net savings every year regardless of how many agents run." },
  { key: "rampMonths", label: "Ramp-up (months)", min: 0, max: 12, step: 1, kind: "int", why: "How long it takes to reach full savings after go-live. Year-1 savings are reduced by half the ramp period." },
  { key: "discountRate", label: "Discount rate", min: 0, max: 0.2, step: 0.01, kind: "pct", why: "Used to discount years 2 and 3 for the net present value (NPV). Your cost of capital or hurdle rate." },
  { key: "workWeeksPerYear", label: "Working weeks / year", min: 40, max: 52, step: 1, kind: "int", why: "Weeks actually worked after PTO and holidays. Annual figures are weekly figures × this number." },
];

const fmtSlider = (v: number, kind: string) => kind === "pct" ? `${Math.round(v * 100)}%` : kind === "mult" ? `${v.toFixed(2)}×` : kind === "usd" ? fmtUSD(v) : String(v);
const months = (m: number | null) => (m == null ? "not reached" : `${m.toFixed(1)} mo`);
const compact = (n: number) => (Math.abs(n) < 10_000 ? fmtUSD(n) : fmtUSD(n, { compact: true }));
const pick = (a: FinancialAssumptions): Sliders => Object.fromEntries(SLIDER_KEYS.map((k) => [k, a[k]])) as Sliders;

export function FinanceClient({ saved, initial, opportunities, canWrite, canReports }: { saved: FinancialAssumptions; initial: RecomputeResult; opportunities: OpportunityOption[]; canWrite: boolean; canReports: boolean }) {
  const [sliders, setSliders] = React.useState<Sliders>(pick(saved));
  const [savedSliders, setSavedSliders] = React.useState<Sliders>(pick(saved));
  const [scenario, setScenario] = React.useState<ScenarioKey>("expected");
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(opportunities.map((o) => o.id)));
  const [data, setData] = React.useState<RecomputeResult>(initial);
  const [busy, setBusy] = React.useState(false);
  const [flash, setFlash] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [tree, setTree] = React.useState<{ title: string; node: CalcTree } | null>(null);
  const [projTab, setProjTab] = React.useState<ScenarioKey>("expected");
  const [showAssumptions, setShowAssumptions] = React.useState(true);
  const seq = React.useRef(0); const first = React.useRef(true);

  // Debounced recompute on any input change (250ms); stale responses are ignored.
  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    const id = ++seq.current; setBusy(true);
    const t = setTimeout(async () => {
      const r = await recompute({ assumptions: sliders, scenario, opportunityIds: [...selected] });
      if (id !== seq.current) return;
      setBusy(false);
      if (r.ok) setData({ fin: r.fin, workflows: r.workflows, months: r.months }); else setFlash({ ok: false, text: r.error });
    }, 250);
    return () => clearTimeout(t);
  }, [sliders, scenario, selected]);

  const fin = data.fin;
  const dirty = SLIDER_KEYS.some((k) => sliders[k] !== savedSliders[k]);
  const set = (k: SliderKey, v: number) => setSliders((s) => ({ ...s, [k]: v }));
  const applyScenario = (k: ScenarioKey) => { setScenario(k); setProjTab(k); setSliders((s) => ({ ...s, automationPct: SCENARIOS[k].automationMult, adoptionRate: SCENARIOS[k].adoptionRate, realizationRate: SCENARIOS[k].realizationRate })); };
  const reset = () => { setSliders(savedSliders); setScenario("expected"); setProjTab("expected"); setSelected(new Set(opportunities.map((o) => o.id))); };
  async function save() {
    setBusy(true); const r = await saveDefaultModel(sliders); setBusy(false);
    if (r.ok) { setSavedSliders(pick(r.assumptions)); setFlash({ ok: true, text: "Saved as the default financial model. Dashboards and reports now use these assumptions." }); }
    else setFlash({ ok: false, text: r.error });
  }
  async function download(kind: "investment_proposal" | "executive_roi") {
    setBusy(true);
    try {
      const res = await fetch("/api/reports/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, scenario, opportunityIds: [...selected] }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); setFlash({ ok: false, text: j.error ?? `Report failed (${res.status})` }); return; }
      const blob = await res.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `${kind}-${new Date().toISOString().slice(0, 10)}.pdf`; a.click(); URL.revokeObjectURL(url);
      setFlash({ ok: true, text: "PDF downloaded and saved under Reports." });
    } finally { setBusy(false); }
  }

  const npvTree: CalcTree = { label: "3-year NPV", value: fin.threeYear.npv, unit: "usd", basis: "estimated", formula: `Σ year net ÷ (1 + ${fin.assumptions.discountRate})^year`, source: `${SCENARIOS[scenario].label} scenario, ${fin.assumptions.rampMonths}-month ramp`, children: fin.threeYear.years.map((y) => ({ label: `Year ${y.year} net (discounted)`, value: y.discounted, unit: "usd", basis: "estimated", formula: `${fmtUSD(y.savings)} savings − ${fmtUSD(y.costs)} costs = ${fmtUSD(y.net)}, ÷ (1 + ${fin.assumptions.discountRate})^${y.year}`, children: [
    { label: "Savings", value: y.savings, unit: "usd", basis: "estimated", formula: y.year === 1 ? `realizable × (1 − ${fin.assumptions.rampMonths} ÷ 24)` : "realizable annual savings" },
    { label: "Costs", value: y.costs, unit: "usd", basis: "assumed", formula: y.year === 1 ? "operating + platform base + implementation" : "operating + platform base" },
  ] })) };

  const tiles: { key: string; label: string; value: string; sub: string; node: CalcTree; basis: CalcTree["basis"] }[] = [
    { key: "gross", label: "Gross annual savings", value: compact(fin.grossAnnualSavings), sub: `${fmtHours(fin.hoursRecoverablePerWeek)}/wk recoverable`, node: fin.trees.grossSavings, basis: "estimated" },
    { key: "realizable", label: "Realizable per year", value: compact(fin.realizableAnnualSavings), sub: `${fmtPct(fin.assumptions.realizationRate)} of gross becomes cash`, node: fin.trees.realizableSavings, basis: "estimated" },
    { key: "implementation", label: "Implementation (one-time)", value: compact(fin.implementationCost), sub: `${fin.opportunityCount} opportunities in scope`, node: fin.trees.implementationCost, basis: "estimated" },
    { key: "operating", label: "Operating cost / year", value: compact(fin.annualOperatingCost), sub: `+ ${fmtUSD(fin.assumptions.platformFeeMonthly * 12)} platform base`, node: fin.trees.operatingCost, basis: "assumed" },
    { key: "net", label: "Net annual savings", value: compact(fin.netAnnualSavings), sub: "realizable − operating − platform", node: fin.trees.netSavings, basis: "estimated" },
    { key: "roi", label: "First-year ROI", value: fmtPct(fin.roi1y), sub: "(net − implementation) ÷ implementation", node: fin.trees.roi, basis: "estimated" },
    { key: "payback", label: "Payback", value: months(fin.paybackMonths), sub: "implementation ÷ monthly net", node: fin.trees.payback, basis: "estimated" },
    { key: "npv", label: "3-year NPV", value: compact(fin.threeYear.npv), sub: `${compact(fin.threeYear.totalNet)} undiscounted net`, node: npvTree, basis: "estimated" },
  ];

  const sc = (k: ScenarioKey) => fin.scenarios[k];
  const scenarioRows: { label: string; f: (k: ScenarioKey) => string }[] = [
    { label: "Recoverable hrs / week", f: (k) => fmtHours(sc(k).hoursRecoverablePerWeek) },
    { label: "Gross annual savings", f: (k) => fmtUSD(sc(k).grossAnnualSavings) },
    { label: "Realizable annual savings", f: (k) => fmtUSD(sc(k).realizableAnnualSavings) },
    { label: "Implementation (one-time)", f: (k) => fmtUSD(sc(k).implementationCost) },
    { label: "Operating cost / year", f: (k) => fmtUSD(sc(k).annualOperatingCost) },
    { label: "Net annual savings", f: (k) => fmtUSD(sc(k).netAnnualSavings) },
    { label: "Payback", f: (k) => months(sc(k).paybackMonths) },
    { label: "3-year net", f: (k) => fmtUSD(sc(k).threeYear.totalNet) },
    { label: "3-year NPV", f: (k) => fmtUSD(sc(k).threeYear.npv) },
  ];
  const projRows = fin.scenarios[projTab].threeYear.years.map((y) => ({ name: `Year ${y.year}`, savings: Math.round(y.savings), costs: Math.round(y.costs), cumulative: Math.round(y.cumulative), net: Math.round(y.net), discounted: Math.round(y.discounted) }));
  const hasVerified = data.months.some((m) => m.verified > 0);
  const monthRows = data.months.map((m) => ({ name: new Date(m.month + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }), projected: Math.round(m.projectedMonthly), verified: Math.round(m.verified), measurements: m.measurements }));
  const empty = opportunities.length === 0 && data.workflows.length === 0;

  return (
    <div data-testid="finance-page">
      <PageHeader title="Financial Model" subtitle="Move the assumptions and watch every number update. Projected figures are estimates built on observed hours; verified figures come only from measured deployments."
        actions={canReports ? <>
          <Button variant="secondary" onClick={() => download("executive_roi")} loading={busy} data-testid="finance-download-roi"><Download size={15} />Executive ROI report (PDF)</Button>
          <Button onClick={() => download("investment_proposal")} loading={busy} data-testid="finance-download-proposal"><Download size={15} />Investment proposal (PDF)</Button>
        </> : undefined} />
      {flash && <div className={cn("mb-3 rounded-lg px-3 py-2 text-xs", flash.ok ? "bg-money-soft text-money" : "bg-danger-soft text-danger")} role="status" data-testid="finance-flash">{flash.text}</div>}
      {empty && <div className="mb-4"><Empty title="No workflow data yet" body="The model needs discovered workflows and opportunities. Enroll collectors and run an analysis under Data Collection; the assumptions below will apply as soon as data arrives." action={<Button href="/app/collection" data-testid="finance-empty-cta">Go to Data Collection</Button>} /></div>}

      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        {/* ---------------- left: assumptions ---------------- */}
        <aside className="space-y-4">
          <Card data-testid="finance-assumptions">
            <CardHeader title={<span className="flex items-center gap-2"><SlidersHorizontal size={15} />Assumptions</span>} subtitle={<span className="flex items-center gap-2"><BasisChip basis="assumed" />{busy ? "Recomputing…" : "Live"}</span>} action={<button className="lg:hidden text-ink-2" onClick={() => setShowAssumptions((v) => !v)} aria-label="Toggle assumptions" data-testid="finance-toggle-assumptions">{showAssumptions ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>} />
            <div className={cn(!showAssumptions && "hidden lg:block")}>
              <div className="mb-3 flex gap-1.5" role="group" aria-label="Scenario presets">
                {(Object.keys(SCENARIOS) as ScenarioKey[]).map((k) => (
                  <button key={k} onClick={() => applyScenario(k)} data-testid={`finance-scenario-${k}`} className={cn("flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition", scenario === k ? "border-brand bg-brand-soft text-brand" : "border-border text-ink-2 hover:bg-surface-2")}>{SCENARIOS[k].label}</button>
                ))}
              </div>
              <p className="mb-3 text-[11px] text-ink-3">Presets set the three rate sliders and a cost multiplier ({SCENARIOS[scenario].costMult}× on implementation and operating cost). Sliders you move afterwards win.</p>
              <div className="space-y-3">
                {SLIDERS.map((s) => (
                  <div key={s.key} data-testid={`finance-slider-${s.key}`}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <label htmlFor={`sl-${s.key}`} className="flex items-center gap-1 text-xs font-medium text-ink-2">{s.label}<Tooltip text={s.why} /></label>
                      <span className="tabular text-xs font-semibold">{fmtSlider(sliders[s.key], s.kind)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input id={`sl-${s.key}`} type="range" min={s.min} max={s.max} step={s.step} value={sliders[s.key]} onChange={(e) => set(s.key, Number(e.target.value))} className="h-1.5 flex-1 cursor-pointer accent-[var(--color-brand)]" data-testid={`finance-range-${s.key}`} aria-label={s.label} />
                      <input type="number" min={s.min} max={s.max} step={s.step} value={s.kind === "pct" ? Math.round(sliders[s.key] * 100) : sliders[s.key]} onChange={(e) => { const v = Number(e.target.value); if (!Number.isFinite(v)) return; set(s.key, Math.min(s.max, Math.max(s.min, s.kind === "pct" ? v / 100 : v))); }} className="h-7 w-16 rounded-md border border-border bg-surface px-1.5 text-right text-xs tabular" data-testid={`finance-number-${s.key}`} aria-label={`${s.label} value`} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-col gap-2">
                <Button variant="secondary" size="sm" onClick={reset} disabled={!dirty && scenario === "expected" && selected.size === opportunities.length} data-testid="finance-reset"><RotateCcw size={14} />Reset to saved</Button>
                {canWrite ? <Button size="sm" onClick={save} disabled={!dirty} loading={busy && dirty} data-testid="finance-save"><Save size={14} />Save as default model</Button>
                  : <p className="text-[11px] text-ink-3">You can explore, but saving the default model needs an owner or admin.</p>}
              </div>
            </div>
          </Card>

          <Card data-testid="finance-scope">
            <CardHeader title="Opportunities in the model" subtitle={`${selected.size} of ${opportunities.length} included`} action={<div className="flex gap-1"><button className="text-[11px] text-brand" onClick={() => setSelected(new Set(opportunities.map((o) => o.id)))} data-testid="finance-scope-all">All</button><span className="text-ink-3">·</span><button className="text-[11px] text-brand" onClick={() => setSelected(new Set())} data-testid="finance-scope-none">None</button></div>} />
            {opportunities.length === 0 ? <p className="text-xs text-ink-3">No opportunities identified yet.</p> : (
              <ul className="max-h-72 space-y-1 overflow-y-auto scrollbar-thin text-xs">
                {opportunities.map((o) => (
                  <li key={o.id}><label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-surface-2">
                    <input type="checkbox" checked={selected.has(o.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(o.id); else n.delete(o.id); return n; })} className="mt-0.5 accent-[var(--color-brand)]" data-testid={`finance-opp-${o.id}`} />
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{o.title}</span><span className="text-ink-3">{o.departmentName ?? "—"} · {fmtUSD(o.realizableAnnual)}/yr</span></span>
                  </label></li>
                ))}
              </ul>
            )}
          </Card>
        </aside>

        {/* ---------------- right: results ---------------- */}
        <div className="min-w-0 space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="finance-tiles">
            {tiles.map((t) => (
              <button key={t.key} onClick={() => setTree({ title: t.label, node: t.node })} className="card p-4 text-left transition hover:border-brand hover:shadow-pop" data-testid={`finance-tile-${t.key}`}>
                <div className="text-[11px] font-medium uppercase tracking-wide text-ink-2">{t.label}</div>
                <div className={cn("mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xl font-semibold tabular", busy && "opacity-60")}>{t.value}<BasisChip basis={t.basis} /></div>
                <div className="mt-1 text-[11px] text-ink-3">{t.sub}</div>
              </button>
            ))}
          </div>
          <p className="-mt-2 text-[11px] text-ink-3">Click any tile to see exactly how it was calculated. Scenario: <strong>{SCENARIOS[scenario].label}</strong>. Verified so far: <strong className="text-verified">{fmtUSD(fin.verifiedAnnualizedSavings)}</strong> annualized from {fin.verifiedMeasurements} measurement(s) — kept separate from projections.</p>

          <Card data-testid="finance-scenarios">
            <CardHeader title="Scenario comparison" subtitle="Same observed hours and labor costs; only adoption, realization, automation multiplier and cost multiplier change." />
            <Table className="border-0 shadow-none">
              <thead><tr><Th>Metric</Th>{(Object.keys(SCENARIOS) as ScenarioKey[]).map((k) => <Th key={k} className={cn("text-right", scenario === k && "text-brand")}>{SCENARIOS[k].label}<div className="text-[10px] font-normal normal-case tracking-normal text-ink-3">{fmtPct(SCENARIOS[k].adoptionRate)} / {fmtPct(SCENARIOS[k].realizationRate)} / {SCENARIOS[k].automationMult}×</div></Th>)}</tr></thead>
              <tbody>{scenarioRows.map((r) => <tr key={r.label}><Td className="text-xs font-medium">{r.label}</Td>{(Object.keys(SCENARIOS) as ScenarioKey[]).map((k) => <Td key={k} className={cn("text-right tabular text-xs", scenario === k && "font-semibold")}>{r.f(k)}</Td>)}</tr>)}</tbody>
            </Table>
          </Card>

          <Card data-testid="finance-projection">
            <CardHeader title="Three-year projection" subtitle={`Savings ramp over ${fin.assumptions.rampMonths} months in year 1; year-1 costs include implementation.`} action={
              <div className="flex gap-1" role="tablist">{(Object.keys(SCENARIOS) as ScenarioKey[]).map((k) => <button key={k} role="tab" aria-selected={projTab === k} onClick={() => setProjTab(k)} data-testid={`finance-proj-tab-${k}`} className={cn("rounded-md px-2 py-1 text-[11px] font-medium", projTab === k ? "bg-brand-soft text-brand" : "text-ink-2 hover:bg-surface-2")}>{SCENARIOS[k].label}</button>)}</div>} />
            <div className="h-64 w-full" data-testid="finance-projection-chart">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={projRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--color-ink-2)" }} axisLine={{ stroke: "var(--color-border)" }} tickLine={false} />
                  <YAxis tickFormatter={(v: number) => compact(v)} tick={{ fontSize: 11, fill: "var(--color-ink-2)" }} axisLine={false} tickLine={false} width={64} />
                  <ChartTooltip cursor={{ fill: "var(--color-surface-2)" }} contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} formatter={(v: unknown) => fmtUSD(Number(v ?? 0))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={0} stroke="var(--color-ink-3)" />
                  <Bar dataKey="savings" name="Realizable savings (projected)" fill="var(--color-projected)" radius={[4, 4, 0, 0]} maxBarSize={48} />
                  <Bar dataKey="costs" name="Costs" fill="var(--color-ink-3)" radius={[4, 4, 0, 0]} maxBarSize={48} />
                  <Line type="monotone" dataKey="cumulative" name="Cumulative net" stroke="var(--color-brand)" strokeWidth={2} dot={{ r: 4, fill: "var(--color-brand)", stroke: "var(--color-surface)", strokeWidth: 2 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <Table className="mt-3 border-0 shadow-none">
              <thead><tr><Th>Year</Th><Th className="text-right">Savings</Th><Th className="text-right">Costs</Th><Th className="text-right">Net</Th><Th className="text-right">Cumulative</Th><Th className="text-right">Discounted</Th></tr></thead>
              <tbody>
                {projRows.map((y) => <tr key={y.name}><Td className="text-xs font-medium">{y.name}</Td><Td className="text-right tabular text-xs">{fmtUSD(y.savings)}</Td><Td className="text-right tabular text-xs">{fmtUSD(y.costs)}</Td><Td className={cn("text-right tabular text-xs", y.net < 0 && "text-danger")}>{fmtUSD(y.net)}</Td><Td className={cn("text-right tabular text-xs", y.cumulative < 0 && "text-danger")}>{fmtUSD(y.cumulative)}</Td><Td className="text-right tabular text-xs">{fmtUSD(y.discounted)}</Td></tr>)}
                <tr className="font-semibold"><Td className="text-xs">Total</Td><Td className="text-right tabular text-xs">{fmtUSD(projRows.reduce((s, y) => s + y.savings, 0))}</Td><Td className="text-right tabular text-xs">{fmtUSD(projRows.reduce((s, y) => s + y.costs, 0))}</Td><Td className="text-right tabular text-xs">{fmtUSD(fin.scenarios[projTab].threeYear.totalNet)}</Td><Td></Td><Td className="text-right tabular text-xs">{fmtUSD(fin.scenarios[projTab].threeYear.npv)}</Td></tr>
              </tbody>
            </Table>
          </Card>

          <Card data-testid="finance-realized">
            <CardHeader title="Realized vs projected" subtitle="Monthly projected run-rate (realizable ÷ 12) against dollars actually verified from measurements." action={<div className="flex gap-1"><Badge tone="projected">Projected</Badge><Badge tone="verified">Verified</Badge></div>} />
            <div className="h-56 w-full" data-testid="finance-realized-chart">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={monthRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--color-ink-2)" }} axisLine={{ stroke: "var(--color-border)" }} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tickFormatter={(v: number) => compact(v)} tick={{ fontSize: 11, fill: "var(--color-ink-2)" }} axisLine={false} tickLine={false} width={64} />
                  <ChartTooltip cursor={{ fill: "var(--color-surface-2)" }} contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} formatter={(v: unknown) => fmtUSD(Number(v ?? 0))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="verified" name="Verified (measured)" fill="var(--color-verified)" radius={[4, 4, 0, 0]} maxBarSize={32} />
                  <Line type="monotone" dataKey="projected" name="Projected run-rate" stroke="var(--color-projected)" strokeWidth={2} dot={false} strokeDasharray="4 3" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {!hasVerified && <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2" data-testid="finance-realized-empty">No verified measurements yet. Verified dollars appear after an agent is deployed and its run ledger or a before/after observation is recorded — nothing is shown until it is measured.</p>}
          </Card>

          <Card data-testid="finance-workflow-costs">
            <CardHeader title="Cost per workflow" subtitle="What each discovered workflow costs today at loaded rates, and the opportunity modelled against it." />
            {data.workflows.length === 0 ? <p className="text-xs text-ink-3">No workflows discovered yet.</p> : (
              <Table className="border-0 shadow-none">
                <thead><tr><Th>Workflow</Th><Th>Department</Th><Th className="text-right">Hrs / wk</Th><Th className="text-right">People</Th><Th className="text-right">Loaded cost / yr</Th><Th>Opportunity</Th><Th className="text-right">Realizable / yr</Th></tr></thead>
                <tbody>{data.workflows.map((w) => (
                  <tr key={w.id} data-testid={`finance-wf-${w.id}`}>
                    <Td className="text-xs whitespace-nowrap"><a href={`/app/workflows/${w.id}`} className="font-medium hover:text-brand">{w.name}</a>{w.requiresJudgment && <Badge tone="warn" className="ml-1">judgment</Badge>}</Td>
                    <Td className="text-xs text-ink-2">{w.departmentName ?? "—"}</Td>
                    <Td className="text-right tabular text-xs">{fmtHours(w.hoursPerWeek)} <BasisChip basis={w.basis} /></Td>
                    <Td className="text-right tabular text-xs">{w.employeeCount}</Td>
                    <Td className="text-right tabular text-xs">{fmtUSD(w.loadedCostPerYear)} <BasisChip basis={w.costBasis} /></Td>
                    <Td className="text-xs whitespace-nowrap">{w.opportunityId ? <a href={`/app/opportunities/${w.opportunityId}`} className="hover:text-brand">{w.opportunityTitle}</a> : <span className="text-ink-3">none modelled</span>}</Td>
                    <Td className="text-right tabular text-xs">{w.realizableAnnual != null ? <>{fmtUSD(w.realizableAnnual)} <BasisChip basis="estimated" /></> : "—"}</Td>
                  </tr>))}</tbody>
              </Table>
            )}
          </Card>

          <Card data-testid="finance-basis">
            <CardHeader title="How to read these numbers" />
            <ul className="space-y-1 text-xs text-ink-2">
              <li><BasisChip basis="observed" /> measured from collector activity, HR cost records or agent run ledgers.</li>
              <li><BasisChip basis="estimated" /> derived from observed data through the model (recoverable hours, savings, implementation cost).</li>
              <li><BasisChip basis="assumed" /> a slider on the left. Change it and everything recomputes.</li>
              <li className="pt-1">Evidence mix in this model: {fin.basisSummary.observed} observed, {fin.basisSummary.estimated} estimated, {fin.basisSummary.assumed} assumed nodes. {fmtNum(fin.employeesAnalyzed)} employees and {fmtUSD(fin.totalAnnualLaborAnalyzed)} of loaded labor analyzed.</li>
            </ul>
          </Card>
        </div>
      </div>

      <Modal open={!!tree} onClose={() => setTree(null)} title={tree?.title ?? ""} wide>
        {tree && <div data-testid="finance-calc-modal"><CalcTreeView node={tree.node} /></div>}
      </Modal>
    </div>
  );
}
