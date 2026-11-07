"use client";
/**
 * SkillStage — runs one skill for an AI employee (sandbox demo or live task) via the workforce server action and
 * plays the returned steps back one by one. Sandbox output is always labelled "Synthetic sample".
 * Degrades to "Skills engine unavailable" when @/engine/skills is not loaded.
 */
import * as React from "react";
import { Play, FlaskConical, ShieldCheck, RotateCcw } from "lucide-react";
import { Button, Badge } from "@/components/ui";
import { runSkillAction } from "@/app/app/workforce/actions";
import { DemoPlayer } from "@/components/skills";
import type { SkillResult } from "@/engine/skills/contract";

export type StageResult = {
  ok: boolean; status: string; summary: string; output: Record<string, unknown>; steps: { key: string; label: string; status: string; ms: number; detail?: string }[];
  citations: { type: string; id: string; label: string; href?: string }[]; durationMs: number; manualBaselineMinutes: number; humanReviewMinutes: number; synthetic: boolean; error?: string; skillRunId?: string;
};


export function SkillStage({ aiEmployeeId, firstName, skillKey, skillName, mode, disabledReason, autoStart, onResult, testid = "skill-stage", inputHint }: {
  aiEmployeeId: string; firstName: string; skillKey: string; skillName: string; mode: "sandbox" | "live"; disabledReason?: string | null; autoStart?: boolean;
  onResult?: (r: StageResult) => void; testid?: string; inputHint?: string;
}) {
  const [raw, setRaw] = React.useState("");
  const [state, setState] = React.useState<"idle" | "running" | "playing" | "done" | "error" | "unavailable">("idle");
  const [res, setRes] = React.useState<StageResult | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const started = React.useRef(false);

  const run = React.useCallback(async () => {
    let input: unknown = undefined;
    if (mode === "live") {
      if (!raw.trim()) { setErr("Live tasks need real input from your business — paste the task details below."); setState("error"); return; }
      try { input = JSON.parse(raw); } catch { setErr("The task details must be valid JSON (see the format hint)."); setState("error"); return; }
    }
    setState("running"); setErr(null); setRes(null);
    const r = await runSkillAction({ aiEmployeeId, skillKey, mode, input });
    if (!r.ok) { setErr(r.error); setState("error"); return; }
    const out = r.result as unknown as StageResult & { status: string };
    if (out.status === "unavailable") { setState("unavailable"); return; }
    setRes(out); setState("playing");
  }, [aiEmployeeId, skillKey, mode, raw]);

  React.useEffect(() => { if (autoStart && !started.current && !disabledReason) { started.current = true; void run(); } }, [autoStart, run, disabledReason]);

  return (
    <div className="space-y-4" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-2">
        {mode === "sandbox" ? <Badge tone="cyan"><FlaskConical size={12} className="mr-1" />Sandbox · Synthetic sample</Badge> : <Badge tone="emerald"><ShieldCheck size={12} className="mr-1" />Live · your real data</Badge>}
        <span className="text-sm font-semibold">{skillName}</span>
        <div className="ml-auto flex gap-2">
          {(state === "idle" || state === "error") && <Button size="sm" variant="gradient" onClick={run} disabled={!!disabledReason} data-testid={`${testid}-run`}><Play size={14} />{mode === "sandbox" ? "Start demonstration" : "Run task"}</Button>}
          {state === "done" && <Button size="sm" variant="secondary" onClick={run} data-testid={`${testid}-rerun`}><RotateCcw size={14} />Run again</Button>}
        </div>
      </div>
      {mode === "live" && !disabledReason && (state === "idle" || state === "error") && (
        <label className="block text-sm"><span className="mb-1 block text-xs font-medium text-ink-2">Task details from your business (JSON). Synthetic samples are refused in live mode.</span>
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={6} placeholder={inputHint ? `Format, for example:\n${inputHint}` : "{ }"} className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs" data-testid={`${testid}-input`} /></label>
      )}
      {disabledReason && <p className="rounded-xl bg-gold-soft px-3 py-2 text-xs font-medium text-gold-ink" data-testid={`${testid}-blocked`}>{disabledReason}</p>}
      {state === "unavailable" && <div className="rounded-xl border border-dashed border-border p-4 text-sm text-ink-2" data-testid={`${testid}-unavailable`}><b>Skills engine unavailable.</b> {firstName} can't run skills until the skills engine is deployed. Nothing was executed.</div>}
      {state === "error" && err && <p className="rounded-xl bg-coral-soft px-3 py-2 text-xs font-medium text-coral-ink" role="alert" data-testid={`${testid}-error`}>{err}</p>}
      {(state === "running" || res) && (
        <DemoPlayer result={(res as unknown as SkillResult) ?? null} running={state === "running"} skillName={skillName} employeeName={firstName} testid={`${testid}-player`}
          onComplete={() => { if (res && state === "playing") { setState("done"); onResult?.(res); } }} />
      )}
      {state === "done" && res && (
        <div className="fade-up space-y-3" data-testid={`${testid}-result`}>
          {res.synthetic && <div className="rounded-xl bg-cyan-soft px-3 py-2 text-xs font-semibold text-cyan-ink" data-testid={`${testid}-synthetic`}>Synthetic sample — demonstration data only. No real systems were touched and this run never counts toward savings.</div>}
          <details className="group"><summary className="cursor-pointer text-xs font-semibold text-royal-ink">Show the full output</summary><div className="mt-2"><OutputView output={res.output} /></div></details>
        </div>
      )}
    </div>
  );
}


/** Renders a skill's structured output as readable rows; deep/technical structures go into a collapsed "Technical details". */
const HIDDEN = new Set(["summary", "synthetic", "mode", "appliedMemory", "permissionLevel", "savings", "extraction"]);
const isPrim = (v: unknown) => v == null || ["string", "number", "boolean"].includes(typeof v);
const isFlat = (v: unknown) => isPrim(v) || (Array.isArray(v) ? v.every((x) => isPrim(x) || (typeof x === "object" && Object.values(x as object).every(isPrim))) : typeof v === "object" && Object.values(v as object).every(isPrim));
export function OutputView({ output }: { output: Record<string, unknown> }) {
  const all = Object.entries(output ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length));
  const main = all.filter(([k, v]) => !HIDDEN.has(k) && isFlat(v));
  const tech = all.filter(([k, v]) => !(!HIDDEN.has(k) && isFlat(v)) && k !== "summary");
  const render = (v: unknown): React.ReactNode => {
    if (Array.isArray(v)) return v.length && typeof v[0] === "object" ? <ul className="space-y-1">{v.slice(0, 12).map((x, i) => <li key={i} className="rounded-lg bg-surface-2 px-2 py-1 text-xs">{Object.entries(x as Record<string, unknown>).map(([k, y]) => <span key={k} className="mr-3 inline-block"><span className="text-ink-3">{human(k)}:</span> {fmtVal(y)}</span>)}</li>)}</ul> : <span>{v.map(fmtVal).join(", ")}</span>;
    if (v && typeof v === "object") return <div className="space-y-0.5">{Object.entries(v as Record<string, unknown>).slice(0, 12).map(([k, y]) => <div key={k} className="text-xs"><span className="text-ink-3">{human(k)}:</span> {fmtVal(y)}</div>)}</div>;
    return fmtVal(v);
  };
  if (!main.length && !tech.length) return null;
  return (
    <div className="card overflow-hidden p-0" data-testid="skill-output">
      <div className="border-b border-border bg-surface-2/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2">Output</div>
      <dl className="divide-y divide-border/70">{main.slice(0, 16).map(([k, v]) => <div key={k} className="grid grid-cols-1 gap-1 px-4 py-2.5 text-sm sm:grid-cols-[180px_1fr]"><dt className="font-medium text-ink-2">{human(k)}</dt><dd className="min-w-0 break-words">{render(v)}</dd></div>)}</dl>
      {tech.length > 0 && <details className="border-t border-border px-4 py-2.5 text-xs"><summary className="cursor-pointer font-semibold text-ink-2">Technical details ({tech.map(([k]) => human(k)).join(", ")})</summary><pre className="scrollbar-thin mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2 text-[11px]">{JSON.stringify(Object.fromEntries(tech), null, 2)}</pre></details>}
    </div>
  );
}
const human = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const fmtVal = (v: unknown): string => typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 })) : typeof v === "boolean" ? (v ? "Yes" : "No") : typeof v === "object" && v ? JSON.stringify(v) : String(v ?? "");
