"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sparkles, PlayCircle, Calculator, Rocket, ArrowRight, GraduationCap, MessageSquare, ClipboardList, Timer, BadgeDollarSign, Settings2, Check, Bot } from "lucide-react";
import type { CalcTree } from "@/db/schema";
import { Button, Modal, Badge } from "@/components/ui";
import { SectionHeader } from "@/components/ui/enterprise";
import { CalcTreeView } from "@/components/calc-tree";
import { AiAvatar, AiBadge, TEAM_ACCENT, GRADIENT } from "@/components/workforce/avatar";
import { SkillStage, type StageResult } from "@/components/workforce/skill-stage";
import { ChatPanel } from "@/components/workforce/chat-panel";
import { cn, fmtNum, fmtUSD } from "@/lib/utils";
import type { Recommendation } from "@/engine/workforce/recommendations";
import { provisionAction, startPilotAction } from "../workforce/actions";

type P = { key: string; firstName: string; title: string; team: string; intro: string; responsibilities: string[]; expertise: string[]; skills: string[]; portrait: string | null; demoSkill: string };
type Existing = Record<string, { id: string; status: string; portraitUrl: string | null; portraitProvenance: string | null; intro: string }>;
type Custom = { id: string; firstName: string; title: string; team: string; intro: string; portraitUrl: string | null; portraitProvenance: string | null; status: string; skills: string[] };
const DEMO_STEPS = [
  { key: "select", label: "Select", icon: <Bot size={14} /> }, { key: "learn", label: "Learn", icon: <GraduationCap size={14} /> }, { key: "watch", label: "Watch", icon: <PlayCircle size={14} /> },
  { key: "ask", label: "Ask", icon: <MessageSquare size={14} /> }, { key: "assign", label: "Sample task", icon: <ClipboardList size={14} /> }, { key: "compare", label: "Compare time", icon: <Timer size={14} /> },
  { key: "benefit", label: "Financial benefit", icon: <BadgeDollarSign size={14} /> }, { key: "activate", label: "Configure & activate", icon: <Settings2 size={14} /> },
] as const;

export function Showroom(p: { orgName: string; canWrite: boolean; userName: string; personas: P[]; teams: { key: string; label: string }[]; existing: Existing; custom: Custom[]; recs: Recommendation[]; skillNames: Record<string, string>; skillsAvailable: boolean; workweeks: number }) {
  const router = useRouter();
  const [existing, setExisting] = React.useState(p.existing);
  const [calc, setCalc] = React.useState<Recommendation | null>(null);
  const [stageKey, setStageKey] = React.useState<string | null>(p.recs[0]?.persona.key ?? "olivia");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  React.useEffect(() => setExisting(p.existing), [p.existing]);
  const portraits = p.personas.filter((x) => x.portrait);
  const recPersonas = [...new Map(p.recs.map((r) => [r.persona.key, r])).values()];

  const ensure = async (key: string): Promise<string | null> => {
    if (existing[key]) return existing[key].id;
    if (!p.canWrite) { setMsg("Ask an owner or admin to add this AI employee to your team."); return null; }
    setBusy(key); const r = await provisionAction({ personaKeys: [key] }); setBusy(null);
    if (!r.ok) { setMsg(r.error); return null; }
    const id = r.ids[key]; const per = p.personas.find((x) => x.key === key)!;
    setExisting((x) => ({ ...x, [key]: { id, status: "draft", portraitUrl: per.portrait, portraitProvenance: per.portrait ? "ai_generated" : "none", intro: per.intro } })); return id;
  };
  const meet = async (key: string) => { const id = await ensure(key); if (id) router.push(`/app/workforce/${id}`); };
  const watch = (key: string) => { setStageKey(key); document.getElementById("demo-stage")?.scrollIntoView({ behavior: "smooth" }); };
  const pilot = async (key: string) => {
    if (!p.canWrite) { setMsg("Ask an owner or admin to start a pilot."); return; }
    setBusy(`pilot-${key}`); const r = await startPilotAction({ personaKey: key }); setBusy(null);
    if (!r.ok) { setMsg(r.error); return; }
    setMsg(r.message); setExisting((x) => ({ ...x, [key]: { ...(x[key] ?? { portraitUrl: null, portraitProvenance: null, intro: "" }), id: r.id, status: r.status } }));
    if (r.needsDemo) watch(key); else router.refresh();
  };

  return (
    <div className="-mx-3 -mt-5 sm:-mx-5 lg:-mx-8 lg:-mt-7">
      {/* ---------------- hero */}
      <section className="relative overflow-hidden bg-[linear-gradient(135deg,#050d1c_0%,#0a1a33_45%,#1a1550_100%)] px-5 pb-12 pt-10 text-white sm:px-10 sm:pb-16 sm:pt-14" data-testid="xp-hero">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_400px_at_80%_10%,rgba(139,92,246,.35),transparent_60%),radial-gradient(700px_300px_at_10%_90%,rgba(6,182,212,.25),transparent_60%)]" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[.2em] text-cyan-300">Experience Center</div>
            <h1 className="mt-3 font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">Meet your new <span className="text-gradient">AI workforce</span></h1>
            <p className="mt-4 max-w-xl text-base text-slate-300 sm:text-lg">AI agents trained on {p.orgName}&apos;s approved knowledge and observed workflows. Watch them work on synthetic samples, ask them anything, and see the real numbers before anything goes live.</p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Button variant="gradient" size="lg" onClick={() => document.getElementById("recommended")?.scrollIntoView({ behavior: "smooth" })} data-testid="xp-cta-recs"><Sparkles size={16} />See who we recommend</Button>
              <Button variant="glass" size="lg" onClick={() => document.getElementById("demo-stage")?.scrollIntoView({ behavior: "smooth" })} data-testid="xp-cta-demo"><PlayCircle size={16} />Try the live demo</Button>
            </div>
            <p className="mt-4 text-xs text-slate-400">Every AI employee is labelled as AI. Portraits marked “AI-generated portrait” depict no real person.</p>
          </div>
          <div className="relative mx-auto grid w-full max-w-md grid-cols-3 gap-x-3 gap-y-5" aria-label="AI workforce portraits" data-testid="xp-mosaic">
            {[...portraits, ...p.personas.filter((x) => !x.portrait).slice(0, 4)].slice(0, 9).map((x, i) => (
              <div key={x.key} className="fade-up flex flex-col items-center" style={{ animationDelay: `${i * 60}ms` }}>
                <AiAvatar name={x.firstName} portraitUrl={x.portrait} provenance="ai_generated" team={x.team} size="lg" className="[&>span:first-child]:h-24 [&>span:first-child]:w-24 sm:[&>span:first-child]:h-28 sm:[&>span:first-child]:w-28" />
                <span className="mt-1.5 text-xs font-semibold">{x.firstName}</span><span className="text-[10px] text-slate-400">{x.portrait ? "AI-generated portrait" : "AI agent"}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-3 py-8 sm:px-5 lg:px-8">
        {msg && <p className="mb-4 rounded-xl bg-surface-2 px-4 py-2 text-sm" role="status" data-testid="xp-msg">{msg}</p>}
        {/* ---------------- recommendations */}
        <section id="recommended" className="scroll-mt-4">
          <SectionHeader title={`Recommended for ${p.orgName}`} subtitle="Matched to workflows BridgeBox observed at your company · numbers from the finance engine (estimated)" accent="gold" icon={<Sparkles size={15} />} />
          {recPersonas.length === 0 ? <div className="card p-6 text-sm text-ink-2">No observed workflow matches an AI persona yet. Run workflow discovery, or browse the teams below and watch any demonstration.</div> : (
            <div className="stagger grid gap-4 lg:grid-cols-2">{recPersonas.slice(0, 6).map((r) => <RecCard key={r.persona.key} r={r} all={p.recs.filter((x) => x.persona.key === r.persona.key)} ex={existing[r.persona.key]} busy={busy} onMeet={meet} onWatch={watch} onCalc={setCalc} onPilot={pilot} canWrite={p.canWrite} />)}</div>
          )}
        </section>

        {/* ---------------- demo stage */}
        <DemoStage personas={p.personas} recs={p.recs} existing={existing} stageKey={stageKey} setStageKey={setStageKey} ensure={ensure} skillNames={p.skillNames} skillsAvailable={p.skillsAvailable} userName={p.userName} canWrite={p.canWrite} onPilot={pilot} busy={busy} />

        {/* ---------------- teams */}
        {p.teams.map((t) => {
          const list = p.personas.filter((x) => x.team === t.key);
          return (
            <section key={t.key} aria-labelledby={`xp-team-${t.key}`}>
              <SectionHeader id={`xp-team-${t.key}`} title={t.key === "executive" ? "Your Executive AI Team" : t.label.replace(" AI Team", "")} subtitle={`${list.length} AI agents`} accent={TEAM_ACCENT[t.key]} icon={<Bot size={15} />} />
              <div className="scrollbar-thin -mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">{list.map((x) => <PersonaTile key={x.key} x={x} ex={existing[x.key]} onMeet={meet} onWatch={watch} busy={busy === x.key} />)}</div>
            </section>
          );
        })}
        <section>
          <SectionHeader title="Your Custom AI Team" subtitle="AI employees you designed in the builder" accent="purple" icon={<Bot size={15} />} action={p.canWrite ? <Button size="sm" variant="secondary" href="/app/workforce/new" data-testid="xp-build">Build one</Button> : undefined} />
          {p.custom.length ? <div className="scrollbar-thin -mx-1 flex gap-3 overflow-x-auto px-1 pb-2">{p.custom.map((c) => (
            <div key={c.id} className="card w-56 shrink-0 p-4 text-center"><AiAvatar name={c.firstName} portraitUrl={c.portraitUrl} provenance={c.portraitProvenance} team={c.team} size="md" caption /><div className="mt-2 flex items-center justify-center gap-1.5 font-bold">{c.firstName}<AiBadge compact /></div><div className="text-xs text-ink-2">{c.title}</div><Button size="sm" className="mt-3 w-full" href={`/app/workforce/${c.id}`}>Meet {c.firstName}</Button></div>
          ))}</div> : <div className="card p-5 text-sm text-ink-2">No custom AI employees yet. Use the 10-step builder to design one for a role we don&apos;t have in the library.</div>}
        </section>
      </div>
      <CalcModal r={calc} onClose={() => setCalc(null)} weeks={p.workweeks} />
    </div>
  );
}

function RecCard({ r, all, ex, busy, onMeet, onWatch, onCalc, onPilot, canWrite }: { r: Recommendation; all: Recommendation[]; ex?: Existing[string]; busy: string | null; onMeet: (k: string) => void; onWatch: (k: string) => void; onCalc: (r: Recommendation) => void; onPilot: (k: string) => void; canWrite: boolean }) {
  const accent = TEAM_ACCENT[r.persona.team];
  const total = all.reduce((s, x) => s + x.realizableAnnualSavings, 0);
  return (
    <article id={`meet-${r.persona.key}`} className="card card-hover relative scroll-mt-4 overflow-hidden p-0" data-testid={`rec-${r.persona.key}`}>
      <div className={cn("absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b", GRADIENT[accent])} />
      <div className="flex flex-col gap-4 p-5 sm:flex-row">
        <AiAvatar name={r.persona.firstName} portraitUrl={ex?.portraitUrl ?? r.persona.portrait} provenance={ex?.portraitProvenance ?? "ai_generated"} team={r.persona.team} size="lg" caption className="self-center sm:self-start" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><AiBadge />{ex ? <Badge tone="emerald">On your team · {ex.status}</Badge> : <Badge tone="gold">Recommended</Badge>}</div>
          <h3 className="mt-1 font-display text-2xl font-black uppercase tracking-tight">Meet {r.persona.firstName}</h3>
          <p className="text-sm font-semibold text-ink-2">{r.persona.title}</p>
          <blockquote className="mt-3 rounded-xl bg-surface-2/70 p-3 text-sm italic" data-testid={`rec-quote-${r.persona.key}`}>“{r.quote}”</blockquote>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs"><span><b className="text-gold-ink">{fmtUSD(total)}/yr</b> projected capacity</span><span><b>{fmtNum(all.reduce((s, x) => s + x.hoursRecoverablePerWeek, 0), 1)} h/wk</b> automatable</span>{all.length > 1 && <span className="text-ink-3">{all.length} workflows</span>}</div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="gradient" loading={busy === r.persona.key} onClick={() => onMeet(r.persona.key)} data-testid={`rec-meet-${r.persona.key}`}>Meet {r.persona.firstName}<ArrowRight size={14} /></Button>
            <Button size="sm" variant="secondary" onClick={() => onWatch(r.persona.key)} data-testid={`rec-watch-${r.persona.key}`}><PlayCircle size={14} />Watch demonstration</Button>
            <Button size="sm" variant="secondary" onClick={() => onCalc(r)} data-testid={`rec-calc-${r.persona.key}`}><Calculator size={14} />Calculate my savings</Button>
            {canWrite && <Button size="sm" variant="secondary" loading={busy === `pilot-${r.persona.key}`} onClick={() => onPilot(r.persona.key)} disabled={ex?.status === "pilot" || ex?.status === "active"} data-testid={`rec-pilot-${r.persona.key}`}><Rocket size={14} />{ex?.status === "pilot" || ex?.status === "active" ? "Piloting" : "Start pilot"}</Button>}
          </div>
        </div>
      </div>
    </article>
  );
}

function PersonaTile({ x, ex, onMeet, onWatch, busy }: { x: P; ex?: Existing[string]; onMeet: (k: string) => void; onWatch: (k: string) => void; busy: boolean }) {
  return (
    <div id={`meet-${x.key}`} className="card card-hover w-60 shrink-0 snap-start scroll-mt-4 p-4" data-testid={`xp-persona-${x.key}`}>
      <div className="flex items-center gap-3"><AiAvatar name={x.firstName} portraitUrl={ex?.portraitUrl ?? x.portrait} provenance={ex?.portraitProvenance ?? "ai_generated"} team={x.team} size="md" /><div className="min-w-0"><div className="flex items-center gap-1.5 font-bold">{x.firstName}<AiBadge compact /></div><div className="line-clamp-2 text-xs text-ink-2">{x.title}</div></div></div>
      <p className="mt-3 line-clamp-3 text-xs text-ink-2">{x.intro}</p>
      {x.portrait && <p className="mt-1 text-[10px] text-ink-3">AI-generated portrait</p>}
      <div className="mt-3 flex gap-2"><Button size="sm" className="flex-1" loading={busy} onClick={() => onMeet(x.key)} data-testid={`xp-meet-${x.key}`}>Meet</Button><Button size="sm" variant="secondary" onClick={() => onWatch(x.key)} aria-label={`Watch ${x.firstName}'s demonstration`} data-testid={`xp-watch-${x.key}`}><PlayCircle size={14} /></Button></div>
    </div>
  );
}

function CalcModal({ r, onClose, weeks }: { r: Recommendation | null; onClose: () => void; weeks: number }) {
  const [adopt, setAdopt] = React.useState(100); const [tree, setTree] = React.useState(false);
  React.useEffect(() => { setAdopt(100); setTree(false); }, [r]);
  if (!r) return null;
  const a = adopt / 100; const saved = r.hoursRecoverablePerWeek * a; const after = Math.max(0, r.observedHoursPerWeek - saved); const annual = r.realizableAnnualSavings * a; const net = annual - r.annualOperatingCost;
  const max = Math.max(r.observedHoursPerWeek, 1);
  return (
    <Modal open onClose={onClose} title={`Calculate savings — ${r.persona.firstName} on ${r.workflowLabel}`} wide>
      <div className="space-y-5" data-testid="xp-calc">
        <p className="text-sm text-ink-2">Manual hours are observed from your workflows; automatable hours and dollars come from the finance engine&apos;s projection for <Link href={`/app/opportunities/${r.opportunityId}`} className="font-semibold text-royal-ink hover:underline">{r.opportunityTitle}</Link> (estimated). Move the slider to see a partial rollout.</p>
        <label className="block"><span className="flex justify-between text-sm font-semibold"><span>Adoption of the projected automation</span><span className="tabular">{adopt}%</span></span>
          <input type="range" min={0} max={100} step={5} value={adopt} onChange={(e) => setAdopt(Number(e.target.value))} className="mt-2 w-full accent-[#8B5CF6]" aria-valuetext={`${adopt}%`} data-testid="xp-calc-adoption" /></label>
        <div className="space-y-3" role="img" aria-label={`Manual ${r.observedHoursPerWeek.toFixed(1)} hours per week; with ${r.persona.firstName} ${after.toFixed(1)} hours per week`}>
          <Bar label="Today (manual, observed)" hours={r.observedHoursPerWeek} max={max} cls="bg-gold" />
          <Bar label={`With ${r.persona.firstName} (estimated)`} hours={after} max={max} cls="bg-cyan" />
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Tile label="Hours back / week" value={`${fmtNum(saved, 1)} h`} tone="text-cyan-ink" />
          <Tile label="Hours back / year" value={`${fmtNum(saved * weeks, 0)} h`} tone="text-cyan-ink" sub={`× ${weeks} work weeks (org setting)`} />
          <Tile label="Capacity value / year" value={fmtUSD(annual)} tone="text-gold-ink" sub="estimated, not cash" />
          <Tile label="Net of AI cost / year" value={fmtUSD(net)} tone={net >= 0 ? "text-emerald-ink" : "text-coral-ink"} sub={`${fmtUSD(r.annualOperatingCost)} operating cost`} />
        </div>
        <p className="text-[11px] text-ink-3">Time saved is capacity your people get back — not a payroll reduction. Hard savings count only after finance approves them in the savings ledger.</p>
        <button className="text-xs font-semibold text-royal-ink hover:underline" onClick={() => setTree(!tree)} data-testid="xp-calc-tree">{tree ? "Hide" : "Show"} the full calculation</button>
        {tree && <div className="rounded-xl border border-border p-3"><CalcTreeView node={r.tree as CalcTree} /></div>}
      </div>
    </Modal>
  );
}
function Bar({ label, hours, max, cls }: { label: string; hours: number; max: number; cls: string }) {
  return <div><div className="mb-1 flex justify-between text-xs font-semibold"><span>{label}</span><span className="tabular">{fmtNum(hours, 1)} h/wk</span></div><div className="h-4 w-full overflow-hidden rounded-full bg-surface-3"><div className={cn("h-full rounded-full transition-all duration-500", cls)} style={{ width: `${(hours / max) * 100}%` }} /></div></div>;
}
function Tile({ label, value, tone, sub }: { label: string; value: string; tone: string; sub?: string }) {
  return <div className="rounded-xl border border-border p-3"><div className="text-[11px] font-semibold text-ink-2">{label}</div><div className={cn("mt-1 font-display text-xl font-bold", tone)}>{value}</div>{sub && <div className="text-[10px] text-ink-3">{sub}</div>}</div>;
}

function DemoStage({ personas, recs, existing, stageKey, setStageKey, ensure, skillNames, skillsAvailable, userName, canWrite, onPilot, busy }: {
  personas: P[]; recs: Recommendation[]; existing: Existing; stageKey: string | null; setStageKey: (k: string) => void; ensure: (k: string) => Promise<string | null>;
  skillNames: Record<string, string>; skillsAvailable: boolean; userName: string; canWrite: boolean; onPilot: (k: string) => void; busy: string | null;
}) {
  const [step, setStep] = React.useState(0);
  const [demo, setDemo] = React.useState<StageResult | null>(null);
  const [task, setTask] = React.useState<StageResult | null>(null);
  const per = personas.find((x) => x.key === stageKey) ?? personas[0];
  const ex = existing[per.key];
  const rec = recs.filter((r) => r.persona.key === per.key);
  React.useEffect(() => { setStep(0); setDemo(null); setTask(null); }, [stageKey]);
  const goto = async (i: number) => { if (i >= 2 && !ex) { const id = await ensure(per.key); if (!id) return; } setStep(i); };
  const taskSkill = per.skills.find((k) => k !== per.demoSkill) ?? per.demoSkill;
  const res = task ?? demo;
  const nm = (k: string) => skillNames[k] ?? k.replace(/_/g, " ");
  const featured = [...new Set([...recs.map((r) => r.persona.key), "olivia", "james", "victoria", "alexander", "sophia"])].slice(0, 8);
  return (
    <section id="demo-stage" className="mb-4 scroll-mt-4" aria-labelledby="demo-stage-title">
      <SectionHeader id="demo-stage-title" title="Interactive demo stage" subtitle="Pick an AI employee and walk through how it would work for you — no technical knowledge needed" accent="purple" icon={<PlayCircle size={15} />} />
      <div className="card overflow-hidden p-0" data-testid="xp-stage">
        <div className="border-b border-border bg-surface-2/50 p-4">
          <div className="scrollbar-thin flex gap-2 overflow-x-auto pb-1" role="listbox" aria-label="Choose an AI employee">{featured.map((k) => { const x = personas.find((y) => y.key === k)!; return (
            <button key={k} role="option" aria-selected={k === per.key} onClick={() => setStageKey(k)} data-testid={`stage-pick-${k}`} className={cn("flex shrink-0 items-center gap-2 rounded-xl border px-2.5 py-1.5 text-left", k === per.key ? "border-purple bg-purple-soft/60" : "border-border bg-surface hover:bg-surface-2")}>
              <AiAvatar name={x.firstName} portraitUrl={existing[k]?.portraitUrl ?? x.portrait} provenance="ai_generated" team={x.team} size="xs" /><span className="text-xs font-semibold">{x.firstName}</span></button>
          ); })}</div>
          <ol className="scrollbar-thin mt-3 flex gap-1 overflow-x-auto" aria-label="Demo steps">{DEMO_STEPS.map((s, i) => (
            <li key={s.key}><button onClick={() => goto(i)} aria-current={i === step ? "step" : undefined} data-testid={`stage-step-${s.key}`} className={cn("flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-semibold", i === step ? "bg-midnight text-white dark:bg-royal" : i < step ? "text-emerald-ink" : "text-ink-3 hover:text-ink")}>{i < step ? <Check size={12} /> : s.icon}{i + 1}. {s.label}</button></li>
          ))}</ol>
        </div>
        <div className="p-5" data-testid={`stage-body-${DEMO_STEPS[step].key}`}>
          {step === 0 && <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left"><AiAvatar name={per.firstName} portraitUrl={ex?.portraitUrl ?? per.portrait} provenance="ai_generated" team={per.team} size="xl" caption /><div><div className="flex items-center justify-center gap-2 sm:justify-start"><h3 className="font-display text-3xl font-bold">{per.firstName}</h3><AiBadge /></div><p className="text-ink-2">{per.title}</p><p className="mt-3 max-w-xl text-sm">{ex?.intro ?? per.intro}</p><Button className="mt-4" variant="gradient" onClick={() => goto(1)} data-testid="stage-next-0">Learn what {per.firstName} does<ArrowRight size={14} /></Button></div></div>}
          {step === 1 && <div className="grid gap-4 sm:grid-cols-2"><div><h3 className="font-bold">Responsibilities</h3><ul className="mt-2 space-y-1.5 text-sm">{per.responsibilities.map((r) => <li key={r} className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0 text-emerald-ink" />{r}</li>)}</ul></div><div><h3 className="font-bold">Skills</h3><div className="mt-2 flex flex-wrap gap-1.5">{per.skills.map((k) => <Badge key={k} tone="purple">{nm(k)}</Badge>)}</div><p className="mt-3 text-xs text-ink-2">Starts at read-only permission. Anything consequential waits for a person to approve.</p><Button className="mt-4" variant="gradient" loading={busy === per.key} onClick={() => goto(2)} data-testid="stage-next-1">Watch {per.firstName} work<ArrowRight size={14} /></Button></div></div>}
          {step === 2 && ex && <><SkillStage key={`d-${ex.id}`} aiEmployeeId={ex.id} firstName={per.firstName} skillKey={per.demoSkill} skillName={nm(per.demoSkill)} mode="sandbox" autoStart onResult={setDemo} testid="stage-demo" />{(demo || !skillsAvailable) && <Button className="mt-4" onClick={() => setStep(3)} data-testid="stage-next-2">Ask {per.firstName} a question<ArrowRight size={14} /></Button>}</>}
          {step === 3 && ex && <><div className="h-[480px]"><ChatPanel key={ex.id} employee={{ id: ex.id, firstName: per.firstName, title: per.title, team: per.team, portraitUrl: ex.portraitUrl ?? per.portrait, portraitProvenance: ex.portraitProvenance, intro: ex.intro || per.intro }} initial={[]} conversationId={null} userName={userName} testid="stage-chat" onAction={(a) => { if (a.kind === "start_demo") setStep(2); }} /></div><Button className="mt-3" onClick={() => setStep(4)} data-testid="stage-next-3">Give a sample task<ArrowRight size={14} /></Button></>}
          {step === 4 && ex && <><p className="mb-3 text-sm text-ink-2">A sample task on synthetic data — see exactly what {per.firstName} hands back.</p><SkillStage key={`t-${ex.id}-${taskSkill}`} aiEmployeeId={ex.id} firstName={per.firstName} skillKey={taskSkill} skillName={nm(taskSkill)} mode="sandbox" onResult={setTask} testid="stage-task" />{(task || !skillsAvailable) && <Button className="mt-4" onClick={() => setStep(5)} data-testid="stage-next-4">Compare the time<ArrowRight size={14} /></Button>}</>}
          {step === 5 && <div>
            {res ? <div className="grid gap-3 sm:grid-cols-3"><Tile label="A person doing it (documented baseline)" value={`${fmtNum(res.manualBaselineMinutes, 1)} min`} tone="text-gold-ink" /><Tile label={`${per.firstName} + human review`} value={`${fmtNum(res.durationMs / 60000 + res.humanReviewMinutes, 1)} min`} tone="text-cyan-ink" /><Tile label="Saved per task" value={`${fmtNum(Math.max(0, res.manualBaselineMinutes - res.durationMs / 60000 - res.humanReviewMinutes), 1)} min`} tone="text-emerald-ink" sub="sandbox — illustrates the method" /></div> : <p className="text-sm text-ink-2">Run the demonstration first to compare times.</p>}
            {rec[0] && <p className="mt-4 text-sm">At your company, <b>{rec[0].workflowLabel}</b> takes ~<b>{fmtNum(rec[0].observedHoursPerWeek, 1)} h/week</b> today (observed) across ~{fmtNum(rec[0].runsPerWeek, 0)} runs.</p>}
            <Button className="mt-4" onClick={() => setStep(6)} data-testid="stage-next-5">See the financial benefit<ArrowRight size={14} /></Button>
          </div>}
          {step === 6 && <div>
            {rec.length ? <div className="grid gap-3 sm:grid-cols-3"><Tile label="Automatable hours / week" value={`${fmtNum(rec.reduce((s, r) => s + r.hoursRecoverablePerWeek, 0), 1)} h`} tone="text-cyan-ink" sub="estimated" /><Tile label="Recovered capacity / year" value={fmtUSD(rec.reduce((s, r) => s + r.realizableAnnualSavings, 0))} tone="text-gold-ink" sub="finance engine, estimated" /><Tile label="Net of AI operating cost" value={fmtUSD(rec.reduce((s, r) => s + r.netAnnualSavings, 0))} tone="text-emerald-ink" sub="per year" /></div>
              : <p className="text-sm text-ink-2">{per.firstName} isn&apos;t matched to an observed workflow at your company yet, so we won&apos;t show a number. Choose a recommended AI employee to see real projections.</p>}
            <p className="mt-3 text-[11px] text-ink-3">Capacity, not cash: time your people get back. Verified savings appear only after live work, and hard savings only after finance approval.</p>
            <Button className="mt-4" onClick={() => setStep(7)} data-testid="stage-next-6">Configure & activate<ArrowRight size={14} /></Button>
          </div>}
          {step === 7 && <div className="space-y-3">
            <p className="text-sm">Ready to try {per.firstName} on real work? A pilot keeps <b>read-only</b> permission and a named approver until you decide otherwise.</p>
            <div className="flex flex-wrap gap-2">
              {canWrite && <Button variant="gradient" loading={busy === `pilot-${per.key}`} onClick={() => onPilot(per.key)} disabled={ex?.status === "pilot" || ex?.status === "active"} data-testid="stage-pilot"><Rocket size={14} />{ex?.status === "pilot" || ex?.status === "active" ? `${per.firstName} is piloting` : "Start pilot"}</Button>}
              {ex && <Button variant="secondary" href={`/app/workforce/${ex.id}?tab=customize`} data-testid="stage-configure"><Settings2 size={14} />Configure {per.firstName}</Button>}
              {ex && <Button variant="secondary" href={`/app/workforce/${ex.id}`}>Open profile</Button>}
            </div>
          </div>}
          {step >= 2 && !ex && <p className="text-sm text-ink-2">{canWrite ? "Adding to your team…" : "An owner or admin must add this AI employee before it can run demonstrations."}</p>}
        </div>
      </div>
    </section>
  );
}
