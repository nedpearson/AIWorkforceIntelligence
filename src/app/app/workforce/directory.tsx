"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Bot, Users, CheckCircle2, Clock, BadgeDollarSign, Search, Plus, Network, Sparkles } from "lucide-react";
import type { CalcTree } from "@/db/schema";
import { PageHeader, Button, Modal, Empty } from "@/components/ui";
import { KpiCard, SectionHeader, FilterBar, type FilterDef } from "@/components/ui/enterprise";
import { CalcTreeView } from "@/components/calc-tree";
import { EmployeeCard, type CardEmployee } from "@/components/workforce/employee-card";
import { TEAM_ACCENT } from "@/components/workforce/avatar";
import { fmtNum, fmtUSD } from "@/lib/utils";
import { provisionAction } from "./actions";

type Kpis = { total: number; active: number; tasksThisMonth: number; verifiedHoursThisMonth: number; netBenefitThisMonth: number; trees: Record<"total" | "active" | "tasks" | "hours" | "net", CalcTree> };

export function Directory({ cards, total, kpis, teams, filterDefs, canWrite, recommendedKeys, recommendedNames }: {
  cards: CardEmployee[]; total: number; kpis: Kpis; teams: { key: string; label: string }[]; filterDefs: FilterDef[]; canWrite: boolean; recommendedKeys: string[]; recommendedNames: string[];
}) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [tree, setTree] = React.useState<CalcTree | null>(null);
  const [busy, setBusy] = React.useState<"rec" | "all" | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const shown = cards.filter((c) => !q || `${c.firstName} ${c.title} ${c.expertise.join(" ")} ${c.departmentName ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const provision = async (which: "rec" | "all") => {
    setBusy(which); setMsg(null);
    const r = await provisionAction(which === "rec" ? { personaKeys: recommendedKeys } : {});
    setBusy(null);
    if (!r.ok) { setMsg(r.error); return; }
    setMsg(`${r.created} AI employee${r.created === 1 ? "" : "s"} added as drafts at read-only permission.`); router.refresh();
  };

  return (
    <div>
      <PageHeader hero eyebrow="AI Workforce" icon={<Bot size={22} />} title="Your AI Workforce"
        subtitle="AI agents that take on repetitive work in your departments. Every one is clearly labelled as AI, starts at read-only permission, and earns more responsibility only through your approvals."
        actions={<>
          {canWrite && <Button variant="gradient" href="/app/workforce/new" data-testid="wf-new"><Plus size={15} />Build an AI employee</Button>}
          <Button variant="glass" href="/app/workforce/org-chart" data-testid="wf-orgchart"><Network size={15} />Org chart</Button>
          <Button variant="glass" href="/app/experience" data-testid="wf-experience"><Sparkles size={15} />Experience Center</Button>
        </>} />

      <div className="stagger mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label="AI employees" value={kpis.total} format={(n) => fmtNum(n)} accent="purple" icon={<Users size={16} />} onClick={() => setTree(kpis.trees.total)} testid="kpi-total" />
        <KpiCard label="Active" value={kpis.active} format={(n) => fmtNum(n)} accent="emerald" icon={<CheckCircle2 size={16} />} caption="owner-approved, live" onClick={() => setTree(kpis.trees.active)} testid="kpi-active" />
        <KpiCard label="Tasks this month" value={kpis.tasksThisMonth} format={(n) => fmtNum(n)} accent="cyan" icon={<Bot size={16} />} caption="live runs only" onClick={() => setTree(kpis.trees.tasks)} testid="kpi-tasks" />
        <KpiCard label="Verified hours" value={kpis.verifiedHoursThisMonth} format={(n) => `${fmtNum(n, 1)} h`} accent="emerald" icon={<Clock size={16} />} caption="this month · observed" onClick={() => setTree(kpis.trees.hours)} testid="kpi-hours" />
        <KpiCard label="Net benefit" value={kpis.netBenefitThisMonth} format={(n) => fmtUSD(n)} accent="gold" icon={<BadgeDollarSign size={16} />} caption="capacity value − AI cost" hint="Capacity, not cash. Hard savings count only once approved in the savings ledger." onClick={() => setTree(kpis.trees.net)} testid="kpi-net" />
      </div>

      {total === 0 ? (
        <div className="card relative overflow-hidden p-6 text-center sm:p-10" data-testid="wf-empty">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(600px_200px_at_50%_0%,rgba(139,92,246,.15),transparent)]" />
          <div className="relative mx-auto max-w-xl">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-purple-soft text-purple-ink"><Bot size={26} /></div>
            <h2 className="text-xl font-bold">Build your AI team</h2>
            <p className="mt-2 text-sm text-ink-2">{recommendedNames.length ? `Based on the workflows BridgeBox observed, we recommend starting with ${recommendedNames.slice(0, 4).join(", ")}${recommendedNames.length > 4 ? ` and ${recommendedNames.length - 4} more` : ""}.` : "No workflow-based recommendations yet — you can still add the full library of 26 AI personas and try them in the sandbox."} Everyone starts as a draft at read-only permission.</p>
            {canWrite ? (
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {recommendedKeys.length > 0 && <Button variant="gradient" size="lg" loading={busy === "rec"} onClick={() => provision("rec")} data-testid="wf-provision-recommended">Add {recommendedKeys.length} recommended AI employees</Button>}
                <Button variant={recommendedKeys.length ? "secondary" : "gradient"} size="lg" loading={busy === "all"} onClick={() => provision("all")} data-testid="wf-provision-all">Add all 26 AI personas</Button>
              </div>
            ) : <p className="mt-4 text-xs text-ink-3">Ask an owner or admin to add AI employees.</p>}
            {msg && <p className="mt-3 text-xs font-medium text-ink-2" role="status">{msg}</p>}
          </div>
        </div>
      ) : (
        <>
          <FilterBar filters={filterDefs} testid="wf-filters" extra={
            <label className="relative ml-auto flex items-center"><span className="sr-only">Search AI employees</span><Search size={14} className="pointer-events-none absolute left-2.5 text-ink-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, role, skill…" className="h-8 w-48 rounded-lg border border-border bg-surface pl-8 pr-2 text-xs sm:w-60" data-testid="wf-search" /></label>
          } />
          {msg && <p className="mb-3 text-xs text-ink-2" role="status">{msg}</p>}
          {shown.length === 0 && <Empty title="No AI employees match these filters" body="Clear the filters or search to see your whole AI team." />}
          {teams.map((t) => {
            const list = shown.filter((c) => c.team === t.key); if (!list.length) return null;
            return (
              <section key={t.key} aria-labelledby={`team-${t.key}`}>
                <SectionHeader id={`team-${t.key}`} title={t.label} subtitle={`${list.length} AI employee${list.length === 1 ? "" : "s"}`} accent={TEAM_ACCENT[t.key] ?? "purple"} icon={<Bot size={15} />} />
                <div className="stagger mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">{list.map((c) => <EmployeeCard key={c.id} e={c} />)}</div>
              </section>
            );
          })}
          {canWrite && total < 26 && <div className="mt-2 flex justify-center"><Button variant="secondary" loading={busy === "all"} onClick={() => provision("all")} data-testid="wf-provision-rest">Add the remaining library personas</Button></div>}
        </>
      )}
      <Modal open={!!tree} onClose={() => setTree(null)} title="How is this calculated?">{tree && <CalcTreeView node={tree} />}</Modal>
    </div>
  );
}
