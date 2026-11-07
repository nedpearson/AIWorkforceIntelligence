"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Play, Pause, Power, Archive, UploadCloud, RefreshCw, ChevronLeft, RotateCcw, Bot, FlaskConical, CalendarClock, Clock, CircleCheck, DollarSign, Activity } from "lucide-react";
import { Tabs, KpiCard, StatusPill } from "@/components/ui/enterprise";
import { DrilldownModal, type Drill } from "@/components/dashboard/stat-tile";
import type { AgentMetrics } from "@/engine/agents/portfolio";
import { VersionsTab } from "./versions-tab";
import { TestTab } from "./test-tab";
import { Badge, Button, Card, CardHeader, Empty, Input, Modal, PageHeader, Select, Table, Th, Td, Textarea, Tooltip, BasisChip } from "@/components/ui";
import { CalcTreeView } from "@/components/calc-tree";
import { fmtNum, fmtUSD, fmtPct, cn } from "@/lib/utils";
import type { AgentDefinition, ApprovalPolicy, CalcTree, RunLog } from "@/db/schema";
import { CATEGORY_LABELS, type AgentCategory, type RequiredCredential } from "@/engine/agents/templates";
import { setAgentStatus, runAgentNow, retryRun, getRun, decideApproval, pushAgentToN8n, pullN8nRuns, checkN8n, recordMeasurement, updateAgentSettings } from "../actions";
import { RUN_TONE, ago } from "../agents-list";
import { FlowBuilder } from "./flow-builder";
import { useTimeZone, ViewerTime } from "@/components/time-zone";
import { formatDateTime, formatTime } from "@/lib/datetime";

export type RunRow = { id: string; status: string; trigger: string; createdAt: string; startedAt: string | null; finishedAt: string | null; minutesSaved: number | null; humanMinutes: number; error: string | null; currentNodeId: string | null };
export type ApprovalRow = { id: string; runId: string; nodeId: string; status: string; requestedAction: string; payload: Record<string, unknown>; createdAt: string; expiresAt: string | null; decisionNote: string | null; decidedAt: string | null };
export type MeasurementRow = { id: string; periodStart: string; periodEnd: string; method: string; runs: number; hoursSaved: number; dollarsSaved: number; costIncurred: number; basis: "observed" | "estimated" | "assumed"; calculation: CalcTree };
export type VersionRow = { id: string; version: number; definition: AgentDefinition; approvalPolicy: ApprovalPolicy | null; note: string | null; createdAt: string; by: string };
type AgentData = { id: string; name: string; category: string; templateKey: string; status: string; runtime: string; externalId: string | null; definition: AgentDefinition; credentialIds: string[]; approvalPolicy: ApprovalPolicy; expectedMinutesSavedPerRun: number; baselineMinutesPerRun: number; monthlyCost: number; deployedAt: string | null; lastRunAt: string | null; workflowId: string | null };
type Props = { agent: AgentData; template: { description: string; requiredCredentials: RequiredCredential[]; exampleInput: Record<string, unknown> } | null; opportunity: { id: string; title: string; status: string; realizable: number; calculation: CalcTree; basis: "observed" | "estimated" | "assumed" } | null; runs: RunRow[]; approvals: ApprovalRow[]; measurements: MeasurementRow[]; beforeAfter: CalcTree | null; credentials: { id: string; name: string; provider: string }[]; n8n: { configured: boolean; status: string; lastError: string | null }; perms: { write: boolean; approve: boolean }; initialTab: string; versions: VersionRow[]; metrics: AgentMetrics | null; windowDays: number; timezone: string };
const TABS = ["overview", "flow", "test", "runs", "approvals", "versions", "results"] as const;
const TAB_LABEL: Record<(typeof TABS)[number], string> = { overview: "Overview", flow: "Flow", test: "Test environment", runs: "Runs", approvals: "Approvals", versions: "Versions", results: "Results" };
const dur = (a: string | null, b: string | null) => { if (!a) return "—"; const ms = (b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime(); return ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`; };
const fmtDate = (iso: string | null, tz: string) => (iso ? formatDateTime(iso, tz) : "—");

export function AgentDetail(p: Props) {
  const router = useRouter();
  const [tab, setTab] = React.useState<(typeof TABS)[number]>(TABS.includes(p.initialTab as (typeof TABS)[number]) ? (p.initialTab as (typeof TABS)[number]) : "overview");
  const [busy, setBusy] = React.useState(""); const [flash, setFlash] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [runModal, setRunModal] = React.useState(false); const [runInput, setRunInput] = React.useState(JSON.stringify(p.template?.exampleInput ?? {}, null, 2));
  const [drawer, setDrawer] = React.useState<string | null>(null);
  const a = p.agent;
  const pending = p.approvals.filter((x) => x.status === "pending");
  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>, okText?: string) => {
    setBusy(key); setFlash(null); const r = await fn(); setBusy("");
    setFlash(r.ok ? { ok: true, text: okText ?? "Done" } : { ok: false, text: r.error ?? "failed" }); router.refresh(); return r;
  };
  async function runNow() {
    let input: Record<string, unknown>; try { input = JSON.parse(runInput || "{}"); } catch { setFlash({ ok: false, text: "Input must be valid JSON" }); return; }
    const r = await act("run", () => runAgentNow({ agentId: a.id, input }), "Run started");
    if (r.ok && "run" in r) { const run = r.run as { runId: string; status: string }; setRunModal(false); if (run.runId) { setTab("runs"); setDrawer(run.runId); } setFlash({ ok: true, text: `Run ${run.status.replace("_", " ")}` }); }
  }
  const latestVersion = p.versions[0]?.version ?? null;
  return (
    <div>
      <PageHeader hero eyebrow="AI Agent Command Center" icon={<Bot size={22} className="text-cyan-300" />}
        title={<span className="flex flex-wrap items-center gap-2">{a.name}<StatusPill status={a.status} /></span>}
        subtitle={<>{`${CATEGORY_LABELS[a.category as AgentCategory] ?? a.category} · ${a.runtime} runtime · template ${a.templateKey}${latestVersion ? ` · v${latestVersion}` : ""}`}{a.deployedAt && <> · deployed <ViewerTime dateTime={a.deployedAt}>{ago(a.deployedAt)}</ViewerTime></>} · last run {a.lastRunAt ? <ViewerTime dateTime={a.lastRunAt}>{ago(a.lastRunAt)}</ViewerTime> : ago(null)}</>}
        actions={<>
          <Button variant="glass" href="/app/agents" data-testid="agent-back"><ChevronLeft size={15} />All agents</Button>
          {p.perms.write && a.status !== "retired" && <>
            <Button variant="glass" onClick={() => setTab("test")} data-testid="agent-test-run"><FlaskConical size={15} />Test run</Button>
            <Button variant="glass" onClick={() => setRunModal(true)} data-testid="agent-run-now"><Play size={15} />Run now</Button>
            {a.runtime === "n8n" && <Button variant="glass" onClick={() => act("push", () => pushAgentToN8n({ agentId: a.id }), "Pushed to n8n")} loading={busy === "push"} data-testid="agent-push-n8n"><UploadCloud size={15} />{a.externalId ? "Update in n8n" : "Push to n8n"}</Button>}
            {a.status === "deployed" && <Button variant="glass" onClick={() => act("pause", () => setAgentStatus({ agentId: a.id, status: "paused" }), "Paused")} loading={busy === "pause"} data-testid="agent-pause"><Pause size={15} />Pause</Button>}
            <Button variant="glass" onClick={() => confirm("Retire this agent? It stops running and is kept for history.") && act("retire", () => setAgentStatus({ agentId: a.id, status: "retired" }), "Retired")} loading={busy === "retire"} data-testid="agent-retire"><Archive size={15} />Retire</Button>
            {a.status !== "deployed" && <Button variant="gradient" onClick={() => act("deploy", () => setAgentStatus({ agentId: a.id, status: "deployed" }), "Deployed — version recorded")} loading={busy === "deploy"} data-testid="agent-deploy"><Power size={15} />Deploy</Button>}
          </>}
        </>} />
      {flash && <div className={cn("mb-3 rounded-xl px-3 py-2 text-xs", flash.ok ? "bg-emerald-soft text-emerald-ink" : "bg-coral-soft text-coral-ink")} role="status" data-testid="agent-flash">{flash.text}</div>}
      <Tabs testid="tab" value={tab} onChange={setTab} tabs={TABS.map((t) => ({ key: t, label: TAB_LABEL[t], count: t === "approvals" && pending.length ? pending.length : t === "versions" && p.versions.length ? p.versions.length : undefined }))} />

      {tab === "overview" && <Overview p={p} act={act} busy={busy} />}
      {tab === "test" && <TestTab agentId={a.id} definition={a.definition} exampleInput={p.template?.exampleInput ?? {}} canWrite={p.perms.write && a.status !== "retired"} testRuns={p.runs.filter((r) => r.trigger === "test")} onDone={() => router.refresh()} />}
      {tab === "versions" && <VersionsTab agentId={a.id} versions={p.versions} current={a.definition} canWrite={p.perms.write && a.status !== "retired"} onDone={() => router.refresh()} />}
      {tab === "flow" && <FlowBuilder agentId={a.id} definition={a.definition} canWrite={p.perms.write && a.status !== "retired"} onSaved={() => router.refresh()} />}
      {tab === "runs" && <Runs p={p} act={act} busy={busy} drawer={drawer} setDrawer={setDrawer} />}
      {tab === "approvals" && <Approvals approvals={p.approvals} canApprove={p.perms.approve} act={act} busy={busy} />}
      {tab === "results" && <Results p={p} act={act} busy={busy} />}

      <Modal open={runModal} onClose={() => setRunModal(false)} title="Run now">
        <p className="mb-2 text-xs text-ink-2">{a.runtime === "n8n" ? "Posts this JSON to the agent's n8n webhook, then imports executions." : "Starts a run with this JSON as the trigger input. Approval steps will pause the run."}</p>
        <Textarea rows={10} className="font-mono text-xs" value={runInput} onChange={(e) => setRunInput(e.target.value)} data-testid="run-input" />
        <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={() => setRunModal(false)}>Cancel</Button><Button onClick={runNow} loading={busy === "run"} data-testid="run-submit"><Play size={15} />Start run</Button></div>
      </Modal>
    </div>
  );
}

type Act = (key: string, fn: () => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>, okText?: string) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

function Overview({ p, act, busy }: { p: Props; act: Act; busy: string }) {
  const a = p.agent;
  const [policy, setPolicy] = React.useState<ApprovalPolicy>(a.approvalPolicy); const [credIds, setCredIds] = React.useState<string[]>(a.credentialIds);
  const [n8nMsg, setN8nMsg] = React.useState<string>(p.n8n.configured ? `Configured · last status: ${p.n8n.status}${p.n8n.lastError ? ` (${p.n8n.lastError})` : ""}` : "n8n not configured — set N8N_BASE_URL and N8N_API_KEY or add it in Settings → Integrations");
  const nodes = a.definition.nodes;
  const m = p.metrics; const [drill, setDrill] = React.useState<{ title: string; drill: Drill } | null>(null);
  return (
    <div className="space-y-4">
    {m && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 stagger" data-testid="agent-kpis">
      <KpiCard testid="agent-kpi-tasks" label={`Tasks completed (${p.windowDays}d)`} value={m.tasksCompleted} format={(n) => fmtNum(n)} accent="cyan" basis="observed" icon={<Activity size={16} />} caption={`${m.humanInterventions} human approval${m.humanInterventions === 1 ? "" : "s"} · test runs excluded`} />
      <KpiCard testid="agent-kpi-success" label="Success rate" value={m.successRate} format={(n) => fmtPct(n, 0)} accent={m.successRate != null && m.successRate < 0.8 ? "coral" : "emerald"} basis="observed" icon={<CircleCheck size={16} />} emptyText="no finished runs" caption={`${m.succeeded} ok · ${m.failed} failed${m.consecutiveFailures ? ` · ${m.consecutiveFailures} failing in a row` : ""}`} />
      <KpiCard testid="agent-kpi-hours" label={`Hours saved (${p.windowDays}d)`} value={m.hoursSaved} format={(n) => fmtNum(n, 1)} accent="emerald" basis="observed" icon={<Clock size={16} />} caption={`valued at ${fmtUSD(m.hourly)}/h loaded`}
        onClick={() => setDrill({ title: "Financial benefit", drill: { tree: m.trees.benefit, meaning: "Hours saved by succeeded runs × the loaded hourly cost of the people who perform the linked workflow (finance run-ledger method)." } })} />
      <KpiCard testid="agent-kpi-net" label={`Net benefit (${p.windowDays}d)`} value={m.netBenefit} format={(n) => fmtUSD(n)} accent="gold" basis="estimated" icon={<DollarSign size={16} />} caption={`${fmtUSD(m.benefit)} benefit − ${fmtUSD(m.operatingCost)} cost${m.roi != null ? ` · ROI ${Math.round(m.roi * 100)}%` : ""}`}
        onClick={() => setDrill({ title: "Net benefit", drill: { tree: m.trees.net, meaning: "Financial benefit minus operating cost in the window. Projected until recorded as a measurement on the Results tab; capacity freed is not a payroll reduction." } })} />
    </div>}
    {drill && <DrilldownModal open onClose={() => setDrill(null)} title={drill.title} drill={drill.drill} />}
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <CardHeader title="What it does" />
          <p className="text-sm text-ink-2">{p.template?.description ?? "Custom agent."}</p>
          <ol className="mt-3 space-y-1 text-xs">{nodes.map((n, i) => <li key={n.id} className="flex items-center gap-2"><span className="w-5 text-right tabular text-ink-3">{i + 1}.</span><Badge tone={n.type === "approval" ? "warn" : n.type === "action" ? "money" : n.type === "llm" ? "projected" : "neutral"}>{n.type}</Badge><span>{n.label}</span>{n.compensate && <span className="text-[10px] text-ink-3">· undo: {String(n.compensate.note ?? n.compensate.kind)}</span>}</li>)}</ol>
        </Card>
        <Card>
          <CardHeader title="Linked opportunity" subtitle="Projected savings — estimated until measured on the Results tab." />
          {p.opportunity ? <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm"><Link href={`/app/opportunities/${p.opportunity.id}`} className="font-medium text-brand hover:underline">{p.opportunity.title}</Link><Badge tone="neutral">{p.opportunity.status}</Badge><span className="tabular text-projected">{fmtUSD(p.opportunity.realizable)}/yr realizable</span><BasisChip basis={p.opportunity.basis} /></div>
            <CalcTreeView node={p.opportunity.calculation} />
          </> : <Empty title="No opportunity linked" body="Link one so projected savings and before/after measurement show up here." action={<Button variant="secondary" href="/app/opportunities">Opportunities</Button>} />}
        </Card>
      </div>
      <div className="space-y-4">
        <Card data-testid="agent-schedule">
          <CardHeader title={<span className="flex items-center gap-2"><CalendarClock size={15} />Schedule</span>} />
          {m?.schedule ? <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-2"><dt className="text-ink-2">Cron</dt><dd className="font-mono text-xs">{m.schedule.cron}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-ink-2">Means</dt><dd className="text-right text-xs">{m.schedule.description}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-ink-2">Next run</dt><dd className="text-right text-xs tabular" data-testid="agent-next-run">{m.schedule.nextRunAt ? new Date(m.schedule.nextRunAt).toLocaleString("en-US", { timeZone: p.timezone, dateStyle: "medium", timeStyle: "short" }) + ` (${p.timezone})` : m.schedule.valid ? "none within a year" : "invalid expression"}</dd></div>
            <p className="pt-1 text-[11px] text-ink-3">{a.runtime === "n8n" ? "Fires in n8n on this schedule once pushed." : a.status === "deployed" ? "The schedule is honoured by the jobs worker (npm run worker) for deployed agents." : "Deploy the agent for the schedule to take effect."}</p>
          </dl> : <p className="text-xs text-ink-2">No schedule — this agent runs when its trigger fires (webhook, manual or another system). Add <code>schedule</code> (cron) on the Flow tab to run it on a timetable.</p>}
        </Card>
        <Card>
          <CardHeader title="Economics" />
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-ink-2">Monthly cost</dt><dd className="tabular">{fmtUSD(a.monthlyCost)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-2">Baseline min / run</dt><dd className="tabular">{a.baselineMinutesPerRun} <Badge tone="warn">assumed</Badge></dd></div>
            <div className="flex justify-between"><dt className="text-ink-2">Expected min saved / run</dt><dd className="tabular">{a.expectedMinutesSavedPerRun} <Badge tone="projected">estimated</Badge></dd></div>
          </dl>
        </Card>
        {p.perms.write && a.status !== "retired" && <Card>
          <CardHeader title="Settings" />
          <div className="space-y-2">
            <Select label="Approval policy" value={policy.mode} onChange={(e) => setPolicy({ ...policy, mode: e.target.value as ApprovalPolicy["mode"] })} data-testid="settings-approval-mode"><option value="sensitive_only">Sensitive steps only</option><option value="all">Every approval step</option><option value="none">No approvals</option></Select>
            <Select label="Approver" value={policy.approverRole ?? "manager"} onChange={(e) => setPolicy({ ...policy, approverRole: e.target.value as ApprovalPolicy["approverRole"] })}><option value="manager">Manager+</option><option value="admin">Admin+</option><option value="owner">Owner</option></Select>
            <Input label="Approval expires after (h)" type="number" min={1} value={policy.timeoutHours ?? 72} onChange={(e) => setPolicy({ ...policy, timeoutHours: Number(e.target.value) || 72 })} />
            <div className="text-xs font-medium text-ink-2">Attached credentials</div>
            {p.credentials.length === 0 && <p className="text-xs text-ink-3">None in the vault yet. <Link className="text-brand" href="/app/agents/credentials">Add one</Link>.</p>}
            {p.credentials.map((c) => <label key={c.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={credIds.includes(c.id)} onChange={(e) => setCredIds((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id)))} data-testid={`settings-cred-${c.id}`} />{c.name} <span className="text-ink-3">({c.provider})</span></label>)}
            {p.template && p.template.requiredCredentials.filter((rc) => !p.credentials.some((c) => credIds.includes(c.id) && c.provider === rc.provider)).map((rc) => <p key={rc.provider} className="text-xs text-warn">Needs a {rc.label} ({rc.provider}) credential.</p>)}
            <Button size="sm" variant="secondary" onClick={() => act("settings", () => updateAgentSettings({ agentId: a.id, approvalPolicy: policy, credentialIds: credIds }), "Settings saved")} loading={busy === "settings"} data-testid="settings-save">Save settings</Button>
          </div>
        </Card>}
        {a.runtime === "n8n" && <Card>
          <CardHeader title="n8n" subtitle={a.externalId ? `Workflow id ${a.externalId}` : "Not pushed yet"} />
          <p className="text-xs text-ink-2" data-testid="n8n-status">{n8nMsg}</p>
          <div className="mt-2 flex gap-2"><Button size="sm" variant="secondary" onClick={async () => { const r = await checkN8n(); setN8nMsg(r.ok ? `Connected to ${r.baseUrl} (${r.source})` : r.error); }} data-testid="n8n-check">Check</Button>
            {a.externalId && p.perms.write && <Button size="sm" variant="secondary" onClick={() => act("pull", () => pullN8nRuns({ agentId: a.id }), "Executions imported")} loading={busy === "pull"} data-testid="n8n-pull"><RefreshCw size={14} />Import executions</Button>}</div>
        </Card>}
      </div>
    </div>
    </div>
  );
}

function Runs({ p, act, busy, drawer, setDrawer }: { p: Props; act: Act; busy: string; drawer: string | null; setDrawer: (id: string | null) => void }) {
  const tz = useTimeZone();
  if (p.runs.length === 0) return <Empty title="No runs yet" body="Use Run now to start one with sample input. Each step is logged with its output (secrets redacted)." />;
  return (
    <>
      <Table>
        <thead><tr><Th>Status</Th><Th>Trigger</Th><Th>Started</Th><Th>Duration</Th><Th className="text-right">Min saved</Th><Th className="text-right">Human min</Th><Th>Error</Th></tr></thead>
        <tbody>{p.runs.map((r) => (
          <tr key={r.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setDrawer(r.id)} data-testid={`run-row-${r.id}`}>
            <Td><Badge tone={RUN_TONE[r.status] ?? "neutral"}>{r.status.replace("_", " ")}</Badge></Td><Td className="text-xs">{r.trigger === "test" ? <Badge tone="purple">test · dry run</Badge> : r.trigger}</Td><Td className="text-xs">{fmtDate(r.startedAt ?? r.createdAt, tz)}</Td><Td className="text-xs tabular">{dur(r.startedAt, r.finishedAt)}</Td>
            <Td className="text-right tabular text-verified">{r.minutesSaved == null ? "—" : fmtNum(r.minutesSaved, 1)}</Td><Td className="text-right tabular">{fmtNum(r.humanMinutes, 1)}</Td><Td className="max-w-[260px] truncate text-xs text-danger">{r.error ?? ""}</Td>
          </tr>))}</tbody>
      </Table>
      <RunDrawer runId={drawer} onClose={() => setDrawer(null)} canWrite={p.perms.write} canApprove={p.perms.approve} act={act} busy={busy} definition={p.agent.definition} />
    </>
  );
}

function RunDrawer({ runId, onClose, canWrite, canApprove, act, busy, definition }: { runId: string | null; onClose: () => void; canWrite: boolean; canApprove: boolean; act: Act; busy: string; definition: AgentDefinition }) {
  const tz = useTimeZone();
  const [data, setData] = React.useState<{ run: { id: string; status: string; trigger: string; input: unknown; output: unknown; logs: RunLog[]; error: string | null; currentNodeId: string | null; attempt: number; minutesSaved: string | null; humanMinutes: string | null; startedAt: string | Date | null; finishedAt: string | Date | null }; approvals: { id: string; status: string; requestedAction: string; nodeId: string }[] } | null>(null);
  const [note, setNote] = React.useState("");
  React.useEffect(() => {
    if (!runId) { setData(null); return; }
    let alive = true;
    const load = async () => { const r = await getRun({ runId }); if (alive && r.ok) setData({ run: r.run as unknown as NonNullable<typeof data>["run"], approvals: r.approvals }); };
    load(); const t = setInterval(() => { if (data?.run.status && !["running", "queued"].includes(data.run.status)) return; load(); }, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!runId) return null;
  const run = data?.run; const pendingAp = data?.approvals.find((x) => x.status === "pending");
  const out = (run?.output ?? {}) as { nodes?: Record<string, unknown>; state?: { completedActions?: string[] } };
  const label = (id?: string) => definition.nodes.find((n) => n.id === id)?.label ?? id ?? "";
  return (
    <Modal open onClose={onClose} title={<span className="flex items-center gap-2">Run {run ? <Badge tone={RUN_TONE[run.status] ?? "neutral"}>{run.status.replace("_", " ")}</Badge> : null}</span>} wide>
      {!run ? <p className="text-xs text-ink-2">Loading…</p> : (
        <div className="space-y-4" data-testid="run-drawer">
          <div className="grid gap-2 text-xs sm:grid-cols-4">
            <div><div className="text-ink-3">Trigger</div>{run.trigger}</div><div><div className="text-ink-3">Attempts at failing step</div>{run.attempt}</div>
            <div><div className="text-ink-3">Minutes saved</div><span className="text-verified">{run.minutesSaved ?? "—"}</span></div><div><div className="text-ink-3">Human minutes</div>{run.humanMinutes ?? "0"}</div>
          </div>
          {run.error && <div className="rounded-lg bg-danger-soft p-2 text-xs text-danger" data-testid="run-error">{run.error}</div>}
          {run.status === "rolled_back" && <div className="rounded-lg bg-warn-soft p-2 text-xs text-warn">Rolled back: compensation ran for {(out.state?.completedActions ?? []).map(label).join(", ") || "completed actions"} (see log).</div>}
          {run.status === "awaiting_approval" && pendingAp && <div className="rounded-lg border border-warn bg-warn-soft/40 p-3 text-xs" data-testid="run-approval">
            <div className="font-medium">Waiting for approval: {pendingAp.requestedAction}</div>
            {canApprove && <div className="mt-2 flex flex-wrap gap-2"><Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="sm:w-64" data-testid="run-approval-note" />
              <Button size="sm" onClick={() => act("approve", () => decideApproval({ approvalId: pendingAp.id, decision: "approved", note }), "Approved — run resumed")} loading={busy === "approve"} data-testid="run-approve">Approve</Button>
              <Button size="sm" variant="danger" onClick={() => act("reject", () => decideApproval({ approvalId: pendingAp.id, decision: "rejected", note }), "Rejected — run cancelled")} loading={busy === "reject"} data-testid="run-reject">Reject</Button></div>}
          </div>}
          {["failed", "rolled_back", "cancelled"].includes(run.status) && canWrite && <Button size="sm" variant="secondary" onClick={() => act("retry", () => retryRun({ runId: run.id }), "Retry started as a new run")} loading={busy === "retry"} data-testid="run-retry"><RotateCcw size={14} />Retry with same input</Button>}
          <div>
            <div className="mb-1 text-xs font-semibold">Step log</div>
            <ol className="max-h-80 space-y-1 overflow-y-auto rounded-lg bg-surface-2 p-2 font-mono text-[11px]" data-testid="run-logs">
              {run.logs.map((l, i) => <li key={i} className={cn(l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warn" : "text-ink")}><span className="text-ink-3">{formatTime(l.t, tz)}</span> {l.nodeId && <span className="text-brand">[{label(l.nodeId)}]</span>} {l.msg}{l.data && <details className="ml-4 text-ink-2"><summary className="cursor-pointer">data</summary><pre className="whitespace-pre-wrap">{JSON.stringify(l.data, null, 1)}</pre></details>}</li>)}
              {run.logs.length === 0 && <li className="text-ink-3">No log entries yet.</li>}
            </ol>
          </div>
          <details><summary className="cursor-pointer text-xs font-semibold">Input &amp; outputs (secrets redacted)</summary><pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-surface-2 p-2 text-[11px]">{JSON.stringify({ input: run.input, outputs: out.nodes ?? {} }, null, 2)}</pre></details>
        </div>
      )}
    </Modal>
  );
}

export function Approvals({ approvals, canApprove, act, busy, showAgent }: { approvals: (ApprovalRow & { agentName?: string; agentId?: string })[]; canApprove: boolean; act: Act; busy: string; showAgent?: boolean }) {
  const tz = useTimeZone();
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const pending = approvals.filter((x) => x.status === "pending"); const past = approvals.filter((x) => x.status !== "pending");
  if (approvals.length === 0) return <Empty title="No approvals" body="Approval steps pause a run until a person decides. Nothing is waiting." />;
  return (
    <div className="space-y-4">
      {pending.length === 0 ? <p className="text-xs text-ink-2">Nothing pending.</p> : pending.map((ap) => (
        <Card key={ap.id} data-testid={`approval-${ap.id}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              {showAgent && ap.agentName && <Link href={`/app/agents/${ap.agentId}?tab=approvals`} className="text-xs font-medium text-brand hover:underline">{ap.agentName}</Link>}
              <div className="text-sm font-semibold">{ap.requestedAction}</div>
              <div className="text-xs text-ink-3">Requested <ViewerTime dateTime={ap.createdAt}>{ago(ap.createdAt)}</ViewerTime>{ap.expiresAt && ` · expires ${formatDateTime(ap.expiresAt, tz)}`} · step {ap.nodeId}</div>
              <details className="mt-1 text-xs"><summary className="cursor-pointer text-ink-2">What the agent has so far</summary><pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 text-[11px]">{JSON.stringify(ap.payload, null, 2)}</pre></details>
            </div>
            {canApprove ? <div className="flex shrink-0 flex-col gap-2">
              <Input placeholder="Note (optional)" value={notes[ap.id] ?? ""} onChange={(e) => setNotes({ ...notes, [ap.id]: e.target.value })} data-testid={`approval-note-${ap.id}`} />
              <div className="flex gap-2"><Button size="sm" onClick={() => act(`ap-${ap.id}`, () => decideApproval({ approvalId: ap.id, decision: "approved", note: notes[ap.id] }), "Approved — run resumed")} loading={busy === `ap-${ap.id}`} data-testid={`approval-approve-${ap.id}`}>Approve</Button>
                <Button size="sm" variant="danger" onClick={() => act(`rj-${ap.id}`, () => decideApproval({ approvalId: ap.id, decision: "rejected", note: notes[ap.id] }), "Rejected — run cancelled")} loading={busy === `rj-${ap.id}`} data-testid={`approval-reject-${ap.id}`}>Reject</Button></div>
            </div> : <Tooltip text="Only managers, admins and owners can approve."><Badge tone="neutral">view only</Badge></Tooltip>}
          </div>
        </Card>))}
      {past.length > 0 && <Table><thead><tr>{showAgent && <Th>Agent</Th>}<Th>Request</Th><Th>Decision</Th><Th>Note</Th><Th>Decided</Th></tr></thead><tbody>{past.map((ap) => <tr key={ap.id}>{showAgent && <Td className="text-xs">{ap.agentName}</Td>}<Td className="text-xs">{ap.requestedAction}</Td><Td><Badge tone={ap.status === "approved" ? "money" : ap.status === "rejected" ? "danger" : "neutral"}>{ap.status}</Badge></Td><Td className="text-xs">{ap.decisionNote ?? ""}</Td><Td className="text-xs">{fmtDate(ap.decidedAt, tz)}</Td></tr>)}</tbody></Table>}
    </div>
  );
}

function Results({ p, act, busy }: { p: Props; act: Act; busy: string }) {
  const first = new Date(); first.setDate(1); first.setHours(0, 0, 0, 0);
  const [start, setStart] = React.useState(first.toISOString().slice(0, 10)); const [end, setEnd] = React.useState(new Date().toISOString().slice(0, 10));
  const live = p.runs.filter((r) => r.trigger !== "test"); // dry runs never count
  const ledger = live.filter((r) => r.status === "succeeded");
  const totalMin = ledger.reduce((s, r) => s + (r.minutesSaved ?? 0), 0); const human = live.reduce((s, r) => s + r.humanMinutes, 0);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <CardHeader title="Measured savings" subtitle="Each row is a recorded measurement with its own calculation. Verified = basis observed." action={p.perms.write && <div className="flex flex-wrap items-end gap-2"><Input label="From" type="date" value={start} onChange={(e) => setStart(e.target.value)} data-testid="measure-start" /><Input label="To" type="date" value={end} onChange={(e) => setEnd(e.target.value)} data-testid="measure-end" /><Button size="sm" onClick={() => act("measure", () => recordMeasurement({ agentId: p.agent.id, periodStart: new Date(start).toISOString(), periodEnd: new Date(new Date(end).getTime() + 86400_000).toISOString() }), "Measurement recorded")} loading={busy === "measure"} data-testid="measure-record">Record measurement for period</Button></div>} />
          {p.measurements.length === 0 ? <p className="text-xs text-ink-2">No measurements yet. Record one for a period with runs; the finance engine prices the ledger minutes with the loaded hourly cost of the people who did this work.</p> : (
            <div className="space-y-3">{p.measurements.map((m) => <div key={m.id} className="rounded-lg border border-border p-3" data-testid={`measurement-${m.id}`}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{m.periodStart.slice(0, 10)} → {m.periodEnd.slice(0, 10)}</span><Badge tone="neutral">{m.method.replace(/_/g, " ")}</Badge><BasisChip basis={m.basis} /><span className="tabular text-verified">{fmtNum(m.hoursSaved, 1)} h</span><span className="tabular text-money">{fmtUSD(m.dollarsSaved)}</span><span className="text-xs text-ink-3">cost {fmtUSD(m.costIncurred)} · {m.runs} runs</span></div>
              <CalcTreeView node={m.calculation} />
            </div>)}</div>)}
        </Card>
        <Card>
          <CardHeader title="Before vs after (observed)" subtitle="Hours per week on the linked workflow from collector events, either side of deployment." />
          {p.beforeAfter ? <CalcTreeView node={p.beforeAfter} /> : <p className="text-xs text-ink-2">{!p.agent.workflowId ? "Link a workflow to this agent to compare observed hours before and after deployment." : !p.agent.deployedAt ? "Deploy the agent to start the after-period." : "Not enough data yet."}</p>}
        </Card>
      </div>
      <div className="space-y-4">
        <Card>
          <CardHeader title="Run ledger (last 100)" subtitle="Live runs only — test-environment dry runs are excluded." />
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-ink-2">Successful runs</dt><dd className="tabular">{ledger.length} / {live.length}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-2">Minutes saved <Tooltip text="Per-run minutes from the agent's expectation unless a run's output overrides it. Becomes 'verified' once recorded as a measurement." /></dt><dd className="tabular text-verified">{fmtNum(totalMin)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-2">Human review minutes</dt><dd className="tabular">{fmtNum(human)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-2">Net hours</dt><dd className="tabular">{fmtNum((totalMin - human) / 60, 1)}</dd></div>
          </dl>
        </Card>
      </div>
    </div>
  );
}
