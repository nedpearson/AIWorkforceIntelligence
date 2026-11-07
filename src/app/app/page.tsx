import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { computeOrgFinancials } from "@/engine/finance";
import type { CalcTree } from "@/db/schema";
import type { OpportunityLine } from "@/engine/finance.types";
import { ExecutiveSummary, type ExecData } from "@/components/dashboard/executive-summary";
import { loadProgress, checklist } from "./onboarding/progress";

export const metadata = { title: "Executive Summary" };
export const dynamic = "force-dynamic";

function findNode(tree: CalcTree | undefined, label: string): CalcTree | undefined {
  if (!tree) return undefined; if (tree.label === label) return tree;
  for (const c of tree.children ?? []) { const f = findNode(c, label); if (f) return f; }
  return undefined;
}

/**
 * "Spent on automatable work today": gross annual labor on every workflow that has an (non-rejected) opportunity.
 * = Σ opportunity (observed workflow hrs/wk × working weeks/yr × avg loaded hourly of the people doing it).
 * Inputs are read off each opportunity's CalcTree from computeOrgFinancials so the numbers match the finance engine exactly.
 */
function wastedLabor(lines: OpportunityLine[], weeks: number): { value: number; tree: CalcTree } {
  const seen = new Set<string>(); const children: CalcTree[] = []; let total = 0;
  for (const l of lines) {
    const key = l.workflowId ?? l.id; if (seen.has(key)) continue; seen.add(key); // one workflow counted once even if several opportunities point at it
    const hourly = findNode(l.tree, "Average loaded hourly cost")?.value ?? 0;
    const hoursNode = findNode(l.tree, "Observed workflow hours per week");
    const annual = l.hoursPerWeek * weeks * hourly; total += annual;
    children.push({ label: l.workflowName ?? l.title, value: annual, unit: "usd", basis: "estimated", formula: `${l.hoursPerWeek.toFixed(1)} hrs/wk × ${weeks} wk × $${hourly.toFixed(2)}/hr`, source: `Opportunity ${l.title}`, children: [
      { label: "Observed workflow hours per week", value: l.hoursPerWeek, unit: "hours", basis: hoursNode?.basis ?? "observed", source: "Collector events (sum of step durations)" },
      { label: "Working weeks per year", value: weeks, unit: "weeks", basis: "assumed" },
      { label: "Average loaded hourly cost", value: hourly, unit: "usd", basis: "estimated", source: "Hours-weighted across the people performing it" },
    ] });
  }
  return { value: total, tree: { label: "Spent on automatable work today (annual)", value: total, unit: "usd", basis: "estimated", formula: "Σ workflows with an opportunity: hrs/wk × weeks/yr × avg loaded hourly", source: `${children.length} automatable workflow(s); the size of the prize, before any automation`, children } };
}

export default async function ExecutivePage() {
  const ctx = await requireCtx();
  const [fin, progress] = await Promise.all([computeOrgFinancials(ctx.orgId), loadProgress(ctx.orgId)]);
  const { byEmployee: _drop, ...finNoEmp } = fin; void _drop; // per-person $ never leaves the server on this page
  const data: ExecData = {
    fin: finNoEmp,
    wasted: wastedLabor(fin.opportunities, fin.assumptions.workWeeksPerYear),
    progress, steps: checklist(progress), role: ctx.role,
    canWriteAgents: can(ctx.role, "agents:write"), canManageCollection: can(ctx.role, "collectors:manage"),
  };
  return <ExecutiveSummary data={data} />;
}
