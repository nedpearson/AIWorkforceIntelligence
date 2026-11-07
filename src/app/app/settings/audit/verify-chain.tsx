"use client";
import * as React from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui";
import { verifyAuditChainAction } from "./actions";

type R = Awaited<ReturnType<typeof verifyAuditChainAction>>;
/** Read-only: recomputes this organization's audit hash chain on the server and shows the result. */
export function VerifyChain() {
  const [r, setR] = React.useState<R | null>(null); const [busy, setBusy] = React.useState(false);
  async function run() { setBusy(true); try { setR(await verifyAuditChainAction()); } finally { setBusy(false); } }
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" data-testid="audit-chain">
      <Button size="sm" variant="secondary" loading={busy} onClick={run} data-testid="audit-verify-chain">Verify audit chain</Button>
      {r && (r.ok
        ? <span className="flex items-center gap-1 text-money" role="status" data-testid="audit-chain-result"><ShieldCheck size={14} />Chain intact: {r.checked.toLocaleString("en-US")} entries verified{r.legacy ? `, ${r.legacy.toLocaleString("en-US")} older entries predate hashing` : ""}.</span>
        : <span className="flex items-center gap-1 text-danger" role="alert" data-testid="audit-chain-result"><ShieldAlert size={14} />{"error" in r && r.error ? r.error : `Chain broken at entry #${r.firstBreak?.id} (${r.firstBreak?.reason === "hash_mismatch" ? "entry was modified" : "an entry before it was removed or inserted"}) after ${r.checked} intact entries.`}</span>)}
    </div>
  );
}
