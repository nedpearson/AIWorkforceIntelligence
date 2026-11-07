"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Button, PageHeader } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Approvals, type ApprovalRow } from "../[id]/agent-detail";

export function ApprovalsInbox({ approvals, canApprove }: { approvals: (ApprovalRow & { agentName: string; agentId: string })[]; canApprove: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(""); const [flash, setFlash] = React.useState<{ ok: boolean; text: string } | null>(null);
  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>, okText?: string) => { setBusy(key); const r = await fn(); setBusy(""); setFlash(r.ok ? { ok: true, text: okText ?? "Done" } : { ok: false, text: r.error ?? "failed" }); router.refresh(); return r; };
  const pending = approvals.filter((a) => a.status === "pending").length;
  return (
    <div>
      <PageHeader title="Approvals inbox" subtitle={`${pending} waiting across all agents. Approving resumes the run; rejecting cancels it.`} actions={<Button variant="secondary" href="/app/agents"><ChevronLeft size={15} />All agents</Button>} />
      {flash && <div className={cn("mb-3 rounded-lg px-3 py-2 text-xs", flash.ok ? "bg-money-soft text-money" : "bg-danger-soft text-danger")} role="status" data-testid="inbox-flash">{flash.text}</div>}
      <Approvals approvals={approvals} canApprove={canApprove} act={act} busy={busy} showAgent />
    </div>
  );
}
