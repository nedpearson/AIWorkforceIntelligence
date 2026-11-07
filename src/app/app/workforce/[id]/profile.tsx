"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MessageSquare, Sparkles, PlayCircle, ClipboardList, History, Plug, BadgeDollarSign, Settings2, Brain, ShieldCheck, ArrowLeft, Upload, CheckCircle2, XCircle, AlertTriangle, Quote } from "lucide-react";
import type { CalcTree } from "@/db/schema";
import { Button, Badge, Input, Select, Textarea, Modal, Empty, Table, Th, Td, Tooltip } from "@/components/ui";
import { KpiCard, SectionHeader, Tabs, StatusPill, ExportButton, Segmented } from "@/components/ui/enterprise";
import { CalcTreeView } from "@/components/calc-tree";
import { BeforeAfterBars } from "@/components/charts";
import { AiAvatar, AiBadge, TEAM_ACCENT, TEAM_LABEL } from "@/components/workforce/avatar";
import { ChatPanel, type ChatMsg } from "@/components/workforce/chat-panel";
import { SkillStage } from "@/components/workforce/skill-stage";
import { availability } from "@/components/workforce/employee-card";
import { cn, fmtNum, fmtUSD, fmtPct } from "@/lib/utils";
import type { SkillInfo } from "@/engine/workforce/skills-adapter";
import type { SkillMeta } from "@/engine/skills";
import { SkillRunnerPanel } from "@/components/skills";
import type { EmployeeFinancialsResult } from "@/engine/workforce/financials";
import { updateEmployeeAction, setStatusAction, setPermissionAction, decideMemoryAction, decideRunAction, reviewRunAction, syncConnectionsAction } from "../actions";
import { useTimeZone } from "@/components/time-zone";
import { formatDate, formatDateTime } from "@/lib/datetime";

type Emp = {
  id: string; firstName: string; title: string; team: string; intro: string; status: string; permissionLevel: string; portraitUrl: string | null; portraitProvenance: string | null;
  responsibilities: string[]; expertise: string[]; skills: string[]; knowledgeScope: { departmentIds?: string[]; documentIds?: string[]; categories?: string[] }; instructions: string; instructionsVersion: number;
  departmentId: string | null; approvalOwnerUserId: string | null; monthlyRunBudget: number; monthlyCostBudget: number; connectedProviders: string[]; personaKey: string | null; agentId: string | null;
};
type Run = { id: string; skillKey: string; mode: string; status: string; summary: string; createdAt: string; durationMs: number; manualBaselineMinutes: number; humanReviewMinutes: number; reviewStatus: string | null; reviewNote: string | null; error: string | null;
  steps: { key: string; label: string; status: string; detail: string }[]; approval: { status: string; decidedRole: string | null; decidedAt: string | null; approverRole: string | null; elevated: boolean } | null };
type Mem = { id: string; kind: string; text: string; status: string; createdAt: string; sourceSkillRunId: string | null };
type Conn = { key: string; required: boolean; name: string; status: string; purpose: string; envVars: string[] };
type TabKey = "talk" | "skills" | "demo" | "assign" | "work" | "connect" | "savings" | "customize" | "memory";

const PERM: Record<string, { label: string; body: string }> = {
  read_only: { label: "Read only", body: "May read and analyze. Produces nothing outside BridgeBox." },
  draft_only: { label: "Draft only", body: "May prepare drafts stored in BridgeBox for a person to use." },
  act_with_approval: { label: "Act with approval", body: "Consequential actions wait for a named person to approve." },
  autonomous: { label: "Autonomous", body: "Acts without per-task approval; steps flagged always-approve still wait. Never the default." },
};
const PERM_ORDER = ["read_only", "draft_only", "act_with_approval", "autonomous"];
const CATEGORIES = ["company", "policy", "procedure", "pricing", "product", "customer", "vendor", "terminology", "goal", "decision", "preference", "system", "general"];
const label = (k: string, s: SkillInfo[] | null) => s?.find((x) => x.key === k)?.name ?? k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function Profile(p: {
  tab: string; employee: Emp; opportunity: { id: string; title: string } | null; demoSkill: string | null; skills: SkillInfo[] | null; allSkillKeys: string[];
  counts: { sandboxSuccesses: number; liveSuccesses: number; total: number }; gates: { pilot: string | null; active: string | null };
  runs: Run[]; memory: Mem[]; chat: { conversationId: string | null; messages: ChatMsg[] }; connections: Conn[]; financials: EmployeeFinancialsResult;
  departments: { id: string; name: string }[]; members: { userId: string; label: string }[]; documents: { id: string; title: string; category: string; departmentId: string | null }[];
  perms: { write: boolean; approve: boolean; elevated: boolean }; userName: string; catalog: SkillMeta[] | null; role: string;
}) {
  const e = p.employee; const router = useRouter();
  const [tab, setTab] = React.useState<TabKey>((["talk", "skills", "demo", "assign", "work", "connect", "savings", "customize", "memory"].includes(p.tab) ? p.tab : "talk") as TabKey);
  const [autoDemo, setAutoDemo] = React.useState(false);

  const go = (t: TabKey) => { setTab(t); const u = new URL(window.location.href); u.searchParams.set("tab", t);
    // Work started in another tab (skill runner, demo) is persisted server-side: the tabs that list it navigate so the
    // server props are fresh (history.replaceState + router.refresh kept the old page segment's props).
    if (t === "work" || t === "savings" || t === "memory") router.replace(`${u.pathname}${u.search}`, { scroll: false }); else window.history.replaceState(null, "", u.toString()); document.getElementById("profile-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const accent = TEAM_ACCENT[e.team] ?? "purple";
  const pending = p.memory.filter((m) => m.status === "pending_review").length;
  const ACTIONS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: "talk", label: `Talk to ${e.firstName}`, icon: <MessageSquare size={16} /> }, { key: "skills", label: "See what I can do", icon: <Sparkles size={16} /> },
    { key: "demo", label: "Watch a demonstration", icon: <PlayCircle size={16} /> }, { key: "assign", label: "Assign me a task", icon: <ClipboardList size={16} /> },
    { key: "work", label: "View my work", icon: <History size={16} /> }, { key: "connect", label: "Connect my tools", icon: <Plug size={16} /> },
    { key: "savings", label: "Review my savings", icon: <BadgeDollarSign size={16} /> }, { key: "customize", label: "Customize responsibilities", icon: <Settings2 size={16} /> },
  ];

  return (
    <div>
      <Link href="/app/workforce" className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-ink-2 hover:text-ink" data-testid="back-directory"><ArrowLeft size={14} />AI Workforce</Link>
      <header className="bg-hero relative mb-5 overflow-hidden rounded-[24px] px-5 py-6 text-white shadow-[var(--shadow-lift)] sm:px-8 sm:py-8" data-testid="profile-hero">
        <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(139,92,246,.35),transparent_70%)]" />
        <div className="relative flex flex-col items-center gap-6 text-center md:flex-row md:items-end md:text-left">
          <AiAvatar name={e.firstName} portraitUrl={e.portraitUrl} provenance={e.portraitProvenance} team={e.team} size="xl" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-center gap-2 md:justify-start">
              <AiBadge className="bg-white/95 !text-[#5b21b6] ring-white/40" />
              <span className="text-[11px] font-semibold uppercase tracking-[.16em] text-cyan-300">{TEAM_LABEL[e.team] ?? "Custom AI Team"}</span>
            </div>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight sm:text-5xl">Meet {e.firstName}</h1>
            <p className="mt-1 text-base font-medium text-slate-200 sm:text-lg">{e.title} · <span className="text-slate-300">AI agent, not a person</span></p>
            <blockquote className="mt-4 flex max-w-3xl gap-2 text-sm text-slate-200 sm:text-base"><Quote size={18} className="mt-0.5 shrink-0 text-purple-300" aria-hidden /><span data-testid="profile-intro">{e.intro}</span></blockquote>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs md:justify-start">
              <StatusPill status={e.status} map={{ sandbox: "cyan", pilot: "purple", active: "emerald" }} />
              <span className="rounded-full bg-white/10 px-2 py-0.5 font-semibold ring-1 ring-white/20"><ShieldCheck size={11} className="mr-1 inline" />{PERM[e.permissionLevel]?.label}</span>
              <span className="text-slate-300">{availability(e.status)}</span>
              {e.portraitUrl && <span className="text-slate-400">· {e.portraitProvenance === "licensed" ? "Licensed portrait of an AI agent" : "AI-generated portrait"}</span>}
            </div>
          </div>
        </div>
        <div className="relative mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ACTIONS.map((a) => (
            <button key={a.key} onClick={() => { if (a.key === "demo") setAutoDemo(false); go(a.key); }} data-testid={`action-${a.key}`}
              className={cn("flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-semibold ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white", tab === a.key ? "bg-white text-midnight ring-white" : "bg-white/10 text-white ring-white/20 hover:bg-white/20")}>
              {a.icon}<span className="min-w-0 leading-tight">{a.label}</span>
            </button>
          ))}
        </div>
      </header>

      <div id="profile-tabs" className="scroll-mt-4">
        <Tabs testid="profile-tab" value={tab} onChange={go} tabs={[...ACTIONS.map((a) => ({ key: a.key, label: a.label.replace(`Talk to ${e.firstName}`, "Talk").replace("Customize responsibilities", "Customize") })), { key: "memory" as TabKey, label: "Memory", count: pending || undefined }]} />
      </div>

      {tab === "talk" && (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="card min-w-0 p-4 sm:p-5"><ChatPanel employee={e} initial={p.chat.messages} conversationId={p.chat.conversationId} userName={p.userName} onAction={(a) => { if (a.kind === "start_demo") { setAutoDemo(true); go("demo"); } }} /></div>
          <aside className="space-y-3">
            <div className="card p-4"><div className="text-sm font-bold">What {e.firstName} knows</div><p className="mt-1 text-xs text-ink-2">Answers come only from <b>approved</b> AI Brain documents and facts{e.knowledgeScope.departmentIds?.length ? " in its departments" : ""} plus BridgeBox workflow and financial evidence. No approved source → it says so.</p><Link href="/app/brain" className="mt-2 inline-block text-xs font-semibold text-royal-ink hover:underline">Open the AI Brain →</Link></div>
            <div className="card p-4"><div className="text-sm font-bold">Voice</div><p className="mt-1 text-xs text-ink-2">Use the microphone (where your browser supports speech recognition) and turn on <b>AI voice</b> to hear replies read aloud by your browser&apos;s speech synthesis. The voice is synthetic.</p></div>
          </aside>
        </div>
      )}
      {tab === "skills" && <SkillsTab e={e} skills={p.skills} connections={p.connections} />}
      {tab === "demo" && (
        <div className="card p-5">
          <SectionHeader title={`Watch ${e.firstName} work`} subtitle="Runs in the sandbox on a synthetic sample — nothing touches your real systems." accent="cyan" icon={<PlayCircle size={15} />} />
          {p.demoSkill ? <SkillStage key={`demo-${autoDemo}`} aiEmployeeId={e.id} firstName={e.firstName} skillKey={p.demoSkill} skillName={label(p.demoSkill, p.skills)} mode="sandbox" autoStart={autoDemo} onResult={(r) => { if (r.ok) router.refresh(); }} testid="demo" />
            : <Empty title="No demonstration skill" body="Add a skill under Customize responsibilities." />}
          <PilotNudge e={e} gates={p.gates} perms={p.perms} counts={p.counts} />
        </div>
      )}
      {tab === "assign" && <AssignTab e={e} skills={p.skills} perms={p.perms} catalog={p.catalog} demoSkill={p.demoSkill} />}
      {tab === "work" && <WorkTab e={e} runs={p.runs} skills={p.skills} perms={p.perms} />}
      {tab === "connect" && <ConnectTab e={e} connections={p.connections} perms={p.perms} />}
      {tab === "savings" && <SavingsTab e={e} f={p.financials} />}
      {tab === "customize" && <CustomizeTab {...p} />}
      {tab === "memory" && <MemoryTab e={e} memory={p.memory} perms={p.perms} />}
    </div>
  );
}

function PilotNudge({ e, gates, perms, counts }: { e: Emp; gates: { pilot: string | null; active: string | null }; perms: { write: boolean }; counts: { sandboxSuccesses: number } }) {
  const router = useRouter(); const [msg, setMsg] = React.useState<string | null>(null); const [busy, setBusy] = React.useState(false);
  if (!perms.write || !["draft", "sandbox"].includes(e.status)) return null;
  const start = async () => {
    setBusy(true); setMsg(null);
    if (e.status === "draft") { const r = await setStatusAction({ id: e.id, status: "sandbox" }); if (!r.ok) { setBusy(false); setMsg(r.error); return; } }
    const r = await setStatusAction({ id: e.id, status: "pilot" }); setBusy(false);
    setMsg(r.ok ? `${e.firstName} is now in Pilot.` : r.error); if (r.ok) router.refresh();
  };
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-purple/25 bg-purple-soft/40 p-4">
      <div className="min-w-0 flex-1 text-sm"><b>Ready for a pilot?</b> <span className="text-ink-2">{counts.sandboxSuccesses ? `${counts.sandboxSuccesses} successful sandbox run(s) recorded.` : gates.pilot ?? "Run the demonstration once successfully to unlock a pilot."}</span></div>
      <Button variant="gradient" size="sm" disabled={!counts.sandboxSuccesses} loading={busy} onClick={start} data-testid="start-pilot">Start pilot</Button>
      {msg && <p className="w-full text-xs" role="status">{msg}</p>}
    </div>
  );
}

function SkillsTab({ e, skills, connections }: { e: Emp; skills: SkillInfo[] | null; connections: Conn[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="card p-5 lg:col-span-1">
        <SectionHeader title="Responsibilities" accent="purple" icon={<ClipboardList size={15} />} />
        <ul className="space-y-2">{e.responsibilities.map((r) => <li key={r} className="flex gap-2 text-sm"><CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-ink" />{r}</li>)}</ul>
        {e.expertise.length > 0 && <><div className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-3">Expertise</div><div className="mt-1 flex flex-wrap gap-1">{e.expertise.map((x) => <Badge key={x} tone="purple">{x}</Badge>)}</div></>}
      </div>
      <div className="card p-5 lg:col-span-2">
        <SectionHeader title="Skills" subtitle={skills ? "Typed, permissioned units of work with documented manual baselines" : "Skills engine unavailable — showing skill names only"} accent="cyan" icon={<Sparkles size={15} />} />
        <div className="grid gap-3 sm:grid-cols-2" data-testid="skills-list">
          {e.skills.map((k) => { const s = skills?.find((x) => x.key === k); return (
            <div key={k} className="rounded-xl border border-border p-3">
              <div className="flex items-center justify-between gap-2"><div className="text-sm font-bold">{label(k, skills)}</div>{s && <Badge tone={s.access === "act" ? "coral" : s.access === "draft" ? "gold" : "cyan"}>{s.access}</Badge>}</div>
              {s ? <><p className="mt-1 text-xs text-ink-2">{s.description}</p><p className="mt-2 text-[11px] text-ink-3">Manual baseline: {s.manualBaselineMinutes} min per run (assumption){s.requiresProviders.length ? ` · needs ${s.requiresProviders.join(", ")}` : ""}</p></> : <p className="mt-1 text-xs text-ink-3">Skills engine unavailable.</p>}
            </div>
          ); })}
        </div>
        <div className="mt-5 text-xs font-semibold uppercase tracking-wide text-ink-3">Connections for live work</div>
        <div className="mt-2 flex flex-wrap gap-2">{connections.length ? connections.map((c) => <span key={c.key} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs">{c.name}<StatusPill status={c.status} />{c.required && <Badge tone="coral">required</Badge>}</span>) : <span className="text-xs text-ink-2">None — works from BridgeBox data and approved knowledge.</span>}</div>
      </div>
    </div>
  );
}

function AssignTab({ e, skills, perms, catalog, demoSkill }: { e: Emp; skills: SkillInfo[] | null; perms: { write: boolean; approve: boolean; elevated: boolean }; catalog: SkillMeta[] | null; demoSkill: string | null }) {
  const [skill, setSkill] = React.useState(e.skills[0] ?? "");
  const router = useRouter();
  const liveWhy = !perms.write ? "Your role can't assign live tasks. Ask an owner, admin or consultant." : !["pilot", "active"].includes(e.status) ? `${e.firstName} is in ${e.status} status. Live tasks start in Pilot: watch a demonstration, then press Start pilot.` : undefined;
  if (catalog && catalog.length) return (
    <div className="card p-5">
      <SectionHeader title={`Assign ${e.firstName} a task`} subtitle={`Sandbox uses synthetic samples; live uses your real data at ${PERM[e.permissionLevel]?.label} permission.`} accent="emerald" icon={<ClipboardList size={15} />} />
      <SkillRunnerPanel aiEmployeeId={e.id} employeeName={e.firstName} skills={catalog} canRunLive={!liveWhy} liveDisabledReason={liveWhy} canApprove={perms.approve} canApproveElevated={perms.elevated} canReview={perms.approve} permissionLevel={e.permissionLevel} defaultSkill={demoSkill ?? undefined} testid="assign-runner" />
    </div>
  );
  const reason = !perms.write ? "Your role can't assign live tasks. Ask an owner, admin or consultant." : !["pilot", "active"].includes(e.status) ? `${e.firstName} is in ${e.status} status. Live tasks start in Pilot: watch a demonstration, then press Start pilot.` : null;
  return (
    <div className="card p-5">
      <SectionHeader title={`Assign ${e.firstName} a task`} subtitle="Live work uses your real data and obeys the permission level below." accent="emerald" icon={<ClipboardList size={15} />} />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <Select label="Skill" value={skill} onChange={(ev) => setSkill(ev.target.value)} data-testid="assign-skill">{e.skills.map((k) => <option key={k} value={k}>{label(k, skills)}</option>)}</Select>
        <div className="rounded-xl border border-border px-3 py-2 text-xs"><div className="font-semibold">Permission: {PERM[e.permissionLevel]?.label}</div><div className="text-ink-2">{PERM[e.permissionLevel]?.body}</div></div>
      </div>
      {skill && <SkillStage key={skill} aiEmployeeId={e.id} firstName={e.firstName} skillKey={skill} skillName={label(skill, skills)} mode="live" disabledReason={reason} onResult={() => router.refresh()} testid="assign" inputHint={skills?.find((x) => x.key === skill)?.sampleShape} />}
    </div>
  );
}

function WorkTab({ e, runs, skills, perms }: { e: Emp; runs: Run[]; skills: SkillInfo[] | null; perms: { approve: boolean; elevated: boolean } }) {
  const tz = useTimeZone();
  const router = useRouter(); const [busy, setBusy] = React.useState<string | null>(null); const [msg, setMsg] = React.useState<string | null>(null);
  const [review, setReview] = React.useState<Run | null>(null); const [verdict, setVerdict] = React.useState<"accepted" | "corrected" | "rejected">("accepted"); const [note, setNote] = React.useState(""); const [improve, setImprove] = React.useState("");
  const decide = async (r: Run, d: "approve" | "reject") => { setBusy(r.id); const x = await decideRunAction({ skillRunId: r.id, decision: d, aiEmployeeId: e.id }); setBusy(null); setMsg(x.ok ? `Run ${d}d.` : x.error); router.refresh(); };
  const submitReview = async () => { if (!review) return; setBusy(review.id); const x = await reviewRunAction({ skillRunId: review.id, verdict, note: note || undefined, improvement: improve || undefined, aiEmployeeId: e.id }); setBusy(null); setMsg(x.ok ? "Review saved. Any improvement goes to Memory for manager approval." : x.error); setReview(null); setNote(""); setImprove(""); router.refresh(); };
  const awaiting = runs.filter((r) => r.status === "awaiting_approval");
  if (!runs.length) return <Empty title={`${e.firstName} hasn't done any work yet`} body="Watch a demonstration to see a sandbox run, then start a pilot to assign live tasks." />;
  return (
    <div className="space-y-4">
      {msg && <p className="text-xs text-ink-2" role="status">{msg}</p>}
      {awaiting.length > 0 && (
        <div className="card border-gold/40 p-4" data-testid="approvals">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold"><AlertTriangle size={16} className="text-gold-ink" />{awaiting.length} task(s) waiting for approval</div>
          {awaiting.map((r) => <div key={r.id} className="flex flex-wrap items-center gap-2 border-t border-border py-2 text-sm"><span className="font-semibold">{label(r.skillKey, skills)}</span><span className="text-ink-2">{r.summary}</span>
            {perms.approve && (!r.approval?.elevated || perms.elevated) ? <span className="ml-auto flex gap-2"><Button size="sm" loading={busy === r.id} onClick={() => decide(r, "approve")} data-testid={`approve-${r.id}`}>Approve</Button><Button size="sm" variant="secondary" onClick={() => decide(r, "reject")} data-testid={`reject-${r.id}`}>Reject</Button></span> : <span className="ml-auto text-xs text-ink-3" data-testid={`approve-blocked-${r.id}`}>{r.approval?.elevated ? "Over the approval threshold — an owner or admin must approve" : "A manager must approve"}</span>}</div>)}
        </div>
      )}
      <Table>
        <thead><tr><Th>When</Th><Th>Skill</Th><Th>Mode</Th><Th>Status</Th><Th>Outcome</Th><Th>Time</Th><Th>Review</Th></tr></thead>
        <tbody>{runs.map((r) => (
          <tr key={r.id} data-testid={`run-${r.id}`}>
            <Td className="whitespace-nowrap text-xs">{formatDateTime(r.createdAt, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Td>
            <Td className="font-medium">{label(r.skillKey, skills)}</Td>
            <Td>{r.mode === "sandbox" ? <Badge tone="cyan">Synthetic sample</Badge> : <Badge tone="emerald">Live</Badge>}</Td>
            <Td><StatusPill status={r.status} /></Td>
            <Td className="max-w-[320px] text-xs text-ink-2">{r.error ?? r.summary}
              {r.approval && <div className="mt-1" data-testid={`run-approval-${r.id}`}><Badge tone={r.approval.status === "approved" ? "emerald" : r.approval.status === "rejected" ? "coral" : "gold"}>{r.approval.status === "pending" ? `Waiting for ${r.approval.approverRole ?? "approval"}` : `${r.approval.status} by ${r.approval.decidedRole ?? "a person"}`}</Badge></div>}
              {r.steps.length > 0 && <details className="mt-1" data-testid={`run-steps-${r.id}`}><summary className="cursor-pointer font-semibold text-royal-ink">{r.steps.length} steps</summary>
                <ol className="mt-1 space-y-0.5">{r.steps.map((st, i) => <li key={`${st.key}-${i}`} className="flex gap-1.5" data-testid={`run-step-${st.key}`}><span className="tabular text-ink-3">{i + 1}.</span><span className="font-medium text-ink">{st.label}</span><span className="text-ink-3">· {st.status.replace(/_/g, " ")}</span></li>)}</ol></details>}
            </Td>
            <Td className="whitespace-nowrap text-xs">{(r.durationMs / 1000).toFixed(1)}s · {fmtNum(r.manualBaselineMinutes, 0)} min manual</Td>
            <Td>{r.reviewStatus ? <StatusPill status={r.reviewStatus === "accepted" ? "approved" : r.reviewStatus === "rejected" ? "rejected" : "reviewing"} /> : perms.approve && r.mode === "live" && ["succeeded", "failed"].includes(r.status) ? <Button size="sm" variant="secondary" onClick={() => setReview(r)} data-testid={`review-${r.id}`}>Review</Button> : <span className="text-xs text-ink-3">—</span>}</Td>
          </tr>
        ))}</tbody>
      </Table>
      <Modal open={!!review} onClose={() => setReview(null)} title="Review this task">
        <div className="space-y-3">
          <Segmented testid="review-verdict" value={verdict} onChange={setVerdict} options={[{ key: "accepted", label: "Accept" }, { key: "corrected", label: "Corrected" }, { key: "rejected", label: "Reject" }]} />
          <Textarea label="Note (optional)" value={note} onChange={(ev) => setNote(ev.target.value)} rows={2} />
          <Textarea label={`What should ${e.firstName} do differently next time? (becomes a pending memory for approval)`} value={improve} onChange={(ev) => setImprove(ev.target.value)} rows={3} />
          <p className="text-[11px] text-ink-3">Feedback never changes permissions or approval rules.</p>
          <Button onClick={submitReview} loading={!!busy} data-testid="review-submit">Save review</Button>
        </div>
      </Modal>
    </div>
  );
}

function ConnectTab({ e, connections, perms }: { e: Emp; connections: Conn[]; perms: { write: boolean } }) {
  const router = useRouter(); const [msg, setMsg] = React.useState<string | null>(null); const [busy, setBusy] = React.useState(false);
  const sync = async () => { setBusy(true); const r = await syncConnectionsAction({ id: e.id, providers: connections.map((c) => c.key) }); setBusy(false); setMsg(r.ok ? (r.connected.length ? `Recorded ${r.connected.length} connected tool(s).` : "None of these tools are connected yet.") : r.error); router.refresh(); };
  return (
    <div className="card p-5">
      <SectionHeader title={`Connect ${e.firstName}'s tools`} subtitle="Live tasks use these systems. Status is the real state of each connector for your organization." accent="royal" icon={<Plug size={15} />}
        action={<div className="flex gap-2">{perms.write && <Button size="sm" variant="secondary" loading={busy} onClick={sync} data-testid="sync-connections">Check & record connections</Button>}<Button size="sm" href="/app/integrations" data-testid="open-integrations">Open integrations</Button></div>} />
      {msg && <p className="mb-3 text-xs" role="status">{msg}</p>}
      {connections.length === 0 ? <Empty title="No external tools needed" body={`${e.firstName}'s skills work from BridgeBox data and your approved AI Brain knowledge.`} /> : (
        <div className="grid gap-3 sm:grid-cols-2">{connections.map((c) => (
          <div key={c.key} className="rounded-xl border border-border p-3" data-testid={`conn-${c.key}`}>
            <div className="flex items-center justify-between gap-2"><div className="text-sm font-bold">{c.name}</div><StatusPill status={c.status} /></div>
            <p className="mt-1 text-xs text-ink-2">{c.purpose}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">{c.required ? <Badge tone="coral">Required by a skill</Badge> : <Badge tone="neutral">Used in observed workflow</Badge>}{e.connectedProviders.includes(c.key) && <Badge tone="emerald">Recorded</Badge>}
              {c.status !== "connected" && c.envVars.length > 0 && <span className="text-ink-3">needs {c.envVars.join(", ")}</span>}</div>
          </div>
        ))}</div>
      )}
    </div>
  );
}

function SavingsTab({ e, f }: { e: Emp; f: EmployeeFinancialsResult }) {
  const tz = useTimeZone();
  const [tree, setTree] = React.useState<CalcTree | null>(null);
  const t = f.totals;
  const csv = f.months.map((m) => ({ month: m.month, tasks_completed: m.tasksCompleted, live_runs: m.liveRuns, sandbox_runs_excluded: m.sandboxRuns, manual_baseline_hours: m.manualBaselineHours.toFixed(2), automated_hours: m.automatedHours.toFixed(3), human_review_hours: m.humanReviewHours.toFixed(2), verified_hours_recovered: m.verifiedHoursRecovered.toFixed(2), capacity_value_usd: m.capacityValue.toFixed(2), ai_operating_cost_usd: m.operatingCost.toFixed(2) }));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-2">
        <span>Last 6 months · {formatDate(f.range.from, "UTC")} – {formatDate(f.range.to, tz)} · live work only</span>
        <span className="ml-auto"><ExportButton rows={csv} filename={`${e.firstName.toLowerCase()}-savings`} testid="savings-export" /></span>
      </div>
      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="savings-kpis">
        <KpiCard label="Tasks completed" value={t.tasksCompleted} format={(n) => fmtNum(n)} accent="cyan" basis="observed" caption={`${t.sandboxRuns} sandbox excluded`} onClick={() => setTree(f.trees.tasks)} testid="sv-tasks" />
        <KpiCard label="Verified hours" value={t.verifiedHoursRecovered} format={(n) => `${fmtNum(n, 1)} h`} accent="emerald" basis="observed" onClick={() => setTree(f.trees.verifiedHours)} testid="sv-hours" />
        <KpiCard label="Capacity value" value={t.capacityValue} format={(n) => fmtUSD(n)} accent="cyan" caption="time, not cash" onClick={() => setTree(f.trees.capacityValue)} testid="sv-capacity" />
        <KpiCard label="Hard savings / yr" value={t.hardSavingsAnnual} format={(n) => fmtUSD(n)} accent="emerald" basis="observed" caption="approved ledger only" onClick={() => setTree(f.trees.hardSavings)} testid="sv-hard" />
        <KpiCard label="AI operating cost" value={t.operatingCost} format={(n) => fmtUSD(n)} accent="coral" basis="assumed" onClick={() => setTree(f.trees.operatingCost)} testid="sv-cost" />
        <KpiCard label="Net capacity benefit" value={t.netBenefit} format={(n) => fmtUSD(n)} accent="gold" onClick={() => setTree(f.trees.netBenefit)} testid="sv-net" />
        <KpiCard label="ROI" value={t.roi} format={(n) => fmtPct(n)} accent="gold" emptyText="n/a" caption={t.roi == null ? "no live work yet" : "capacity basis"} onClick={() => setTree(f.trees.roi)} testid="sv-roi" />
        <KpiCard label="Cost per task" value={t.costPerTask} format={(n) => fmtUSD(n)} accent="royal" emptyText="n/a" onClick={() => setTree(f.trees.costPerTask)} testid="sv-cpt" />
        <KpiCard label="Accuracy" value={t.accuracy} format={(n) => fmtPct(n)} accent="emerald" emptyText="n/a" caption={`${t.reviewedRuns} reviewed`} onClick={() => setTree(f.trees.accuracy)} testid="sv-accuracy" />
        <KpiCard label="Human intervention" value={t.interventionRate} format={(n) => fmtPct(n)} accent="purple" emptyText="n/a" caption="approvals + corrections" onClick={() => setTree(f.trees.interventionRate)} testid="sv-intervention" />
      </div>
      {f.notes.length > 0 && <div className="mt-4 space-y-1">{f.notes.map((n) => <p key={n} className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">{n}</p>)}</div>}
      {e.agentId && <p className="mt-3 text-xs text-ink-2">Live work is recorded on the linked agent&apos;s run ledger. <Link href={`/app/agents/${e.agentId}?tab=results`} className="font-semibold text-royal-ink hover:underline" data-testid="sv-agent-link">Record a verified-savings measurement →</Link></p>}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="card p-5" role="figure" aria-label={`Verified hours recovered by month: ${f.months.map((m) => `${m.month} ${m.verifiedHoursRecovered.toFixed(1)}`).join(", ")}`}>
          <SectionHeader title="Verified hours by month" subtitle="Live runs + linked agent runs" accent="emerald" />
          <MonthBars rows={f.months.map((m) => ({ name: m.month, value: m.verifiedHoursRecovered, tasks: m.tasksCompleted }))} />
        </div>
        <div className="card p-5">
          <SectionHeader title="Before / after" subtitle={f.beforeAfter ? f.beforeAfter.workflowName : "No matched workflow"} accent="gold" />
          {f.beforeAfter ? (
            <div role="figure" aria-label={`Manual ${f.beforeAfter.manualHoursPerWeek.toFixed(1)} hours per week; after automation ${(f.beforeAfter.observedAfterHoursPerWeek ?? f.beforeAfter.projectedAfterHoursPerWeek).toFixed(1)} hours per week`}>
              <div className="h-56"><BeforeAfterBars rows={[{ name: "Projected", before: f.beforeAfter.manualHoursPerWeek, after: f.beforeAfter.projectedAfterHoursPerWeek }, ...(f.beforeAfter.observedAfterHoursPerWeek != null ? [{ name: "Observed", before: f.beforeAfter.manualHoursPerWeek, after: f.beforeAfter.observedAfterHoursPerWeek }] : [])]} /></div>
              <button className="mt-2 text-xs font-semibold text-royal-ink hover:underline" onClick={() => setTree(f.beforeAfter!.tree)} data-testid="before-after-tree">How is this calculated?</button>
              {f.beforeAfter.observedAfterHoursPerWeek == null && <p className="mt-1 text-[11px] text-ink-3">Observed &quot;after&quot; appears once {e.firstName} completes live runs.</p>}
            </div>
          ) : <Empty title="No workflow matched yet" body="Link this AI employee to an opportunity to compare manual vs automated time." />}
        </div>
      </div>
      {f.opportunity && <p className="mt-4 text-xs text-ink-2">Projected for <Link className="font-semibold text-royal-ink hover:underline" href={`/app/opportunities/${f.opportunity.id}`}>{f.opportunity.title}</Link>: {fmtUSD(f.opportunity.realizableAnnualSavings)}/yr realizable (estimated) — kept separate from the verified figures above.</p>}
      <Modal open={!!tree} onClose={() => setTree(null)} title="How is this calculated?">{tree && <CalcTreeView node={tree} />}</Modal>
    </div>
  );
}

function CustomizeTab(p: Parameters<typeof Profile>[0]) {
  const e = p.employee; const router = useRouter();
  const [f, setF] = React.useState({ firstName: e.firstName, title: e.title, intro: e.intro, responsibilities: e.responsibilities.join("\n"), skills: e.skills, instructions: e.instructions, departmentId: e.departmentId ?? "",
    approvalOwnerUserId: e.approvalOwnerUserId ?? "", monthlyRunBudget: e.monthlyRunBudget, monthlyCostBudget: e.monthlyCostBudget, depts: e.knowledgeScope.departmentIds ?? [], cats: e.knowledgeScope.categories ?? [], docs: e.knowledgeScope.documentIds ?? [] });
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null); const [busy, setBusy] = React.useState(false);
  const [perm, setPerm] = React.useState<string | null>(null); const [confirm, setConfirm] = React.useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (k: "skills" | "depts" | "cats" | "docs", v: string) => setF((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] }));
  const ro = !p.perms.write;
  const save = async () => {
    setBusy(true); setMsg(null);
    const r = await updateEmployeeAction({ id: e.id, patch: { firstName: f.firstName, title: f.title, intro: f.intro, responsibilities: f.responsibilities.split("\n").map((s) => s.trim()).filter(Boolean), skills: f.skills, instructions: f.instructions,
      departmentId: f.departmentId || null, approvalOwnerUserId: f.approvalOwnerUserId || null, monthlyRunBudget: Number(f.monthlyRunBudget), monthlyCostBudget: Number(f.monthlyCostBudget),
      knowledgeScope: { departmentIds: f.depts, categories: f.cats, documentIds: f.docs } } });
    setBusy(false); setMsg(r.ok ? { ok: true, text: "Saved. Changes are audited; instruction edits create a new version." } : { ok: false, text: r.error }); if (r.ok) router.refresh();
  };
  const changePerm = async (level: string, confirmed: boolean) => {
    const r = await setPermissionAction({ id: e.id, level, confirm: confirmed }); setPerm(null); setConfirm(false);
    setMsg(r.ok ? { ok: true, text: `Permission set to ${PERM[r.level].label}.` } : { ok: false, text: r.error }); if (r.ok) router.refresh();
  };
  const status = async (s: string) => { const r = await setStatusAction({ id: e.id, status: s }); setMsg(r.ok ? { ok: true, text: `Status: ${r.status}.` } : { ok: false, text: r.error }); if (r.ok) router.refresh(); };
  const allSkills = p.skills?.map((s) => s.key) ?? p.allSkillKeys;
  const docsInScope = p.documents.filter((d) => !f.cats.length || f.cats.includes(d.category));
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <fieldset className="card space-y-3 p-5" disabled={ro}>
          <legend className="sr-only">Identity</legend>
          <SectionHeader title="Identity & responsibilities" accent="purple" />
          <div className="grid gap-3 sm:grid-cols-2"><Input label="Name" value={f.firstName} onChange={(ev) => set("firstName", ev.target.value)} data-testid="cz-name" /><Input label="Position title" value={f.title} onChange={(ev) => set("title", ev.target.value)} data-testid="cz-title" /></div>
          <Textarea label="Introduction (must say it is an AI agent — added automatically if missing)" rows={3} value={f.intro} onChange={(ev) => set("intro", ev.target.value)} data-testid="cz-intro" />
          <Textarea label="Responsibilities (one per line)" rows={4} value={f.responsibilities} onChange={(ev) => set("responsibilities", ev.target.value)} data-testid="cz-resp" />
          <Textarea label={`Instructions (version ${e.instructionsVersion})`} rows={4} value={f.instructions} onChange={(ev) => set("instructions", ev.target.value)} placeholder="e.g. Always flag invoices over $5,000 for controller review." data-testid="cz-instructions" />
          <div><div className="mb-1 text-xs font-medium text-ink-2">Skills</div><div className="flex flex-wrap gap-1.5">{allSkills.map((k) => <label key={k} className={cn("cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium", f.skills.includes(k) ? "border-purple bg-purple-soft text-purple-ink" : "border-border text-ink-2")}><input type="checkbox" className="sr-only" checked={f.skills.includes(k)} onChange={() => toggle("skills", k)} data-testid={`cz-skill-${k}`} />{label(k, p.skills)}</label>)}</div></div>
        </fieldset>
        <fieldset className="card space-y-3 p-5" disabled={ro}>
          <SectionHeader title="Business knowledge scope" subtitle="Only approved AI Brain content inside this scope is used" accent="indigo" icon={<Brain size={15} />} />
          <div><div className="mb-1 text-xs font-medium text-ink-2">Departments (none = all)</div><div className="flex flex-wrap gap-1.5">{p.departments.map((d) => <Chip key={d.id} on={f.depts.includes(d.id)} onClick={() => toggle("depts", d.id)} testid={`cz-dept-${d.id}`}>{d.name}</Chip>)}</div></div>
          <div><div className="mb-1 text-xs font-medium text-ink-2">Categories (none = all)</div><div className="flex flex-wrap gap-1.5">{CATEGORIES.map((c) => <Chip key={c} on={f.cats.includes(c)} onClick={() => toggle("cats", c)} testid={`cz-cat-${c}`}>{c}</Chip>)}</div></div>
          <div><div className="mb-1 text-xs font-medium text-ink-2">Specific documents (none = all in scope)</div>{docsInScope.length ? <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">{docsInScope.map((d) => <Chip key={d.id} on={f.docs.includes(d.id)} onClick={() => toggle("docs", d.id)} testid={`cz-doc-${d.id}`}>{d.title}</Chip>)}</div> : <p className="text-xs text-ink-3">No approved documents yet. <Link href="/app/brain" className="text-royal-ink hover:underline">Add knowledge →</Link></p>}</div>
        </fieldset>
        <fieldset className="card space-y-3 p-5" disabled={ro}>
          <SectionHeader title="Assignment, budgets & approvals" accent="gold" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Department served" value={f.departmentId} onChange={(ev) => set("departmentId", ev.target.value)} data-testid="cz-department"><option value="">Organization-wide</option>{p.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
            <Select label="Approval owner (a person)" value={f.approvalOwnerUserId} onChange={(ev) => set("approvalOwnerUserId", ev.target.value)} data-testid="cz-owner"><option value="">Not set</option>{p.members.map((m) => <option key={m.userId} value={m.userId}>{m.label}</option>)}</Select>
            <Input label="Monthly run budget" type="number" min={0} value={f.monthlyRunBudget} onChange={(ev) => set("monthlyRunBudget", Number(ev.target.value))} data-testid="cz-run-budget" />
            <Input label="Monthly cost budget (USD)" type="number" min={0} value={f.monthlyCostBudget} onChange={(ev) => set("monthlyCostBudget", Number(ev.target.value))} data-testid="cz-cost-budget" />
          </div>
        </fieldset>
        {!ro && <div className="flex items-center gap-3"><Button onClick={save} loading={busy} data-testid="cz-save">Save changes</Button>{msg && <span className={cn("text-xs", msg.ok ? "text-emerald-ink" : "text-coral-ink")} role="status">{msg.text}</span>}</div>}
      </div>
      <div className="space-y-4">
        <div className="card p-5">
          <SectionHeader title="Permission level" accent="coral" icon={<ShieldCheck size={15} />} />
          <div className="space-y-2" role="radiogroup" aria-label="Permission level">
            {PERM_ORDER.map((k) => { const cur = e.permissionLevel === k; const up = PERM_ORDER.indexOf(k) > PERM_ORDER.indexOf(e.permissionLevel); return (
              <button key={k} role="radio" aria-checked={cur} disabled={ro || cur} onClick={() => up ? setPerm(k) : changePerm(k, false)} data-testid={`perm-${k}`}
                className={cn("w-full rounded-xl border p-3 text-left text-sm transition", cur ? "border-coral bg-coral-soft/40" : "border-border hover:bg-surface-2 disabled:hover:bg-transparent")}>
                <div className="flex items-center justify-between font-semibold">{PERM[k].label}{cur && <Badge tone="coral">current</Badge>}</div><div className="text-xs text-ink-2">{PERM[k].body}</div>
              </button>
            ); })}
          </div>
          <p className="mt-2 text-[11px] text-ink-3">Raising permission requires an owner or admin, explicit confirmation, and one level at a time. Every change is audited.</p>
        </div>
        <div className="card p-5">
          <SectionHeader title="Lifecycle" accent="emerald" />
          <div className="text-sm">Current: <StatusPill status={e.status} /></div>
          <div className="mt-3 flex flex-wrap gap-2">
            {e.status === "draft" && <Button size="sm" variant="secondary" disabled={ro} onClick={() => status("sandbox")} data-testid="st-sandbox">Move to sandbox</Button>}
            {["sandbox", "paused"].includes(e.status) && <Button size="sm" disabled={ro} onClick={() => status("pilot")} data-testid="st-pilot">Start pilot</Button>}
            {e.status === "pilot" && <Button size="sm" disabled={ro} onClick={() => status("active")} data-testid="st-active">Activate</Button>}
            {["sandbox", "pilot", "active"].includes(e.status) && <Button size="sm" variant="secondary" disabled={ro} onClick={() => status("paused")} data-testid="st-pause">Pause</Button>}
            {e.status !== "retired" && <Button size="sm" variant="ghost" disabled={ro} onClick={() => status("retired")} data-testid="st-retire">Retire</Button>}
          </div>
          <ul className="mt-3 space-y-1 text-[11px] text-ink-2">
            <li>{p.gates.pilot ? <XCircle size={12} className="mr-1 inline text-coral-ink" /> : <CheckCircle2 size={12} className="mr-1 inline text-emerald-ink" />}Pilot: {p.gates.pilot ?? "ready"}</li>
            <li>{p.gates.active ? <XCircle size={12} className="mr-1 inline text-coral-ink" /> : <CheckCircle2 size={12} className="mr-1 inline text-emerald-ink" />}Active: {p.gates.active ?? "ready"}</li>
          </ul>
        </div>
        <PortraitUpload e={e} disabled={ro} />
      </div>
      <Modal open={!!perm} onClose={() => { setPerm(null); setConfirm(false); }} title={`Raise permission to ${perm ? PERM[perm].label : ""}?`}>
        {perm && <div className="space-y-3 text-sm">
          <p>{PERM[perm].body}</p>
          {!p.perms.elevated && <p className="rounded-lg bg-coral-soft px-3 py-2 text-xs text-coral-ink">Only an owner or admin can raise permissions. This request will be refused and audited.</p>}
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirm} onChange={(ev) => setConfirm(ev.target.checked)} className="mt-0.5" data-testid="perm-confirm" />I understand {e.firstName} is an AI agent and that this lets it {perm === "draft_only" ? "store drafts for people to use" : perm === "act_with_approval" ? "take actions after a named person approves each one" : "act without per-task approval"}. This change is audited.</label>
          <Button variant="danger" disabled={!confirm} onClick={() => changePerm(perm, true)} data-testid="perm-apply">Raise permission</Button>
        </div>}
      </Modal>
    </div>
  );
}
function Chip({ on, onClick, children, testid }: { on: boolean; onClick: () => void; children: React.ReactNode; testid?: string }) {
  return <button type="button" onClick={onClick} aria-pressed={on} data-testid={testid} className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", on ? "border-indigo bg-indigo-soft text-indigo-ink" : "border-border text-ink-2 hover:bg-surface-2")}>{children}</button>;
}

function PortraitUpload({ e, disabled }: { e: Emp; disabled: boolean }) {
  const router = useRouter(); const [prov, setProv] = React.useState<"ai_generated" | "licensed" | "">(""); const [credit, setCredit] = React.useState(""); const [msg, setMsg] = React.useState<string | null>(null); const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);
  const upload = async () => {
    const file = ref.current?.files?.[0]; if (!file) { setMsg("Choose an image first."); return; }
    if (!prov) { setMsg("Choose the portrait's provenance."); return; }
    if (file.size > 1_048_576) { setMsg("Image is larger than 1 MB."); return; }
    const fd = new FormData(); fd.set("file", file); fd.set("kind", "ai_portrait"); fd.set("provenance", prov); fd.set("aiEmployeeId", e.id); if (credit) fd.set("credit", credit);
    setBusy(true); const r = await fetch("/api/media", { method: "POST", body: fd }); setBusy(false);
    const j = await r.json().catch(() => ({})); setMsg(r.ok ? "Portrait updated." : j.error ?? `Upload failed (${r.status}).`); if (r.ok) router.refresh();
  };
  return (
    <fieldset className="card space-y-3 p-5" disabled={disabled}>
      <SectionHeader title="Portrait" accent="indigo" icon={<Upload size={15} />} />
      <div className="flex items-center gap-3"><AiAvatar name={e.firstName} portraitUrl={e.portraitUrl} provenance={e.portraitProvenance} team={e.team} size="md" caption /><p className="text-xs text-ink-2">PNG, JPEG or WebP up to 1 MB. Must be AI-generated or licensed — never a real person&apos;s likeness.</p></div>
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" className="block w-full text-xs file:mr-2 file:rounded-lg file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-xs file:font-semibold" aria-label="Portrait image" data-testid="portrait-file" />
      <div role="radiogroup" aria-label="Provenance" className="flex flex-wrap gap-3 text-xs">
        {(["ai_generated", "licensed"] as const).map((v) => <label key={v} className="flex items-center gap-1.5"><input type="radio" name="prov" checked={prov === v} onChange={() => setProv(v)} data-testid={`portrait-prov-${v}`} />{v === "ai_generated" ? "AI-generated" : "Licensed"}</label>)}
        <Tooltip text="Provenance is recorded with the image and shown as a caption wherever the portrait appears." />
      </div>
      <Input label="Credit / license reference (optional)" value={credit} onChange={(ev) => setCredit(ev.target.value)} />
      <Button size="sm" variant="secondary" loading={busy} onClick={upload} data-testid="portrait-upload">Upload portrait</Button>
      {msg && <p className="text-xs" role="status">{msg}</p>}
    </fieldset>
  );
}

function MemoryTab({ e, memory, perms }: { e: Emp; memory: Mem[]; perms: { approve: boolean } }) {
  const router = useRouter(); const [busy, setBusy] = React.useState<string | null>(null);
  const decide = async (m: Mem, d: "approve" | "reject") => { setBusy(m.id); await decideMemoryAction({ memoryId: m.id, decision: d, aiEmployeeId: e.id }); setBusy(null); router.refresh(); };
  if (!memory.length) return <Empty title={`${e.firstName} hasn't learned anything yet`} body="When a manager reviews a live task and suggests an improvement, it appears here for approval. Approved memory guides future work; it never changes permissions." />;
  const groups = [["pending_review", "Waiting for approval"], ["approved", "Approved — in use"], ["rejected", "Rejected"]] as const;
  return (
    <div className="space-y-4">{groups.map(([s, title]) => { const xs = memory.filter((m) => m.status === s); if (!xs.length) return null; return (
      <div key={s} className="card p-5"><SectionHeader title={title} accent={s === "approved" ? "emerald" : s === "pending_review" ? "gold" : "coral"} icon={<Brain size={15} />} />
        <ul className="space-y-2">{xs.map((m) => <li key={m.id} className="flex flex-wrap items-start gap-2 rounded-xl border border-border p-3" data-testid={`memory-${m.id}`}><Badge tone="purple">{m.kind}</Badge><span className="min-w-0 flex-1 text-sm">{m.text}</span>
          {s === "pending_review" && (perms.approve ? <span className="flex gap-2"><Button size="sm" loading={busy === m.id} onClick={() => decide(m, "approve")} data-testid={`mem-approve-${m.id}`}>Approve</Button><Button size="sm" variant="secondary" onClick={() => decide(m, "reject")} data-testid={`mem-reject-${m.id}`}>Reject</Button></span> : <span className="text-xs text-ink-3">Manager approval needed</span>)}</li>)}</ul>
      </div>
    ); })}</div>
  );
}

function MonthBars({ rows }: { rows: { name: string; value: number; tasks: number }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  return (
    <div className="flex h-48 items-end gap-2 pt-4" data-testid="month-bars">
      {rows.map((r) => (
        <div key={r.name} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
          <span className="tabular text-[10px] font-semibold text-emerald-ink">{fmtNum(r.value, 1)}h</span>
          <div className="w-full max-w-10 rounded-t-md bg-gradient-to-t from-emerald to-cyan" style={{ height: max > 0 ? `${Math.max(2, (r.value / max) * 75)}%` : "2px", opacity: r.value ? 1 : 0.3 }} title={`${r.tasks} live tasks`} />
          <span className="text-[10px] text-ink-3">{new Date(r.name + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}</span>
        </div>
      ))}
    </div>
  );
}
