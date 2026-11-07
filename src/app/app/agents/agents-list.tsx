"use client";
import * as React from "react";
import Link from "next/link";
import { Bot, Plus, KeyRound, Inbox } from "lucide-react";
import { Badge, Button, Card, Empty, PageHeader, Select, Table, Th, Td, Tooltip } from "@/components/ui";
import { fmtNum, fmtUSD } from "@/lib/utils";
import { CATEGORY_LABELS, type AgentCategory } from "@/engine/agents/templates";

export type AgentRow = { id: string; name: string; category: string; status: string; runtime: string; runs30: number; successRate: number | null; minutes30: number; monthlyCost: number; lastRunAt: string | null; externalId: string | null };
export const STATUS_TONE: Record<string, "neutral" | "brand" | "money" | "warn" | "danger" | "info" | "verified" | "projected"> = { draft: "neutral", configured: "info", deployed: "money", paused: "warn", retired: "neutral", error: "danger" };
export const RUN_TONE: Record<string, "neutral" | "brand" | "money" | "warn" | "danger" | "info" | "verified" | "projected"> = { queued: "neutral", running: "info", awaiting_approval: "warn", succeeded: "money", failed: "danger", rolled_back: "danger", cancelled: "neutral" };
export const ago = (iso: string | null) => { if (!iso) return "never"; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return "just now"; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 48) return `${h} h ago`; return `${Math.round(h / 24)} d ago`; };

function Kpi({ label, value, hint, testid }: { label: string; value: React.ReactNode; hint?: string; testid: string }) {
  return <Card className="p-4" data-testid={testid}><div className="flex items-center gap-1 text-xs text-ink-2">{label}{hint && <Tooltip text={hint} />}</div><div className="mt-1 text-2xl font-semibold tabular">{value}</div></Card>;
}

export function AgentsList({ rows, kpis, canWrite, canApprove, canCreds, initialStatus, initialCategory, hasOpportunities }: { rows: AgentRow[]; kpis: { deployed: number; monthRuns: number; verifiedHours: number; pending: number }; canWrite: boolean; canApprove: boolean; canCreds: boolean; initialStatus: string; initialCategory: string; hasOpportunities: boolean }) {
  const [status, setStatus] = React.useState(initialStatus); const [category, setCategory] = React.useState(initialCategory);
  const filtered = rows.filter((r) => (!status || r.status === status) && (!category || r.category === category));
  return (
    <div>
      <PageHeader title="AI Agents" subtitle="Agents built from your opportunities. Every run is logged; savings are verified from the run ledger, not assumed." actions={<>
        {canCreds && <Button variant="secondary" href="/app/agents/credentials" data-testid="agents-credentials"><KeyRound size={15} />Credentials</Button>}
        {canApprove && <Button variant="secondary" href="/app/agents/approvals" data-testid="agents-approvals"><Inbox size={15} />Approvals{kpis.pending > 0 && <Badge tone="warn">{kpis.pending}</Badge>}</Button>}
        {canWrite && <Button href="/app/agents/new" data-testid="agents-new"><Plus size={15} />New agent</Button>}
      </>} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Deployed agents" value={kpis.deployed} testid="kpi-deployed" />
        <Kpi label="Runs this month" value={fmtNum(kpis.monthRuns)} testid="kpi-runs" />
        <Kpi label="Verified hours saved" value={<span className="text-verified">{fmtNum(kpis.verifiedHours, 1)}</span>} hint="Sum of recorded measurements with basis 'observed' (run ledger or before/after observation). Projected savings are shown on each opportunity, never here." testid="kpi-verified" />
        <Kpi label="Pending approvals" value={kpis.pending} hint="Runs paused at a human-approval step. Someone with the approver role must decide before the agent continues." testid="kpi-pending" />
      </div>
      {rows.length === 0 ? (
        <Empty title="No agents yet" body={hasOpportunities ? "Pick an opportunity and turn it into an agent. Each template explains in plain English what it does and what it needs." : "Agents are built from opportunities found in your workflow analysis. Go to Opportunities to pick one to automate."}
          action={<div className="flex gap-2"><Button variant="secondary" href="/app/opportunities" data-testid="agents-empty-opps">Go to Opportunities</Button>{canWrite && <Button href="/app/agents/new" data-testid="agents-empty-new">Start from a template</Button>}</div>} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" data-testid="filter-status" aria-label="Status filter"><option value="">All statuses</option>{Object.keys(STATUS_TONE).map((s) => <option key={s} value={s}>{s}</option>)}</Select>
            <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-48" data-testid="filter-category" aria-label="Category filter"><option value="">All categories</option>{(Object.keys(CATEGORY_LABELS) as AgentCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}</Select>
            <span className="self-center text-xs text-ink-3">{filtered.length} of {rows.length}</span>
          </div>
          <Table>
            <thead><tr><Th>Agent</Th><Th>Status</Th><Th>Runtime</Th><Th className="text-right">Runs (30d)</Th><Th className="text-right">Success</Th><Th className="text-right">Min saved (30d)</Th><Th className="text-right">Monthly cost</Th><Th>Last run</Th></tr></thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="hover:bg-surface-2" data-testid={`agent-row-${r.id}`}>
                  <Td><Link href={`/app/agents/${r.id}`} className="flex items-center gap-2 font-medium text-brand hover:underline"><Bot size={15} />{r.name}</Link><div className="text-xs text-ink-3">{CATEGORY_LABELS[r.category as AgentCategory] ?? r.category}</div></Td>
                  <Td><Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge></Td>
                  <Td><span className="text-xs">{r.runtime}{r.runtime === "n8n" && !r.externalId && <span className="text-warn"> (not pushed)</span>}</span></Td>
                  <Td className="text-right tabular">{r.runs30}</Td>
                  <Td className="text-right tabular">{r.successRate == null ? "—" : `${Math.round(r.successRate * 100)}%`}</Td>
                  <Td className="text-right tabular text-verified">{fmtNum(r.minutes30)}</Td>
                  <Td className="text-right tabular">{fmtUSD(r.monthlyCost)}</Td>
                  <Td className="text-xs text-ink-2">{ago(r.lastRunAt)}</Td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><Td colSpan={8} className="text-center text-xs text-ink-3">No agents match these filters.</Td></tr>}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}
