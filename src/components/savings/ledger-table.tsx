"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, X } from "lucide-react";
import { BasisChip, Button, Empty, Modal, Table, Td, Th, Textarea } from "@/components/ui";
import { StatusPill } from "@/components/ui/enterprise";
import { decideSavingsEntry } from "@/app/app/savings/actions";
import type { LedgerRow } from "@/app/app/savings/lib";
import { fmtNum, fmtUSD } from "@/lib/utils";
import { useTimeZone } from "@/components/time-zone";
import { formatDate } from "@/lib/datetime";

export const TIER_LABEL: Record<LedgerRow["tier"], string> = { approved: "Approved", cost_avoidance: "Cost avoidance", realized_hard: "Realized hard" };
const TIER_TONE: Record<LedgerRow["tier"], string> = { approved: "bg-indigo-soft text-indigo-ink", cost_avoidance: "bg-purple-soft text-purple-ink", realized_hard: "bg-emerald-soft text-emerald-ink" };
const dU = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "—");
const d = (s: string | null, tz: string) => (s ? formatDate(s, tz, { year: "numeric", month: "short", day: "numeric" }) : "—");

export function TierTag({ tier }: { tier: LedgerRow["tier"] }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${TIER_TONE[tier]}`}>{TIER_LABEL[tier]}</span>;
}

function Links({ r }: { r: LedgerRow }) {
  const items = [
    r.opportunity && { href: `/app/opportunities/${r.opportunity.id}`, label: r.opportunity.label, k: "Opp" },
    r.workflow && { href: `/app/workflows/${r.workflow.id}`, label: r.workflow.label, k: "Workflow" },
    r.project && { href: `/app/roadmap?project=${r.project.id}`, label: r.project.label, k: "Project" },
    r.agent && { href: `/app/agents/${r.agent.id}`, label: r.agent.label, k: "Agent" },
  ].filter(Boolean) as { href: string; label: string; k: string }[];
  if (!items.length) return <span className="text-ink-3">—</span>;
  return <div className="flex max-w-[16rem] flex-col gap-0.5">{items.map((i) => <Link key={i.href} href={i.href} className="truncate text-xs text-royal-ink hover:underline" title={i.label}><span className="text-ink-3">{i.k}:</span> {i.label}</Link>)}</div>;
}

/** Approve / reject with reason. Warns (does not block) when the approver submitted the entry — segregation of duties. */
export function DecideModal({ entry, mode, meId, onClose }: { entry: LedgerRow | null; mode: "approve" | "reject"; meId: string; onClose: () => void }) {
  const tz = useTimeZone();
  const router = useRouter();
  const [reason, setReason] = React.useState(""); const [busy, setBusy] = React.useState(false); const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => { setReason(""); setErr(null); }, [entry, mode]);
  if (!entry) return null;
  const self = entry.submittedById === meId;
  const missingEvidence = entry.tier !== "approved" && entry.evidence.length === 0;
  async function go() {
    setBusy(true); setErr(null);
    try { const r = await decideSavingsEntry({ id: entry!.id, decision: mode, reason: reason || undefined }); if (!r.ok) setErr(r.error); else { onClose(); router.refresh(); } } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={mode === "approve" ? "Approve savings entry" : "Reject savings entry"}>
      <div className="space-y-3" data-testid="ledger-decide-modal">
        <div className="rounded-xl bg-surface-2 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2"><TierTag tier={entry.tier} /><span className="font-semibold">{entry.title}</span></div>
          <div className="mt-1 tabular text-lg font-bold">{fmtUSD(entry.annualAmount)}<span className="text-xs font-medium text-ink-2"> / yr{entry.hoursPerYear != null ? ` · ${fmtNum(entry.hoursPerYear)} hrs/yr` : ""}</span></div>
          <div className="mt-1 text-xs text-ink-2">Submitted by {entry.submittedBy ?? "—"} on {d(entry.createdAt, tz)} · effective {dU(entry.effectiveFrom)}</div>
          <ul className="mt-2 space-y-0.5 text-xs">{entry.evidence.length ? entry.evidence.map((e, i) => <li key={i}><span className="font-semibold capitalize">{e.kind.replace(/_/g, " ")}</span>: {e.ref}{e.note ? <span className="text-ink-3"> — {e.note}</span> : null}</li>) : <li className="text-ink-3">No evidence attached</li>}</ul>
        </div>
        {self && mode === "approve" && (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-gold/40 bg-gold-soft px-3 py-2 text-xs text-gold-ink" data-testid="ledger-sod-warning">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span><b>Segregation of duties:</b> you submitted this entry. Approving your own claim is recorded in the audit log and flagged in the reconciliation panel. Ask another owner or admin to approve it if possible.</span>
          </div>
        )}
        {missingEvidence && mode === "approve" && <p role="alert" className="rounded-lg bg-coral-soft px-3 py-2 text-xs font-medium text-coral-ink">This entry has no evidence. Approving it will fail the evidence reconciliation check.</p>}
        <Textarea label={mode === "reject" ? "Reason (required)" : "Note (optional)"} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="ledger-decide-reason" required={mode === "reject"} />
        {err && <p role="alert" className="rounded-lg bg-coral-soft px-3 py-2 text-xs font-medium text-coral-ink" data-testid="ledger-decide-error">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} data-testid="ledger-decide-cancel">Cancel</Button>
          <Button variant={mode === "approve" ? "primary" : "danger"} loading={busy} onClick={go} disabled={mode === "reject" && reason.trim().length < 3} data-testid="ledger-decide-confirm">{mode === "approve" ? (self ? "Approve anyway" : "Approve") : "Reject"}</Button>
        </div>
      </div>
    </Modal>
  );
}

export function LedgerTable({ rows, canApprove, meId, onOpen, onDecide }: { rows: LedgerRow[]; canApprove: boolean; meId: string; onOpen: (r: LedgerRow) => void; onDecide: (r: LedgerRow, m: "approve" | "reject") => void }) {
  const tz = useTimeZone();
  if (!rows.length) return <Empty title="No ledger entries match" body="Entries record approved business cases, cost avoidance and realized hard savings. Submit one when finance confirms a saving." />;
  return (
    <Table>
      <thead><tr><Th>Tier</Th><Th>Status</Th><Th>Title</Th><Th className="text-right">Annual $</Th><Th className="text-right">Hrs/yr</Th><Th>Linked to</Th><Th>Evidence</Th><Th>Submitted</Th><Th>Decided</Th><Th>Effective</Th>{canApprove && <Th aria-label="Actions" />}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-surface-2/50" data-testid={`ledger-row-${r.id}`}>
            <Td><TierTag tier={r.tier} /></Td>
            <Td><StatusPill status={r.status} /></Td>
            <Td><button className="max-w-[16rem] truncate text-left font-semibold text-ink hover:text-royal-ink hover:underline" onClick={() => onOpen(r)} title={r.title} data-testid={`ledger-open-${r.id}`}>{r.title}</button><div className="mt-0.5"><BasisChip basis={r.basis} /></div></Td>
            <Td className="text-right tabular font-semibold">{fmtUSD(r.annualAmount)}</Td>
            <Td className="text-right tabular">{r.hoursPerYear != null ? fmtNum(r.hoursPerYear) : "—"}</Td>
            <Td><Links r={r} /></Td>
            <Td>{r.evidence.length ? <span className="text-xs" title={r.evidence.map((e) => `${e.kind}: ${e.ref}`).join("\n")}>{r.evidence.length} · {[...new Set(r.evidence.map((e) => e.kind.replace(/_/g, " ")))].join(", ")}</span> : <span className={r.tier === "approved" ? "text-xs text-ink-3" : "text-xs font-semibold text-coral-ink"}>none</span>}</Td>
            <Td className="whitespace-nowrap text-xs">{r.submittedBy ?? "—"}<div className="text-ink-3">{d(r.createdAt, tz)}</div></Td>
            <Td className="whitespace-nowrap text-xs">{r.approvedBy ? <>{r.approvedBy}{r.approvedById === r.submittedById && <span className="ml-1 rounded bg-gold-soft px-1 text-[10px] font-semibold text-gold-ink" title="Approved by the submitter">SoD</span>}<div className="text-ink-3">{d(r.approvedAt, tz)}</div></> : "—"}{r.rejectionReason && <div className="max-w-[12rem] truncate text-coral-ink" title={r.rejectionReason}>{r.rejectionReason}</div>}</Td>
            <Td className="whitespace-nowrap text-xs">{dU(r.effectiveFrom)}{r.effectiveTo && <div className="text-ink-3">to {dU(r.effectiveTo)}</div>}</Td>
            {canApprove && <Td className="whitespace-nowrap">{r.status === "submitted" ? <div className="flex gap-1"><Button size="sm" onClick={() => onDecide(r, "approve")} data-testid={`ledger-approve-${r.id}`} aria-label={`Approve ${r.title}`}><Check size={13} />Approve</Button><Button size="sm" variant="secondary" onClick={() => onDecide(r, "reject")} data-testid={`ledger-reject-${r.id}`} aria-label={`Reject ${r.title}`}><X size={13} />Reject</Button></div> : null}</Td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
