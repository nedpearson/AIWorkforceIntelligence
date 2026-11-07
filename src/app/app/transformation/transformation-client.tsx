"use client";
import * as React from "react";
import Link from "next/link";
import { Shuffle, Users, BadgeCheck, PiggyBank, ShieldAlert, Save, Trash2, Send, Bot, Building2, UserCog } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip } from "recharts";
import type { CapacityResult, CapacityRow } from "@/engine/capacity";
import { Button, Empty, Input, Modal, PageHeader, Select, Table, Td, Th, Tooltip } from "@/components/ui";
import { KpiCard, SectionHeader, Segmented, ExportButton, ACCENT_HEX } from "@/components/ui/enterprise";
import { DrilldownModal, type Drill } from "@/components/dashboard/stat-tile";
import { ChartTip } from "@/components/charts";
import { axisProps } from "@/components/charts/theme";
import { OPP_TYPE_LABEL } from "@/components/dashboard/opportunity-card";
import { fmtNum, fmtUSD, fmtPct } from "@/lib/utils";
import { hiringAvoidance } from "./hiring-avoidance";
import { submitCostAvoidance } from "./actions";

type Plan = { hires: Record<string, number>; utilization: number; basis: "projected" | "verified" };
type Scenario = Plan & { name: string; savedAt: string };
const SCEN_KEY = "bb-redeploy-scenarios";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function TransformationClient({ cap, canSubmit }: { cap: CapacityResult; canSubmit: boolean }) {
  const [dim, setDim] = React.useState<"department" | "role">("department");
  const [drill, setDrill] = React.useState<{ title: string; drill: Drill } | null>(null);
  const [plan, setPlan] = React.useState<Plan>({ hires: {}, utilization: 0.75, basis: cap.totals.verifiedFte > 0 ? "verified" : "projected" });
  const [scenarios, setScenarios] = React.useState<Scenario[]>([]);
  const [scenName, setScenName] = React.useState("");
  const [submitFor, setSubmitFor] = React.useState<CapacityRow | null>(null);
  React.useEffect(() => { try { const s = JSON.parse(localStorage.getItem(SCEN_KEY) ?? "[]"); if (Array.isArray(s)) setScenarios(s); } catch {} }, []);
  const persist = (s: Scenario[]) => { setScenarios(s); try { localStorage.setItem(SCEN_KEY, JSON.stringify(s)); } catch {} };

  const planned = cap.departments.map((d) => {
    const fte = plan.basis === "verified" ? d.verifiedFte : d.fteReleased;
    const h = hiringAvoidance({ plannedHires: plan.hires[d.key] ?? 0, fteReleased: fte, utilization: plan.utilization, loadedCostPerFte: d.loadedCostPerFte ?? cap.totals.orgLoadedCostPerFte });
    return { d, fte, ...h };
  });
  const avoidTotal = planned.reduce((s, x) => s + x.value, 0);
  const avoidTree = { label: "Hiring avoidance potential (scenario)", value: avoidTotal, unit: "usd", basis: "estimated" as const, formula: "Σ departments min(planned hires, FTE released × utilization) × loaded cost per FTE", source: `${plan.basis === "verified" ? "Verified" : "Projected"} capacity · utilization ${Math.round(plan.utilization * 100)}%`, children: planned.filter((x) => x.value > 0).map((x) => ({ ...x.tree, label: x.d.name })) };

  const header = <PageHeader hero eyebrow="Transformation" icon={<Shuffle size={22} className="text-cyan-300" />} title="Organizational Transformation"
    subtitle="How much working capacity automation frees, where, and how to redeploy it — by department and role, never by person." />;
  const disclaimer = (
    <div className="flex items-start gap-3 rounded-2xl border border-coral/30 bg-coral-soft/50 p-4 text-sm" role="note" data-testid="capacity-disclaimer">
      <ShieldAlert size={18} className="mt-0.5 shrink-0 text-coral-ink" />
      <div><p className="font-semibold text-ink">{cap.disclaimer}</p><p className="mt-0.5 text-xs text-ink-2">This page shows role-level capacity only. It never recommends changes for individual employees; use released capacity for growth, backlog, quality and avoided future hiring.</p></div>
    </div>
  );
  if (!cap.departments.length) return <div className="space-y-5">{header}{disclaimer}<Empty title="No observed work yet" body="Capacity is computed from observed workflows and the people who perform them. Deploy desktop collectors and run the analysis first." action={<Button href="/app/collection">Set up collectors</Button>} /></div>;

  const rows = dim === "department" ? cap.departments : cap.roles;
  const chart = rows.slice(0, 12).map((r) => ({ name: r.name, observed: r.observedHoursPerWeek, recoverable: r.recoverableHoursPerWeek, verified: r.verifiedHoursPerWeek }));
  const exportRows = [...cap.departments.map((r) => ({ level: "department", ...flat(r) })), ...cap.roles.map((r) => ({ level: "role", ...flat(r) }))];
  const scenarioRows = planned.map((x) => ({ department: x.d.name, planned_hires: plan.hires[x.d.key] ?? 0, fte_released: Number(x.fte.toFixed(2)), utilization_pct: Math.round(plan.utilization * 100), avoided_hires: Number(x.avoidedHires.toFixed(2)), loaded_cost_per_fte: Math.round(x.d.loadedCostPerFte ?? 0), cost_source: x.d.costSource ?? "", avoidance_value: Math.round(x.value), basis: plan.basis }));

  return (
    <div className="space-y-5">
      {header}
      {disclaimer}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 stagger">
        <KpiCard testid="kpi-tx-fte" size="lg" label="FTE capacity recoverable" value={cap.totals.fteReleased} format={(n) => `${fmtNum(n, 1)} FTE`} accent="cyan" basis="estimated" icon={<Users size={16} />}
          caption={`${fmtNum(cap.totals.recoverableHoursPerWeek, 1)} hrs/wk ÷ ${cap.hoursPerFte} hrs per FTE`} onClick={() => setDrill({ title: "FTE capacity recoverable", drill: { tree: cap.trees.fte, meaning: "Hours per week the identified automations would take over, expressed as full-time equivalents. It is capacity to redeploy, not a headcount number." } })} />
        <KpiCard testid="kpi-tx-verified" size="lg" label="Verified capacity released" value={cap.totals.verifiedFte} format={(n) => `${fmtNum(n, 2)} FTE`} accent="emerald" basis="observed" icon={<BadgeCheck size={16} />}
          caption={cap.totals.verifiedHoursPerWeek > 0 ? `${fmtNum(cap.totals.verifiedHoursPerWeek, 1)} hrs/wk measured after deployment` : "no savings measurements yet"} onClick={() => setDrill({ title: "Verified capacity released", drill: { tree: cap.trees.verified, meaning: "Hours actually saved by deployed agents (run ledger or before/after observation), annualized and expressed per week." } })} />
        <KpiCard testid="kpi-tx-avoid" size="lg" label="Hiring avoidance potential" value={avoidTotal} format={(n) => fmtUSD(n, { compact: true })} accent="gold" basis="estimated" icon={<PiggyBank size={16} />}
          caption={Object.values(plan.hires).some((v) => v > 0) ? "from the redeployment planner below" : "enter planned hires below to estimate"} onClick={() => setDrill({ title: "Hiring avoidance potential", drill: { tree: avoidTree, meaning: "Future hires that released capacity could cover, valued at the department's average loaded cost. Becomes cost avoidance only when evidenced and approved." } })} />
      </div>

      <SectionHeader accent="cyan" icon={dim === "department" ? <Building2 size={16} /> : <UserCog size={16} />} title="Capacity by department and role" subtitle="Observed, repetitive and recoverable hours per week. Recoverable hours come from finance-engine opportunity lines distributed by each person's share of the workflow."
        action={<div className="flex items-center gap-2"><Segmented testid="tx-dim" size="sm" value={dim} onChange={setDim} options={[{ key: "department", label: "Department" }, { key: "role", label: "Role" }]} /><ExportButton rows={exportRows} filename="capacity" testid="tx-export" /></div>} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="card p-5 xl:col-span-2" data-testid="tx-chart">
          <h3 className="text-sm font-semibold">Hours per week — {dim === "department" ? "departments" : "roles"}</h3>
          <ul className="mb-2 mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2" aria-label="Legend">{[["Observed", "var(--color-ink-3)"], ["Recoverable (projected)", ACCENT_HEX.cyan], ["Verified released", ACCENT_HEX.emerald]].map(([l, c]) => <li key={l} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{l}</li>)}</ul>
          <div style={{ height: Math.max(220, chart.length * 46) }} role="img" aria-label={`Bar chart of observed, recoverable and verified hours per week by ${dim}. Table alongside.`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }} barCategoryGap="22%" barGap={2}>
                <CartesianGrid stroke="var(--color-border)" horizontal={false} />
                <XAxis type="number" {...axisProps} tickFormatter={(v) => `${fmtNum(Number(v), 0)}h`} />
                <YAxis type="category" dataKey="name" {...axisProps} width={104} tickFormatter={(v: string) => (v.length > 15 ? v.slice(0, 14) + "…" : v)} />
                <RTooltip cursor={{ fill: "var(--color-surface-2)" }} content={((p: Any) => <ChartTip active={p.active} label={p.label} rows={(p.payload ?? []).map((x: Any) => ({ name: x.dataKey === "observed" ? "Observed" : x.dataKey === "recoverable" ? "Recoverable (projected)" : "Verified released", value: `${fmtNum(Number(x.value), 1)} hrs/wk`, color: x.fill }))} />) as Any} />
                <Bar dataKey="observed" fill="var(--color-ink-3)" radius={[0, 4, 4, 0]} maxBarSize={10} isAnimationActive={false} />
                <Bar dataKey="recoverable" fill={ACCENT_HEX.cyan} radius={[0, 4, 4, 0]} maxBarSize={10} isAnimationActive={false} />
                <Bar dataKey="verified" fill={ACCENT_HEX.emerald} radius={[0, 4, 4, 0]} maxBarSize={10} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="xl:col-span-3">
          <Table>
            <thead><tr><Th>{dim === "department" ? "Department" : "Role"}</Th><Th className="text-right">People</Th><Th className="text-right">Observed h/wk</Th><Th className="text-right">Repetitive h/wk</Th><Th className="text-right">Recoverable h/wk</Th><Th className="text-right"><Tooltip text={`Recoverable hours ÷ ${cap.hoursPerFte} hours per FTE-week.`}><span>FTE released</span></Tooltip></Th><Th className="text-right">Verified FTE</Th></tr></thead>
            <tbody data-testid="tx-table">
              {rows.map((r) => <tr key={r.key} className="hover:bg-surface-2"><Td className="font-medium">{dim === "department" && r.key !== "unassigned" ? <Link href={`/app/departments/${r.key}`} className="text-royal-ink hover:underline">{r.name}</Link> : r.name}</Td><Td className="text-right tabular">{r.headcount}</Td><Td className="text-right tabular">{fmtNum(r.observedHoursPerWeek, 1)}</Td><Td className="text-right tabular">{fmtNum(r.repetitiveHoursPerWeek, 1)}</Td><Td className="text-right tabular font-semibold text-cyan-ink">{fmtNum(r.recoverableHoursPerWeek, 1)}</Td><Td className="text-right tabular font-semibold">{fmtNum(r.fteReleased, 2)}</Td><Td className="text-right tabular text-emerald-ink">{r.verifiedFte > 0 ? fmtNum(r.verifiedFte, 2) : "—"}</Td></tr>)}
              {cap.unattributed.recoverableHoursPerWeek > 0.05 && <tr className="text-ink-2"><Td>Unattributed <Tooltip text="Opportunities whose workflow has no linked performers. Included in totals so they reconcile with finance." /></Td><Td /><Td /><Td /><Td className="text-right tabular">{fmtNum(cap.unattributed.recoverableHoursPerWeek, 1)}</Td><Td className="text-right tabular">{fmtNum(cap.unattributed.recoverableHoursPerWeek / cap.hoursPerFte, 2)}</Td><Td /></tr>}
              <tr className="bg-surface-2/60 font-semibold"><Td>Total</Td><Td className="text-right tabular">{cap.departments.reduce((s, d) => s + d.headcount, 0)}</Td><Td className="text-right tabular">{fmtNum(cap.totals.observedHoursPerWeek, 1)}</Td><Td className="text-right tabular">{fmtNum(cap.totals.repetitiveHoursPerWeek, 1)}</Td><Td className="text-right tabular text-cyan-ink">{fmtNum(cap.totals.recoverableHoursPerWeek, 1)}</Td><Td className="text-right tabular">{fmtNum(cap.totals.fteReleased, 2)}</Td><Td className="text-right tabular text-emerald-ink">{fmtNum(cap.totals.verifiedFte, 2)}</Td></tr>
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] text-ink-3">Reconciles with Financial Intelligence: {fmtNum(cap.totals.financeRecoverableHoursPerWeek, 1)} recoverable hrs/wk.</p>
        </div>
      </div>

      <SectionHeader accent="gold" icon={<PiggyBank size={16} />} title="Redeployment planner" subtitle="Enter the hires each department plans in the next 12 months. Released capacity × utilization can cover some of them — that is cost avoidance potential, not a cut."
        action={<ExportButton rows={scenarioRows} filename="redeployment-scenario" testid="tx-scenario-export" />} />
      <div className="card p-5" data-testid="tx-planner">
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <label className="block text-xs"><span className="mb-1 block font-medium text-ink-2">Utilization of released capacity: <b className="text-ink">{Math.round(plan.utilization * 100)}%</b></span>
            <input type="range" min={0} max={100} step={5} value={Math.round(plan.utilization * 100)} onChange={(e) => setPlan({ ...plan, utilization: Number(e.target.value) / 100 })} className="w-56 accent-[#f59e0b]" data-testid="tx-utilization" aria-label="Utilization percent" /></label>
          <div className="text-xs"><span className="mb-1 block font-medium text-ink-2">Capacity basis</span><Segmented testid="tx-basis" size="sm" value={plan.basis} onChange={(b) => setPlan({ ...plan, basis: b })} options={[{ key: "projected", label: "Projected" }, { key: "verified", label: "Verified only" }]} /></div>
          <div className="ml-auto text-right"><div className="text-[11px] text-ink-2">Scenario total</div><div className="font-display text-2xl font-bold tabular text-gold-ink" data-testid="tx-scenario-total">{fmtUSD(avoidTotal)}</div></div>
        </div>
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-2"><th className="pb-2">Department</th><th className="pb-2 text-right">FTE released</th><th className="pb-2 text-right">Planned hires (12 mo)</th><th className="pb-2 text-right">Avoidable hires</th><th className="pb-2 text-right">Loaded cost / FTE</th><th className="pb-2 text-right">Potential</th><th className="pb-2" /></tr></thead>
            <tbody>
              {planned.map((x) => (
                <tr key={x.d.key} className="border-t border-border">
                  <td className="py-2 font-medium">{x.d.name}</td>
                  <td className="py-2 text-right tabular">{fmtNum(x.fte, 2)}</td>
                  <td className="py-2 text-right"><input type="number" min={0} step={0.5} value={plan.hires[x.d.key] ?? ""} placeholder="0" onChange={(e) => setPlan({ ...plan, hires: { ...plan.hires, [x.d.key]: Math.max(0, Number(e.target.value) || 0) } })} aria-label={`Planned hires for ${x.d.name}`} data-testid={`tx-hires-${x.d.key}`} className="h-8 w-20 rounded-lg border border-border bg-surface px-2 text-right text-sm tabular" /></td>
                  <td className="py-2 text-right tabular">{fmtNum(x.avoidedHires, 2)}</td>
                  <td className="py-2 text-right tabular text-ink-2">{fmtUSD(x.d.loadedCostPerFte ?? 0, { compact: true })}{x.d.costSource === "org_average" && <Tooltip text="Fewer than 3 people in this department, so the organization average is used to avoid revealing individual pay."><span className="ml-1 text-[10px] text-ink-3">org avg</span></Tooltip>}</td>
                  <td className="py-2 text-right font-semibold tabular text-gold-ink">{x.value > 0 ? <button type="button" className="underline decoration-dotted underline-offset-4" onClick={() => setDrill({ title: `Hiring avoidance — ${x.d.name}`, drill: { tree: x.tree, meaning: "Planned hires that released capacity could cover, valued at loaded cost." } })}>{fmtUSD(x.value)}</button> : "—"}</td>
                  <td className="py-2 pl-2 text-right">{canSubmit && x.value > 0 && <Button size="sm" variant="secondary" onClick={() => setSubmitFor(x.d)} data-testid={`tx-submit-${x.d.key}`}><Send size={12} />Submit</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <Input label="Save scenario as" value={scenName} onChange={(e) => setScenName(e.target.value)} placeholder="e.g. FY27 hiring plan" className="w-56" data-testid="tx-scenario-name" />
          <Button variant="secondary" disabled={!scenName.trim()} onClick={() => { persist([{ ...plan, name: scenName.trim(), savedAt: new Date().toISOString() }, ...scenarios.filter((s) => s.name !== scenName.trim())].slice(0, 20)); setScenName(""); }} data-testid="tx-scenario-save"><Save size={14} />Save</Button>
          <span className="text-[11px] text-ink-3">Scenarios stay in this browser; export to share.</span>
        </div>
        {scenarios.length > 0 && <ul className="mt-3 flex flex-wrap gap-2" data-testid="tx-scenarios">{scenarios.map((s) => <li key={s.name} className="inline-flex items-center gap-1 rounded-xl border border-border bg-surface-2 py-1 pl-3 pr-1 text-xs"><button type="button" onClick={() => setPlan({ hires: s.hires, utilization: s.utilization, basis: s.basis })} className="font-semibold hover:text-royal-ink">{s.name}</button><span className="text-ink-3">{Math.round(s.utilization * 100)}% · {s.basis}</span><button type="button" aria-label={`Delete scenario ${s.name}`} onClick={() => persist(scenarios.filter((x) => x.name !== s.name))} className="rounded p-1 text-ink-3 hover:bg-surface hover:text-coral-ink"><Trash2 size={12} /></button></li>)}</ul>}
      </div>

      <SectionHeader accent="purple" icon={<Bot size={16} />} title="Role redesign notes" subtitle="Which tasks move to agents, per role. Role-level only — redesign with managers, HR and legal before changing any job." />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 stagger" data-testid="tx-roles">
        {cap.roleNotes.map((r) => {
          const rec = r.tasks.reduce((s, t) => s + t.recoverableHoursPerWeek, 0);
          return (
            <div key={r.role} className="card p-4" data-testid={`tx-role-${r.role.replace(/\W+/g, "-").toLowerCase()}`}>
              <div className="flex items-start justify-between gap-2"><div><div className="text-sm font-bold">{r.role}</div><div className="text-[11px] text-ink-3">{r.headcount} {r.headcount === 1 ? "person" : "people"} · {fmtNum(r.hoursPerWeek, 1)} observed hrs/wk</div></div><span className="rounded-lg bg-cyan-soft px-2 py-0.5 text-[11px] font-bold tabular text-cyan-ink">{fmtNum(rec, 1)} h/wk freed</span></div>
              <ul className="mt-3 space-y-2">
                {r.tasks.slice(0, 5).map((t) => (
                  <li key={t.workflowId} className="text-xs">
                    <div className="flex justify-between gap-2"><Link href={`/app/workflows/${t.workflowId}`} className="truncate font-medium hover:text-royal-ink hover:underline">{t.workflow}</Link><span className="shrink-0 tabular text-ink-2">{fmtPct(t.shareOfRole)} of role</span></div>
                    {t.opportunityId ? <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-purple-ink"><Bot size={11} />{t.solution ?? OPP_TYPE_LABEL[t.type ?? ""]}<span className="text-ink-3">· {fmtNum(t.recoverableHoursPerWeek, 1)} h/wk · <Link href={`/app/opportunities/${t.opportunityId}`} className="text-royal-ink underline underline-offset-2">report</Link></span></div>
                      : <div className="mt-0.5 text-[11px] text-ink-3">Stays with the role (no automation opportunity)</div>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {submitFor && <SubmitModal d={submitFor} plan={plan} onClose={() => setSubmitFor(null)} value={planned.find((x) => x.d.key === submitFor.key)?.value ?? 0} />}
      {drill && <DrilldownModal open onClose={() => setDrill(null)} title={drill.title} drill={drill.drill} />}
    </div>
  );
}

function flat(r: CapacityRow) {
  return { name: r.name, people: r.headcount, observed_hrs_wk: Number(r.observedHoursPerWeek.toFixed(2)), repetitive_hrs_wk: Number(r.repetitiveHoursPerWeek.toFixed(2)), recoverable_hrs_wk: Number(r.recoverableHoursPerWeek.toFixed(2)), fte_released: Number(r.fteReleased.toFixed(3)), verified_hrs_wk: Number(r.verifiedHoursPerWeek.toFixed(2)), verified_fte: Number(r.verifiedFte.toFixed(3)) };
}

function SubmitModal({ d, plan, value, onClose }: { d: CapacityRow; plan: Plan; value: number; onClose: () => void }) {
  const [ev, setEv] = React.useState({ kind: "requisition_cancelled", ref: "", note: "" });
  const [busy, setBusy] = React.useState(false); const [res, setRes] = React.useState<{ ok: boolean; text: string } | null>(null);
  const submit = async () => {
    setBusy(true); setRes(null);
    const r = await submitCostAvoidance({ departmentKey: d.key, plannedHires: plan.hires[d.key] ?? 0, utilization: plan.utilization, basis: plan.basis, evidence: { kind: ev.kind, ref: ev.ref, note: ev.note || undefined } });
    setBusy(false); setRes(r.ok ? { ok: true, text: `Submitted ${fmtUSD(r.amount)}/yr for finance approval.` } : { ok: false, text: r.error });
  };
  return (
    <Modal open onClose={onClose} title={`Submit cost avoidance — ${d.name}`}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-testid="tx-submit-form">
        <p className="text-sm">Amount (recomputed on the server): <b className="text-gold-ink">{fmtUSD(value)}</b>/yr · {plan.basis} capacity · {Math.round(plan.utilization * 100)}% utilization.</p>
        <p className="rounded-lg bg-coral-soft/60 p-2 text-xs text-ink-2">Cost avoidance must cite evidence that a planned expense was not incurred (e.g. a cancelled requisition). It enters the savings ledger as <em>submitted</em> and counts only after a different person approves it.</p>
        <Select label="Evidence type" value={ev.kind} onChange={(e) => setEv({ ...ev, kind: e.target.value })} data-testid="tx-ev-kind"><option value="requisition_cancelled">Requisition cancelled / not opened</option><option value="budget_revision">Approved budget revision</option><option value="hiring_plan">Signed hiring-plan change</option><option value="other">Other document</option></Select>
        <Input label="Reference (document ID or link)" value={ev.ref} onChange={(e) => setEv({ ...ev, ref: e.target.value })} required minLength={2} placeholder="e.g. REQ-2026-114" data-testid="tx-ev-ref" />
        <Input label="Note (optional)" value={ev.note} onChange={(e) => setEv({ ...ev, note: e.target.value })} data-testid="tx-ev-note" />
        {res && <p role="status" className={res.ok ? "text-sm text-emerald-ink" : "text-sm text-coral-ink"}>{res.text}</p>}
        <div className="flex gap-2"><Button type="submit" loading={busy} disabled={res?.ok} data-testid="tx-submit-save"><Send size={14} />Submit for approval</Button><Button type="button" variant="ghost" onClick={onClose}>Close</Button></div>
      </form>
    </Modal>
  );
}
