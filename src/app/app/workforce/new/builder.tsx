"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Wand2, ChevronLeft, ChevronRight, Check, Upload, Trash2, Plus, ShieldCheck, AlertTriangle } from "lucide-react";
import type { CalcTree } from "@/db/schema";
import { PageHeader, Button, Input, Select, Textarea, Badge, Modal, Tooltip } from "@/components/ui";
import { StatusPill } from "@/components/ui/enterprise";
import { CalcTreeView } from "@/components/calc-tree";
import { AiAvatar, AiBadge, TEAM_LABEL } from "@/components/workforce/avatar";
import { SkillStage } from "@/components/workforce/skill-stage";
import { cn, fmtNum, fmtUSD } from "@/lib/utils";
import type { SkillInfo } from "@/engine/workforce/skills-adapter";
import { saveBuilderDraftAction, activateBuilderAction } from "../actions";
import { useTimeZone } from "@/components/time-zone";
import { formatTime } from "@/lib/datetime";

type Persona = { key: string; firstName: string; title: string; team: string; intro: string; responsibilities: string[]; skills: string[]; portrait: string | null; demoSkill: string; providers: string[]; deptId: string | null; existingId: string | null };
type Rec = { personaKey: string; departmentId: string | null; opportunityId: string; title: string; workflowLabel: string; observedHoursPerWeek: number; hoursRecoverablePerWeek: number; realizableAnnualSavings: number; annualOperatingCost: number; tree: CalcTree };
type Conn = { key: string; name: string; category: string; status: string; envVars: string[] };
type Resume = { id: string; personaKey: string | null; firstName: string; title: string; team: string; departmentId: string | null; responsibilities: string[]; skills: string[]; knowledgeScope: { departmentIds?: string[]; documentIds?: string[]; categories?: string[] }; monthlyRunBudget: number; monthlyCostBudget: number; approvalOwnerUserId: string | null; connectedProviders: string[]; portraitUrl: string | null; portraitProvenance: string | null };

const STEPS = ["Department", "Position", "Visual identity", "Responsibilities", "Business knowledge", "Skills", "Applications", "Test", "Costs & risks", "Activate"];
const CATEGORIES = ["company", "policy", "procedure", "pricing", "product", "customer", "vendor", "terminology", "goal", "decision", "preference", "system", "general"];
const TEAM_CAT: Record<string, string[]> = { executive: ["executive", "finance", "operations"], finance: ["finance"], sales: ["sales"], operations: ["operations"], marketing: ["marketing"], hr: ["hr"], customer_service: ["customer_service"], custom: [] };

/** Natural language → editable checklist ("Process invoices and match POs; flag duplicates." → 3 items). */
export function toChecklist(text: string): string[] {
  return text.split(/\n|;|•|(?<=[.!?])\s+|,\s*and\s+|\s+and then\s+/i).map((s) => s.replace(/^[-*\d.)\s]+/, "").replace(/[.!?]+$/, "").trim()).filter((s) => s.length > 2).map((s) => s[0].toUpperCase() + s.slice(1)).slice(0, 20);
}
const teamForDept = (name: string) => /financ|account/i.test(name) ? "finance" : /sales/i.test(name) ? "sales" : /operat|logist|warehouse/i.test(name) ? "operations" : /market/i.test(name) ? "marketing" : /\bhr\b|human|people/i.test(name) ? "hr" : /customer|support|service/i.test(name) ? "customer_service" : "custom";

export function Builder(p: { departments: { id: string; name: string }[]; personas: Persona[]; teams: { key: string; label: string }[]; skills: SkillInfo[] | null; recs: Rec[]; connectors: Conn[]; documents: { id: string; title: string; category: string; departmentId: string | null }[]; members: { userId: string; label: string }[]; meId: string; role: string; resume: Resume | null }) {
  const tz = useTimeZone();
  const router = useRouter();
  const r0 = p.resume;
  const [step, setStep] = React.useState(r0 ? 3 : 0);
  const [id, setId] = React.useState<string | null>(r0?.id ?? null);
  const [s, setS] = React.useState({
    departmentId: r0?.departmentId ?? "", personaKey: r0?.personaKey ?? "", firstName: r0?.firstName ?? "", title: r0?.title ?? "", team: r0?.team ?? "custom",
    identity: (r0?.portraitUrl ? "persona" : "monogram") as "persona" | "upload" | "monogram", nl: "", responsibilities: r0?.responsibilities ?? [] as string[], skills: r0?.skills ?? [] as string[],
    depts: r0?.knowledgeScope.departmentIds ?? [] as string[], cats: r0?.knowledgeScope.categories ?? [] as string[], docs: r0?.knowledgeScope.documentIds ?? [] as string[],
    providers: r0?.connectedProviders ?? [] as string[], monthlyRunBudget: r0?.monthlyRunBudget ?? 500, monthlyCostBudget: r0?.monthlyCostBudget ?? 250, approvalOwnerUserId: r0?.approvalOwnerUserId ?? p.meId,
  });
  const [portrait, setPortrait] = React.useState<{ url: string | null; provenance: string | null }>({ url: r0?.portraitUrl ?? null, provenance: r0?.portraitProvenance ?? null });
  const [tested, setTested] = React.useState(false);
  const [testSkill, setTestSkill] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState<string | null>(null); const [saved, setSaved] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ status: string; missing: string[] } | null>(null);
  const [tree, setTree] = React.useState<CalcTree | null>(null);
  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) => setS((x) => ({ ...x, [k]: v }));
  const toggle = (k: "skills" | "depts" | "cats" | "docs" | "providers", v: string) => setS((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] }));
  const persona = p.personas.find((x) => x.key === s.personaKey) ?? null;
  const dept = p.departments.find((d) => d.id === s.departmentId);
  const deptTeam = dept ? teamForDept(dept.name) : null;
  const recFor = p.recs.filter((r) => (!s.departmentId || r.departmentId === s.departmentId));
  const suggested = p.personas.filter((x) => (deptTeam && x.team === deptTeam) || recFor.some((r) => r.personaKey === x.key));
  const match = p.recs.filter((r) => r.personaKey === s.personaKey);
  const skillPool = (p.skills ?? []).filter((k) => !TEAM_CAT[s.team]?.length || TEAM_CAT[s.team].includes(k.category) || s.skills.includes(k.key) || persona?.skills.includes(k.key));
  const neededProviders = [...new Set([...(persona?.providers ?? []), ...s.skills.flatMap((k) => p.skills?.find((x) => x.key === k)?.requiresProviders ?? [])])];

  const pickPersona = (x: Persona) => setS((v) => ({ ...v, personaKey: x.key, firstName: x.firstName, title: x.title, team: x.team, responsibilities: x.responsibilities, skills: x.skills, identity: x.portrait ? "persona" : "monogram", depts: v.departmentId ? [v.departmentId] : v.depts, providers: x.providers }));
  React.useEffect(() => { if (!testSkill && (persona?.demoSkill || s.skills[0])) setTestSkill(persona?.demoSkill && s.skills.includes(persona.demoSkill) ? persona.demoSkill : s.skills[0] ?? ""); }, [persona, s.skills, testSkill]);

  const valid = (i: number): string | null => {
    if (i === 0 && !s.departmentId) return "Choose the department this AI employee will serve.";
    if (i === 1 && (!s.firstName.trim() || !s.title.trim())) return "Pick a recommended AI persona or enter a name and position title.";
    if (i === 3 && !s.responsibilities.length) return "Add at least one responsibility.";
    if (i === 5 && !s.skills.length) return "Choose at least one skill.";
    if (i === 7 && !tested) return "Run the sandbox test successfully to continue.";
    if (i === 8 && !s.approvalOwnerUserId) return "Choose a person who approves this AI employee's work.";
    return null;
  };
  const save = async (): Promise<string | null> => {
    if (step < 1 || !s.firstName.trim() || !s.title.trim()) return id;
    const r = await saveBuilderDraftAction({ id, personaKey: s.personaKey || null, firstName: s.firstName, title: s.title, team: s.team, departmentId: s.departmentId || null,
      intro: s.personaKey ? undefined : `Hi, I'm ${s.firstName} — an AI agent working as your ${s.title}.`, responsibilities: s.responsibilities.length ? s.responsibilities : [s.title], skills: s.skills,
      knowledgeScope: { departmentIds: s.depts, categories: s.cats, documentIds: s.docs }, monthlyRunBudget: s.monthlyRunBudget, monthlyCostBudget: s.monthlyCostBudget, approvalOwnerUserId: s.approvalOwnerUserId || null, connectedProviders: s.providers,
      portraitProvenance: s.identity === "monogram" ? "none" : undefined });
    if (!r.ok) { setErr(r.error); return null; }
    setId(r.id); setSaved(formatTime(Date.now(), tz, { hour: "numeric", minute: "2-digit" })); return r.id;
  };
  const next = async () => { const v = valid(step); if (v) { setErr(v); return; } setErr(null); setBusy(true); const ok = await save(); setBusy(false); if (step >= 1 && !ok) return; setStep((x) => Math.min(STEPS.length - 1, x + 1)); };
  const back = () => { setErr(null); setStep((x) => Math.max(0, x - 1)); };
  const activate = async () => { setBusy(true); const cur = await save(); if (!cur) { setBusy(false); return; } const r = await activateBuilderAction({ id: cur }); setBusy(false); if (!r.ok) { setErr(r.error); return; } setResult({ status: r.status, missing: r.missing }); router.refresh(); };

  const upload = async (file: File, prov: string) => {
    const cur = id ?? (await save()); if (!cur) return;
    const fd = new FormData(); fd.set("file", file); fd.set("kind", "ai_portrait"); fd.set("provenance", prov); fd.set("aiEmployeeId", cur);
    const res = await fetch("/api/media", { method: "POST", body: fd }); const j = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(j.error ?? `Upload failed (${res.status})`); return; } setErr(null); setPortrait({ url: j.url, provenance: prov });
  };

  return (
    <div>
      <PageHeader hero eyebrow="AI Workforce" icon={<Wand2 size={22} />} title="Build an AI employee" subtitle="Ten guided steps. Your AI employee is saved as a draft as you go, starts at read-only permission, and must pass a real sandbox test before it can pilot." />
      <nav aria-label="Builder progress" className="scrollbar-thin -mx-1 mb-5 overflow-x-auto px-1">
        <ol className="flex min-w-max gap-1.5" data-testid="builder-stepper">
          {STEPS.map((t, i) => <li key={t}><button onClick={() => i < step && setStep(i)} disabled={i > step} aria-current={i === step ? "step" : undefined} data-testid={`step-${i}`}
            className={cn("flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-semibold", i === step ? "bg-midnight text-white dark:bg-royal" : i < step ? "bg-emerald-soft text-emerald-ink" : "bg-surface-2 text-ink-3")}>
            <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[10px]", i === step ? "bg-white/20" : i < step ? "bg-emerald text-white" : "bg-surface-3")}>{i < step ? <Check size={11} /> : i + 1}</span>{t}</button></li>)}
        </ol>
      </nav>
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <section className="card min-h-[420px] p-5 sm:p-6" aria-labelledby="step-title" data-testid={`builder-step-${step}`}>
          <h2 id="step-title" className="mb-1 text-lg font-bold">{step + 1}. {STEPS[step]}</h2>
          {step === 0 && <>
            <p className="mb-4 text-sm text-ink-2">Which department will this AI employee support?</p>
            <div className="grid gap-2 sm:grid-cols-3">{p.departments.map((d) => <button key={d.id} onClick={() => set("departmentId", d.id)} aria-pressed={s.departmentId === d.id} data-testid={`b-dept-${d.id}`} className={cn("rounded-xl border p-3 text-left text-sm font-semibold", s.departmentId === d.id ? "border-royal bg-royal-soft text-royal-ink" : "border-border hover:bg-surface-2")}>{d.name}<span className="block text-[11px] font-normal text-ink-3">{p.recs.filter((r) => r.departmentId === d.id).length} recommended role(s)</span></button>)}</div>
            {!p.departments.length && <p className="text-sm text-ink-2">No departments yet — add them under Departments first.</p>}
          </>}
          {step === 1 && <>
            <p className="mb-4 text-sm text-ink-2">Pick a recommended AI persona for {dept?.name ?? "this department"} or create a custom position.</p>
            <div className="grid gap-3 sm:grid-cols-2">{(suggested.length ? suggested : p.personas).map((x) => { const rec = p.recs.find((r) => r.personaKey === x.key); return (
              <button key={x.key} onClick={() => pickPersona(x)} aria-pressed={s.personaKey === x.key} data-testid={`b-persona-${x.key}`} className={cn("flex items-center gap-3 rounded-2xl border p-3 text-left", s.personaKey === x.key ? "border-purple bg-purple-soft/50" : "border-border hover:bg-surface-2")}>
                <AiAvatar name={x.firstName} portraitUrl={x.portrait} provenance="ai_generated" team={x.team} size="sm" />
                <span className="min-w-0"><span className="flex items-center gap-1.5 text-sm font-bold">{x.firstName}<AiBadge compact /></span><span className="block truncate text-xs text-ink-2">{x.title}</span>
                  {rec ? <span className="text-[11px] font-semibold text-gold-ink">{fmtUSD(rec.realizableAnnualSavings)}/yr on {rec.workflowLabel} (est.)</span> : x.existingId ? <span className="text-[11px] text-ink-3">already on your team</span> : null}</span>
              </button>
            ); })}</div>
            <div className="mt-5 rounded-2xl border border-dashed border-border p-4">
              <div className="mb-2 text-sm font-semibold">Or a custom position</div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input label="Name" value={s.personaKey ? "" : s.firstName} placeholder="e.g. Rex" onChange={(e) => setS((v) => ({ ...v, personaKey: "", firstName: e.target.value, team: deptTeam ?? "custom" }))} data-testid="b-custom-name" />
                <Input label="Position title" value={s.personaKey ? "" : s.title} placeholder="e.g. AI Freight Auditor" onChange={(e) => setS((v) => ({ ...v, personaKey: "", title: e.target.value, team: deptTeam ?? "custom" }))} data-testid="b-custom-title" />
                <Select label="Team" value={s.team} onChange={(e) => set("team", e.target.value)} data-testid="b-team">{[...p.teams, { key: "custom", label: "Custom AI Team" }].map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select>
              </div>
              <p className="mt-2 text-[11px] text-ink-3">Custom AI employees are always labelled “AI Agent”. Don&apos;t use a real person&apos;s name or identity.</p>
            </div>
          </>}
          {step === 2 && <>
            <p className="mb-4 text-sm text-ink-2">How should {s.firstName} look? AI employees always appear as rounded squares with an AI badge.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {persona?.portrait && <IdOption on={s.identity === "persona"} onClick={() => { set("identity", "persona"); setPortrait({ url: persona.portrait, provenance: "ai_generated" }); }} testid="b-id-persona" title="Library portrait" body="AI-generated, labelled as such"><AiAvatar name={s.firstName} portraitUrl={persona.portrait} provenance="ai_generated" team={s.team} size="md" caption /></IdOption>}
              <IdOption on={s.identity === "monogram"} onClick={() => { set("identity", "monogram"); setPortrait({ url: null, provenance: "none" }); }} testid="b-id-monogram" title="Premium monogram" body="Team gradient + initials"><AiAvatar name={s.firstName || "AI"} team={s.team} size="md" /></IdOption>
              <IdOption on={s.identity === "upload"} onClick={() => set("identity", "upload")} testid="b-id-upload" title="Upload a portrait" body="AI-generated or licensed only">{portrait.url && s.identity === "upload" ? <AiAvatar name={s.firstName} portraitUrl={portrait.url} provenance={portrait.provenance} team={s.team} size="md" caption /> : <span className="flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-dashed border-border"><Upload size={18} /></span>}</IdOption>
            </div>
            {s.identity === "upload" && <UploadBox onUpload={upload} />}
          </>}
          {step === 3 && <>
            <p className="mb-3 text-sm text-ink-2">Describe the job in plain words. We&apos;ll turn it into a checklist you can edit.</p>
            <Textarea rows={3} value={s.nl} onChange={(e) => set("nl", e.target.value)} placeholder="e.g. Read vendor invoices from the AP inbox, check for duplicates and match them to purchase orders; prepare entries for the controller to approve." data-testid="b-nl" />
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => { const items = toChecklist(s.nl); if (items.length) set("responsibilities", [...s.responsibilities, ...items.filter((x) => !s.responsibilities.includes(x))]); set("nl", ""); }} data-testid="b-nl-convert"><Wand2 size={14} />Turn into checklist</Button>
            <ul className="mt-4 space-y-2" data-testid="b-resp-list">{s.responsibilities.map((r, i) => (
              <li key={i} className="flex items-center gap-2"><Check size={16} className="shrink-0 text-emerald-ink" /><input aria-label={`Responsibility ${i + 1}`} value={r} onChange={(e) => set("responsibilities", s.responsibilities.map((x, j) => j === i ? e.target.value : x))} className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm" />
                <button onClick={() => set("responsibilities", s.responsibilities.filter((_, j) => j !== i))} aria-label="Remove" className="rounded-lg p-1.5 text-ink-3 hover:bg-coral-soft hover:text-coral-ink"><Trash2 size={15} /></button></li>
            ))}</ul>
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => set("responsibilities", [...s.responsibilities, ""])} data-testid="b-resp-add"><Plus size={14} />Add item</Button>
          </>}
          {step === 4 && <>
            <p className="mb-4 text-sm text-ink-2">What company knowledge may {s.firstName} use? Only <b>approved</b> AI Brain content is ever used.</p>
            <Group label="Departments (none = all)">{p.departments.map((d) => <Chip key={d.id} on={s.depts.includes(d.id)} onClick={() => toggle("depts", d.id)} testid={`b-kdept-${d.id}`}>{d.name}</Chip>)}</Group>
            <Group label="Categories (none = all)">{CATEGORIES.map((c) => <Chip key={c} on={s.cats.includes(c)} onClick={() => toggle("cats", c)} testid={`b-kcat-${c}`}>{c}</Chip>)}</Group>
            <Group label="Specific documents">{p.documents.length ? p.documents.filter((d) => !s.cats.length || s.cats.includes(d.category)).map((d) => <Chip key={d.id} on={s.docs.includes(d.id)} onClick={() => toggle("docs", d.id)} testid={`b-kdoc-${d.id}`}>{d.title}</Chip>) : <span className="text-xs text-ink-3">No approved documents yet — you can add them in the AI Brain later.</span>}</Group>
          </>}
          {step === 5 && <>
            <p className="mb-4 text-sm text-ink-2">Skills are typed units of work with documented manual time. {p.skills ? `Showing skills for the ${TEAM_LABEL[s.team] ?? "selected team"}.` : ""}</p>
            {!p.skills ? <p className="rounded-xl border border-dashed border-border p-4 text-sm text-ink-2" data-testid="b-skills-unavailable"><b>Skills engine unavailable.</b> Persona skills are kept: {s.skills.join(", ") || "none"}.</p> : (
              <div className="grid gap-2 sm:grid-cols-2">{skillPool.map((k) => (
                <label key={k.key} className={cn("flex cursor-pointer gap-3 rounded-xl border p-3", s.skills.includes(k.key) ? "border-purple bg-purple-soft/40" : "border-border hover:bg-surface-2")}>
                  <input type="checkbox" checked={s.skills.includes(k.key)} onChange={() => toggle("skills", k.key)} className="mt-1" data-testid={`b-skill-${k.key}`} />
                  <span><span className="block text-sm font-semibold">{k.name} <Badge tone={k.access === "act" ? "coral" : k.access === "draft" ? "gold" : "cyan"}>{k.access}</Badge></span><span className="block text-xs text-ink-2">{k.description}</span><span className="text-[11px] text-ink-3">{k.manualBaselineMinutes} min manual baseline</span></span>
                </label>
              ))}</div>
            )}
          </>}
          {step === 6 && <>
            <p className="mb-4 text-sm text-ink-2">Applications {s.firstName} needs for live work. Statuses are your organization&apos;s real connector states.</p>
            {neededProviders.length === 0 ? <p className="text-sm text-ink-2">No external applications needed.</p> : <div className="grid gap-2 sm:grid-cols-2">{neededProviders.map((k) => { const c = p.connectors.find((x) => x.key === k); const ok = c && ["connected", "configured"].includes(c.status); return (
              <label key={k} className="flex items-center gap-3 rounded-xl border border-border p-3"><input type="checkbox" disabled={!ok} checked={!!ok && s.providers.includes(k)} onChange={() => toggle("providers", k)} data-testid={`b-app-${k}`} />
                <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{c?.name ?? k}</span>{!ok && c?.envVars.length ? <span className="text-[11px] text-ink-3">needs {c.envVars.join(", ")}</span> : null}</span><StatusPill status={c?.status ?? "not_built"} /></label>
            ); })}</div>}
            <Button size="sm" variant="secondary" className="mt-3" href="/app/integrations">Open integrations</Button>
          </>}
          {step === 7 && <>
            <p className="mb-4 text-sm text-ink-2">Run a real skill in the sandbox on a synthetic sample. It must succeed before you can continue.</p>
            {!id ? <p className="text-sm text-coral-ink">Save the earlier steps first.</p> : <>
              <Select label="Skill to test" value={testSkill} onChange={(e) => { setTestSkill(e.target.value); setTested(false); }} data-testid="b-test-skill">{s.skills.map((k) => <option key={k} value={k}>{p.skills?.find((x) => x.key === k)?.name ?? k}</option>)}</Select>
              <div className="mt-4">{testSkill && <SkillStage key={testSkill} aiEmployeeId={id} firstName={s.firstName} skillKey={testSkill} skillName={p.skills?.find((x) => x.key === testSkill)?.name ?? testSkill} mode="sandbox" onResult={(r) => setTested(r.ok)} testid="b-test" />}</div>
              {tested && <p className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-emerald-ink" data-testid="b-test-passed"><Check size={16} />Test passed — you can continue.</p>}
            </>}
          </>}
          {step === 8 && <>
            <p className="mb-4 text-sm text-ink-2">What {s.firstName} costs, what could go wrong, and who approves.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input label="Monthly run budget" type="number" min={0} value={s.monthlyRunBudget} onChange={(e) => set("monthlyRunBudget", Number(e.target.value))} data-testid="b-run-budget" />
              <Input label="Monthly cost budget (USD)" type="number" min={0} value={s.monthlyCostBudget} onChange={(e) => set("monthlyCostBudget", Number(e.target.value))} data-testid="b-cost-budget" />
              <Select label="Approval owner" value={s.approvalOwnerUserId} onChange={(e) => set("approvalOwnerUserId", e.target.value)} data-testid="b-owner"><option value="">Choose a person</option>{p.members.map((m) => <option key={m.userId} value={m.userId}>{m.label}</option>)}</Select>
            </div>
            <div className="mt-4 overflow-x-auto rounded-xl border border-border"><table className="w-full text-sm"><thead><tr className="bg-surface-2 text-left text-[11px] uppercase text-ink-2"><th className="px-3 py-2">Skill</th><th className="px-3 py-2">Access</th><th className="px-3 py-2">Unit cost</th><th className="px-3 py-2">Always needs approval</th></tr></thead>
              <tbody>{s.skills.map((k) => { const x = p.skills?.find((y) => y.key === k); return <tr key={k} className="border-t border-border"><td className="px-3 py-2 font-medium">{x?.name ?? k}</td><td className="px-3 py-2">{x?.access ?? "—"}</td><td className="px-3 py-2">{x?.unitCost != null ? fmtUSD(x.unitCost) : <span className="text-ink-3">not set by skills engine</span>}</td><td className="px-3 py-2 text-xs">{x?.alwaysApproveSteps.length ? x.alwaysApproveSteps.join(", ") : "—"}</td></tr>; })}</tbody></table></div>
            <ul className="mt-4 space-y-1.5 text-xs text-ink-2">
              <li className="flex gap-2"><ShieldCheck size={14} className="shrink-0 text-emerald-ink" />Starts at <b>read-only</b>. Raising to draft-only, then act-with-approval, needs an owner/admin and explicit confirmation.</li>
              <li className="flex gap-2"><ShieldCheck size={14} className="shrink-0 text-emerald-ink" />Text from documents and external systems is treated as data, never as instructions.</li>
              <li className="flex gap-2"><AlertTriangle size={14} className="shrink-0 text-gold-ink" />Time saved is capacity, not a payroll cut. Role changes require management and HR/legal review.</li>
            </ul>
            {match.length ? <div className="mt-4 rounded-2xl border border-gold/40 bg-gold-soft/40 p-4 text-sm" data-testid="b-projection">Projected for <b>{match[0].workflowLabel}</b>: your team spends {fmtNum(match[0].observedHoursPerWeek, 1)} h/week; about {fmtNum(match[0].hoursRecoverablePerWeek, 1)} h/week is automatable — <b className="text-gold-ink">{fmtUSD(match[0].realizableAnnualSavings)}/yr</b> recovered capacity (estimated), {fmtUSD(match[0].annualOperatingCost)}/yr operating cost. <button className="font-semibold text-royal-ink hover:underline" onClick={() => setTree(match[0].tree)}>How is this calculated?</button></div>
              : <p className="mt-4 text-xs text-ink-3">No discovered opportunity matches this position yet, so no savings are projected.</p>}
          </>}
          {step === 9 && <>
            <p className="mb-4 text-sm text-ink-2">Review and start {s.firstName}&apos;s pilot. A pilot runs live tasks at the current permission level, with a named approver.</p>
            <div className="flex items-center gap-4 rounded-2xl border border-border p-4"><AiAvatar name={s.firstName} portraitUrl={s.identity === "monogram" ? null : portrait.url ?? persona?.portrait} provenance={portrait.provenance ?? "ai_generated"} team={s.team} size="lg" caption />
              <div><div className="flex items-center gap-2 text-lg font-bold">{s.firstName}<AiBadge /></div><div className="text-sm text-ink-2">{s.title} · {dept?.name}</div><div className="mt-1 text-xs text-ink-3">{s.responsibilities.length} responsibilities · {s.skills.length} skills · test {tested ? "passed" : "not run"}</div></div></div>
            {result ? (
              <div className={cn("mt-4 rounded-2xl p-4 text-sm", result.missing.length ? "bg-gold-soft/50" : "bg-emerald-soft/60")} data-testid="b-activate-result">
                {result.missing.length ? <>Saved as <b>{result.status}</b>. Still needed for a pilot: {result.missing.join("; ")}.</> : <>{s.firstName} is now in <b>{result.status}</b>.</>}
                <div className="mt-3"><Button size="sm" href={`/app/workforce/${id}`} data-testid="b-open-profile">Meet {s.firstName}</Button></div>
              </div>
            ) : <div className="mt-5 flex flex-wrap gap-2"><Button variant="gradient" size="lg" loading={busy} onClick={activate} data-testid="b-activate">Start pilot</Button><Button variant="secondary" size="lg" onClick={async () => { const cur = await save(); if (cur) router.push(`/app/workforce/${cur}`); }} data-testid="b-save-draft">Save as draft</Button></div>}
          </>}
          {err && <p className="mt-4 rounded-lg bg-coral-soft px-3 py-2 text-xs font-medium text-coral-ink" role="alert" data-testid="b-error">{err}</p>}
          <div className="mt-6 flex items-center gap-2 border-t border-border pt-4">
            <Button variant="secondary" onClick={back} disabled={step === 0} data-testid="b-back"><ChevronLeft size={15} />Back</Button>
            {saved && <span className="text-[11px] text-ink-3" role="status">Draft saved {saved}</span>}
            {step < STEPS.length - 1 && <Button className="ml-auto" onClick={next} loading={busy} disabled={step === 7 && !tested} data-testid="b-next">Next<ChevronRight size={15} /></Button>}
          </div>
        </section>
        <aside className="card h-max p-5 lg:sticky lg:top-4" aria-label="Preview">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">Preview</div>
          <div className="mt-3 flex flex-col items-center text-center">
            <AiAvatar name={s.firstName || "AI"} portraitUrl={s.identity === "monogram" ? null : portrait.url ?? (s.identity === "persona" ? persona?.portrait : null)} provenance={portrait.provenance ?? "ai_generated"} team={s.team} size="lg" caption />
            <div className="mt-2 flex items-center gap-1.5 font-bold">{s.firstName || "Your AI employee"}<AiBadge compact /></div>
            <div className="text-xs text-ink-2">{s.title || "Position title"}</div>
            <div className="mt-1 text-[11px] text-ink-3">{dept?.name ?? "No department"} · read-only · draft</div>
          </div>
          {s.responsibilities.length > 0 && <ul className="mt-4 space-y-1 text-xs">{s.responsibilities.slice(0, 5).map((r, i) => <li key={i} className="flex gap-1.5"><Check size={12} className="mt-0.5 shrink-0 text-emerald-ink" />{r}</li>)}</ul>}
          <p className="mt-4 text-[11px] text-ink-3"><Tooltip text="Every greeting begins by stating it's an AI agent." /> Introduces itself as an AI agent.</p>
        </aside>
      </div>
      <Modal open={!!tree} onClose={() => setTree(null)} title="How is this calculated?">{tree && <CalcTreeView node={tree} />}</Modal>
    </div>
  );
}

function IdOption({ on, onClick, title, body, children, testid }: { on: boolean; onClick: () => void; title: string; body: string; children: React.ReactNode; testid: string }) {
  return <button onClick={onClick} aria-pressed={on} data-testid={testid} className={cn("flex flex-col items-center gap-2 rounded-2xl border p-4 text-center", on ? "border-purple bg-purple-soft/40" : "border-border hover:bg-surface-2")}>{children}<span className="text-sm font-semibold">{title}</span><span className="text-[11px] text-ink-3">{body}</span></button>;
}
function UploadBox({ onUpload }: { onUpload: (f: File, prov: string) => Promise<void> }) {
  const [prov, setProv] = React.useState(""); const ref = React.useRef<HTMLInputElement>(null); const [busy, setBusy] = React.useState(false); const [m, setM] = React.useState<string | null>(null);
  return (
    <div className="mt-4 space-y-3 rounded-2xl border border-dashed border-border p-4">
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Portrait image" className="block w-full text-xs" data-testid="b-upload-file" />
      <div className="flex flex-wrap gap-4 text-xs" role="radiogroup" aria-label="Provenance">{[["ai_generated", "AI-generated"], ["licensed", "Licensed"]].map(([v, l]) => <label key={v} className="flex items-center gap-1.5"><input type="radio" name="b-prov" checked={prov === v} onChange={() => setProv(v)} data-testid={`b-upload-prov-${v}`} />{l}</label>)}</div>
      <p className="text-[11px] text-ink-3">PNG/JPEG/WebP up to 1 MB. Never a real person&apos;s likeness. Provenance is recorded and shown.</p>
      <Button size="sm" variant="secondary" loading={busy} onClick={async () => { const f = ref.current?.files?.[0]; if (!f || !prov) { setM("Choose a file and its provenance."); return; } if (f.size > 1_048_576) { setM("Image is larger than 1 MB."); return; } setBusy(true); await onUpload(f, prov); setBusy(false); setM("Uploaded."); }} data-testid="b-upload">Upload</Button>
      {m && <p className="text-xs" role="status">{m}</p>}
    </div>
  );
}
function Group({ label, children }: { label: string; children: React.ReactNode }) { return <div className="mb-4"><div className="mb-1.5 text-xs font-medium text-ink-2">{label}</div><div className="flex flex-wrap gap-1.5">{children}</div></div>; }
function Chip({ on, onClick, children, testid }: { on: boolean; onClick: () => void; children: React.ReactNode; testid?: string }) {
  return <button type="button" onClick={onClick} aria-pressed={on} data-testid={testid} className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", on ? "border-indigo bg-indigo-soft text-indigo-ink" : "border-border text-ink-2 hover:bg-surface-2")}>{children}</button>;
}
