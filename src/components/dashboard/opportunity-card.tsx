"use client";
import * as React from "react";
import Link from "next/link";
import { Sparkles, ShieldAlert, Scale, Copy } from "lucide-react";
import { Badge, BasisChip, Button, Tooltip } from "@/components/ui";
import { Meter } from "@/components/dashboard/stat-tile";
import { fmtUSD, fmtNum } from "@/lib/utils";

export const OPP_TYPE_LABEL: Record<string, string> = { ai_agent: "AI agent", rpa: "RPA bot", conventional_automation: "Integration", process_change: "Process change", role_consolidation: "Consolidation" };
export const OPP_STATUS_TONE: Record<string, "neutral" | "brand" | "money" | "warn" | "danger" | "info" | "verified" | "projected"> = { identified: "neutral", reviewing: "info", approved: "brand", in_progress: "warn", deployed: "money", verified: "verified", rejected: "danger" };

export type OppCardData = {
  id: string; title: string; summary?: string; type: string; status: string; rank: number; feasibility: number; risk: number;
  hoursRecoverablePerWeek: number; grossAnnualSavings?: number; realizableAnnualSavings: number; implementationCost?: number; paybackMonths: number | null;
  basis: "observed" | "estimated" | "assumed"; deployed?: boolean; requiresHumanJudgment?: boolean; regulatoryFlag?: string | null; duplicate?: boolean;
  departmentName?: string | null; workflowName?: string | null; agent?: { id: string; name: string; status: string } | null;
};

export function OpportunityCard({ o, canAutomate, actions, compact }: { o: OppCardData; canAutomate: boolean; actions?: React.ReactNode; compact?: boolean }) {
  return (
    <div className="card p-4" data-testid={`opp-card-${o.id}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-sm font-semibold text-ink-2" title="Rank">{o.rank || "—"}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={`/app/opportunities/${o.id}`} className="text-sm font-semibold text-ink hover:text-brand hover:underline">{o.title}</Link>
            <Badge tone="neutral">{OPP_TYPE_LABEL[o.type] ?? o.type}</Badge>
            <Badge tone={OPP_STATUS_TONE[o.status] ?? "neutral"}>{o.status.replace("_", " ")}</Badge>
            <BasisChip basis={o.basis} />
            {o.requiresHumanJudgment && <Tooltip text="Some steps need a person's decision (review, approve, dispute…). The agent will pause for approval at those steps."><Badge tone="warn"><Scale size={11} className="mr-1" />judgment</Badge></Tooltip>}
            {o.regulatoryFlag && <Tooltip text={`Touches ${o.regulatoryFlag}-regulated data. Extra review and audit logging apply.`}><Badge tone="danger"><ShieldAlert size={11} className="mr-1" />{o.regulatoryFlag}</Badge></Tooltip>}
            {o.duplicate && <Tooltip text="This workflow overlaps with another one — the same work is being done twice."><Badge tone="info"><Copy size={11} className="mr-1" />duplicate work</Badge></Tooltip>}
          </div>
          {!compact && o.summary && <p className="mt-1 line-clamp-3 text-xs text-ink-2">{o.summary}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-2">
            {o.departmentName && <span>{o.departmentName}</span>}
            {o.workflowName && <span className="truncate">Workflow: {o.workflowName}</span>}
            {o.agent && <Link href={`/app/agents/${o.agent.id}`} className="text-brand hover:underline">Agent: {o.agent.name} ({o.agent.status})</Link>}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            <Meter value={o.feasibility} label="Feasibility" testid={`meter-feas-${o.id}`} />
            <Meter value={o.risk} label="Risk" invert testid={`meter-risk-${o.id}`} />
            <div><div className="text-[10px] text-ink-2">Hrs recoverable/wk</div><div className="tabular text-sm font-semibold text-projected">{fmtNum(o.hoursRecoverablePerWeek, 1)}</div></div>
            <div><div className="text-[10px] text-ink-2">Gross → realizable</div><div className="tabular text-sm font-semibold"><span className="text-ink-3">{o.grossAnnualSavings != null ? fmtUSD(o.grossAnnualSavings, { compact: true }) : "—"}</span> → <span className="text-projected">{fmtUSD(o.realizableAnnualSavings, { compact: true })}</span></div></div>
            <div><div className="text-[10px] text-ink-2">Setup cost</div><div className="tabular text-sm font-semibold">{o.implementationCost != null ? fmtUSD(o.implementationCost, { compact: true }) : "—"}</div></div>
            <div><div className="text-[10px] text-ink-2">Payback</div><div className="tabular text-sm font-semibold">{o.paybackMonths == null ? <span className="text-ink-3">not reached</span> : `${fmtNum(o.paybackMonths, 0)} mo`}</div></div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
          {canAutomate && !o.deployed && !o.agent && o.status !== "rejected" && <Button size="sm" href={`/app/agents/new?opportunityId=${o.id}`} data-testid={`automate-${o.id}`}><Sparkles size={13} />Automate this</Button>}
          {actions}
        </div>
      </div>
    </div>
  );
}
