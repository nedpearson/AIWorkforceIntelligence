"use client";
/** Project detail drawer: overview & approval, milestones CRUD (with dependencies), risk register (severity × likelihood), savings lineage, verification. */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trash2, Plus, BadgeCheck, Lock, ExternalLink, Check } from "lucide-react";
import type { RoadmapProject, AttentionItem } from "@/engine/roadmap";
import { Button, Input, Select, Textarea, Badge, BasisChip } from "@/components/ui";
import { Drawer, Tabs, StatusPill, Meter, ACCENT_HEX } from "@/components/ui/enterprise";
import { cn, fmtUSD, fmtNum } from "@/lib/utils";
import { saveProject, removeProject, verifyProjectCompletion, saveMilestone, removeMilestone, saveRisk, removeRisk } from "@/app/app/roadmap/actions";
import { COLUMN } from "./kanban";

type Opt = { id: string; label: string };
const d10 = (s: string | null) => (s ? s.slice(0, 10) : "");
type Tab = "overview" | "milestones" | "risks" | "savings";

export function ProjectDrawer({ project, open, onClose, canWrite, members, opportunities, agents, blocker, attention }: {
  project: RoadmapProject | null; open: boolean; onClose: () => void; canWrite: boolean; members: { id: string; email: string }[];
  opportunities: Opt[]; agents: Opt[]; blocker: string | null; attention: AttentionItem[];
}) {
  const [tab, setTab] = React.useState<Tab>("overview");
  React.useEffect(() => { setTab("overview"); }, [project?.id]);
  if (!project) return null;
  const p = project;
  return (
    <Drawer open={open} onClose={onClose} title={<span className="flex items-center gap-2">{p.name}<StatusPill status={p.status} /></span>} width="max-w-2xl" testid="project-drawer">
      {attention.length > 0 && <ul className="mb-4 space-y-1 rounded-xl bg-coral-soft/60 p-3 text-xs text-coral-ink" data-testid="project-attention">{attention.map((a) => <li key={a.kind + a.refId}><span className="font-semibold">{a.title}:</span> {a.detail}</li>)}</ul>}
      <Tabs testid="project-tabs" value={tab} onChange={setTab} tabs={[{ key: "overview", label: "Overview" }, { key: "milestones", label: "Milestones", count: p.milestones.length }, { key: "risks", label: "Risks", count: p.risks.length }, { key: "savings", label: "Savings" }]} />
      {tab === "overview" && <Overview p={p} canWrite={canWrite} members={members} opportunities={opportunities} agents={agents} blocker={blocker} onDeleted={onClose} />}
      {tab === "milestones" && <Milestones p={p} canWrite={canWrite} />}
      {tab === "risks" && <Risks p={p} canWrite={canWrite} />}
      {tab === "savings" && <Savings p={p} />}
    </Drawer>
  );
}

function useAct() {
  const router = useRouter(); const [busy, setBusy] = React.useState<string | null>(null); const [err, setErr] = React.useState("");
  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setBusy(key); setErr(""); const r = await fn(); setBusy(null);
    if (!r.ok) { setErr(r.error ?? "failed"); return false; } after?.(); router.refresh(); return true;
  };
  return { busy, err, act };
}
const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

function Overview({ p, canWrite, members, opportunities, agents, blocker, onDeleted }: { p: RoadmapProject; canWrite: boolean; members: { id: string; email: string }[]; opportunities: Opt[]; agents: Opt[]; blocker: string | null; onDeleted: () => void }) {
  const { busy, err, act } = useAct();
  const [f, setF] = React.useState({ name: p.name, status: p.status, ownerUserId: p.ownerUserId ?? "", budget: p.budget ? String(p.budget) : "", spent: String(p.spent || 0), targetAnnualSavings: p.targetAnnualSavings ? String(Math.round(p.targetAnnualSavings)) : "", startDate: d10(p.startDate), targetDate: d10(p.targetDate), notes: p.notes ?? "", opportunityIds: p.opportunityIds, agentIds: p.agentIds });
  React.useEffect(() => { setF({ name: p.name, status: p.status, ownerUserId: p.ownerUserId ?? "", budget: p.budget ? String(p.budget) : "", spent: String(p.spent || 0), targetAnnualSavings: p.targetAnnualSavings ? String(Math.round(p.targetAnnualSavings)) : "", startDate: d10(p.startDate), targetDate: d10(p.targetDate), notes: p.notes ?? "", opportunityIds: p.opportunityIds, agentIds: p.agentIds }); }, [p]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const toggle = (k: "opportunityIds" | "agentIds", id: string) => setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] });
  const save = () => act("save", () => saveProject({ id: p.id, name: f.name, status: f.status, ownerUserId: f.ownerUserId || null, budget: numOrNull(f.budget), spent: numOrNull(f.spent) ?? 0, targetAnnualSavings: numOrNull(f.targetAnnualSavings), startDate: f.startDate || null, targetDate: f.targetDate || null, notes: f.notes || null, opportunityIds: f.opportunityIds, agentIds: f.agentIds }));
  const burn = p.budget > 0 ? p.spent / p.budget : 0;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Mini label="Budget" value={p.budget ? fmtUSD(p.budget, { compact: true }) : "—"} />
        <Mini label="Spent" value={fmtUSD(p.spent, { compact: true })} sub={p.budget ? `${Math.round(burn * 100)}% of budget` : undefined} tone={burn > 1 ? "text-coral-ink" : undefined} />
        <Mini label="Target / yr" value={fmtUSD(p.targetAnnualSavings, { compact: true })} tone="text-gold-ink" />
        <Mini label="Verified / yr" value={p.savings.verifiedTime.amount > 0 ? fmtUSD(p.savings.verifiedTime.amount, { compact: true }) : "—"} tone="text-emerald-ink" />
      </div>
      {p.budget > 0 && <Meter value={Math.min(100, burn * 100)} accent={burn > 1 ? "coral" : burn > 0.8 ? "gold" : "cyan"} label="Budget burn" />}

      {/* approval + verification */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border p-3">
          <div className="text-xs font-bold">Approval</div>
          {p.status === "proposed" ? (<><p className="mt-1 text-[11px] text-ink-2">Approving moves the project to “Approved” and is audited.</p>{canWrite ? <Button size="sm" className="mt-2" loading={busy === "approve"} onClick={() => act("approve", () => saveProject({ id: p.id, name: p.name, status: "approved" }))} data-testid="project-approve"><Check size={13} />Approve project</Button> : <p className="mt-2 text-[11px] text-ink-3">Requires opportunities:write.</p>}</>)
            : <p className="mt-1 text-[11px] text-ink-2">Status: {p.status.replace(/_/g, " ")}</p>}
        </div>
        <div className={cn("rounded-xl border p-3", p.verifiedAt ? "border-emerald/40 bg-emerald-soft/40" : "border-border")} data-testid="project-verification">
          <div className="flex items-center gap-1.5 text-xs font-bold">{p.verifiedAt ? <BadgeCheck size={14} className="text-emerald-ink" /> : <Lock size={13} className="text-ink-3" />}Completion verification</div>
          {p.verifiedAt ? <p className="mt-1 text-[11px] text-ink-2">Verified {p.verifiedAt.slice(0, 10)} by {p.verifiedByEmail ?? "—"}.</p>
            : blocker ? <p className="mt-1 text-[11px] text-ink-2" data-testid="project-verify-blocked">{blocker}</p>
              : canWrite ? <Button size="sm" className="mt-2" variant="primary" loading={busy === "verify"} onClick={() => act("verify", () => verifyProjectCompletion({ id: p.id }))} data-testid="project-verify"><BadgeCheck size={13} />Verify completion</Button> : <p className="mt-1 text-[11px] text-ink-3">Ready to verify — requires opportunities:write.</p>}
        </div>
      </div>

      {canWrite ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="project-form">
          <Input label="Project name" value={f.name} onChange={set("name")} required minLength={2} data-testid="project-name" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select label="Status" value={f.status} onChange={set("status")} data-testid="project-status">{COLUMN.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>
            <Select label="Owner" value={f.ownerUserId} onChange={set("ownerUserId")} data-testid="project-owner"><option value="">Unassigned</option>{members.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}</Select>
            <Input label="Budget ($)" type="number" min={0} step="100" value={f.budget} onChange={set("budget")} data-testid="project-budget" />
            <Input label="Spent to date ($)" type="number" min={0} step="100" value={f.spent} onChange={set("spent")} data-testid="project-spent" hint="Feeds the savings engine's attributable cost" />
            <Input label="Start date" type="date" value={f.startDate} onChange={set("startDate")} data-testid="project-start" />
            <Input label="Target date" type="date" value={f.targetDate} onChange={set("targetDate")} data-testid="project-target-date" />
            <Input label="Target annual savings ($)" type="number" min={0} step="100" value={f.targetAnnualSavings} onChange={set("targetAnnualSavings")} data-testid="project-target" hint="Prefilled from realizable savings" />
          </div>
          <Textarea label="Notes" rows={2} value={f.notes} onChange={set("notes")} data-testid="project-notes" />
          <fieldset><legend className="mb-1 text-xs font-medium text-ink-2">Linked opportunities</legend>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">{opportunities.map((o) => <label key={o.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.opportunityIds.includes(o.id)} onChange={() => toggle("opportunityIds", o.id)} data-testid={`project-opp-${o.id}`} />{o.label}</label>)}</div>
          </fieldset>
          <fieldset><legend className="mb-1 text-xs font-medium text-ink-2">Linked agents <span className="text-ink-3">(agents built for linked opportunities are included automatically)</span></legend>
            {agents.length ? <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-border p-2">{agents.map((o) => <label key={o.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.agentIds.includes(o.id)} onChange={() => toggle("agentIds", o.id)} data-testid={`project-agent-${o.id}`} />{o.label}</label>)}</div> : <p className="text-[11px] text-ink-3">No agents in this organization yet.</p>}
          </fieldset>
          {err && <p role="alert" className="text-xs text-coral-ink">{err}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={busy === "save"} data-testid="project-save">Save changes</Button>
            <Button type="button" variant="ghost" className="text-coral-ink" loading={busy === "delete"} onClick={() => { if (confirm(`Delete “${p.name}” and its milestones and risks?`)) void act("delete", () => removeProject({ id: p.id }), onDeleted); }} data-testid="project-delete"><Trash2 size={13} />Delete</Button>
          </div>
        </form>
      ) : (
        <dl className="grid grid-cols-2 gap-2 text-xs"><dt className="text-ink-2">Owner</dt><dd>{p.ownerEmail ?? "—"}</dd><dt className="text-ink-2">Dates</dt><dd>{d10(p.startDate) || "?"} → {d10(p.targetDate) || "?"}</dd><dt className="text-ink-2">Notes</dt><dd>{p.notes ?? "—"}</dd></dl>
      )}
      <div>
        <h4 className="mb-1 text-xs font-bold">Linked records</h4>
        <ul className="space-y-1 text-xs">
          {p.opportunities.map((o) => <li key={o.id}><Link href={`/app/opportunities/${o.id}`} className="inline-flex items-center gap-1 text-royal-ink hover:underline">{o.title}<ExternalLink size={11} /></Link> <span className="text-ink-3">· {fmtUSD(o.realizableAnnual, { compact: true })}/yr realizable · {o.status.replace(/_/g, " ")}</span></li>)}
          {p.agents.map((a) => <li key={a.id}><Link href={`/app/agents/${a.id}`} className="inline-flex items-center gap-1 text-purple-ink hover:underline">Agent: {a.name}<ExternalLink size={11} /></Link> <span className="text-ink-3">· {a.status} · {a.measurements} measurement(s)</span></li>)}
          {!p.opportunities.length && !p.agents.length && <li className="text-ink-3">Nothing linked yet.</li>}
        </ul>
      </div>
    </div>
  );
}

function Milestones({ p, canWrite }: { p: RoadmapProject; canWrite: boolean }) {
  const { busy, err, act } = useAct();
  const blank = { name: "", status: "not_started", startDate: "", dueDate: "", dependsOnMilestoneId: "" };
  const [n, setN] = React.useState(blank);
  const now = Date.now();
  const save = (m: { id?: string; name: string; status: string; startDate: string; dueDate: string; dependsOnMilestoneId: string }) => saveMilestone({ id: m.id, projectId: p.id, name: m.name, status: m.status, startDate: m.startDate || null, dueDate: m.dueDate || null, dependsOnMilestoneId: m.dependsOnMilestoneId || null });
  return (
    <div className="space-y-3" data-testid="milestones">
      {p.milestones.length === 0 && <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-ink-2">No milestones yet. Typical plan: design → build → pilot with approvals → go live → measure.</p>}
      {p.milestones.map((m) => {
        const overdue = m.status !== "done" && m.dueDate && new Date(m.dueDate).getTime() < now;
        const dep = p.milestones.find((x) => x.id === m.dependsOnMilestoneId);
        return canWrite ? <MilestoneRow key={m.id} m={m} siblings={p.milestones} overdue={!!overdue} busy={busy === m.id} onSave={(v) => act(m.id, () => save({ ...v, id: m.id }))} onDelete={() => act(m.id, () => removeMilestone({ id: m.id }))} />
          : <div key={m.id} className="flex items-center justify-between rounded-xl border border-border p-3 text-xs"><div><div className="font-semibold">{m.name}</div><div className="text-ink-3">{d10(m.startDate) || "?"} → {d10(m.dueDate) || "?"}{dep && ` · after ${dep.name}`}</div></div><StatusPill status={overdue ? "blocked" : m.status} /></div>;
      })}
      {canWrite && (
        <form className="rounded-xl border border-dashed border-border p-3" onSubmit={(e) => { e.preventDefault(); void act("new", () => save(n), () => setN(blank)); }} data-testid="milestone-new">
          <div className="mb-2 text-xs font-bold">Add milestone</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input label="Name" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} required data-testid="milestone-new-name" />
            <Select label="Depends on" value={n.dependsOnMilestoneId} onChange={(e) => setN({ ...n, dependsOnMilestoneId: e.target.value })} data-testid="milestone-new-dep"><option value="">No dependency</option>{p.milestones.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
            <Input label="Start" type="date" value={n.startDate} onChange={(e) => setN({ ...n, startDate: e.target.value })} data-testid="milestone-new-start" />
            <Input label="Due" type="date" value={n.dueDate} onChange={(e) => setN({ ...n, dueDate: e.target.value })} data-testid="milestone-new-due" />
          </div>
          <Button size="sm" className="mt-2" type="submit" loading={busy === "new"} data-testid="milestone-add"><Plus size={13} />Add milestone</Button>
        </form>
      )}
      {err && <p role="alert" className="text-xs text-coral-ink">{err}</p>}
    </div>
  );
}

function MilestoneRow({ m, siblings, overdue, busy, onSave, onDelete }: { m: RoadmapProject["milestones"][number]; siblings: RoadmapProject["milestones"]; overdue: boolean; busy: boolean; onSave: (v: { name: string; status: string; startDate: string; dueDate: string; dependsOnMilestoneId: string }) => void; onDelete: () => void }) {
  const [v, setV] = React.useState({ name: m.name, status: m.status, startDate: d10(m.startDate), dueDate: d10(m.dueDate), dependsOnMilestoneId: m.dependsOnMilestoneId ?? "" });
  React.useEffect(() => { setV({ name: m.name, status: m.status, startDate: d10(m.startDate), dueDate: d10(m.dueDate), dependsOnMilestoneId: m.dependsOnMilestoneId ?? "" }); }, [m]);
  const dirty = v.name !== m.name || v.status !== m.status || v.startDate !== d10(m.startDate) || v.dueDate !== d10(m.dueDate) || v.dependsOnMilestoneId !== (m.dependsOnMilestoneId ?? "");
  return (
    <div className={cn("rounded-xl border p-3", overdue ? "border-coral/50" : "border-border", busy && "opacity-60")} data-testid={`milestone-${m.id}`}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px]">
        <Input aria-label="Milestone name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} data-testid={`milestone-name-${m.id}`} />
        <Select aria-label="Milestone status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} data-testid={`milestone-status-${m.id}`}>{["not_started", "in_progress", "blocked", "done"].map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</Select>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Input label="Start" type="date" value={v.startDate} onChange={(e) => setV({ ...v, startDate: e.target.value })} />
        <Input label="Due" type="date" value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} />
        <Select label="Depends on" value={v.dependsOnMilestoneId} onChange={(e) => setV({ ...v, dependsOnMilestoneId: e.target.value })}><option value="">None</option>{siblings.filter((s) => s.id !== m.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {overdue && <Badge tone="coral">overdue</Badge>}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Delete milestone ${m.name}`} data-testid={`milestone-delete-${m.id}`}><Trash2 size={13} /></Button>
        <Button size="sm" disabled={!dirty} onClick={() => onSave(v)} data-testid={`milestone-save-${m.id}`}>Save</Button>
      </div>
    </div>
  );
}

const exposureHex = (e: number) => (e >= 15 ? ACCENT_HEX.coral : e >= 8 ? ACCENT_HEX.gold : ACCENT_HEX.emerald);
function Risks({ p, canWrite }: { p: RoadmapProject; canWrite: boolean }) {
  const { busy, err, act } = useAct();
  const blank = { title: "", severity: 3, likelihood: 3, mitigation: "" };
  const [nk, setNk] = React.useState(0);
  const [edit, setEdit] = React.useState<string | null>(null);
  return (
    <div className="space-y-4" data-testid="risks">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[auto_1fr]">
        <div>
          <div className="mb-1 text-[11px] font-semibold text-ink-2">Severity × likelihood</div>
          <div className="flex gap-1">
            <div className="flex flex-col justify-between py-1 text-[9px] text-ink-3" aria-hidden><span>5</span><span>Sev</span><span>1</span></div>
            <div className="grid grid-cols-5 gap-0.5" role="img" aria-label={`Risk matrix with ${p.risks.length} risks; ${p.risks.filter((r) => r.severity * r.likelihood >= 15).length} high exposure`}>
              {[5, 4, 3, 2, 1].flatMap((sev) => [1, 2, 3, 4, 5].map((lik) => {
                const here = p.risks.filter((r) => r.severity === sev && r.likelihood === lik && r.status !== "closed");
                return <div key={`${sev}-${lik}`} className="flex h-8 w-8 items-center justify-center rounded text-[10px] font-bold text-white" style={{ background: exposureHex(sev * lik), opacity: here.length ? 1 : 0.18 }} title={here.map((r) => r.title).join(", ")}>{here.length || ""}</div>;
              }))}
            </div>
          </div>
          <div className="mt-1 pl-4 text-center text-[9px] text-ink-3">1 — Likelihood — 5</div>
        </div>
        <ul className="space-y-2">
          {p.risks.length === 0 && <li className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-ink-2">No risks logged. Typical risks: data quality, vendor API limits, change adoption, compliance review.</li>}
          {p.risks.map((r) => edit === r.id && canWrite ? (
            <RiskForm key={r.id} initial={{ title: r.title, severity: r.severity, likelihood: r.likelihood, mitigation: r.mitigation ?? "", status: r.status }} busy={busy === r.id} onCancel={() => setEdit(null)} onSave={(v) => act(r.id, () => saveRisk({ ...v, id: r.id, projectId: p.id }), () => setEdit(null))} testid={`risk-form-${r.id}`} />
          ) : (
            <li key={r.id} className="rounded-xl border border-border p-3 text-xs" data-testid={`risk-${r.id}`}>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-bold text-white tabular" style={{ background: exposureHex(r.severity * r.likelihood) }} title="Exposure = severity × likelihood">{r.severity * r.likelihood}</span>
                <div className="min-w-0 flex-1"><div className="font-semibold">{r.title}</div><div className="text-ink-3">Severity {r.severity} · likelihood {r.likelihood} · {r.status}</div>{r.mitigation ? <p className="mt-1 text-ink-2">Mitigation: {r.mitigation}</p> : <p className="mt-1 font-semibold text-coral-ink">No mitigation plan</p>}</div>
                {canWrite && <div className="flex shrink-0 gap-1"><Button size="sm" variant="ghost" onClick={() => setEdit(r.id)} data-testid={`risk-edit-${r.id}`}>Edit</Button><Button size="sm" variant="ghost" aria-label={`Delete risk ${r.title}`} onClick={() => act(r.id, () => removeRisk({ id: r.id }))} data-testid={`risk-delete-${r.id}`}><Trash2 size={13} /></Button></div>}
              </div>
            </li>
          ))}
        </ul>
      </div>
      {canWrite && <div className="rounded-xl border border-dashed border-border p-3"><div className="mb-2 text-xs font-bold">Log a risk</div><RiskForm initial={{ ...blank, status: "open" }} busy={busy === "new"} onSave={(v) => act("new", () => saveRisk({ ...v, projectId: p.id }), () => setNk(nk + 1))} key={nk} testid="risk-new" /></div>}
      {err && <p role="alert" className="text-xs text-coral-ink">{err}</p>}
    </div>
  );
}
function RiskForm({ initial, busy, onSave, onCancel, testid }: { initial: { title: string; severity: number; likelihood: number; mitigation: string; status: string }; busy: boolean; onSave: (v: { title: string; severity: number; likelihood: number; mitigation: string | null; status: string }) => void; onCancel?: () => void; testid: string }) {
  const [v, setV] = React.useState(initial);
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onSave({ ...v, mitigation: v.mitigation.trim() || null }); }} data-testid={testid}>
      <Input label="Risk" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} required minLength={2} data-testid={`${testid}-title`} />
      <div className="grid grid-cols-3 gap-2">
        <Select label="Severity" value={String(v.severity)} onChange={(e) => setV({ ...v, severity: Number(e.target.value) })} data-testid={`${testid}-severity`}>{[1, 2, 3, 4, 5].map((x) => <option key={x}>{x}</option>)}</Select>
        <Select label="Likelihood" value={String(v.likelihood)} onChange={(e) => setV({ ...v, likelihood: Number(e.target.value) })} data-testid={`${testid}-likelihood`}>{[1, 2, 3, 4, 5].map((x) => <option key={x}>{x}</option>)}</Select>
        <Select label="Status" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>{["open", "mitigated", "closed"].map((x) => <option key={x}>{x}</option>)}</Select>
      </div>
      <Textarea label="Mitigation" rows={2} value={v.mitigation} onChange={(e) => setV({ ...v, mitigation: e.target.value })} data-testid={`${testid}-mitigation`} />
      <div className="flex gap-2"><Button size="sm" type="submit" loading={busy} data-testid={`${testid}-save`}>Save risk</Button>{onCancel && <Button size="sm" variant="ghost" type="button" onClick={onCancel}>Cancel</Button>}</div>
    </form>
  );
}

function Savings({ p }: { p: RoadmapProject }) {
  const s = p.savings;
  const rows: { k: string; label: string; b: typeof s.verifiedTime; tone: string; help: string }[] = [
    { k: "verified", label: "Verified time savings (annualized)", b: s.verifiedTime, tone: "text-emerald-ink", help: "Measured after deployment on the project's agents — time, not cash." },
    { k: "approved", label: "Approved business case", b: s.approved, tone: "text-indigo-ink", help: "Finance-approved annual savings in the ledger." },
    { k: "avoid", label: "Cost avoidance", b: s.costAvoidance, tone: "text-purple-ink", help: "Evidenced, approved future expense avoided." },
    { k: "hard", label: "Realized hard savings", b: s.realizedHard, tone: "text-emerald-ink", help: "Evidenced, approved reduction in an actual expense line." },
  ];
  const pct = p.targetAnnualSavings > 0 ? s.verifiedTime.amount / p.targetAnnualSavings : 0;
  return (
    <div className="space-y-4" data-testid="project-savings">
      <div className="rounded-xl bg-surface-2 p-3">
        <div className="flex items-end justify-between text-xs"><span className="text-ink-2">Target vs verified</span><span className="tabular"><span className="font-bold text-emerald-ink">{fmtUSD(s.verifiedTime.amount)}</span> <span className="text-ink-3">of</span> <span className="font-bold text-gold-ink">{fmtUSD(p.targetAnnualSavings)}</span>/yr</span></div>
        <div className="mt-2"><Meter value={Math.min(100, pct * 100)} accent="emerald" label="Verified vs target" /></div>
        <p className="mt-2 text-[11px] text-ink-3">Every number here is the Savings Intelligence Engine lineage filtered to this project&apos;s opportunities and agents — no separate source.</p>
      </div>
      {rows.map((r) => (
        <div key={r.k} data-testid={`project-savings-${r.k}`}>
          <div className="flex items-center justify-between text-xs"><span className="font-semibold">{r.label}</span><span className={cn("font-bold tabular", r.tone)}>{fmtUSD(r.b.amount)}{r.b.hours ? <span className="ml-1 font-normal text-ink-3">· {fmtNum(r.b.hours, 0)} hrs</span> : null}</span></div>
          <p className="text-[11px] text-ink-3">{r.help}</p>
          {r.b.items.length > 0 && <ul className="mt-1 space-y-0.5 border-l border-border pl-3 text-[11px]">{r.b.items.map((i) => <li key={i.id} className="flex justify-between gap-2"><Link href={i.href} className="truncate text-royal-ink hover:underline">{i.label}</Link><span className="flex shrink-0 items-center gap-1 tabular">{fmtUSD(i.amount)}<BasisChip basis={i.basis} /></span></li>)}</ul>}
        </div>
      ))}
    </div>
  );
}

function Mini({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return <div className="rounded-xl bg-surface-2/70 p-2.5"><div className="text-[10px] text-ink-2">{label}</div><div className={cn("text-sm font-bold tabular", tone)}>{value}</div>{sub && <div className="text-[10px] text-ink-3">{sub}</div>}</div>;
}
