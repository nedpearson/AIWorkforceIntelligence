"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Sparkles, Scale, ShieldAlert, FileCheck2, Route, ClipboardList, Cpu, Wrench, TrendingUp, Landmark, Rocket, Check, Circle, ChevronRight, History, Database, Users } from "lucide-react";
import type { CalcTree, ProcessMap, WorkflowStep } from "@/db/schema";
import type { OpportunityAnalysis } from "@/engine/opportunity-score";
import { Badge, BasisChip, Button, Card, CardHeader, PageHeader, Table, Th, Td } from "@/components/ui";
import { ScoreRing, StatusPill, Meter as BarMeter, SectionHeader, ACCENT_HEX, type Accent } from "@/components/ui/enterprise";
import { CalcTreeView } from "@/components/calc-tree";
import { Meter, DrilldownModal, type Drill } from "@/components/dashboard/stat-tile";
import { ProcessMapView } from "@/components/dashboard/process-map";
import { OpportunityActions } from "@/components/dashboard/opportunity-actions";
import { OPP_TYPE_LABEL, OPP_TYPE_ACCENT } from "@/components/dashboard/opportunity-card";
import { cn, fmtUSD, fmtNum, fmtPct } from "@/lib/utils";
import { createProjectFromOpportunity, submitBusinessCase } from "../actions";

export type ReportData = {
  a: OpportunityAnalysis; splits: { value: number; effort: number }; totalRanked: number;
  storedCalculation: CalcTree; liveDiffers: boolean; createdAt: string; updatedAt: string;
  workflow: { id: string; name: string; processMap: ProcessMap | null; steps: WorkflowStep[]; runsPerWeek: number; avgDurationMin: number; hoursPerWeek: number; repetitionScore: number; automationScore: number; reworkRate: number; handoffs: number } | null;
  performers: { id: string; name: string; title: string | null; hoursPerWeek: number }[];
  agents: { id: string; name: string; status: string; deployedAt: string | null; templateKey: string }[];
  measurements: { id: string; periodStart: string; periodEnd: string; hoursSaved: number; dollarsSaved: number; method: string; basis: "observed" | "estimated" | "assumed" }[];
  decisions: { id: string; decision: string; note: string | null; by: string; at: string }[];
  ledger: { id: string; status: string; amount: number; at: string }[];
  projects: { id: string; name: string; status: string }[];
  events: { id: number; ts: string; type: string; app: string; titleCategory: string | null; durationMs: number }[];
  approvalMode: string; canWrite: boolean; canFinance: boolean; canAutomate: boolean;
};

function findNode(t: CalcTree | undefined, label: string): CalcTree | undefined { if (!t) return; if (t.label === label) return t; for (const c of t.children ?? []) { const f = findNode(c, label); if (f) return f; } }
const QUAD_LABEL: Record<string, string> = { quick_win: "Quick win", strategic: "Strategic bet", fill_in: "Fill-in", reconsider: "Reconsider" };
const QUAD_ACCENT: Record<string, Accent> = { quick_win: "emerald", strategic: "royal", fill_in: "gold", reconsider: "coral" };
const CONF_ACCENT: Record<string, Accent> = { High: "emerald", Medium: "gold", Low: "coral" };
const DECISION_LABEL: Record<string, string> = { approve: "Approved", reject: "Rejected", postpone: "Postponed", request_analysis: "Requested additional analysis", reopen: "Reopened", review: "Moved to review" };
const DECISION_ACCENT: Record<string, Accent> = { approve: "indigo", reject: "coral", postpone: "gold", request_analysis: "purple", reopen: "royal", review: "cyan" };

const STEPS = [
  { id: "current", label: "Current state", icon: ClipboardList, accent: "midnight" as Accent },
  { id: "solution", label: "Recommended AI solution", icon: Cpu, accent: "purple" as Accent },
  { id: "requirements", label: "Implementation requirements", icon: Wrench, accent: "cyan" as Accent },
  { id: "savings", label: "Projected savings", icon: TrendingUp, accent: "gold" as Accent },
  { id: "roi", label: "Financial ROI", icon: Landmark, accent: "gold" as Accent },
  { id: "plan", label: "Deployment plan", icon: Rocket, accent: "royal" as Accent },
];

export function OpportunityReport({ data }: { data: ReportData }) {
  const { a } = data; const l = a.line; const ans = a.answers;
  const router = useRouter();
  const [drill, setDrill] = React.useState<{ title: string; drill: Drill } | null>(null);
  const [showStored, setShowStored] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null); const [msg, setMsg] = React.useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const agent = data.agents.find((x) => x.status === "deployed") ?? data.agents[0] ?? null;
  const verified = data.measurements.reduce((s, m) => s + m.dollarsSaved, 0);
  const openCase = data.ledger.find((x) => x.status === "submitted" || x.status === "approved");
  const project = data.projects[0];
  const open = (title: string, tree: CalcTree | undefined, meaning: string) => tree && setDrill({ title, drill: { tree, meaning } });
  const Money = ({ v, tree, title, meaning, className, testid }: { v: string; tree?: CalcTree; title: string; meaning: string; className?: string; testid?: string }) => (
    <button type="button" onClick={() => open(title, tree, meaning)} disabled={!tree} data-testid={testid} className={cn("tabular rounded-md font-bold underline decoration-dotted decoration-1 underline-offset-4 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-indigo disabled:no-underline", className)}>{v}</button>
  );

  async function mkProject() { setBusy("project"); setMsg(null); const r = await createProjectFromOpportunity({ id: a.id }); setBusy(null); if (!r.ok) { setMsg({ tone: "err", text: r.error }); return; } router.push(`/app/roadmap?project=${r.projectId}`); }
  async function submitCase() { setBusy("case"); setMsg(null); const r = await submitBusinessCase({ id: a.id }); setBusy(null); if (!r.ok) { setMsg({ tone: "err", text: r.error }); return; } setMsg({ tone: "ok", text: "Business case submitted to finance for approval (savings ledger, tier: approved)." }); router.refresh(); }

  const implTree = findNode(l.tree, "Implementation cost (one-time)");
  const opexTree = findNode(l.tree, "Annual operating cost");
  const grossTree = findNode(l.tree, "Gross annual savings");
  const hoursTree = findNode(l.tree, "Hours recoverable per week");
  const roiTree: CalcTree = { label: "First-year ROI", value: l.roi1y, unit: "pct", basis: "estimated", formula: "(net annual − implementation) ÷ implementation", children: [{ label: "Net annual savings", value: l.netAnnualSavings, unit: "usd", basis: "estimated", formula: "realizable − operating" }, { label: "Implementation cost (one-time)", value: l.implementationCost, unit: "usd", basis: "estimated" }] };
  const paybackTree: CalcTree = { label: "Payback period", value: l.paybackMonths ?? 0, unit: "months", basis: "estimated", formula: l.paybackMonths == null ? "not reached (net annual ≤ 0)" : "implementation ÷ (net annual ÷ 12)", children: roiTree.children };
  const annualHoursTree: CalcTree = { label: "Annual time savings", value: ans.annualHoursSaved, unit: "hours", basis: "estimated", formula: "hours recoverable per week × working weeks per year", children: hoursTree ? [hoursTree] : [] };

  const plan = [
    { key: "decision", title: "Executive decision", done: ["approved", "in_progress", "deployed", "verified"].includes(a.status), detail: a.status === "approved" ? "Approved" : `Currently ${a.status.replace(/_/g, " ")}`, href: "#decision", cta: "Decide" },
    { key: "case", title: "Finance business case", done: openCase?.status === "approved", detail: openCase ? `${openCase.status} · ${fmtUSD(openCase.amount)}/yr` : "Not submitted", href: "#decision", cta: "Submit" },
    { key: "project", title: "Transformation project", done: !!project, detail: project ? `${project.name} (${project.status.replace(/_/g, " ")})` : "Not planned", href: project ? `/app/roadmap?project=${project.id}` : "#decision", cta: project ? "Open" : "Create" },
    { key: "build", title: `Build the ${ans.recommendedSolution.name}`, done: data.agents.length > 0, detail: data.agents.length ? `${data.agents.length} agent(s) linked` : `Template ${ans.recommendedSolution.key} · connect ${ans.requiredCredentials.map((c) => c.label).join(", ") || "no credentials"}`, href: agent ? `/app/agents/${agent.id}` : `/app/agents/new?opportunityId=${a.id}&template=${ans.recommendedSolution.key}`, cta: agent ? "Open" : "Build" },
    { key: "pilot", title: "Pilot with human approval", done: data.agents.some((x) => x.status === "deployed"), detail: data.approvalMode, href: agent ? `/app/agents/${agent.id}` : undefined, cta: "Deploy" },
    { key: "measure", title: "Measure verified savings", done: data.measurements.length > 0, detail: data.measurements.length ? `${data.measurements.length} measurement(s) · ${fmtUSD(verified)} measured` : "Run ledger or before/after observation after a few weeks of runs", href: agent ? `/app/agents/${agent.id}?tab=results` : undefined, cta: "Measure" },
  ];
  const currentPlanIdx = plan.findIndex((p) => !p.done);

  return (
    <div className="space-y-6" data-testid="opportunity-detail">
      <PageHeader icon={<Sparkles size={20} />} accent="purple" eyebrow={`AI Opportunity Center · priority #${ans.priorityRank} of ${data.totalRanked}`}
        title={<span className="flex items-center gap-2"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-midnight text-sm font-bold text-white dark:bg-royal" title="Priority rank">{ans.priorityRank}</span>{a.title}</span>}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Badge tone={OPP_TYPE_ACCENT[a.type] ?? "neutral"}>{OPP_TYPE_LABEL[a.type] ?? a.type}</Badge><StatusPill status={a.status} /><BasisChip basis={a.basis} />{a.requiresHumanJudgment && <Badge tone="warn"><Scale size={11} className="mr-1" />judgment</Badge>}{a.regulatoryFlag && <Badge tone="danger"><ShieldAlert size={11} className="mr-1" />{a.regulatoryFlag}</Badge>}{a.departmentName && <Link href={`/app/departments/${a.departmentId}`} className="text-royal-ink hover:underline">{a.departmentName}</Link>}<Link href="/app/opportunities" className="text-ink-3 hover:underline">All opportunities</Link></span>}
        actions={<>
          {data.canAutomate && !agent && a.status !== "rejected" && <Button href={`/app/agents/new?opportunityId=${a.id}`} data-testid="opp-automate"><Sparkles size={15} />Automate this</Button>}
          {data.canWrite && a.status !== "rejected" && <Button variant="secondary" onClick={mkProject} loading={busy === "project"} data-testid="opp-create-project"><Route size={15} />{project ? "Open project" : "Create transformation project"}</Button>}
        </>} />

      {!a.inScope && <Card className="border-gold/40 bg-gold-soft/40 text-xs text-ink-2" data-testid="opp-out-of-scope">This opportunity is rejected, so it is excluded from the organization totals. Its figures below are computed by the same finance engine on its own.</Card>}
      {msg && <div role="status" className={cn("rounded-xl px-4 py-2.5 text-sm", msg.tone === "ok" ? "bg-emerald-soft text-emerald-ink" : "bg-coral-soft text-coral-ink")} data-testid="opp-message">{msg.text}</div>}

      {/* ---------- report cover ---------- */}
      <div className="card relative overflow-hidden p-0" data-testid="opp-cover">
        <div className="bg-hero px-5 py-5 text-white sm:px-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
            <div className="flex items-center gap-4">
              <div className="rounded-2xl bg-white/95 p-2 dark:bg-surface"><ScoreRing score={a.score.total} size={92} /></div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[.16em] text-cyan-300">Opportunity score</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-white ring-1 ring-white/25" style={{ background: `${ACCENT_HEX[CONF_ACCENT[a.score.confidence.level]]}55` }} data-testid="opp-confidence">{a.score.confidence.level} confidence</span>
                  <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-white ring-1 ring-white/25" style={{ background: `${ACCENT_HEX[QUAD_ACCENT[a.quadrant]]}55` }}>{QUAD_LABEL[a.quadrant]}</span>
                </div>
                <p className="mt-2 line-clamp-4 max-w-md text-xs text-slate-300" title={a.summary}>{a.summary}</p>
              </div>
            </div>
            <dl className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { k: "Realizable / yr", v: fmtUSD(l.realizableAnnualSavings), tree: l.tree, m: "Gross savings × realization rate: the share of freed time that becomes real money.", c: "text-amber-300" },
                { k: "Payback", v: l.paybackMonths == null ? "not reached" : `${fmtNum(l.paybackMonths, 1)} mo`, tree: paybackTree, m: "Months of net savings to earn back the one-time setup cost.", c: "text-cyan-300" },
                { k: "First-year ROI", v: fmtPct(l.roi1y), tree: roiTree, m: "(Net annual savings − implementation) ÷ implementation.", c: "text-emerald-300" },
                { k: "Hours freed / yr", v: fmtNum(ans.annualHoursSaved, 0), tree: annualHoursTree, m: "Capacity freed for higher-value work — not a payroll reduction.", c: "text-violet-300" },
              ].map((x) => (
                <div key={x.k} className="rounded-xl bg-white/5 p-3 ring-1 ring-white/10">
                  <dt className="text-[11px] text-slate-300">{x.k}</dt>
                  <dd className="mt-1"><button type="button" onClick={() => open(x.k, x.tree, x.m)} className={cn("tabular rounded text-lg font-bold underline decoration-dotted decoration-1 underline-offset-4 hover:bg-white/10 sm:text-xl", x.c)} data-testid={`opp-cover-${x.k.split(" ")[0].toLowerCase()}`}>{x.v}</button></dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <nav aria-label="Report sections" className="scrollbar-thin flex gap-1 overflow-x-auto border-t border-border bg-surface px-3 py-2">
          {STEPS.map((s, i) => <a key={s.id} href={`#${s.id}`} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 text-[10px] text-ink">{i + 1}</span>{s.label}</a>)}
          <a href="#score" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink">Score breakdown</a>
          <a href="#decision" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink">Decision</a>
        </nav>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* ---------- stepped report ---------- */}
        <ol className="relative space-y-5 before:absolute before:bottom-6 before:left-[19px] before:top-6 before:w-px before:bg-border" data-testid="opp-report-steps">
          <Step n={1} s={STEPS[0]}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Fact label="Current process cost / yr" value={<Money v={fmtUSD(ans.currentProcessCost.value)} tree={ans.currentProcessCost.tree} title="Current process cost" meaning="What the people doing this workflow cost today for the time they spend on it (loaded hourly × hours × working weeks)." testid="opp-current-cost" />} />
              <Fact label="Hours / week" value={fmtNum(ans.hoursPerWeek, 1)} sub="observed" />
              <Fact label="Frequency" value={`${fmtNum(ans.runsPerWeek, 1)} runs/wk`} sub={`${fmtNum(ans.avgDurationMin, 1)} min avg`} />
              <Fact label="Manual steps" value={fmtNum(ans.manualSteps)} sub={`${a.peopleAffected} people`} />
            </div>
            {data.workflow && data.workflow.steps.length > 0 && (
              <ol className="mt-4 flex flex-wrap items-center gap-1.5 text-xs" aria-label="Process steps">
                {data.workflow.steps.map((s, i) => <li key={i} className="flex items-center gap-1.5"><span className="rounded-lg bg-surface-2 px-2 py-1"><span className="font-semibold">{s.app}</span> <span className="text-ink-2">{s.action}</span> <span className="text-ink-3">{fmtPct(s.share)}</span></span>{i < data.workflow!.steps.length - 1 && <ChevronRight size={12} className="text-ink-3" />}</li>)}
              </ol>
            )}
            {data.workflow && <p className="mt-3 text-xs text-ink-2">Repetition {Math.round(data.workflow.repetitionScore)}/100 · rework {fmtPct(data.workflow.reworkRate, 1)} · {data.workflow.handoffs} handoffs · workflow <Link className="text-royal-ink hover:underline" href={`/app/workflows/${data.workflow.id}`}>{data.workflow.name}</Link></p>}
          </Step>

          <Step n={2} s={STEPS[1]}>
            <div className="flex flex-col gap-4 sm:flex-row" data-testid="opp-agent">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-purple-soft text-purple-ink"><Bot size={24} /></div>
              <div className="min-w-0 flex-1">
                {agent ? (<>
                  <div className="text-sm font-bold">Linked agent: <Link href={`/app/agents/${agent.id}`} className="text-royal-ink hover:underline">{agent.name}</Link> <StatusPill status={agent.status} /></div>
                  {agent.deployedAt && <p className="text-xs text-ink-2">Deployed {agent.deployedAt.slice(0, 10)}</p>}
                </>) : (<>
                  <div className="text-sm font-bold">{ans.recommendedSolution.name}</div>
                  <p className="mt-1 text-sm text-ink-2">{ans.recommendedSolution.description}</p>
                </>)}
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                  <Badge tone="purple">{OPP_TYPE_LABEL[a.type] ?? a.type}</Badge><Badge tone="neutral">template {ans.recommendedSolution.key}</Badge><Badge tone="neutral">runtime {ans.recommendedSolution.runtime}</Badge><Badge tone="gold">≈ {fmtUSD(ans.recommendedSolution.monthlyCost)}/mo to run</Badge>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div><div className="mb-1 flex justify-between text-xs"><span className="text-ink-2">Share of time automatable</span><span className="font-semibold tabular">{fmtPct(ans.automationPct)}</span></div><BarMeter value={ans.automationPct * 100} accent="cyan" label="Share of time automatable" /></div>
                  <div><div className="mb-1 flex justify-between text-xs"><span className="text-ink-2">Automation feasibility</span><span className="font-semibold tabular">{Math.round(ans.feasibility)}/100</span></div><BarMeter value={ans.feasibility} accent="purple" label="Automation feasibility" /></div>
                </div>
                {data.canAutomate && !agent && a.status !== "rejected" && <Button size="sm" className="mt-3" href={`/app/agents/new?opportunityId=${a.id}&template=${ans.recommendedSolution.key}`} data-testid="opp-use-template">Build from this template</Button>}
              </div>
            </div>
          </Step>

          <Step n={3} s={STEPS[2]}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-2">Integrations (apps in the workflow)</h4>
                {ans.integrations.length ? <ul className="flex flex-wrap gap-1.5">{ans.integrations.map((x) => <li key={x.app} className="rounded-lg bg-cyan-soft px-2 py-1 text-xs font-semibold text-cyan-ink">{x.app} <span className="font-normal opacity-80">· {x.steps} step{x.steps === 1 ? "" : "s"}</span></li>)}</ul> : <p className="text-xs text-ink-3">No step data.</p>}
                <h4 className="mb-2 mt-4 text-xs font-bold uppercase tracking-wide text-ink-2">Credentials the agent needs</h4>
                {ans.requiredCredentials.length ? <ul className="space-y-1 text-xs">{ans.requiredCredentials.map((c) => <li key={c.provider} className="flex items-center gap-2"><Circle size={8} className="text-ink-3" />{c.label} <span className="text-ink-3">({c.provider})</span></li>)}</ul> : <p className="text-xs text-ink-3">None — runs on internal tools.</p>}
                <p className="mt-3 text-xs text-ink-2"><span className="font-semibold text-ink">Human in the loop:</span> {data.approvalMode}</p>
              </div>
              <div className="space-y-3" data-testid="opp-meters">
                <div className="flex items-center justify-between text-xs"><span className="text-ink-2">Implementation difficulty</span><Badge tone={ans.difficulty.level === "High" ? "coral" : ans.difficulty.level === "Medium" ? "gold" : "emerald"}>{ans.difficulty.level}</Badge></div>
                <p className="-mt-2 text-[11px] text-ink-3">{ans.difficulty.reason}</p>
                <Meter value={l.feasibility} label="Feasibility" testid="opp-meter-feas" />
                <Meter value={l.risk} label="Operational risk" invert testid="opp-meter-risk" />
                <p className="text-[11px] text-ink-2">Risk drivers: {ans.operationalRisk.drivers.length ? ans.operationalRisk.drivers.join(", ") : "none flagged"}.</p>
                <Meter value={a.score.factors.find((f) => f.key === "dataReadiness")!.value} label="Data readiness" testid="opp-meter-data" />
                <div>
                  <h4 className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-2">Regulatory considerations</h4>
                  {ans.regulatory.length ? <ul className="space-y-1 text-xs">{ans.regulatory.map((r) => <li key={r} className="flex gap-2"><ShieldAlert size={13} className="mt-0.5 shrink-0 text-coral-ink" />{/^[A-Z]{2,6}$/.test(r) ? `${r}-regulated data: keep audit logging and least-privilege credentials; review with compliance before go-live.` : r}</li>)}</ul> : <p className="text-xs text-ink-3">No regulated data or judgment steps detected.</p>}
                </div>
              </div>
            </div>
          </Step>

          <Step n={4} s={STEPS[3]}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Fact label="Annual time savings" value={<Money v={`${fmtNum(ans.annualHoursSaved, 0)} hrs`} tree={annualHoursTree} title="Annual time savings" meaning="Hours per week the automation takes over × working weeks per year." />} />
              <Fact label="Gross / yr" value={<Money v={fmtUSD(ans.grossAnnual)} tree={grossTree} title="Gross annual savings" meaning="Value of every recoverable hour at loaded cost." className="text-ink-2" />} />
              <Fact label="Realizable / yr" value={<Money v={fmtUSD(ans.realizableAnnual)} tree={l.tree} title="Realizable annual savings" meaning="Gross × realization rate. Time saved ≠ payroll cut." className="text-gold-ink" testid="opp-realizable" />} />
              <Fact label="Verified so far" value={verified > 0 ? <span className="font-bold text-emerald-ink tabular">{fmtUSD(verified)}</span> : "—"} sub={verified > 0 ? `${data.measurements.length} measurement(s)` : agent ? "no measurement yet" : "no agent yet"} />
            </div>
            {l.overlap && <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">Shares its workflow with {l.overlap.sharedWith.length} other opportunit{l.overlap.sharedWith.length === 1 ? "y" : "ies"}: scaled × {l.overlap.factor.toFixed(3)} — {fmtUSD(l.overlap.realizableRemoved)}/yr removed so nothing is double counted.</p>}
            <div className="mt-4 rounded-xl border border-border p-3" data-testid="opp-calculation">
              <div className="mb-2 flex items-center justify-between gap-2"><h4 className="text-xs font-bold uppercase tracking-wide text-ink-2">How the money is calculated</h4>{data.liveDiffers && <button className="text-xs font-semibold text-royal-ink hover:underline" onClick={() => setShowStored(!showStored)} data-testid="opp-toggle-stored">{showStored ? "Show live" : "Show as analyzed"}</button>}</div>
              <CalcTreeView node={showStored ? data.storedCalculation : l.tree} />
            </div>
          </Step>

          <Step n={5} s={STEPS[4]}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Fact label="Implementation (one-time)" value={<Money v={fmtUSD(ans.implementationCost)} tree={implTree} title="Implementation cost" meaning="Consulting hours × rate × complexity, plus tooling." />} />
              <Fact label="Recurring / yr" value={<Money v={fmtUSD(ans.recurringCost)} tree={opexTree} title="Annual operating cost" meaning="Monthly platform, model and runtime fees × 12." />} />
              <Fact label="Net / yr" value={<Money v={fmtUSD(ans.netAnnual)} tree={roiTree.children?.[0]} title="Net annual savings" meaning="Realizable savings minus operating cost." className={ans.netAnnual >= 0 ? "text-emerald-ink" : "text-coral-ink"} />} />
              <Fact label="ROI (year 1)" value={<Money v={fmtPct(ans.roi1y)} tree={roiTree} title="First-year ROI" meaning="(Net annual − implementation) ÷ implementation." />} />
              <Fact label="Payback" value={<Money v={ans.paybackMonths == null ? "not reached" : `${fmtNum(ans.paybackMonths, 1)} mo`} tree={paybackTree} title="Payback" meaning="Implementation ÷ monthly net savings." />} />
            </div>
            <div className="mt-4" aria-label={`One-time cost ${fmtUSD(ans.implementationCost)} versus net savings per year ${fmtUSD(ans.netAnnual)}`} role="img">
              {(() => { const max = Math.max(ans.implementationCost, Math.abs(ans.netAnnual), 1); return (
                <div className="space-y-2 text-xs">
                  <div className="flex items-center gap-2"><span className="w-28 shrink-0 text-ink-2">One-time cost</span><div className="h-3 flex-1 rounded-full bg-surface-2"><div className="h-3 rounded-full" style={{ width: `${(ans.implementationCost / max) * 100}%`, background: ACCENT_HEX.coral }} /></div><span className="w-20 text-right tabular">{fmtUSD(ans.implementationCost, { compact: true })}</span></div>
                  <div className="flex items-center gap-2"><span className="w-28 shrink-0 text-ink-2">Net savings / yr</span><div className="h-3 flex-1 rounded-full bg-surface-2"><div className="h-3 rounded-full" style={{ width: `${(Math.max(0, ans.netAnnual) / max) * 100}%`, background: ACCENT_HEX.gold }} /></div><span className="w-20 text-right tabular">{fmtUSD(ans.netAnnual, { compact: true })}</span></div>
                </div>); })()}
            </div>
          </Step>

          <Step n={6} s={STEPS[5]}>
            <ol className="space-y-2" data-testid="opp-plan">
              {plan.map((p, i) => (
                <li key={p.key} className={cn("flex items-start gap-3 rounded-xl border p-3", p.done ? "border-emerald/30 bg-emerald-soft/40" : i === currentPlanIdx ? "border-royal/40 bg-royal-soft/40" : "border-border")}>
                  <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold", p.done ? "bg-emerald text-white" : i === currentPlanIdx ? "bg-royal text-white" : "bg-surface-2 text-ink-2")}>{p.done ? <Check size={13} /> : i + 1}</span>
                  <div className="min-w-0 flex-1"><div className="text-sm font-semibold">{p.title}</div><div className="text-xs text-ink-2">{p.detail}</div></div>
                  {!p.done && p.href && <Link href={p.href} className="shrink-0 text-xs font-semibold text-royal-ink hover:underline">{p.cta} →</Link>}
                </li>
              ))}
            </ol>
            <p className="mt-2 text-[11px] text-ink-3">Steps reflect live records (decisions, ledger, projects, agents, measurements) — no dates are invented. Plan dates on the transformation roadmap.</p>
          </Step>
        </ol>

        {/* ---------- side rail: score + decision ---------- */}
        <div className="space-y-5">
          <Card id="score" data-testid="opp-score-breakdown">
            <CardHeader title="Score breakdown" subtitle="Eight weighted factors, each 0–100 (weights sum to 100). Contribution = value × weight. Expand a factor for its inputs and reasoning." />
            <ul className="space-y-3">
              {a.score.factors.map((f) => (
                <li key={f.key} data-testid={`opp-factor-${f.key}`}>
                  <details className="group">
                    <summary className="cursor-pointer list-none">
                      <div className="flex items-center justify-between gap-2 text-xs"><span className="font-semibold">{f.label}</span><span className="tabular text-ink-2"><span className="font-bold text-ink">{Math.round(f.value)}</span> × {f.weight}% = <span className="font-bold text-ink">{f.contribution.toFixed(1)}</span></span></div>
                      <div className="mt-1"><BarMeter value={f.value} accent={f.value >= 65 ? "emerald" : f.value >= 40 ? "gold" : "coral"} label={f.label} /></div>
                    </summary>
                    <div className="mt-2 rounded-lg bg-surface-2 p-2 text-[11px]">
                      <p className="text-ink">{f.reason}</p>
                      <dl className="mt-1 grid grid-cols-2 gap-x-2 text-ink-2">{f.inputs.map((x) => <React.Fragment key={x.label}><dt>{x.label}</dt><dd className="text-right tabular text-ink">{x.value}</dd></React.Fragment>)}</dl>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-sm"><span className="font-semibold">Total</span><span className="font-display text-xl font-bold tabular">{a.score.total.toFixed(1)}</span></div>
            <div className="mt-3 rounded-lg border border-border p-2 text-[11px] text-ink-2"><span className="font-semibold text-ink">Evidence confidence: {a.score.confidence.level}.</span> {a.score.confidence.reasons.join(" · ")}. <span className="text-ink-3">Rule — {a.score.confidence.rule}</span></div>
          </Card>

          <Card id="decision" data-testid="opp-decision">
            <CardHeader title="Decision" subtitle="Recorded with your name, time and note; every decision is audited." />
            {data.canWrite ? <OpportunityActions id={a.id} status={a.status} size="sm" full /> : <p className="text-xs text-ink-3">You can view this report; decisions need the opportunities:write permission (owner, admin or consultant).</p>}
            <div className="mt-4 space-y-2 border-t border-border pt-4">
              <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">Finance business case</span>{openCase && <StatusPill status={openCase.status} />}</div>
              <p className="text-[11px] text-ink-2">Submits {fmtUSD(l.realizableAnnualSavings)}/yr (realizable) to the savings ledger as tier <em>approved</em>, de-duplicated by workflow.</p>
              {data.canFinance ? <Button size="sm" variant="secondary" onClick={submitCase} loading={busy === "case"} disabled={!!openCase || !a.inScope} data-testid="opp-submit-case"><FileCheck2 size={13} />{openCase ? `Business case ${openCase.status}` : "Submit business case for finance approval"}</Button>
                : <p className="text-[11px] text-ink-3">Requires finance:write.</p>}
              {openCase && <Link href={`/app/savings?entry=${openCase.id}`} className="block text-[11px] font-semibold text-royal-ink hover:underline">View in ROI & Savings Center →</Link>}
            </div>
            <div className="mt-4 border-t border-border pt-4">
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><History size={13} />Decision history</h4>
              {data.decisions.length === 0 ? <p className="text-[11px] text-ink-3">No decisions recorded yet.</p> : (
                <ol className="relative space-y-3 border-l border-border pl-4" data-testid="opp-decision-history">
                  {data.decisions.map((d) => <li key={d.id} className="relative"><span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface" style={{ background: ACCENT_HEX[DECISION_ACCENT[d.decision] ?? "midnight"] }} /><div className="text-xs font-semibold">{DECISION_LABEL[d.decision] ?? d.decision}</div><div className="text-[11px] text-ink-3">{d.by} · {new Date(d.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</div>{d.note && <p className="mt-0.5 text-[11px] text-ink-2">“{d.note}”</p>}</li>)}
                </ol>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* ---------- evidence ---------- */}
      <SectionHeader accent="emerald" icon={<Database size={16} />} title="Evidence" subtitle="The observed data behind this report — metadata only, never content." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card data-testid="opp-evidence">
          <CardHeader title="Observation" />
          <dl className="space-y-1.5 text-xs text-ink-2">
            <div className="flex justify-between"><dt>Observed runs</dt><dd className="tabular text-ink">{fmtNum(a.evidence.sampleSize)}</dd></div>
            <div className="flex justify-between"><dt>Window</dt><dd className="text-ink">{a.evidence.observedFrom.slice(0, 10) || "?"} → {a.evidence.observedTo.slice(0, 10) || "?"}</dd></div>
            <div className="flex justify-between"><dt>Collector coverage</dt><dd className="text-ink">{a.evidence.performersWithCollector} of {a.evidence.performers} performers</dd></div>
            <div className="flex justify-between"><dt>Analyzed</dt><dd className="text-ink">{data.updatedAt.slice(0, 10)}</dd></div>
          </dl>
          {a.evidence.notes.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-ink-3">{a.evidence.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        </Card>
        <Card className="lg:col-span-2 p-0" data-testid="opp-events">
          <CardHeader className="px-5 pt-5" title="Sample events" subtitle={`${data.events.length} of ${a.evidence.eventIds.length} referenced events shown`} />
          {data.events.length === 0 ? <p className="px-5 pb-5 text-xs text-ink-3">No sample events are referenced by this opportunity.</p> : (
            <Table className="rounded-t-none border-0 shadow-none"><thead><tr><Th>When</Th><Th>App</Th><Th>Event</Th><Th>Category</Th><Th className="text-right">Duration</Th></tr></thead>
              <tbody>{data.events.map((e) => <tr key={e.id}><Td className="whitespace-nowrap text-xs">{new Date(e.ts).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</Td><Td className="text-xs font-medium">{e.app}</Td><Td className="text-xs">{e.type.replace(/_/g, " ")}</Td><Td className="text-xs text-ink-2">{e.titleCategory ?? "—"}</Td><Td className="text-right text-xs tabular">{fmtNum(e.durationMs / 1000, 0)}s</Td></tr>)}</tbody></Table>
          )}
        </Card>
      </div>
      {data.workflow && (
        <Card data-testid="opp-workflow">
          <CardHeader title={<span>Process map: <Link href={`/app/workflows/${data.workflow.id}`} className="text-royal-ink hover:underline">{data.workflow.name}</Link></span>} subtitle={`${fmtNum(data.workflow.runsPerWeek, 1)} runs/wk · ${fmtNum(data.workflow.avgDurationMin, 1)} min avg · ${fmtNum(data.workflow.hoursPerWeek, 1)} hrs/wk`} />
          <ProcessMapView map={data.workflow.processMap} testid="opp-process-map" />
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-0">
          <CardHeader className="px-5 pt-5" title={<span className="inline-flex items-center gap-1.5"><Users size={14} />People who do this work</span>} subtitle="Their freed time is capacity to reassign, not a headcount reduction." />
          {data.performers.length === 0 ? <p className="px-5 pb-5 text-xs text-ink-3">No performer data.</p> : (
            <Table className="rounded-t-none border-0 shadow-none"><thead><tr><Th>Person</Th><Th className="text-right">Hrs/wk on this</Th><Th className="text-right">Share</Th></tr></thead>
              <tbody>{data.performers.map((p) => <tr key={p.id} className="hover:bg-surface-2"><Td><Link href={`/app/employees/${p.id}`} className="font-medium text-royal-ink hover:underline">{p.name}</Link><div className="text-xs text-ink-3">{p.title ?? "—"}</div></Td><Td className="text-right tabular">{fmtNum(p.hoursPerWeek, 1)}</Td><Td className="text-right tabular">{l.hoursPerWeek > 0 ? fmtPct(p.hoursPerWeek / l.hoursPerWeek) : "—"}</Td></tr>)}</tbody></Table>
          )}
        </Card>
        <Card className="p-0" data-testid="opp-measurements">
          <CardHeader className="px-5 pt-5" title="Verified measurements" subtitle="Recorded after deployment. Never mixed into the projections above." />
          {data.measurements.length === 0 ? <p className="px-5 pb-5 text-xs text-ink-3">{agent ? "No measurement recorded yet. Record one from the agent page after a few weeks of runs." : "Deploy an agent first; measurements come from its run ledger."}</p> : (
            <Table className="rounded-t-none border-0 shadow-none"><thead><tr><Th>Period</Th><Th>Method</Th><Th className="text-right">Hours</Th><Th className="text-right">$ saved</Th><Th>Basis</Th></tr></thead>
              <tbody>{data.measurements.map((m) => <tr key={m.id}><Td className="text-xs">{m.periodStart.slice(0, 10)} → {m.periodEnd.slice(0, 10)}</Td><Td className="text-xs">{m.method.replace(/_/g, " ")}</Td><Td className="text-right tabular text-emerald-ink">{fmtNum(m.hoursSaved, 1)}</Td><Td className="text-right tabular text-emerald-ink">{fmtUSD(m.dollarsSaved)}</Td><Td><BasisChip basis={m.basis} /></Td></tr>)}</tbody></Table>
          )}
        </Card>
      </div>
      {drill && <DrilldownModal open onClose={() => setDrill(null)} title={drill.title} drill={drill.drill} />}
    </div>
  );
}

function Step({ n, s, children }: { n: number; s: (typeof STEPS)[number]; children: React.ReactNode }) {
  const Icon = s.icon;
  return (
    <li id={s.id} className="relative scroll-mt-20 pl-12" data-testid={`opp-step-${s.id}`}>
      <span className="absolute left-0 top-4 flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold text-white shadow-[var(--shadow-card)] ring-4 ring-bg" style={{ background: s.accent === "midnight" ? ACCENT_HEX.indigo : ACCENT_HEX[s.accent] }} aria-hidden>{n}</span>
      <div className="card p-5">
        <div className="mb-3 flex items-center gap-2"><Icon size={16} className="text-ink-2" /><h2 className="text-base font-bold tracking-tight">{s.label}</h2><span className="ml-auto text-[11px] font-semibold uppercase tracking-wide text-ink-3">Step {n} of 6</span></div>
        {children}
      </div>
    </li>
  );
}
function Fact({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return <div className="rounded-xl bg-surface-2/70 p-3"><div className="text-[11px] text-ink-2">{label}</div><div className="mt-0.5 text-base font-bold tabular">{value}</div>{sub && <div className="text-[11px] text-ink-3">{sub}</div>}</div>;
}
