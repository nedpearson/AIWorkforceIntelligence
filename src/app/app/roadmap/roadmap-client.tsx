"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Route, FolderKanban, Wallet, PiggyBank, AlertTriangle, Plus, Sparkles, KanbanSquare, GanttChartSquare, ListOrdered, Presentation, ArrowRight, Flag } from "lucide-react";
import type { CalcTree } from "@/db/schema";
import type { RoadmapData, RoadmapProject } from "@/engine/roadmap";
import { Button, Empty, Input, Modal, PageHeader } from "@/components/ui";
import { KpiCard, SectionHeader, Segmented, StatusPill, ExportButton, Meter, InsightCard } from "@/components/ui/enterprise";
import { DrilldownModal, type Drill } from "@/components/dashboard/stat-tile";
import { Kanban, type KanbanCard } from "@/components/roadmap/kanban";
import { Gantt } from "@/components/roadmap/gantt";
import { ProjectDrawer } from "@/components/roadmap/project-drawer";
import { cn, fmtUSD, fmtNum } from "@/lib/utils";
import { moveProject, saveProject } from "./actions";
import { createProjectFromOpportunity } from "../opportunities/actions";

type View = "kanban" | "gantt" | "timeline" | "summary";
type Kpis = { projects: number; active: number; budget: number; spent: number; target: number; verified: number; realized: number; atRisk: number };

export function RoadmapClient({ data, kpis, trees, blockers, canWrite, initialProject, initialView, today }: {
  data: Omit<RoadmapData, "si">; kpis: Kpis; trees: Record<string, CalcTree>; blockers: Record<string, string | null>; canWrite: boolean; initialProject: string | null; initialView: string | null; today: string;
}) {
  const router = useRouter(); const pathname = usePathname(); const sp = useSearchParams();
  const [view, setView] = React.useState<View>((["kanban", "gantt", "timeline", "summary"].includes(initialView ?? "") ? initialView : "kanban") as View);
  const [openId, setOpenId] = React.useState<string | null>(initialProject);
  const [drill, setDrill] = React.useState<{ title: string; drill: Drill } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null); const [err, setErr] = React.useState("");
  const [newOpen, setNewOpen] = React.useState(false); const [newName, setNewName] = React.useState("");
  React.useEffect(() => { setOpenId(sp.get("project")); }, [sp]);
  const setUrl = (k: string, v: string | null) => { const q = new URLSearchParams(sp.toString()); if (v) q.set(k, v); else q.delete(k); router.replace(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }); };
  const openProject = (id: string | null) => { setOpenId(id); setUrl("project", id); };
  const pickView = (v: View) => { setView(v); setUrl("view", v === "kanban" ? null : v); };

  const attentionBy = (pid: string) => data.attention.filter((a) => a.projectId === pid);
  const cards: KanbanCard[] = data.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, targetAnnualSavings: p.targetAnnualSavings, verified: p.savings.verifiedTime.amount, milestonesDone: p.milestones.filter((m) => m.status === "done").length, milestones: p.milestones.length, attention: attentionBy(p.id).length, verifiedAt: p.verifiedAt, priorityScore: p.priorityScore }));
  const move = async (id: string, status: string) => { setBusy(id); setErr(""); const r = await moveProject({ id, status }); setBusy(null); if (!r.ok) setErr(r.error); else router.refresh(); };
  const fromCandidate = async (oppId: string) => { setBusy(oppId); setErr(""); const r = await createProjectFromOpportunity({ id: oppId }); setBusy(null); if (!r.ok) { setErr(r.error); return; } router.refresh(); openProject(r.projectId); };
  const createBlank = async () => { setBusy("new"); setErr(""); const r = await saveProject({ name: newName }); setBusy(null); if (!r.ok) { setErr(r.error); return; } setNewOpen(false); setNewName(""); router.refresh(); if (r.id) openProject(r.id); };
  const open = data.projects.find((p) => p.id === openId) ?? null;

  const header = <PageHeader hero eyebrow="Transformation" icon={<Route size={22} className="text-cyan-300" />} title="Transformation Roadmap"
    subtitle="Turn approved opportunities into funded projects: milestones, risks, budget and the savings they actually deliver — verified, not promised."
    actions={<>{canWrite && <Button variant="glass" onClick={() => setNewOpen(true)} data-testid="roadmap-new"><Plus size={15} />New project</Button>}<Button variant="glass" href="/app/opportunities"><Sparkles size={15} />Opportunities</Button></>} />;

  const suggestions = (
    <div data-testid="roadmap-suggestions">
      <SectionHeader accent="gold" icon={<Sparkles size={16} />} title="Suggested next projects" subtitle="Auto-prioritized from opportunities not yet on the roadmap: financial impact 25 · complexity 15 · risk 15 · time savings 15 · integrations 10 · data readiness 10 · payback 10." />
      {data.candidates.length === 0 ? <Empty title="Every open opportunity is already on the roadmap" body="New opportunities appear here after the next analysis run." /> : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 stagger">
          {data.candidates.slice(0, 6).map((c, i) => (
            <div key={c.opportunityId} className="card card-hover relative overflow-hidden p-4" data-testid={`candidate-${c.opportunityId}`}>
              <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-gold to-coral" />
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-xl bg-gold-soft text-gold-ink"><span className="text-[9px] font-semibold leading-none">#{i + 1}</span><span className="text-xs font-bold leading-none tabular">{Math.round(c.priorityScore)}</span></span>
                <div className="min-w-0 flex-1"><Link href={`/app/opportunities/${c.opportunityId}`} className="text-sm font-semibold hover:text-royal-ink hover:underline">{c.title}</Link>
                  <div className="mt-0.5 text-xs text-ink-2"><span className="font-semibold text-gold-ink tabular">{fmtUSD(c.realizableAnnual, { compact: true })}/yr</span> · {fmtNum(c.hoursRecoverablePerWeek, 1)} hrs/wk · payback {c.paybackMonths == null ? "not reached" : `${fmtNum(c.paybackMonths, 0)} mo`}</div></div>
              </div>
              <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1">{c.parts.map((p) => <li key={p.key} className="text-[10px] text-ink-2"><div className="flex justify-between"><span>{p.label}</span><span className="tabular">{p.contribution.toFixed(1)}/{p.weight}</span></div><Meter value={p.value} accent="gold" label={p.label} /></li>)}</ul>
              {canWrite && <Button size="sm" className="mt-3 w-full" loading={busy === c.opportunityId} onClick={() => fromCandidate(c.opportunityId)} data-testid={`candidate-create-${c.opportunityId}`}><Plus size={13} />Create project</Button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const newModal = (
    <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New transformation project">
      <form onSubmit={(e) => { e.preventDefault(); void createBlank(); }} className="space-y-3" data-testid="roadmap-new-form">
        <Input label="Project name" value={newName} onChange={(e) => setNewName(e.target.value)} required minLength={2} autoFocus data-testid="roadmap-new-name" />
        <p className="text-xs text-ink-2">Tip: projects created from a suggested opportunity come prefilled with target savings, budget and priority from the engines.</p>
        {err && <p role="alert" className="text-xs text-coral-ink">{err}</p>}
        <Button type="submit" loading={busy === "new"} data-testid="roadmap-new-save">Create project</Button>
      </form>
    </Modal>
  );

  if (data.projects.length === 0) return (
    <div className="space-y-5">
      {header}
      <Empty title="No transformation projects yet" body={data.candidates.length ? `Start with your top-ranked opportunity — “${data.candidates[0].title}” — worth ${fmtUSD(data.candidates[0].realizableAnnual)}/yr realizable. Creating a project prefills its target savings, budget and priority.` : "Run the analysis to discover opportunities, then plan projects for them here."}
        action={canWrite && data.candidates.length ? <Button className="mt-2" loading={busy === data.candidates[0].opportunityId} onClick={() => fromCandidate(data.candidates[0].opportunityId)} data-testid="roadmap-empty-create"><Plus size={15} />Create project from top opportunity</Button> : <Button className="mt-2" href="/app/opportunities">Review opportunities</Button>} />
      {err && <p role="alert" className="text-sm text-coral-ink">{err}</p>}
      {suggestions}
      {newModal}
    </div>
  );

  const exportRows = data.projects.map((p) => ({ project: p.name, status: p.status, owner: p.ownerEmail ?? "", start: p.startDate?.slice(0, 10) ?? "", target_date: p.targetDate?.slice(0, 10) ?? "", budget: p.budget, spent: p.spent, target_annual_savings: Math.round(p.targetAnnualSavings), verified_annual_savings: Math.round(p.savings.verifiedTime.amount), realized_annual: Math.round(p.savings.realizedAnnual), milestones: p.milestones.length, milestones_done: p.milestones.filter((m) => m.status === "done").length, open_risks: p.risks.filter((r) => r.status === "open").length, verified: p.verifiedAt ? "yes" : "no", opportunities: p.opportunities.map((o) => o.title).join("; ") }));

  return (
    <div className="space-y-5">
      {header}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 stagger">
        <KpiCard testid="kpi-rm-projects" label="Projects" value={kpis.projects} format={(n) => fmtNum(n, 0)} accent="royal" icon={<FolderKanban size={16} />} caption={`${kpis.active} active · ${data.projects.filter((p) => p.verifiedAt).length} verified`} />
        <KpiCard testid="kpi-rm-budget" label="Spent vs budget" value={kpis.spent} format={(n) => fmtUSD(n, { compact: true })} accent="cyan" basis="observed" icon={<Wallet size={16} />} caption={`of ${fmtUSD(kpis.budget, { compact: true })} budget${kpis.budget ? ` · ${Math.round((kpis.spent / kpis.budget) * 100)}%` : ""}`} onClick={() => setDrill({ title: "Budget vs spent", drill: { tree: trees.budget, meaning: "What has been spent on each project against its approved budget. Spent feeds the savings engine's attributable cost." } })} />
        <KpiCard testid="kpi-rm-savings" label="Verified savings / yr" value={kpis.verified} format={(n) => fmtUSD(n, { compact: true })} accent="emerald" basis="observed" icon={<PiggyBank size={16} />} caption={<>target <span className="font-semibold text-gold-ink">{fmtUSD(kpis.target, { compact: true })}</span>{kpis.realized > 0 && <> · realized {fmtUSD(kpis.realized, { compact: true })}</>}</>} onClick={() => setDrill({ title: "Verified savings on roadmap projects", drill: { tree: trees.savings, meaning: "Measured, annualized savings from the agents delivering each project — taken from the Savings Intelligence Engine's lineage, never a separate number." } })} />
        <KpiCard testid="kpi-rm-risk" label="Needs attention" value={kpis.atRisk} format={(n) => fmtNum(n, 0)} accent="coral" icon={<AlertTriangle size={16} />} caption="overdue milestones · blocked dependencies · unmitigated high risks" />
      </div>

      {data.attention.length > 0 && (
        <div className="card border-coral/30 p-4" data-testid="roadmap-attention" role="region" aria-label="Attention">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold text-coral-ink"><AlertTriangle size={16} />Attention ({data.attention.length})</div>
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {data.attention.slice(0, 8).map((a) => { const p = data.projects.find((x) => x.id === a.projectId); return (
              <li key={a.kind + a.refId}><button type="button" onClick={() => openProject(a.projectId)} className="flex w-full items-start gap-2 rounded-xl bg-coral-soft/50 px-3 py-2 text-left text-xs hover:bg-coral-soft" data-testid={`attention-${a.refId}`}>
                <span className="mt-0.5 rounded bg-coral px-1.5 text-[9px] font-bold uppercase text-white">{a.kind === "overdue" ? "Overdue" : a.kind === "blocked_dependency" ? "Blocked" : "High risk"}</span>
                <span className="min-w-0"><span className="font-semibold text-ink">{a.title}</span> <span className="text-ink-2">— {a.detail}</span><span className="block text-[10px] text-ink-3">{p?.name}</span></span>
              </button></li>); })}
          </ul>
        </div>
      )}

      <SectionHeader accent="royal" title="Portfolio" subtitle="Drag cards between columns (or use “Move to”) to update status. Click a project for milestones, risks, savings and verification."
        action={<div className="flex flex-wrap items-center gap-2"><Segmented testid="roadmap-view" size="sm" value={view} onChange={pickView} options={[
          { key: "kanban", label: <span className="inline-flex items-center gap-1"><KanbanSquare size={13} />Kanban</span> },
          { key: "gantt", label: <span className="inline-flex items-center gap-1"><GanttChartSquare size={13} />Gantt</span> },
          { key: "timeline", label: <span className="inline-flex items-center gap-1"><ListOrdered size={13} />Timeline</span> },
          { key: "summary", label: <span className="inline-flex items-center gap-1"><Presentation size={13} />Executive</span> },
        ]} /><ExportButton rows={exportRows} filename="transformation-roadmap" testid="roadmap-export" /></div>} />
      {err && <p role="alert" className="text-sm text-coral-ink">{err}</p>}

      {view === "kanban" && <Kanban cards={cards} canWrite={canWrite} onMove={move} onOpen={openProject} busyId={busy} />}
      {view === "gantt" && <div className="card p-4"><Gantt projects={data.projects} today={today} onSelect={openProject} /></div>}
      {view === "timeline" && <Timeline projects={data.projects} onOpen={openProject} today={today} />}
      {view === "summary" && <Summary projects={data.projects} kpis={kpis} attention={data.attention.length} onOpen={openProject} />}

      {suggestions}
      <ProjectDrawer project={open} open={!!open} onClose={() => openProject(null)} canWrite={canWrite} members={data.members} blocker={open ? blockers[open.id] ?? null : null} attention={open ? attentionBy(open.id) : []}
        opportunities={data.opportunities.map((o) => ({ id: o.id, label: `${o.title} · ${fmtUSD(o.realizableAnnual, { compact: true })}/yr${o.status === "rejected" ? " (rejected)" : ""}` }))}
        agents={data.agents.map((a) => ({ id: a.id, label: `${a.name} (${a.status})` }))} />
      {newModal}
      {drill && <DrilldownModal open onClose={() => setDrill(null)} title={drill.title} drill={drill.drill} />}
    </div>
  );
}

function Timeline({ projects, onOpen, today }: { projects: RoadmapProject[]; onOpen: (id: string) => void; today: string }) {
  const now = new Date(today).getTime();
  const items = projects.flatMap((p) => p.milestones.map((m) => ({ p, m }))).sort((a, b) => (a.m.dueDate ?? "9999").localeCompare(b.m.dueDate ?? "9999"));
  return (
    <div className="card p-5" data-testid="roadmap-timeline">
      {items.length === 0 ? <p className="text-sm text-ink-2">No milestones yet — open a project to add some.</p> : (
        <ol className="relative space-y-3 border-l-2 border-border pl-5">
          {items.map(({ p, m }) => { const overdue = m.status !== "done" && m.dueDate && new Date(m.dueDate).getTime() < now; return (
            <li key={m.id} className="relative">
              <span className={cn("absolute -left-[27px] top-1 h-3 w-3 rounded-full ring-4 ring-surface", m.status === "done" ? "bg-emerald" : overdue ? "bg-coral" : m.status === "in_progress" ? "bg-cyan" : "bg-surface-3")} />
              <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold tabular text-ink-2">{m.dueDate ? new Date(m.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "No due date"}</span><StatusPill status={overdue ? "blocked" : m.status} />{overdue && <span className="text-[10px] font-bold uppercase text-coral-ink">overdue</span>}</div>
              <div className="text-sm font-semibold">{m.name}</div>
              <button type="button" onClick={() => onOpen(p.id)} className="text-xs text-royal-ink hover:underline">{p.name}</button>
            </li>); })}
        </ol>
      )}
    </div>
  );
}

function Summary({ projects, kpis, attention, onOpen }: { projects: RoadmapProject[]; kpis: Kpis; attention: number; onOpen: (id: string) => void }) {
  const live = projects.filter((p) => ["live", "measuring", "closed"].includes(p.status)).length;
  const pct = kpis.target > 0 ? kpis.verified / kpis.target : 0;
  return (
    <div className="space-y-4" data-testid="roadmap-summary">
      <InsightCard accent="indigo" title="Executive summary" body={<>
        {projects.length} transformation project{projects.length === 1 ? "" : "s"} on the roadmap ({live} live or measuring) targeting <b className="text-gold-ink">{fmtUSD(kpis.target)}</b> per year.
        Verified so far: <b className="text-emerald-ink">{fmtUSD(kpis.verified)}</b>/yr ({Math.round(pct * 100)}% of target){kpis.realized > 0 ? <>, of which {fmtUSD(kpis.realized)}/yr is evidenced hard savings or cost avoidance</> : null}.
        Spent {fmtUSD(kpis.spent)} of {fmtUSD(kpis.budget)} budget. {attention ? `${attention} item${attention === 1 ? "" : "s"} need attention.` : "Nothing needs attention."}
      </>} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {projects.map((p) => {
          const done = p.milestones.filter((m) => m.status === "done").length; const next = p.milestones.find((m) => m.status !== "done"); const topRisk = p.risks.find((r) => r.status === "open");
          return (
            <button type="button" key={p.id} onClick={() => onOpen(p.id)} className="card card-hover p-4 text-left" data-testid={`summary-${p.id}`}>
              <div className="flex items-start justify-between gap-2"><span className="text-sm font-bold">{p.name}</span><StatusPill status={p.status} /></div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><div><div className="text-ink-3">Target / yr</div><div className="font-bold tabular text-gold-ink">{fmtUSD(p.targetAnnualSavings, { compact: true })}</div></div><div><div className="text-ink-3">Verified / yr</div><div className="font-bold tabular text-emerald-ink">{p.savings.verifiedTime.amount ? fmtUSD(p.savings.verifiedTime.amount, { compact: true }) : "—"}</div></div></div>
              <div className="mt-3"><div className="mb-1 flex justify-between text-[11px] text-ink-2"><span>Milestones</span><span>{done}/{p.milestones.length}</span></div><Meter value={p.milestones.length ? (done / p.milestones.length) * 100 : 0} accent="cyan" label="Milestones done" /></div>
              <div className="mt-3 space-y-1 text-[11px] text-ink-2">
                <div className="flex items-center gap-1"><Flag size={11} />Next: {next ? `${next.name}${next.dueDate ? ` · ${next.dueDate.slice(0, 10)}` : ""}` : "—"}</div>
                <div className="flex items-center gap-1"><AlertTriangle size={11} />Top risk: {topRisk ? `${topRisk.title} (${topRisk.severity * topRisk.likelihood}/25)` : "none open"}</div>
              </div>
              <span className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-royal-ink">Open project <ArrowRight size={12} /></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
