"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button, Input, Modal, Select, Textarea, Tooltip } from "@/components/ui";
import { submitSavingsEntry } from "@/app/app/savings/actions";
import type { LinkOptions } from "@/app/app/savings/lib";

const TIERS = [
  { key: "approved", label: "Approved business case", help: "Finance has approved the case for implementation. No evidence required, but it is still an estimate." },
  { key: "cost_avoidance", label: "Cost avoidance", help: "A future expense that will not happen (e.g. a requisition not opened). Requires evidence." },
  { key: "realized_hard", label: "Realized hard savings", help: "A confirmed reduction in an actual expense line (overtime, contractors, vendor fees, payroll). Requires evidence." },
] as const;
const EVIDENCE_KINDS = ["invoice", "gl_report", "payroll_report", "vendor_contract", "headcount_plan", "purchase_order", "timesheet", "approval_email", "other"];
type Ev = { kind: string; ref: string; note: string };

export function SubmitEntryModal({ open, onClose, options, preset }: { open: boolean; onClose: () => void; options: LinkOptions; preset?: { tier?: string; opportunityId?: string } }) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const blank = React.useCallback(() => ({ tier: preset?.tier ?? "realized_hard", title: "", annualAmount: "", hoursPerYear: "", opportunityId: preset?.opportunityId ?? "", projectId: "", agentId: "", workflowId: "", effectiveFrom: today, calculationNote: "" }), [preset, today]);
  const [f, setF] = React.useState(blank);
  const [ev, setEv] = React.useState<Ev[]>([{ kind: "invoice", ref: "", note: "" }]);
  const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setF(blank()); setErr(null); setEv([{ kind: "invoice", ref: "", note: "" }]); } }, [open, blank]);
  const set = (k: keyof ReturnType<typeof blank>) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const needsEvidence = f.tier !== "approved";
  const evOk = ev.some((e) => e.kind && e.ref.trim());
  // Picking an opportunity pre-fills its workflow (the de-duplication key).
  const onOpp = (e: React.ChangeEvent<HTMLSelectElement>) => { const o = options.opportunities.find((x) => x.id === e.target.value); setF((x) => ({ ...x, opportunityId: e.target.value, workflowId: o?.workflowId ?? x.workflowId })); };

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    if (needsEvidence && !evOk) { setErr("Cost avoidance and realized hard savings require at least one evidence item (kind + reference)."); return; }
    setBusy(true);
    try {
      const r = await submitSavingsEntry({ ...f, evidence: ev.filter((x) => x.kind && x.ref.trim()).map((x) => ({ kind: x.kind, ref: x.ref, note: x.note || undefined })) });
      if (!r.ok) setErr(r.error); else { onClose(); router.refresh(); }
    } finally { setBusy(false); }
  }
  const tierHelp = TIERS.find((t) => t.key === f.tier)?.help;
  return (
    <Modal open={open} onClose={onClose} title="Submit a savings entry" wide>
      <form onSubmit={submit} className="space-y-4" data-testid="ledger-submit-form">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Select label="Tier" value={f.tier} onChange={set("tier")} data-testid="ledger-tier" required>{TIERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select>
            {tierHelp && <p className="mt-1 text-[11px] text-ink-3">{tierHelp}</p>}
          </div>
          <Input label="Title" value={f.title} onChange={set("title")} placeholder="e.g. AP overtime eliminated after invoice agent" required minLength={3} maxLength={200} data-testid="ledger-title" />
          <Input label="Annual amount (USD)" type="number" min={0} step="0.01" inputMode="decimal" value={f.annualAmount} onChange={set("annualAmount")} required data-testid="ledger-amount" />
          <Input label="Hours per year (optional)" type="number" min={0} step="0.1" value={f.hoursPerYear} onChange={set("hoursPerYear")} hint="Hours converted from verified time — reduces capacity released" data-testid="ledger-hours" />
          <Select label="Opportunity" value={f.opportunityId} onChange={onOpp} data-testid="ledger-opportunity"><option value="">— none —</option>{options.opportunities.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
          <Select label="Workflow (de-duplication key)" value={f.workflowId} onChange={set("workflowId")} data-testid="ledger-workflow"><option value="">— none —</option>{options.workflows.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
          <Select label="Project" value={f.projectId} onChange={set("projectId")} data-testid="ledger-project" disabled={!options.projects.length}><option value="">{options.projects.length ? "— none —" : "No projects yet"}</option>{options.projects.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
          <Select label="Agent" value={f.agentId} onChange={set("agentId")} data-testid="ledger-agent" disabled={!options.agents.length}><option value="">{options.agents.length ? "— none —" : "No agents yet"}</option>{options.agents.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
          <Input label="Effective from" type="date" value={f.effectiveFrom} onChange={set("effectiveFrom")} required data-testid="ledger-effective" />
        </div>
        <fieldset className="rounded-xl border border-border p-3">
          <legend className="px-1 text-xs font-semibold text-ink-2">Evidence {needsEvidence ? <span className="text-coral-ink">(required)</span> : <span className="text-ink-3">(optional)</span>} <Tooltip text="Point finance to the record that proves the saving: a GL report, invoice, payroll report or vendor contract. Reference = document number, URL or file location." /></legend>
          <div className="space-y-2">
            {ev.map((x, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[10rem_1fr_1fr_auto]">
                <Select aria-label={`Evidence ${i + 1} kind`} value={x.kind} onChange={(e) => setEv((a) => a.map((y, j) => (j === i ? { ...y, kind: e.target.value } : y)))} data-testid={`ledger-ev-kind-${i}`}>{EVIDENCE_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}</Select>
                <Input aria-label={`Evidence ${i + 1} reference`} placeholder="Reference (doc #, URL, path)" value={x.ref} onChange={(e) => setEv((a) => a.map((y, j) => (j === i ? { ...y, ref: e.target.value } : y)))} data-testid={`ledger-ev-ref-${i}`} />
                <Input aria-label={`Evidence ${i + 1} note`} placeholder="Note (optional)" value={x.note} onChange={(e) => setEv((a) => a.map((y, j) => (j === i ? { ...y, note: e.target.value } : y)))} data-testid={`ledger-ev-note-${i}`} />
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove evidence ${i + 1}`} onClick={() => setEv((a) => a.filter((_, j) => j !== i))} disabled={ev.length === 1} data-testid={`ledger-ev-remove-${i}`}><Trash2 size={14} /></Button>
              </div>
            ))}
          </div>
          <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => setEv((a) => [...a, { kind: "other", ref: "", note: "" }])} data-testid="ledger-ev-add"><Plus size={14} />Add evidence</Button>
        </fieldset>
        <Textarea label="Calculation note" rows={3} value={f.calculationNote} onChange={set("calculationNote")} placeholder="e.g. Overtime Jan–Mar avg $6,200/mo → Apr–Jun avg $2,050/mo; $4,150 × 12" data-testid="ledger-calc" />
        <p className="text-[11px] text-ink-3">Time saved is not a payroll reduction. Only claim realized hard savings when an actual expense line went down; staffing changes require management and HR/legal review.</p>
        {err && <p role="alert" className="rounded-lg bg-coral-soft px-3 py-2 text-xs font-medium text-coral-ink" data-testid="ledger-submit-error">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} data-testid="ledger-cancel">Cancel</Button>
          <Button type="submit" loading={busy} data-testid="ledger-submit">Submit for approval</Button>
        </div>
      </form>
    </Modal>
  );
}
