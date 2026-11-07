"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, X, RotateCcw, PauseCircle, SearchCheck } from "lucide-react";
import { Button } from "@/components/ui";
import { decideOpportunity, type Decision } from "@/app/app/opportunities/actions";

const LABEL: Record<Exclude<Decision, "review">, string> = { approve: "Approve", reject: "Reject", postpone: "Postpone", request_analysis: "Request additional analysis", reopen: "Reopen" };

/**
 * Executive decision buttons. Rendered only for roles with opportunities:write.
 * `full` adds Postpone / Request additional analysis and a decision note (the detail page's decision bar).
 */
export function OpportunityActions({ id, status, size = "sm", full = false }: { id: string; status: string; size?: "sm" | "md"; full?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null); const [err, setErr] = React.useState(""); const [note, setNote] = React.useState("");
  async function run(action: Exclude<Decision, "review">) {
    setBusy(action); setErr("");
    const r = await decideOpportunity({ id, action, note: note.trim() || undefined });
    setBusy(null); if (!r.ok) { setErr(r.error); return; }
    setNote(""); router.refresh();
  }
  const locked = ["in_progress", "deployed", "verified"].includes(status);
  if (locked) return <span className="text-[11px] text-ink-3">Managed by its agent</span>;
  const canReopen = ["rejected", "approved", "postponed", "analysis_requested"].includes(status);
  const buttons = (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={`opp-actions-${id}`}>
      {status !== "approved" && <Button size={size} variant="primary" loading={busy === "approve"} onClick={() => run("approve")} data-testid={`opp-approve-${id}`}><Check size={13} />{LABEL.approve}</Button>}
      {status !== "rejected" && <Button size={size} variant="secondary" loading={busy === "reject"} onClick={() => run("reject")} data-testid={`opp-reject-${id}`}><X size={13} />{LABEL.reject}</Button>}
      {full && status !== "postponed" && <Button size={size} variant="secondary" loading={busy === "postpone"} onClick={() => run("postpone")} data-testid={`opp-postpone-${id}`}><PauseCircle size={13} />{LABEL.postpone}</Button>}
      {full && status !== "analysis_requested" && <Button size={size} variant="secondary" loading={busy === "request_analysis"} onClick={() => run("request_analysis")} data-testid={`opp-analysis-${id}`}><SearchCheck size={13} />{LABEL.request_analysis}</Button>}
      {canReopen && <Button size={size} variant="ghost" loading={busy === "reopen"} onClick={() => run("reopen")} data-testid={`opp-reopen-${id}`}><RotateCcw size={13} />{LABEL.reopen}</Button>}
      {err && <span className="text-[11px] text-coral-ink" role="alert">{err}</span>}
    </div>
  );
  if (!full) return buttons;
  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-ink-2" htmlFor={`opp-note-${id}`}>Decision note <span className="font-normal text-ink-3">(recorded in the decision history and audit log)</span></label>
      <textarea id={`opp-note-${id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} placeholder="Why this decision? e.g. waiting for the NetSuite upgrade in Q1" data-testid={`opp-note-${id}`}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-royal focus:outline-none" />
      {buttons}
    </div>
  );
}
