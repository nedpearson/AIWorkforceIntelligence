"use client";
/**
 * DemoPlayer — animates a SkillResult (or a run in progress) step by step: status icons, real per-step timings as bars,
 * field-extraction highlights over the source invoice text, a "Synthetic sample" ribbon in sandbox, the manual-vs-automated
 * comparison and the plain-English summary. Reduced-motion users see the finished state immediately. All timings shown are
 * the real measured values; only the reveal pacing is animated.
 */
import * as React from "react";
import { Bot, Check, CircleSlash, Clock, X, Play, SkipForward, RotateCcw, FileText, Sparkles, BookOpen } from "lucide-react";
import type { SkillResult, SkillStep } from "@/engine/skills";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";

type Field = { label: string; value: string | number | null; confidence: number; method: string; span?: [number, number] };
type Line = { description: string; quantity: number; unitPrice: number; amount: number; category: string; confidence: number; span?: [number, number] };
type Extraction = { text: string; fields: Record<string, Field>; lines: Line[]; overallConfidence: number };
type Savings = { baselineMinutes: number; baselineBasis: string; baselineSource: string; automatedMinutes: number; reviewMinutes: number; minutesSaved: number; valueUsd: number | null; hourlyRate: number | null; hourlyBasis: string; hourlySource: string; countsNote: string };

const FIELD_ORDER = ["vendor", "invoiceNumber", "invoiceDate", "dueDate", "poNumber", "terms", "subtotal", "tax", "total"];
const FIELD_COLOR: Record<string, string> = { vendor: "bg-royal-soft text-royal-ink", invoiceNumber: "bg-indigo-soft text-indigo-ink", invoiceDate: "bg-cyan-soft text-cyan-ink", dueDate: "bg-cyan-soft text-cyan-ink", poNumber: "bg-purple-soft text-purple-ink", terms: "bg-cyan-soft text-cyan-ink", subtotal: "bg-gold-soft text-gold-ink", tax: "bg-gold-soft text-gold-ink", total: "bg-emerald-soft text-emerald-ink", shipping: "bg-gold-soft text-gold-ink", discount: "bg-gold-soft text-gold-ink" };
const STATUS: Record<SkillStep["status"], { icon: React.ReactNode; cls: string; label: string }> = {
  done: { icon: <Check className="h-3.5 w-3.5" aria-hidden />, cls: "bg-emerald-soft text-emerald-ink", label: "Done" },
  skipped: { icon: <CircleSlash className="h-3.5 w-3.5" aria-hidden />, cls: "bg-surface-3 text-ink-2", label: "Skipped" },
  failed: { icon: <X className="h-3.5 w-3.5" aria-hidden />, cls: "bg-coral-soft text-coral-ink", label: "Failed" },
  awaiting_approval: { icon: <Clock className="h-3.5 w-3.5" aria-hidden />, cls: "bg-gold-soft text-gold-ink", label: "Waiting for approval" },
};
const fmtMs = (ms: number) => (ms < 1 ? `${ms.toFixed(2)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtMin = (m: number) => (m < 1 ? `${Math.round(m * 60)} s` : `${Math.round(m * 10) / 10} min`);

function usePrefersReducedMotion() {
  const [r, setR] = React.useState(false);
  React.useEffect(() => { const m = window.matchMedia?.("(prefers-reduced-motion: reduce)"); if (!m) return; setR(m.matches); const h = () => setR(m.matches); m.addEventListener?.("change", h); return () => m.removeEventListener?.("change", h); }, []);
  return r;
}

export type DemoPlayerProps = { result: SkillResult | null; running?: boolean; skillName?: string; employeeName?: string; autoPlay?: boolean; stepDelayMs?: number; onComplete?: () => void; className?: string; testid?: string };

export function DemoPlayer({ result, running, skillName, employeeName, autoPlay = true, stepDelayMs = 700, onComplete, className, testid = "demo-player" }: DemoPlayerProps) {
  const reduced = usePrefersReducedMotion();
  const steps = result?.steps ?? [];
  const [shown, setShown] = React.useState(0);
  const [playing, setPlaying] = React.useState(autoPlay);
  const doneRef = React.useRef(false);
  React.useEffect(() => { setShown(reduced || !autoPlay ? steps.length : 0); setPlaying(autoPlay && !reduced); doneRef.current = false; }, [result?.skillRunId, result, reduced, autoPlay, steps.length]);
  React.useEffect(() => {
    if (!playing || shown >= steps.length) return;
    const t = setTimeout(() => setShown((s) => s + 1), shown === 0 ? 250 : stepDelayMs);
    return () => clearTimeout(t);
  }, [playing, shown, steps.length, stepDelayMs]);
  const complete = !!result && shown >= steps.length;
  React.useEffect(() => { if (complete && !doneRef.current) { doneRef.current = true; setPlaying(false); onComplete?.(); } }, [complete, onComplete]);

  const maxMs = Math.max(0.01, ...steps.map((s) => s.ms));
  const extraction = (result?.output?.extraction as Extraction | undefined) ?? null;
  const extractIdx = steps.findIndex((s) => s.key === "extract");
  const showExtraction = !!extraction && extractIdx >= 0 && shown > extractIdx;
  const savings = (result?.output?.savings as Savings | undefined) ?? null;
  const pct = steps.length ? Math.round((Math.min(shown, steps.length) / steps.length) * 100) : 0;
  const mode = (result?.output?.mode as string | undefined) ?? "deterministic";

  return (
    <section className={cn("card relative overflow-hidden", className)} data-testid={testid} aria-label={`${skillName ?? "Skill"} demonstration`}>
      {result?.synthetic && (
        <div className="pointer-events-none absolute right-0 top-0 z-10 h-24 w-24 overflow-hidden" aria-hidden>
          <div className="absolute right-[-34px] top-[18px] w-[140px] rotate-45 bg-gold py-1 text-center text-[10px] font-bold uppercase tracking-wider text-[#1f1300] shadow">Synthetic sample</div>
        </div>
      )}
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-purple-soft text-purple-ink"><Bot className="h-5 w-5" aria-hidden /></div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold text-ink">{skillName ?? "Skill run"}</h3>
              <Badge tone="purple">AI Agent</Badge>
              {result && <Badge tone={result.synthetic ? "gold" : "emerald"}>{result.synthetic ? "Sandbox · synthetic" : "Live data"}</Badge>}
              {result && <Badge tone={mode === "llm" ? "purple" : "neutral"}>{mode === "llm" ? "Model-polished" : "Deterministic"}</Badge>}
            </div>
            {employeeName && <p className="mt-0.5 text-xs text-ink-2">{employeeName} (AI agent){result?.synthetic ? " working on a synthetic sample" : ""}</p>}
          </div>
        </div>
        {result && (
          <div className="flex items-center gap-1.5 pr-12 sm:pr-14">
            {!complete && <button type="button" onClick={() => setPlaying((p) => !p)} className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-surface-2" data-testid={`${testid}-play`}>{playing ? "Pause" : <><Play className="h-3.5 w-3.5" aria-hidden />Play</>}</button>}
            {!complete && <button type="button" onClick={() => { setShown(steps.length); setPlaying(false); }} className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-surface-2" data-testid={`${testid}-skip`}><SkipForward className="h-3.5 w-3.5" aria-hidden />Skip</button>}
            {complete && !reduced && <button type="button" onClick={() => { setShown(0); setPlaying(true); doneRef.current = true; }} className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-surface-2" data-testid={`${testid}-replay`}><RotateCcw className="h-3.5 w-3.5" aria-hidden />Replay</button>}
          </div>
        )}
      </header>

      <div className="h-1 w-full bg-surface-3" role="progressbar" aria-label="Demonstration progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={running && !result ? undefined : pct}>
        <div className={cn("h-full bg-gradient-to-r from-purple to-cyan transition-[width] duration-500", running && !result && "w-1/3 animate-pulse")} style={result ? { width: `${pct}%` } : undefined} />
      </div>

      {!result && running && (
        <div className="space-y-3 p-5" aria-live="polite" data-testid={`${testid}-working`}>
          <p className="flex items-center gap-2 text-sm text-ink-2"><span className="live-dot h-2 w-2 rounded-full bg-purple" aria-hidden />The AI agent is working…</p>
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-10" />)}
        </div>
      )}
      {!result && !running && <p className="p-5 text-sm text-ink-2">Choose a sample or paste your own input, then run the skill to watch each step.</p>}

      {result && (
        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ol className="divide-y divide-border/70" aria-live="polite" data-testid={`${testid}-steps`}>
            {steps.map((s, i) => {
              const visible = i < shown; const active = i === shown && !complete && playing;
              const st = STATUS[s.status] ?? STATUS.done;
              return (
                <li key={`${s.key}-${i}`} className={cn("px-4 py-2.5 transition-opacity sm:px-5", visible ? "opacity-100" : active ? "opacity-70" : "opacity-30")} data-testid={`${testid}-step-${s.key}`} data-status={visible ? s.status : "pending"} aria-hidden={!visible && !active}>
                  <div className="flex items-start gap-2.5">
                    <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", visible ? st.cls : "bg-surface-2 text-ink-3", active && "live-dot")} title={visible ? st.label : "Pending"}>
                      {visible ? st.icon : <span className="text-[10px] font-bold">{i + 1}</span>}<span className="sr-only">{visible ? st.label : "Pending"}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-sm font-medium text-ink">{s.label}</p>
                        {visible && s.ms > 0 && <span className="shrink-0 font-mono text-[11px] text-ink-3">{fmtMs(s.ms)}</span>}
                      </div>
                      {visible && s.ms > 0 && <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden><div className="h-full rounded-full bg-cyan" style={{ width: `${Math.max(3, (s.ms / maxMs) * 100)}%` }} /></div>}
                      {visible && s.detail && <p className="mt-1 break-words text-xs leading-relaxed text-ink-2">{s.detail}</p>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="border-t border-border bg-surface-2/40 lg:border-l lg:border-t-0">
            {showExtraction && extraction ? <ExtractionView ex={extraction} /> : (
              <div className="flex h-full min-h-[120px] items-center justify-center p-5 text-xs text-ink-3"><FileText className="mr-2 h-4 w-4" aria-hidden />{complete ? "Output details appear in the summary below." : "Working through the steps…"}</div>
            )}
          </div>
        </div>
      )}

      {result && complete && (
        <div className="fade-up space-y-4 border-t border-border p-4 sm:p-5" data-testid={`${testid}-summary`}>
          <div className={cn("rounded-xl p-3.5 text-sm", result.status === "failed" ? "bg-coral-soft text-coral-ink" : result.status === "awaiting_approval" ? "bg-gold-soft text-gold-ink" : result.status === "rejected" ? "bg-surface-3 text-ink" : "bg-emerald-soft text-emerald-ink")} role="status">
            <p className="flex items-start gap-2 font-medium"><Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{result.summary || result.error}</p>
          </div>
          {savings && <Comparison s={savings} synthetic={result.synthetic} />}
          {result.citations.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ink-2"><BookOpen className="h-3.5 w-3.5" aria-hidden />Approved knowledge used</p>
              <ul className="flex flex-wrap gap-1.5">{result.citations.slice(0, 12).map((c) => <li key={`${c.type}-${c.id}`}>{c.href ? <a href={c.href} className="inline-flex rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink">{c.label}</a> : <span className="inline-flex rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-ink-2">{c.label}</span>}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ExtractionView({ ex }: { ex: Extraction }) {
  const spans = [
    ...FIELD_ORDER.filter((k) => ex.fields[k]?.span && ex.fields[k].value != null).map((k) => ({ key: k, start: ex.fields[k].span![0], end: ex.fields[k].span![1] })),
  ].sort((a, b) => a.start - b.start).filter((s, i, arr) => i === 0 || s.start >= arr[i - 1].end);
  const lineSpans = ex.lines.filter((l) => l.span).map((l) => l.span!) as [number, number][];
  const text = ex.text.slice(0, 6000);
  const parts: React.ReactNode[] = []; let pos = 0;
  const inLine = (i: number) => lineSpans.some(([a, b]) => i >= a && i < b);
  for (const s of spans) {
    if (s.start >= text.length) break;
    if (s.start > pos) parts.push(<Plain key={`p${pos}`} text={text.slice(pos, s.start)} offset={pos} inLine={inLine} />);
    parts.push(<mark key={`m${s.start}`} className={cn("rounded px-0.5 font-semibold", FIELD_COLOR[s.key] ?? "bg-surface-3")} title={ex.fields[s.key].label}>{text.slice(s.start, s.end)}</mark>);
    pos = s.end;
  }
  if (pos < text.length) parts.push(<Plain key={`p${pos}`} text={text.slice(pos)} offset={pos} inLine={inLine} />);
  return (
    <div className="p-4 sm:p-5" data-testid="demo-player-extraction">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink-2">Fields extracted from the document</p>
        <span className="text-[11px] text-ink-3">Overall confidence {Math.round(ex.overallConfidence * 100)}%</span>
      </div>
      <pre className="fade-up max-h-56 overflow-auto whitespace-pre rounded-lg border border-border bg-surface p-3 font-mono text-[11px] leading-relaxed text-ink" aria-label="Source document with extracted fields highlighted">{parts}</pre>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {FIELD_ORDER.map((k) => { const f = ex.fields[k]; if (!f) return null; const c = Math.round(f.confidence * 100); return (
          <div key={k} className="flex items-center justify-between gap-2 text-xs">
            <dt className="flex items-center gap-1.5 text-ink-2"><span className={cn("h-2 w-2 rounded-sm", (FIELD_COLOR[k] ?? "bg-surface-3").split(" ")[0])} aria-hidden />{f.label}</dt>
            <dd className="flex min-w-0 items-center gap-2"><span className="truncate font-medium text-ink">{f.value == null ? "—" : typeof f.value === "number" ? `$${f.value.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : String(f.value)}</span>
              <span className={cn("shrink-0 rounded px-1 text-[10px] font-semibold", f.method === "missing" ? "bg-coral-soft text-coral-ink" : c >= 85 ? "bg-emerald-soft text-emerald-ink" : c >= 65 ? "bg-gold-soft text-gold-ink" : "bg-coral-soft text-coral-ink")} title={`Extraction method: ${f.method}`}>{f.method === "missing" ? "missing" : `${c}%`}</span></dd>
          </div>); })}
      </dl>
      {ex.lines.length > 0 && <p className="mt-2 text-[11px] text-ink-3">{ex.lines.length} line item{ex.lines.length === 1 ? "" : "s"} recognised (underlined above).</p>}
    </div>
  );
}
function Plain({ text, offset, inLine }: { text: string; offset: number; inLine: (i: number) => boolean }) {
  // underline line-item regions without breaking the text into one span per character
  const out: React.ReactNode[] = []; let start = 0; let cur = inLine(offset);
  for (let i = 1; i <= text.length; i++) {
    const v = i < text.length ? inLine(offset + i) : !cur;
    if (v !== cur || i === text.length) { const seg = text.slice(start, i); out.push(cur ? <span key={start} className="underline decoration-cyan decoration-2 underline-offset-2">{seg}</span> : <React.Fragment key={start}>{seg}</React.Fragment>); start = i; cur = v; }
  }
  return <>{out}</>;
}

function Comparison({ s, synthetic }: { s: Savings; synthetic: boolean }) {
  const ai = s.automatedMinutes + s.reviewMinutes; const max = Math.max(s.baselineMinutes, ai, 0.01);
  return (
    <div className="rounded-xl border border-border p-3.5" data-testid="demo-player-comparison" role="group" aria-label={`Manual ${fmtMin(s.baselineMinutes)} versus ${fmtMin(ai)} with the AI agent`}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-ink">Manual vs. with the AI agent</p>
        <p className="text-xs text-ink-2"><span className="font-semibold text-cyan-ink">{fmtMin(s.minutesSaved)} saved</span>{s.valueUsd != null && <> · ${s.valueUsd.toFixed(2)} of time value</>}</p>
      </div>
      <div className="space-y-2 text-xs">
        <div><div className="mb-0.5 flex justify-between text-ink-2"><span>Manual ({s.baselineBasis})</span><span className="font-mono">{fmtMin(s.baselineMinutes)}</span></div><div className="h-2.5 rounded-full bg-surface-3"><div className="h-full rounded-full bg-gold" style={{ width: `${(s.baselineMinutes / max) * 100}%` }} /></div></div>
        <div><div className="mb-0.5 flex justify-between text-ink-2"><span>AI agent + human review</span><span className="font-mono">{fmtMin(ai)}</span></div><div className="flex h-2.5 overflow-hidden rounded-full bg-surface-3"><div className="h-full bg-cyan" style={{ width: `${Math.max(0.5, (s.automatedMinutes / max) * 100)}%` }} title="Automated" /><div className="h-full bg-purple" style={{ width: `${(s.reviewMinutes / max) * 100}%` }} title="Human review" /></div></div>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">Baseline: {s.baselineSource}. {s.hourlyRate != null ? `Rate $${s.hourlyRate.toFixed(2)}/h — ${s.hourlySource}.` : s.hourlySource + "."} {s.countsNote}{synthetic ? "" : " Time saved is capacity, not a payroll cut."}</p>
    </div>
  );
}
