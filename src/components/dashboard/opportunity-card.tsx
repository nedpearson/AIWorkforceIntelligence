"use client";
import * as React from "react";
import Link from "next/link";
import { Sparkles, ShieldAlert, Scale, Copy, Bot, Layers } from "lucide-react";
import { Badge, BasisChip, Button, Tooltip } from "@/components/ui";
import { Meter } from "@/components/dashboard/stat-tile";
import { StatusPill } from "@/components/ui/enterprise";
import { cn, fmtUSD, fmtNum } from "@/lib/utils";
import { OPP_TYPE_LABEL, OPP_STATUS_TONE, OPP_TYPE_ACCENT } from "./opportunity-meta";

export { OPP_TYPE_LABEL, OPP_STATUS_TONE, OPP_TYPE_ACCENT };


export type OppCardData = {
  id: string; title: string; summary?: string; type: string; status: string; rank: number; feasibility: number; risk: number;
  hoursRecoverablePerWeek: number; grossAnnualSavings?: number; realizableAnnualSavings: number; implementationCost?: number; paybackMonths: number | null;
  basis: "observed" | "estimated" | "assumed"; deployed?: boolean; requiresHumanJudgment?: boolean; regulatoryFlag?: string | null; duplicate?: boolean;
  departmentName?: string | null; workflowName?: string | null; agent?: { id: string; name: string; status: string } | null;
  /** Optional AI Opportunity Center extras (explainable 0–100 score, evidence confidence, recommended solution, overlap). */
  score?: number; confidence?: "High" | "Medium" | "Low"; solution?: string | null; overlapRemoved?: number;
};

const CONF_TONE = { High: "emerald", Medium: "gold", Low: "coral" } as const;
function scoreTone(s: number) { return s >= 65 ? "text-emerald-ink bg-emerald-soft" : s >= 45 ? "text-gold-ink bg-gold-soft" : "text-coral-ink bg-coral-soft"; }

export function OpportunityCard({ o, canAutomate, actions, compact }: { o: OppCardData; canAutomate: boolean; actions?: React.ReactNode; compact?: boolean }) {
  return (
    <div className="card card-hover relative overflow-hidden p-4" data-testid={`opp-card-${o.id}`}>
      <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-gold to-coral opacity-70" aria-hidden />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex shrink-0 items-center gap-2 sm:flex-col">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-midnight text-sm font-bold text-white dark:bg-royal" title="Rank">{o.rank || "—"}</span>
          {o.score != null && <Tooltip text="Explainable opportunity score (0–100) from 8 weighted factors. Open the opportunity for the full breakdown."><span className={cn("rounded-lg px-1.5 py-0.5 text-[11px] font-bold tabular", scoreTone(o.score))} data-testid={`opp-score-${o.id}`}>{Math.round(o.score)}</span></Tooltip>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={`/app/opportunities/${o.id}`} className="text-sm font-semibold text-ink hover:text-royal-ink hover:underline">{o.title}</Link>
            <Badge tone={OPP_TYPE_ACCENT[o.type] ?? "neutral"}>{OPP_TYPE_LABEL[o.type] ?? o.type}</Badge>
            <StatusPill status={o.status} />
            <BasisChip basis={o.basis} />
            {o.confidence && <Tooltip text="Evidence confidence: High = observed basis, ≥ 100 runs and ≥ 80% collector coverage; Medium = ≥ 30 runs and not assumed; otherwise Low."><Badge tone={CONF_TONE[o.confidence]}>{o.confidence} confidence</Badge></Tooltip>}
            {o.requiresHumanJudgment && <Tooltip text="Some steps need a person's decision (review, approve, dispute…). The agent will pause for approval at those steps."><Badge tone="warn"><Scale size={11} className="mr-1" />judgment</Badge></Tooltip>}
            {o.regulatoryFlag && <Tooltip text={`Touches ${o.regulatoryFlag}-regulated data. Extra review and audit logging apply.`}><Badge tone="danger"><ShieldAlert size={11} className="mr-1" />{o.regulatoryFlag}</Badge></Tooltip>}
            {o.duplicate && <Tooltip text="This workflow overlaps with another one — the same work is being done twice."><Badge tone="info"><Copy size={11} className="mr-1" />duplicate work</Badge></Tooltip>}
            {!!o.overlapRemoved && o.overlapRemoved > 0.5 && <Tooltip text={`${fmtUSD(o.overlapRemoved)}/yr removed because another opportunity targets the same workflow (never double counted).`}><Badge tone="neutral"><Layers size={11} className="mr-1" />overlap adjusted</Badge></Tooltip>}
          </div>
          {!compact && o.summary && <p className="mt-1 line-clamp-2 text-xs text-ink-2">{o.summary}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-2">
            {o.departmentName && <span>{o.departmentName}</span>}
            {o.workflowName && <span className="truncate">Workflow: {o.workflowName}</span>}
            {o.solution && !o.agent && <span className="inline-flex items-center gap-1 text-purple-ink"><Bot size={12} />{o.solution}</span>}
            {o.agent && <Link href={`/app/agents/${o.agent.id}`} className="text-royal-ink hover:underline">Agent: {o.agent.name} ({o.agent.status})</Link>}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            <Meter value={o.feasibility} label="Feasibility" testid={`meter-feas-${o.id}`} />
            <Meter value={o.risk} label="Risk" invert testid={`meter-risk-${o.id}`} />
            <div><div className="text-[10px] text-ink-2">Hrs recoverable/wk</div><div className="tabular text-sm font-semibold text-cyan-ink">{fmtNum(o.hoursRecoverablePerWeek, 1)}</div></div>
            <div><div className="text-[10px] text-ink-2">Gross → realizable</div><div className="tabular text-sm font-semibold"><span className="text-ink-3">{o.grossAnnualSavings != null ? fmtUSD(o.grossAnnualSavings, { compact: true }) : "—"}</span> → <span className="text-gold-ink">{fmtUSD(o.realizableAnnualSavings, { compact: true })}</span></div></div>
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
