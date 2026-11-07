"use client";
import * as React from "react";
import Link from "next/link";
import { Network, Workflow, GitBranch, ArrowLeftRight, RotateCcw, Layers, ExternalLink, AlertTriangle, Plug } from "lucide-react";
import type { OrgProcessMining } from "@/engine/process-mining-org";
import type { CalcTree } from "@/db/schema";
import { Button, Empty, PageHeader, Table, Th, Td, Card, Tooltip } from "@/components/ui";
import { KpiCard, SectionHeader, FilterBar, Drawer, StatusPill, Meter, ExportButton } from "@/components/ui/enterprise";
import { ProcessGraph } from "@/components/process/process-graph";
import { HandoffHeatmap } from "@/components/process/handoff-heatmap";
import { DataViewCard } from "@/components/process/data-view-card";
import { DrillDrawer } from "@/components/process/drill";
import type { ProviderCard } from "@/components/process/providers";
import { fmtNum, fmtPct, fmtUSD, cn } from "@/lib/utils";

type DrillKey = keyof OrgProcessMining["trees"];
const secs = (ms: number) => (ms >= 60_000 ? `${fmtNum(ms / 60_000, 1)} min` : `${fmtNum(ms / 1000, 0)} s`);

export function ProcessMiningClient({ pm, providers }: { pm: OrgProcessMining; providers: ProviderCard[] }) {
  const [drill, setDrill] = React.useState<DrillKey | null>(null);
  const [node, setNode] = React.useState<string | null>(null);
  const [variantWf, setVariantWf] = React.useState<string>(pm.workflows[0]?.id ?? "");
  const filters = [
    { key: "bu", label: "Business unit", all: "All business units", options: pm.options.businessUnits.map((b) => ({ value: b.id, label: b.name })) },
    { key: "loc", label: "Location", all: "All locations", options: pm.options.locations.map((l) => ({ value: l.id, label: l.name })) },
    { key: "dept", label: "Department", all: "All departments", options: pm.options.departments.map((d) => ({ value: d.id, label: d.name })) },
    { key: "wf", label: "Workflow", all: "All workflows", options: pm.options.workflows.map((w) => ({ value: w.id, label: w.name })) },
  ];
  const header = <PageHeader hero eyebrow="Intelligence" icon={<Network size={22} />} title="Process Mining" accent="cyan"
    subtitle="Every workflow your collectors discovered, merged into one organization-wide process graph — with variants, bottlenecks, rework and department hand-offs." />;
  const filterBar = <FilterBar filters={filters} testid="pm-filters" />;
  const anyFilter = !!(pm.filters.bu || pm.filters.dept || pm.filters.loc || pm.filters.wf);

  const providerPanel = (
    <>
      <SectionHeader accent="purple" icon={<Plug size={16} />} title="Provider connectors" subtitle="External process-mining tools. None are connected — every number on this page comes from BridgeBox desktop collectors." />
      <div className="stagger grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="pm-providers">
        {providers.map((p) => (
          <Card key={p.key} className="card-hover" data-testid={`provider-${p.key}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{p.name}</div><div className="text-sm font-bold">{p.product}</div></div>
              <StatusPill status={p.status} map={{ not_built: "midnight" }} />
            </div>
            <p className="mt-2 text-xs text-ink-2">{p.requirement}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">{p.envVars.map((v) => <code key={v} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">{v}</code>)}</div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
              <a href={p.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-royal-ink hover:underline" data-testid={`provider-${p.key}-docs`}>Vendor documentation<ExternalLink size={12} /></a>
              <span className="text-ink-3">{p.built ? "Adapter implemented against the documented export shape; import blocked until licensed." : "Connector not built."}</span>
            </div>
          </Card>
        ))}
      </div>
    </>
  );

  if (!pm.workflows.length) return (
    <div data-testid="process-mining-page">{header}{filterBar}
      <Empty title={anyFilter ? "No processes match these filters" : "No processes discovered yet"} body={anyFilter ? "Clear a filter to see the organization-wide graph." : "Processes appear once desktop collectors have recorded activity and an analysis run has mined workflows."}
        action={<div className="flex flex-wrap justify-center gap-2">{anyFilter ? <Button href="/app/process-mining" data-testid="pm-empty-clear">Clear filters</Button> : <><Button href="/app/collection" data-testid="pm-empty-collectors">Enroll collectors</Button><Button variant="secondary" href="/app/onboarding" data-testid="pm-empty-onboarding">Rollout checklist</Button></>}</div>} />
      {providerPanel}
    </div>
  );

  const k = pm.kpis;
  const sel = node ? pm.graph.nodes.find((n) => n.id === node) ?? null : null;
  const det = node ? pm.nodeDetails[node] : null;
  const vw = pm.workflows.find((w) => w.id === variantWf) ?? pm.workflows[0];
  const hm = pm.handoffs;
  const tree = drill ? (pm.trees[drill] as CalcTree) : null;

  return (
    <div data-testid="process-mining-page">
      {header}
      {filterBar}
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5" data-testid="pm-kpis">
        <KpiCard testid="kpi-processes" label="Processes discovered" value={k.processes} format={(n) => fmtNum(n)} accent="cyan" basis="observed" icon={<Workflow size={16} />} caption="Mined from collector activity" onClick={() => setDrill("processes")} />
        <KpiCard testid="kpi-steps" label="Distinct steps" value={k.steps} format={(n) => fmtNum(n)} accent="royal" basis="observed" icon={<Layers size={16} />} caption={`${fmtNum(k.edges)} transitions`} onClick={() => setDrill("steps")} />
        <KpiCard testid="kpi-variants" label="Variants" value={k.variants} format={(n) => fmtNum(n)} accent="indigo" basis="observed" icon={<GitBranch size={16} />} caption="Distinct step sequences (sampled)" onClick={() => setDrill("variants")} />
        <KpiCard testid="kpi-handoffs" label="Hand-offs / week" value={k.handoffsPerWeek} format={(n) => fmtNum(n, 1)} accent="purple" basis="observed" icon={<ArrowLeftRight size={16} />} caption={`${fmtNum(hm.crossDeptPerWeek, 1)} cross-department`} onClick={() => setDrill("handoffs")} />
        <KpiCard testid="kpi-rework" label="Rework hours / week" value={k.reworkHoursPerWeek} format={(n) => fmtNum(n, 1)} accent="coral" basis="observed" icon={<RotateCcw size={16} />} caption={`${pm.conformance.length} workflow${pm.conformance.length === 1 ? "" : "s"} above 15% rework`} onClick={() => setDrill("rework")} />
      </div>

      <SectionHeader accent="cyan" title="Organization process graph" subtitle="All workflow process maps merged by step (application + action). Click a step for performers, workflows and linked opportunities."
        action={<ExportButton testid="graph-export" filename="process-graph-steps" rows={pm.graph.nodes.map((n) => ({ step: n.label, app: n.app, perWeek: Number(n.perWeek.toFixed(2)), avgSeconds: Math.round(n.avgMs / 1000), hoursPerWeek: Number(n.hoursPerWeek.toFixed(2)), reworkRate: Number(n.reworkRate.toFixed(4)), workflows: n.workflowIds.length }))} />} />
      <Card className="p-3 sm:p-4">
        <ProcessGraph nodes={pm.graph.nodes} edges={pm.graph.edges} selected={node} onSelect={setNode} />
      </Card>

      <SectionHeader accent="coral" icon={<AlertTriangle size={16} />} title="Bottlenecks" subtitle="Ranked by time load × rework × cross-department hand-off share." />
      <Table>
        <caption className="sr-only">Bottleneck ranking</caption>
        <thead><tr><Th>#</Th><Th>Step</Th><Th className="text-right">Avg time</Th><Th className="text-right">Per week</Th><Th className="text-right">Hrs / wk</Th><Th className="text-right">Rework</Th><Th className="text-right">Cross-dept hand-offs/wk</Th><Th className="text-right"><span className="inline-flex items-center gap-1">Score<Tooltip text="hours per week × (1 + rework rate) × (1 + share of executions that hand off to another department). A ranking aid, not a dollar figure." /></span></Th></tr></thead>
        <tbody>
          {pm.bottlenecks.slice(0, 10).map((b, i) => (
            <tr key={b.nodeId} className="hover:bg-surface-2">
              <Td className="text-ink-3">{i + 1}</Td>
              <Td className="min-w-[14rem]"><button type="button" onClick={() => setNode(b.nodeId)} className="text-left font-medium text-royal-ink hover:underline" data-testid={`bottleneck-${i}`}>{b.label}</button><div className="text-[11px] text-ink-3">{b.departments} department{b.departments === 1 ? "" : "s"}</div></Td>
              <Td className="text-right tabular">{secs(b.avgMs)}</Td>
              <Td className="text-right tabular">{fmtNum(b.perWeek, 0)}</Td>
              <Td className="text-right tabular font-semibold">{fmtNum(b.hoursPerWeek, 1)}</Td>
              <Td className={cn("text-right tabular", b.reworkRate > 0.15 && "font-semibold text-coral-ink")}>{fmtPct(b.reworkRate, 1)}</Td>
              <Td className="text-right tabular">{fmtNum(b.crossDeptHandoffsPerWeek, 1)}</Td>
              <Td className="text-right tabular">{fmtNum(b.score, 1)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div className="mt-8 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="min-w-0">
          <SectionHeader accent="indigo" icon={<GitBranch size={16} />} title="Variant explorer" subtitle={`Step sequences re-mined from up to 80 observed runs per workflow.`} />
          <Card>
            <label className="block text-xs font-medium text-ink-2" htmlFor="variant-wf">Workflow</label>
            <select id="variant-wf" value={vw?.id} onChange={(e) => setVariantWf(e.target.value)} data-testid="variant-workflow" className="mt-1 h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink">
              {pm.workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            {vw && (
              <div className="mt-4 space-y-3" data-testid="variant-list">
                <div className="text-xs text-ink-2">{fmtNum(vw.runsPerWeek, 1)} runs/wk · {fmtNum(vw.hoursPerWeek, 1)} hrs/wk · {vw.sampleRuns} runs sampled · <Link href={`/app/workflows/${vw.id}`} className="font-semibold text-royal-ink hover:underline">Open workflow</Link></div>
                {vw.variants.map((v, i) => (
                  <div key={v.signature} className={cn("rounded-xl border p-3", v.canonical ? "border-cyan/40 bg-cyan-soft/30" : "border-border")} data-testid={`variant-${i}`}>
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-xs"><span className="font-semibold">{v.canonical ? "Canonical path" : `Variant ${i}`}</span><span className="tabular text-ink-2">{v.sampleRuns} runs · {fmtPct(v.share)}</span></div>
                    <Meter value={v.share * 100} accent={v.canonical ? "cyan" : "indigo"} label={`${v.canonical ? "Canonical" : "Variant"} share ${fmtPct(v.share)}`} />
                    <ol className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-ink-2">{v.steps.map((s, j) => <li key={j} className="flex items-center gap-1"><span className="rounded-md bg-surface-2 px-1.5 py-0.5">{s}</span>{j < v.steps.length - 1 && <span aria-hidden className="text-ink-3">→</span>}</li>)}</ol>
                  </div>
                ))}
                {vw.sampleRuns === 0 && <p className="text-xs text-ink-3">No runs could be re-mined from this workflow&apos;s evidence sample; only the canonical path is shown.</p>}
              </div>
            )}
          </Card>
        </div>
        <div className="min-w-0">
          <SectionHeader accent="purple" icon={<ArrowLeftRight size={16} />} title="Department hand-offs" subtitle={`${fmtNum(hm.perWeek, 1)} per week · ${fmtNum(hm.crossDeptPerWeek, 1)} cross into another department`} />
          {hm.matrix.length === 0 ? <Empty title="No hand-offs observed" body="Collectors record a hand-off when work is sent to another person or team (e.g. an approval request)." /> : (
            <DataViewCard testid="chart-handoffs" title="Who hands work to whom" subtitle="Rows send, columns receive · diagonal = within the department (e.g. manager approvals)" filename="department-handoffs" height={Math.max(200, hm.departments.length * 56 + 40)}
              help="Targets are resolved from each hand-off's recipient: “manager” maps to the sender's manager's department, team names map to the matching department. Unmapped teams stay visible."
              summary={`Hand-offs per week: ${hm.matrix.map((m) => `${hm.departments.find((d) => d.key === m.from)?.name} to ${hm.departments.find((d) => d.key === m.to)?.name} ${fmtNum(m.perWeek, 1)}`).join("; ")}`}
              rows={hm.matrix.map((m) => ({ from: hm.departments.find((d) => d.key === m.from)?.name ?? m.from, to: hm.departments.find((d) => d.key === m.to)?.name ?? m.to, perWeek: Number(m.perWeek.toFixed(2)), observed: m.count }))}
              columns={[{ key: "from", label: "From" }, { key: "to", label: "To" }, { key: "perWeek", label: "Per week", align: "right" }, { key: "observed", label: "Observed", align: "right" }]}>
              <HandoffHeatmap departments={hm.departments} matrix={hm.matrix} />
            </DataViewCard>
          )}
        </div>
      </div>

      <SectionHeader accent="gold" icon={<RotateCcw size={16} />} title="Conformance hints" subtitle="Workflows where more than 15% of runs repeat an earlier step. Fix the loop before automating it." />
      {pm.conformance.length === 0 ? <Card className="text-sm text-ink-2" data-testid="conformance-empty">No workflow in scope exceeds 15% rework.</Card> : (
        <div className="stagger grid grid-cols-1 gap-3 lg:grid-cols-3" data-testid="conformance-list">
          {pm.conformance.map((c) => (
            <Card key={c.workflowId} className="card-hover">
              <div className="flex items-start justify-between gap-2"><Link href={`/app/workflows/${c.workflowId}`} className="text-sm font-bold text-royal-ink hover:underline" data-testid={`conformance-${c.workflowId}`}>{c.name}</Link><StatusPill status="high_rework" map={{ high_rework: "coral" }} /></div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div><div className="text-lg font-bold text-coral-ink tabular">{fmtPct(c.reworkRate)}</div><div className="text-[10px] text-ink-3">rework</div></div>
                <div><div className="text-lg font-bold tabular">{fmtNum(c.reworkHoursPerWeek, 1)}</div><div className="text-[10px] text-ink-3">rework hrs/wk</div></div>
                <div><div className="text-lg font-bold tabular">{fmtPct(c.canonicalShare)}</div><div className="text-[10px] text-ink-3">on canonical path</div></div>
              </div>
              <p className="mt-2 text-xs text-ink-2">{c.hint}</p>
            </Card>
          ))}
        </div>
      )}

      {providerPanel}

      <Drawer open={!!sel} onClose={() => setNode(null)} title={sel?.label ?? ""} testid="node-drawer">
        {sel && det && (
          <div className="space-y-5 text-sm">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[["Avg time", secs(sel.avgMs)], ["Per week", fmtNum(sel.perWeek, 0)], ["Hours / week", fmtNum(sel.hoursPerWeek, 1)], ["Rework", fmtPct(sel.reworkRate, 1)]].map(([l, v]) => <div key={l} className="rounded-xl bg-surface-2 p-2.5"><div className="text-[11px] text-ink-3">{l}</div><div className="font-bold tabular">{v}</div></div>)}
            </div>
            <div><h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-3">Workflows ({det.workflows.length})</h3><ul className="space-y-1">{det.workflows.map((w) => <li key={w.id}><Link className="text-royal-ink hover:underline" href={`/app/workflows/${w.id}`}>{w.name}</Link></li>)}</ul></div>
            <div><h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-3">Departments</h3><div className="flex flex-wrap gap-1.5">{det.departments.map((d) => <span key={d.id ?? "none"} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs">{d.name}</span>)}{!det.departments.length && <span className="text-xs text-ink-3">None assigned</span>}</div></div>
            <div><h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-3">Performers ({det.performers.length})</h3>
              <ul className="divide-y divide-border rounded-xl border border-border">{det.performers.map((p) => <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2"><Link href={`/app/employees/${p.id}`} className="text-royal-ink hover:underline">{p.name}</Link><span className="text-xs text-ink-2">{p.department ?? "—"} · {fmtNum(p.hoursPerWeek, 1)} hrs/wk on these workflows</span></li>)}</ul>
            </div>
            <div><h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-3">Linked opportunities ({det.opportunities.length})</h3>
              {det.opportunities.length ? <ul className="space-y-1.5">{det.opportunities.map((o) => <li key={o.id} className="flex items-center justify-between gap-2"><Link href={`/app/opportunities/${o.id}`} className="text-royal-ink hover:underline">{o.title}</Link><span className="flex items-center gap-2"><span className="text-xs font-semibold text-gold-ink tabular">{fmtUSD(o.realizableAnnual)}/yr</span><StatusPill status={o.status} /></span></li>)}</ul> : <p className="text-xs text-ink-3">No opportunity targets these workflows yet.</p>}
              <p className="mt-2 text-[11px] text-ink-3">Opportunity $ shown as stored projections (gold = projected). Time saved is not a payroll cut.</p>
            </div>
          </div>
        )}
      </Drawer>
      <DrillDrawer tree={tree} onClose={() => setDrill(null)} />
    </div>
  );
}
