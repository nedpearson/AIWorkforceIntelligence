"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, Camera, Presentation, ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { Button, Card, Empty, Input, Modal, PageHeader, Select, Table, Td, Th, Tooltip } from "@/components/ui";
import { CheckRow, Drawer, Meter, ScoreRing, SectionHeader, StatusPill, ExportButton } from "@/components/ui/enterprise";
import type { Dimension, DimensionKey, Evaluation, EvaluationSnapshot } from "@/engine/evaluation";
import { fmtNum, fmtUSD, cn } from "@/lib/utils";
import { saveEvaluationSnapshot, setEvaluationStatus } from "./actions";

export type SnapshotRow = { id: string; name: string; status: string; createdAt: string; snapshot: EvaluationSnapshot };
const CONF: Record<string, string> = { high: "bg-emerald-soft text-emerald-ink", medium: "bg-gold-soft text-gold-ink", low: "bg-coral-soft text-coral-ink", none: "bg-surface-2 text-ink-3" };
const fmtInput = (v: number | string, unit?: string) => (typeof v === "string" ? v : unit === "usd" ? fmtUSD(v) : unit === "%" ? `${fmtNum(v, 1)}%` : `${fmtNum(v, 2)}${unit && unit !== "/100" ? ` ${unit}` : unit ?? ""}`);

function Delta({ v, money, hours }: { v: number | null; money?: boolean; hours?: boolean }) {
  if (v == null) return <span className="text-ink-3">n/a</span>;
  const I = Math.abs(v) < 0.05 ? Minus : v > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={cn("inline-flex items-center gap-0.5 tabular font-semibold", Math.abs(v) < 0.05 ? "text-ink-3" : v > 0 ? "text-emerald-ink" : "text-coral-ink")}><I size={13} />{money ? fmtUSD(v) : hours ? `${fmtNum(v, 1)} h` : fmtNum(v, 1)}</span>;
}

function DimensionDrawer({ d, onClose }: { d: Dimension | null; onClose: () => void }) {
  if (!d) return null;
  return (
    <Drawer open onClose={onClose} title={d.label} testid={`dim-drawer-${d.key}`}>
      <div className="flex items-center gap-4"><ScoreRing score={d.score ?? 0} size={88} label={d.score == null ? "No data" : "Score"} /><div className="text-sm text-ink-2">{d.description}<div className="mt-1 text-xs">Weight in composite: <b className="text-ink">{Math.round(d.weight * 100)}%</b></div></div></div>
      <h3 className="mb-1 mt-5 text-sm font-bold">Inputs (actual values)</h3>
      <dl className="divide-y divide-border rounded-xl border border-border text-sm">{d.inputs.map((i) => <div key={i.label} className="flex justify-between gap-3 px-3 py-2"><dt className="text-ink-2">{i.label}</dt><dd className="tabular font-semibold">{fmtInput(i.value, i.unit)}</dd></div>)}</dl>
      <h3 className="mb-1 mt-5 text-sm font-bold">Methodology</h3>
      <p className="rounded-xl bg-surface-2 px-3 py-2 font-mono text-xs">{d.methodology}</p>
      <h3 className="mb-1 mt-5 text-sm font-bold">Confidence</h3>
      <p className="text-sm"><span className={cn("mr-2 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase", CONF[d.confidence.level])}>{d.confidence.level}</span>{d.confidence.basis}</p>
      <h3 className="mb-1 mt-5 text-sm font-bold">Missing evidence</h3>
      {d.missingEvidence.length ? <ul className="list-disc space-y-1 pl-5 text-sm text-coral-ink">{d.missingEvidence.map((m) => <li key={m}>{m}</li>)}</ul> : <p className="text-sm text-emerald-ink">None — all inputs available.</p>}
      <Button href={d.href} variant="secondary" className="mt-5" data-testid="dim-improve">Where to improve this →</Button>
    </Drawer>
  );
}

export function EvaluationClient({ ev, snapshots, canWrite, canApprove }: { ev: Evaluation; snapshots: SnapshotRow[]; canWrite: boolean; canApprove: boolean }) {
  const router = useRouter();
  const [dim, setDim] = React.useState<DimensionKey | null>(null);
  const [saveOpen, setSaveOpen] = React.useState(false); const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState<string | null>(null);
  const [a, setA] = React.useState(snapshots[0]?.id ?? ""); const [b, setB] = React.useState("now");
  const done = ev.steps.filter((s) => s.done).length;
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => { setBusy(true); setErr(null); try { const r = await fn(); if (!r.ok) setErr(r.error ?? "Failed"); else { after?.(); router.refresh(); } } finally { setBusy(false); } };
  const snapOf = (id: string): { label: string; s: EvaluationSnapshot } | null => id === "now" ? { label: "Now (live)", s: ev.snapshot } : (() => { const r = snapshots.find((x) => x.id === id); return r ? { label: r.name, s: r.snapshot } : null; })();
  const A = snapOf(a), B = snapOf(b);
  const d = (x: number | null | undefined, y: number | null | undefined) => (x == null || y == null ? null : y - x);
  const nextStep = ev.steps.find((s) => !s.done);

  return (
    <div className="min-w-0 space-y-2 [contain:inline-size]" data-testid="evaluation-page">
      <PageHeader hero eyebrow="Command · Business Evaluation" icon={<ClipboardCheck size={22} />} title="Company Transformation Score"
        subtitle="A live, evidence-based evaluation: sixteen steps from company profile to measured results, and a 0–100 score across nine dimensions. Every score shows its inputs, formula, confidence and the evidence still missing."
        actions={<>{canWrite && <Button variant="glass" onClick={() => { setName(`Evaluation ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`); setSaveOpen(true); }} data-testid="eval-save"><Camera size={15} />Save snapshot</Button>}<Button variant="gradient" href="/present" data-testid="eval-present"><Presentation size={15} />Present findings</Button></>} />

      <Card className="p-5 sm:p-6" data-testid="eval-score">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="flex flex-col items-center gap-2 lg:w-56">
            <ScoreRing score={ev.score ?? 0} size={156} label={ev.score == null ? "Not enough data" : "Transformation Score"} sub={`${done} of ${ev.steps.length} steps complete`} />
            <p className="max-w-[14rem] text-center text-[11px] text-ink-3">{ev.scoreMethodology}</p>
          </div>
          <div className="grid flex-1 grid-cols-3 gap-x-2 gap-y-4 sm:grid-cols-5 lg:grid-cols-9" data-testid="eval-dimensions">
            {ev.dimensions.map((x) => (
              <button key={x.key} onClick={() => setDim(x.key)} className="flex flex-col items-center rounded-xl p-1 text-center hover:bg-surface-2" data-testid={`dim-${x.key}`}>
                <ScoreRing score={x.score ?? 0} size={64} accent={x.score == null ? "midnight" : undefined} />
                <span className="mt-1 text-[11px] font-semibold leading-tight">{x.label}</span>
                <span className="text-[10px] text-ink-3">weight {Math.round(x.weight * 100)}% · <span className={cn("rounded px-1", CONF[x.confidence.level])}>{x.confidence.level}</span></span>
                <span className="sr-only">{x.score == null ? " (no data)" : ""}. Open details</span>
              </button>
            ))}
          </div>
        </div>
      </Card>

      <SectionHeader accent="royal" title="Dimension detail" subtitle="Click any row for inputs, methodology, confidence and missing evidence." action={<ExportButton rows={ev.dimensions.map((x) => ({ dimension: x.label, score: x.score == null ? "" : Math.round(x.score), weight: x.weight, confidence: x.confidence.level, methodology: x.methodology, missingEvidence: x.missingEvidence.join("; ") }))} filename="transformation-score" testid="eval-export" />} />
      <Table>
        <thead><tr><Th>Dimension</Th><Th className="w-48">Score</Th><Th className="text-right">Weight</Th><Th>Confidence</Th><Th>Missing evidence</Th></tr></thead>
        <tbody>{ev.dimensions.map((x) => (
          <tr key={x.key} className="cursor-pointer hover:bg-surface-2/50" onClick={() => setDim(x.key)} data-testid={`dim-row-${x.key}`}>
            <Td><button className="text-left font-semibold hover:text-royal-ink" onClick={(e) => { e.stopPropagation(); setDim(x.key); }}>{x.label}</button><div className="hidden max-w-xs text-xs text-ink-3 sm:block">{x.description}</div></Td>
            <Td><div className="flex items-center gap-2"><span className="w-8 tabular font-bold">{x.score == null ? "—" : Math.round(x.score)}</span><Meter value={x.score ?? 0} accent={x.score == null ? "midnight" : x.score >= 70 ? "emerald" : x.score >= 45 ? "gold" : "coral"} label={`${x.label} score`} /></div></Td>
            <Td className="text-right tabular">{Math.round(x.weight * 100)}%</Td>
            <Td><span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase", CONF[x.confidence.level])}>{x.confidence.level}</span></Td>
            <Td className="text-xs">{x.missingEvidence.length ? <span className="text-coral-ink">{x.missingEvidence.length} item{x.missingEvidence.length === 1 ? "" : "s"}</span> : <span className="text-emerald-ink">none</span>}</Td>
          </tr>
        ))}</tbody>
      </Table>

      <SectionHeader accent="cyan" title="Evaluation workflow" subtitle={`${done} of ${ev.steps.length} steps complete — status is computed live from your data.`} action={nextStep ? <Button size="sm" href={nextStep.href} data-testid="eval-next">Next: {nextStep.title} →</Button> : undefined} />
      <Card>
        <div className="mb-4 flex items-center gap-3"><Meter value={ev.progressPct} accent="cyan" label="Evaluation progress" /><span className="tabular text-sm font-bold">{Math.round(ev.progressPct)}%</span></div>
        <ol className="stagger grid gap-2 md:grid-cols-2" data-testid="eval-steps">
          {ev.steps.map((s) => <li key={s.key} data-testid={`step-${s.key}`} data-done={s.done}><CheckRow done={s.done} title={`${s.idx}. ${s.title}`} body={`${s.body} — ${s.evidence}`} href={s.href} cta={s.cta} /></li>)}
        </ol>
      </Card>

      <SectionHeader accent="indigo" title="Snapshots & comparison" subtitle="Freeze the live evaluation to track progress and present it. Compare any two snapshots, or a snapshot against now." />
      {err && <p role="alert" className="rounded-lg bg-coral-soft px-3 py-2 text-xs font-medium text-coral-ink">{err}</p>}
      {!snapshots.length ? <Empty title="No snapshots yet" body="Save a snapshot before presenting findings — it freezes the score, the 16 steps and the savings tiers so later progress can be compared." action={canWrite ? <Button onClick={() => { setName(`Baseline ${new Date().toLocaleDateString("en-US")}`); setSaveOpen(true); }} data-testid="eval-save-empty">Save baseline snapshot</Button> : undefined} /> : (
        <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
          <Table>
            <thead><tr><Th>Snapshot</Th><Th>Status</Th><Th className="text-right">Score</Th><Th className="text-right">Potential</Th><Th className="text-right">Steps</Th><Th aria-label="Actions" /></tr></thead>
            <tbody>{snapshots.map((s) => (
              <tr key={s.id} data-testid={`snap-${s.id}`}>
                <Td><div className="font-semibold">{s.name}</div><div className="text-xs text-ink-3">{new Date(s.createdAt).toLocaleString("en-US")}</div></Td>
                <Td><StatusPill status={s.status} map={{ presented: "purple", approved: "emerald" }} /></Td>
                <Td className="text-right tabular font-bold">{s.snapshot.score == null ? "—" : Math.round(s.snapshot.score)}</Td>
                <Td className="text-right tabular">{fmtUSD(s.snapshot.savings.potential)}</Td>
                <Td className="text-right tabular">{s.snapshot.stepsDone}/{s.snapshot.stepsTotal}</Td>
                <Td className="whitespace-nowrap">{canWrite && s.status === "in_progress" && <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => setEvaluationStatus({ id: s.id, status: "presented" }))} data-testid={`snap-present-${s.id}`}>Mark presented</Button>}{canApprove && s.status === "presented" && <Button size="sm" loading={busy} onClick={() => run(() => setEvaluationStatus({ id: s.id, status: "approved" }))} data-testid={`snap-approve-${s.id}`}>Mark approved</Button>}</Td>
              </tr>
            ))}</tbody>
          </Table>
          <Card data-testid="eval-compare">
            <div className="mb-3 grid grid-cols-2 gap-2">
              <Select label="Compare" value={a} onChange={(e) => setA(e.target.value)} data-testid="compare-a">{snapshots.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}<option value="now">Now (live)</option></Select>
              <Select label="With" value={b} onChange={(e) => setB(e.target.value)} data-testid="compare-b"><option value="now">Now (live)</option>{snapshots.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
            </div>
            {A && B && (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-2"><th className="py-1">Metric</th><th className="py-1 text-right">{A.label.slice(0, 16)}</th><th className="py-1 text-right">{B.label.slice(0, 16)}</th><th className="py-1 text-right">Δ</th></tr></thead>
                <tbody className="divide-y divide-border">
                  <tr><td className="py-1.5 font-semibold">Transformation score</td><td className="text-right tabular">{A.s.score == null ? "—" : fmtNum(A.s.score, 1)}</td><td className="text-right tabular">{B.s.score == null ? "—" : fmtNum(B.s.score, 1)}</td><td className="text-right"><Delta v={d(A.s.score, B.s.score)} /></td></tr>
                  {ev.dimensions.map((x) => <tr key={x.key}><td className="py-1.5 text-ink-2">{x.label}</td><td className="text-right tabular">{A.s.dimensions[x.key] == null ? "—" : fmtNum(A.s.dimensions[x.key] as number, 1)}</td><td className="text-right tabular">{B.s.dimensions[x.key] == null ? "—" : fmtNum(B.s.dimensions[x.key] as number, 1)}</td><td className="text-right"><Delta v={d(A.s.dimensions[x.key], B.s.dimensions[x.key])} /></td></tr>)}
                  {([["potential", "Potential savings"], ["verified", "Verified time savings"], ["realizedHard", "Realized hard"], ["net", "Net savings"]] as const).map(([k, l]) => <tr key={k}><td className="py-1.5 text-ink-2">{l}</td><td className="text-right tabular">{fmtUSD(A.s.savings[k])}</td><td className="text-right tabular">{fmtUSD(B.s.savings[k])}</td><td className="text-right"><Delta v={B.s.savings[k] - A.s.savings[k]} money /></td></tr>)}
                  <tr><td className="py-1.5 text-ink-2">Recoverable hrs/wk</td><td className="text-right tabular">{fmtNum(A.s.hours.recoverablePerWeek, 1)}</td><td className="text-right tabular">{fmtNum(B.s.hours.recoverablePerWeek, 1)}</td><td className="text-right"><Delta v={B.s.hours.recoverablePerWeek - A.s.hours.recoverablePerWeek} hours /></td></tr>
                  <tr><td className="py-1.5 text-ink-2">Verified hrs/yr</td><td className="text-right tabular">{fmtNum(A.s.hours.verifiedPerYear)}</td><td className="text-right tabular">{fmtNum(B.s.hours.verifiedPerYear)}</td><td className="text-right"><Delta v={B.s.hours.verifiedPerYear - A.s.hours.verifiedPerYear} hours /></td></tr>
                  <tr><td className="py-1.5 text-ink-2">Steps complete</td><td className="text-right tabular">{A.s.stepsDone}</td><td className="text-right tabular">{B.s.stepsDone}</td><td className="text-right"><Delta v={B.s.stepsDone - A.s.stepsDone} /></td></tr>
                </tbody>
              </table>
            )}
            <p className="mt-2 text-[11px] text-ink-3">Deltas are later minus earlier as selected. <Tooltip text="Snapshot values are frozen at save time; 'Now' recomputes from live data." /></p>
          </Card>
        </div>
      )}

      <DimensionDrawer d={dim ? ev.dimensions.find((x) => x.key === dim) ?? null : null} onClose={() => setDim(null)} />
      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save evaluation snapshot">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(() => saveEvaluationSnapshot({ name }), () => setSaveOpen(false)); }}>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required minLength={3} maxLength={120} data-testid="snap-name" />
          <p className="text-xs text-ink-2">Freezes the current score ({ev.score == null ? "not enough data" : Math.round(ev.score)}), all 9 dimensions, the 16 steps and the savings tiers. Status starts as “in progress”.</p>
          {err && <p role="alert" className="text-xs text-coral-ink">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setSaveOpen(false)}>Cancel</Button><Button type="submit" loading={busy} data-testid="snap-save-confirm">Save snapshot</Button></div>
        </form>
      </Modal>
    </div>
  );
}
