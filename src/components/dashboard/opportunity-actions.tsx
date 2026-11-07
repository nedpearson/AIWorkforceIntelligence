"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, X, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui";
import { setOpportunityStatus } from "@/app/app/opportunities/actions";

/** Approve / Reject / Reopen buttons. Rendered only for roles with opportunities:write. */
export function OpportunityActions({ id, status, size = "sm" }: { id: string; status: string; size?: "sm" | "md" }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null); const [err, setErr] = React.useState("");
  async function run(action: "approve" | "reject" | "reopen") {
    setBusy(action); setErr("");
    const r = await setOpportunityStatus({ id, action });
    setBusy(null); if (!r.ok) { setErr(r.error); return; }
    router.refresh();
  }
  const locked = ["in_progress", "deployed", "verified"].includes(status);
  if (locked) return <span className="text-[11px] text-ink-3">Managed by its agent</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={`opp-actions-${id}`}>
      {status !== "approved" && <Button size={size} variant="primary" loading={busy === "approve"} onClick={() => run("approve")} data-testid={`opp-approve-${id}`}><Check size={13} />Approve</Button>}
      {status !== "rejected" && <Button size={size} variant="secondary" loading={busy === "reject"} onClick={() => run("reject")} data-testid={`opp-reject-${id}`}><X size={13} />Reject</Button>}
      {(status === "rejected" || status === "approved") && <Button size={size} variant="ghost" loading={busy === "reopen"} onClick={() => run("reopen")} data-testid={`opp-reopen-${id}`}><RotateCcw size={13} />Reopen</Button>}
      {err && <span className="text-[11px] text-danger" role="alert">{err}</span>}
    </div>
  );
}
