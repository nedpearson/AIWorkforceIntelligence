"use client";
import * as React from "react";
import Link from "next/link";
import { Wand2, Search, ShieldCheck, Undo2, Plug, CalendarClock, Sparkles, Workflow, Lightbulb, FlaskConical, Bot, LayoutGrid, Plus, X } from "lucide-react";
import { Button, Empty, PageHeader, Table, Th, Td } from "@/components/ui";
import { KpiCard, FilterBar, SectionHeader, StatusPill, type FilterDef, type Accent } from "@/components/ui/enterprise";
import { fmtNum, fmtUSD, cn } from "@/lib/utils";
import { BUSINESS_FUNCTIONS, type BusinessFunction } from "@/engine/agents/templates";

export type GalleryCard = {
  key: string; name: string; description: string; fn: BusinessFunction; useCase: string; category: string; runtime: string; nodeCount: number; schedule: string | null;
  baselineMinutesPerRun: number; expectedMinutesSavedPerRun: number; monthlyCost: number;
  connections: { provider: string; label: string; have: boolean }[]; gates: string[]; writes: number; undoable: number; llm: boolean;
  matchedWorkflows: { id: string; name: string; apps: string[]; hoursPerWeek: number }[]; matchedWorkflowCount: number;
  matchedOpps: { id: string; title: string; realizable: number; workflow: string | null; basis: "observed" | "estimated" | "assumed" }[]; apps: string[];
};
export type FlowRow = { id: string; name: string; status: string; runtime: string; fn: BusinessFunction; templateKey: string; nodes: number; edges: number; gates: number; schedule: string | null; updatedAt: string; lastTest: { id: string; status: string; at: string } | null };
export type TestRunRow = { id: string; agentId: string; agentName: string; status: string; at: string; error: string | null; steps: number; requests: number };

const FN_ACCENT: Record<BusinessFunction, Accent> = { finance: "emerald", sales: "royal", operations: "cyan", customer_service: "purple", hr: "indigo", marketing: "gold" };
const TILE: Record<Accent, string> = { royal: "bg-royal-soft text-royal-ink", purple: "bg-purple-soft text-purple-ink", cyan: "bg-cyan-soft text-cyan-ink", emerald: "bg-emerald-soft text-emerald-ink", gold: "bg-gold-soft text-gold-ink", coral: "bg-coral-soft text-coral-ink", indigo: "bg-indigo-soft text-indigo-ink", midnight: "bg-surface-2 text-ink" };
const ago = (iso: string) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

export function AutomationStudio({ cards, totalTemplates, flows, tests, filterDefs, stats, canWrite }: { cards: GalleryCard[]; totalTemplates: number; flows: FlowRow[]; tests: TestRunRow[]; filterDefs: FilterDef[]; stats: { matched: number; ready: number; opportunities: number; workflows: number }; canWrite: boolean }) {
  const [q, setQ] = React.useState("");
  const [flowQ, setFlowQ] = React.useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle ? cards.filter((c) => `${c.name} ${c.description} ${c.useCase} ${c.apps.join(" ")} ${c.connections.map((x) => x.label).join(" ")}`.toLowerCase().includes(needle)) : cards;
  const groups = BUSINESS_FUNCTIONS.map((f) => ({ f, byUse: f.useCases.map((u) => ({ u, list: shown.filter((c) => c.fn === f.key && c.useCase === u) })).filter((x) => x.list.length) })).filter((g) => g.byUse.length);
  const flowsShown = flowQ.trim() ? flows.filter((f) => f.name.toLowerCase().includes(flowQ.trim().toLowerCase())) : flows;
  return (
    <div className="space-y-5">
      <PageHeader hero eyebrow="Automation" icon={<Wand2 size={22} className="text-cyan-300" />} title="Automation Studio"
        subtitle="Production-ready agent templates for every business function — real node graphs with human approval on sensitive steps and an undo for every external write. Pick one, connect your systems, dry-run it, deploy."
        actions={<><Button variant="glass" href="/app/agents" data-testid="studio-to-agents"><Bot size={15} />Agent Command Center</Button><Button variant="glass" href="/app/integrations" data-testid="studio-to-integrations"><Plug size={15} />Integrations</Button></>} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 stagger">
        <KpiCard testid="studio-kpi-templates" label="Templates" value={totalTemplates} format={(n) => fmtNum(n)} accent="cyan" icon={<LayoutGrid size={16} />} caption="6 business functions" />
        <KpiCard testid="studio-kpi-matched" label="Fit your discovered work" value={stats.matched} format={(n) => fmtNum(n)} accent="purple" basis="observed" icon={<Lightbulb size={16} />} caption={stats.workflows + stats.opportunities ? `matched against ${stats.workflows} workflows · ${stats.opportunities} opportunities` : "run an analysis to match templates"} />
        <KpiCard testid="studio-kpi-ready" label="Connections already in vault" value={stats.ready} format={(n) => fmtNum(n)} accent="emerald" basis="observed" icon={<Plug size={16} />} caption="templates with every credential present" />
        <KpiCard testid="studio-kpi-flows" label="My flows" value={flows.length} format={(n) => fmtNum(n)} accent="royal" icon={<Workflow size={16} />} caption={`${tests.length ? `${tests.length} recent test run${tests.length === 1 ? "" : "s"}` : "no test runs yet"}`} />
      </div>

      <FilterBar filters={filterDefs} testid="studio-filter" extra={
        <label className="relative ml-auto flex min-w-0 flex-1 items-center sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-2.5 text-ink-3" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates, apps, systems…" aria-label="Search templates" data-testid="studio-search" className="h-8 w-full rounded-lg border border-border bg-surface pl-8 pr-7 text-xs focus:border-royal focus:outline-none" />
          {q && <button onClick={() => setQ("")} aria-label="Clear search" className="absolute right-2 text-ink-3 hover:text-ink"><X size={13} /></button>}
        </label>} />

      {shown.length === 0 ? <Empty title="No templates match" body="Try another search term or clear the filters." /> : groups.map(({ f, byUse }) => (
        <section key={f.key} data-testid={`studio-group-${f.key}`}>
          <SectionHeader accent={FN_ACCENT[f.key]} title={f.label} subtitle={`${byUse.reduce((s, x) => s + x.list.length, 0)} template(s) · ${byUse.map((x) => x.u).join(" · ")}`} />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 stagger">
            {byUse.flatMap(({ list }) => list).map((c) => <TemplateCard key={c.key} c={c} canWrite={canWrite} />)}
          </div>
        </section>
      ))}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <section className="min-w-0" data-testid="studio-flows">
          <SectionHeader accent="royal" icon={<Workflow size={16} />} title="My flows" subtitle="Every agent definition in this organization."
            action={<input type="search" value={flowQ} onChange={(e) => setFlowQ(e.target.value)} placeholder="Filter flows…" aria-label="Filter flows" data-testid="studio-flows-search" className="h-8 w-44 rounded-lg border border-border bg-surface px-2 text-xs focus:border-royal focus:outline-none" />} />
          {flows.length === 0 ? <Empty title="No flows yet" body="Use a template above to create your first agent. It starts as a draft — dry-run it in the test environment before deploying." /> : (
            <Table>
              <thead><tr><Th>Flow</Th><Th>Status</Th><Th className="text-right">Nodes</Th><Th className="text-right">Gates</Th><Th>Schedule</Th><Th>Last test run</Th></tr></thead>
              <tbody>{flowsShown.map((f) => (
                <tr key={f.id} className="hover:bg-surface-2" data-testid={`flow-row-${f.id}`}>
                  <Td><Link href={`/app/agents/${f.id}?tab=flow`} className="font-semibold text-royal-ink hover:underline">{f.name}</Link><div className="text-[11px] text-ink-3">{BUSINESS_FUNCTIONS.find((x) => x.key === f.fn)?.label} · {f.runtime} · <span suppressHydrationWarning>edited {ago(f.updatedAt)}</span></div></Td>
                  <Td><StatusPill status={f.status} /></Td>
                  <Td className="text-right tabular">{f.nodes}<span className="text-ink-3"> / {f.edges}e</span></Td>
                  <Td className="text-right tabular">{f.gates}</Td>
                  <Td className="text-xs text-ink-2">{f.schedule ?? "on trigger"}</Td>
                  <Td>{f.lastTest ? <Link href={`/app/agents/${f.id}?tab=test`} className="inline-flex items-center gap-1.5 text-xs hover:underline"><StatusPill status={f.lastTest.status} /><span className="text-ink-3" suppressHydrationWarning>{ago(f.lastTest.at)}</span></Link> : <Link href={`/app/agents/${f.id}?tab=test`} className="text-xs font-semibold text-purple-ink hover:underline">Run a test →</Link>}</Td>
                </tr>))}
                {flowsShown.length === 0 && <tr><Td colSpan={6} className="text-center text-xs text-ink-3">No flows match.</Td></tr>}
              </tbody>
            </Table>
          )}
        </section>
        <section className="min-w-0" data-testid="studio-tests">
          <SectionHeader accent="purple" icon={<FlaskConical size={16} />} title="Recent test runs" subtitle="Dry runs — nothing external was called." />
          {tests.length === 0 ? <div className="card p-4 text-xs text-ink-2">No test runs yet. Open a flow and use <span className="font-semibold">Test run</span> to see exactly which requests it would send.</div> : (
            <ol className="card divide-y divide-border p-0">{tests.map((t) => (
              <li key={t.id}><Link href={`/app/agents/${t.agentId}?tab=test`} className="flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-surface-2" data-testid={`studio-test-${t.id}`}>
                <div className="min-w-0"><div className="truncate text-sm font-semibold">{t.agentName}</div><div className="text-[11px] text-ink-3" suppressHydrationWarning>{ago(t.at)} · {t.steps} log lines · {t.requests} request{t.requests === 1 ? "" : "s"} captured</div>{t.error && <div className="truncate text-[11px] text-coral-ink">{t.error}</div>}</div>
                <StatusPill status={t.status} />
              </Link></li>))}</ol>
          )}
        </section>
      </div>
      <p className="text-[11px] text-ink-3">Minutes per run are assumed baselines from the template until the run ledger measures them. Matching uses the apps observed in your discovered workflows and each opportunity&apos;s recommended agent category.</p>
    </div>
  );
}

function TemplateCard({ c, canWrite }: { c: GalleryCard; canWrite: boolean }) {
  const a = FN_ACCENT[c.fn];
  const firstOpp = c.matchedOpps[0];
  const missing = c.connections.filter((x) => !x.have).length;
  return (
    <article className="card card-hover flex min-w-0 flex-col p-4" data-testid={`template-card-${c.key}`}>
      <div className="flex items-start gap-3">
        <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl font-display text-sm font-bold", TILE[a])} aria-hidden>{c.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold leading-snug">{c.name}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]"><span className={cn("rounded-full px-2 py-0.5 font-semibold", TILE[a])}>{c.useCase}</span>{c.llm && <span className="inline-flex items-center gap-0.5 rounded-full bg-purple-soft px-2 py-0.5 font-semibold text-purple-ink"><Sparkles size={10} />AI step</span>}{c.schedule && <span className="inline-flex items-center gap-0.5 text-ink-3"><CalendarClock size={11} />{c.schedule}</span>}</div>
        </div>
      </div>
      <p className="mt-2 line-clamp-4 text-xs leading-relaxed text-ink-2">{c.description}</p>
      <div className="mt-3 space-y-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-1"><Plug size={12} className="text-ink-3" /><span className="font-semibold text-ink-2">Connections</span>
          {c.connections.map((x) => <span key={x.provider + x.label} className={cn("rounded-md px-1.5 py-0.5 font-medium", x.have ? "bg-emerald-soft text-emerald-ink" : "bg-surface-2 text-ink-2")} title={x.have ? "A credential for this provider is in the vault" : "Needs a credential"}>{x.have ? "✓ " : ""}{x.label}</span>)}
        </div>
        <div className="flex flex-wrap items-center gap-1"><ShieldCheck size={12} className="text-ink-3" /><span className="font-semibold text-ink-2">Approval gates</span>
          {c.gates.length ? <span className="rounded-md bg-indigo-soft px-1.5 py-0.5 font-medium text-indigo-ink" title={c.gates.join(" • ")} aria-label={`${c.gates.length} approval gate(s): ${c.gates.join("; ")}`} tabIndex={0}>{c.gates.length} gate{c.gates.length === 1 ? "" : "s"}</span> : <span className="text-ink-3">none{c.writes ? " (internal writes only)" : " (read-only)"}</span>}
          {c.writes > 0 && <span className="inline-flex items-center gap-0.5 text-ink-3"><Undo2 size={11} />{c.undoable}/{c.writes} writes undoable</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1"><Lightbulb size={12} className="text-ink-3" /><span className="font-semibold text-ink-2">In your org</span>
          {c.matchedOpps.length === 0 && c.matchedWorkflowCount === 0 ? <span className="text-ink-3">no matching workflows yet</span> : <>
            {c.matchedOpps.slice(0, 2).map((o) => <Link key={o.id} href={`/app/opportunities/${o.id}`} className="max-w-full break-words rounded-md bg-gold-soft px-1.5 py-0.5 font-medium text-gold-ink hover:underline" data-testid={`template-opp-${c.key}-${o.id}`}>{o.title} · {fmtUSD(o.realizable, { compact: true })}/yr</Link>)}
            {c.matchedWorkflowCount > 0 && <span className="rounded-md bg-cyan-soft px-1.5 py-0.5 font-medium text-cyan-ink" title={c.matchedWorkflows.map((w) => `${w.name} (${w.apps.join(", ")}, ${fmtNum(w.hoursPerWeek, 1)} h/wk)`).join(" • ")} tabIndex={0}>{c.matchedWorkflowCount} workflow{c.matchedWorkflowCount === 1 ? "" : "s"}</span>}
          </>}
        </div>
      </div>
      <div className="mt-auto pt-3"><div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-[11px] text-ink-3">{c.nodeCount} steps · ~{c.expectedMinutesSavedPerRun} of {c.baselineMinutesPerRun} min/run saved (assumed) · {fmtUSD(c.monthlyCost)}/mo</span>
        {canWrite ? <div className="flex gap-1.5">
          {firstOpp && <Button size="sm" variant="secondary" href={`/app/agents/new?template=${c.key}&opportunityId=${firstOpp.id}`} data-testid={`template-use-opp-${c.key}`}>For this opportunity</Button>}
          <Button size="sm" href={`/app/agents/new?template=${c.key}`} data-testid={`template-use-${c.key}`}><Plus size={13} />Use template</Button>
        </div> : <span className="text-[11px] text-ink-3">{missing ? `${missing} connection(s) needed` : "view only"}</span>}
      </div></div>
    </article>
  );
}
