"use client";
/**
 * SkillRunnerPanel — pick a synthetic sample or paste/upload real input → run (sandbox, or live when the caller and the AI
 * employee allow it) → watch the DemoPlayer → approve/reject a waiting action → leave feedback. All permission checks are
 * repeated server-side; the flags passed in only decide what is shown.
 */
import * as React from "react";
import { Play, ShieldCheck, Upload, MessageSquareText, Lock } from "lucide-react";
import type { SkillMeta, SkillResult } from "@/engine/skills";
import { Badge, Button, Select, Textarea } from "@/components/ui";
import { Segmented } from "@/components/ui/enterprise";
import { DemoPlayer } from "./demo-player";
import { cn } from "@/lib/utils";

export type SkillRunnerPanelProps = {
  aiEmployeeId: string; employeeName: string; skills: SkillMeta[];
  /** caller may run live (agents:write) AND employee status is pilot/active — re-checked server-side */
  canRunLive: boolean; liveDisabledReason?: string;
  /** caller has agents:approve; elevated (over-threshold) approvals need owner/admin */
  canApprove: boolean; canApproveElevated: boolean; canReview: boolean;
  permissionLevel: string; defaultSkill?: string; testid?: string;
};
type Pending = { reasons: string[]; approverRole: string; elevated: boolean; requestedAction: string };

const strip = (input: unknown) => { if (input && typeof input === "object") { const { sampleKey: _s, ...rest } = input as Record<string, unknown>; void _s; return rest; } return input; };

export function SkillRunnerPanel({ aiEmployeeId, employeeName, skills, canRunLive, liveDisabledReason, canApprove, canApproveElevated, canReview, permissionLevel, defaultSkill, testid = "skill-runner" }: SkillRunnerPanelProps) {
  const [skillKey, setSkillKey] = React.useState(defaultSkill && skills.some((s) => s.key === defaultSkill) ? defaultSkill : skills[0]?.key ?? "");
  const skill = skills.find((s) => s.key === skillKey);
  const [mode, setMode] = React.useState<"sandbox" | "live">("sandbox");
  const [source, setSource] = React.useState<"sample" | "paste">("sample");
  const [sampleKey, setSampleKey] = React.useState(skill?.samples[0]?.key ?? "");
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<{ name: string; mimeType: string; dataBase64: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<SkillResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [played, setPlayed] = React.useState(false);
  const isInvoice = skillKey === "process_invoice";

  React.useEffect(() => { setSampleKey(skill?.samples[0]?.key ?? ""); setText(""); setFile(null); setResult(null); setError(null); }, [skillKey]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (mode === "live") setSource("paste"); }, [mode]);
  React.useEffect(() => {
    if (source !== "paste" || text) return;
    const s = skill?.samples.find((x) => x.key === sampleKey) ?? skill?.samples[0];
    if (!s) return;
    setText(isInvoice ? "" : JSON.stringify(strip(s.input), null, 2));
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildInput = (): { ok: true; input: unknown } | { ok: false; error: string } => {
    if (source === "sample") { const s = skill?.samples.find((x) => x.key === sampleKey); return s ? { ok: true, input: s.input } : { ok: false, error: "Choose a sample" }; }
    if (isInvoice) { if (file) return { ok: true, input: { file } }; if (text.trim().length < 20) return { ok: false, error: "Paste the invoice text or upload a text/PDF file." }; return { ok: true, input: { text } }; }
    try { return { ok: true, input: JSON.parse(text) }; } catch { return { ok: false, error: "Input must be valid JSON — start from the sample and edit it." }; }
  };

  async function run() {
    const b = buildInput(); if (!b.ok) { setError(b.error); return; }
    setBusy(true); setError(null); setResult(null); setPlayed(false);
    try {
      const res = await fetch("/api/skills/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aiEmployeeId, skillKey, mode, input: b.input }) });
      const j = await res.json();
      if (!res.ok && !j.steps) throw new Error(j.error ?? `Run failed (${res.status})`);
      setResult(j as SkillResult); if (!j.ok && j.error) setError(j.error);
    } catch (e) { setError(e instanceof Error ? e.message : "Run failed"); }
    finally { setBusy(false); }
  }

  async function onFile(f: File | undefined) {
    if (!f) { setFile(null); return; }
    if (f.size > 5 * 1024 * 1024) { setError("File too large (5 MB max)"); return; }
    const buf = await f.arrayBuffer(); let bin = ""; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    setFile({ name: f.name, mimeType: f.type || (f.name.endsWith(".pdf") ? "application/pdf" : "text/plain"), dataBase64: btoa(bin) }); setError(null);
  }

  const pending = (result?.status === "awaiting_approval" ? (result.output.approval as Pending | undefined) : undefined) ?? null;

  return (
    <div className="space-y-4" data-testid={testid}>
      <div className="card space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2"><h3 className="text-sm font-semibold text-ink">Run a skill</h3><Badge tone="purple">AI Agent</Badge></div>
          <span className="text-xs text-ink-2">Permission: <span className="font-semibold text-ink">{permissionLevel.replace(/_/g, " ")}</span></span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {skills.length > 1 ? (
            <Select label="Skill" value={skillKey} onChange={(e) => setSkillKey(e.target.value)} data-testid={`${testid}-skill`}>
              {skills.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </Select>
          ) : <div><span className="mb-1 block text-xs font-medium text-ink-2">Skill</span><p className="text-sm font-semibold text-ink">{skill?.name}</p></div>}
          <div>
            <span className="mb-1 block text-xs font-medium text-ink-2" id={`${testid}-mode-label`}>Mode</span>
            <div className="flex flex-wrap items-center gap-2" aria-labelledby={`${testid}-mode-label`}>
              <Segmented options={[{ key: "sandbox", label: "Sandbox" }, { key: "live", label: <span className="inline-flex items-center gap-1">{!canRunLive && <Lock className="h-3 w-3" aria-hidden />}Live</span> }]} value={mode} onChange={(k) => { if (k === "live" && !canRunLive) return; setMode(k); }} testid={`${testid}-mode`} size="sm" />
              {!canRunLive && <span className="text-[11px] text-ink-3">{liveDisabledReason ?? "Live runs need agents:write and a pilot/active AI employee."}</span>}
            </div>
          </div>
        </div>
        {skill && <p className="text-xs leading-relaxed text-ink-2">{skill.description}</p>}

        {mode === "sandbox" && (
          <Segmented options={[{ key: "sample", label: "Synthetic sample" }, { key: "paste", label: isInvoice ? "Paste or upload" : "Edit input" }]} value={source} onChange={setSource} testid={`${testid}-source`} size="sm" />
        )}
        {source === "sample" && mode === "sandbox" ? (
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Synthetic samples">
            {skill?.samples.map((s) => (
              <button key={s.key} type="button" role="radio" aria-checked={sampleKey === s.key} onClick={() => setSampleKey(s.key)} data-testid={`${testid}-sample-${s.key}`}
                className={cn("rounded-xl border p-3 text-left transition", sampleKey === s.key ? "border-purple bg-purple-soft" : "border-border bg-surface hover:bg-surface-2")}>
                <span className="block text-xs font-semibold text-ink">{s.label}</span>{s.description && <span className="mt-0.5 block text-[11px] text-ink-2">{s.description}</span>}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <Textarea label={isInvoice ? "Invoice text" : "Input (JSON)"} rows={isInvoice ? 8 : 10} value={text} onChange={(e) => { setText(e.target.value); if (e.target.value) setFile(null); }} placeholder={isInvoice ? "Paste the invoice text exactly as received…" : "{ … }"} className="font-mono text-xs" data-testid={`${testid}-input`} />
            {isInvoice && (
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-ink-2 hover:bg-surface-2">
                <Upload className="h-3.5 w-3.5" aria-hidden /> {file ? `${file.name} attached` : "Or upload a text-based PDF / .txt (5 MB max)"}
                <input type="file" accept=".pdf,.txt,application/pdf,text/plain" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} data-testid={`${testid}-file`} />
              </label>
            )}
            {mode === "live" && <p className="text-[11px] text-ink-3">Live runs use your real data and obey the AI employee&apos;s permission level ({permissionLevel.replace(/_/g, " ")}). Consequential actions wait for a person&apos;s approval.</p>}
          </div>
        )}
        {error && <p role="alert" className="rounded-lg bg-coral-soft px-3 py-2 text-xs text-coral-ink" data-testid={`${testid}-error`}>{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={run} loading={busy} variant="gradient" data-testid={`${testid}-run`}><Play className="h-4 w-4" aria-hidden />{mode === "sandbox" ? "Run demonstration" : "Run on live data"}</Button>
          {skill && <span className="text-[11px] text-ink-3">Manual baseline {skill.manualBaselineMinutes} min (assumption) · review {skill.reviewMinutes} min</span>}
        </div>
      </div>

      <DemoPlayer result={result} running={busy} skillName={skill?.name} employeeName={employeeName} onComplete={() => setPlayed(true)} testid={`${testid}-player`} />

      {result && played && pending && (
        <ApprovalCard runId={result.skillRunId!} pending={pending} canApprove={canApprove && (!pending.elevated || canApproveElevated)} onDecided={(r) => setResult(r)} testid={`${testid}-approval`} />
      )}
      {result && played && result.skillRunId && canReview && result.status !== "awaiting_approval" && !(result.output as { blocked?: string }).blocked && (
        <ReviewCard runId={result.skillRunId} employeeName={employeeName} testid={`${testid}-review`} />
      )}
    </div>
  );
}

function ApprovalCard({ runId, pending, canApprove, onDecided, testid }: { runId: string; pending: Pending; canApprove: boolean; onDecided: (r: SkillResult) => void; testid: string }) {
  const [note, setNote] = React.useState(""); const [confirm, setConfirm] = React.useState(false); const [busy, setBusy] = React.useState<null | "approve" | "reject">(null); const [err, setErr] = React.useState<string | null>(null);
  async function decide(decision: "approve" | "reject") {
    setBusy(decision); setErr(null);
    try { const res = await fetch("/api/skills/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skillRunId: runId, decision, note: note || undefined, confirm: true }) }); const j = await res.json(); if (!res.ok) throw new Error(j.error ?? "Decision failed"); onDecided(j); }
    catch (e) { setErr(e instanceof Error ? e.message : "Decision failed"); } finally { setBusy(null); }
  }
  return (
    <div className="card fade-up space-y-3 border-gold/40 p-4 sm:p-5" data-testid={testid}>
      <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-gold-ink" aria-hidden /><h3 className="text-sm font-semibold text-ink">Approval needed: {pending.requestedAction}</h3></div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-ink-2">{pending.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      <p className="text-[11px] text-ink-3">Approver: {pending.approverRole}{pending.elevated ? " — over the approval threshold, owner or admin only" : ""}.</p>
      {canApprove ? (<>
        <Textarea label="Note (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-testid={`${testid}-note`} />
        <label className="flex items-start gap-2 text-xs text-ink"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" data-testid={`${testid}-confirm`} />I reviewed the extracted details, checks and draft entry above.</label>
        {err && <p role="alert" className="text-xs text-coral-ink">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => decide("approve")} disabled={!confirm} loading={busy === "approve"} data-testid={`${testid}-approve`}>Approve and continue</Button>
          <Button variant="secondary" onClick={() => decide("reject")} loading={busy === "reject"} data-testid={`${testid}-reject`}>Reject</Button>
        </div>
      </>) : <p className="text-xs text-ink-2">You can see this request but your role can&apos;t approve it{pending.elevated ? " (over-threshold approvals need an owner or admin)" : ""}.</p>}
    </div>
  );
}

function ReviewCard({ runId, employeeName, testid }: { runId: string; employeeName: string; testid: string }) {
  const [verdict, setVerdict] = React.useState<"accepted" | "corrected" | "rejected">("accepted");
  const [note, setNote] = React.useState(""); const [improvement, setImprovement] = React.useState(""); const [busy, setBusy] = React.useState(false); const [msg, setMsg] = React.useState<string | null>(null); const [err, setErr] = React.useState<string | null>(null);
  async function submit() {
    setBusy(true); setErr(null);
    try { const res = await fetch("/api/skills/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skillRunId: runId, verdict, note: note || undefined, improvement: improvement || undefined }) }); const j = await res.json(); if (!res.ok) throw new Error(j.error ?? "Could not save"); setMsg(j.memoryPending ? `Saved. The improvement is pending owner/admin approval before ${employeeName} uses it.` : "Feedback saved."); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  if (msg) return <p className="card p-4 text-sm text-emerald-ink" role="status" data-testid={`${testid}-done`}>{msg}</p>;
  return (
    <div className="card space-y-3 p-4 sm:p-5" data-testid={testid}>
      <div className="flex items-center gap-2"><MessageSquareText className="h-4 w-4 text-purple-ink" aria-hidden /><h3 className="text-sm font-semibold text-ink">Review this work</h3></div>
      <Segmented options={[{ key: "accepted", label: "Accept" }, { key: "corrected", label: "Correct" }, { key: "rejected", label: "Reject" }]} value={verdict} onChange={setVerdict} testid={`${testid}-verdict`} size="sm" />
      <Textarea label="What was wrong or right? (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-testid={`${testid}-note`} />
      <Textarea label={`Teach ${employeeName} a better procedure (optional)`} rows={2} value={improvement} onChange={(e) => setImprovement(e.target.value)} placeholder="e.g. Code liftgate fees as freight." data-testid={`${testid}-improvement`} />
      <p className="text-[11px] text-ink-3">Improvements need owner/admin approval before they are used, and can never change permissions, approval steps, budgets or credentials.</p>
      {err && <p role="alert" className="text-xs text-coral-ink">{err}</p>}
      <Button variant="secondary" onClick={submit} loading={busy} data-testid={`${testid}-submit`}>Save review</Button>
    </div>
  );
}
