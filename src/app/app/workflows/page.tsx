import { eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { num } from "@/lib/utils";
import { WorkflowsList, type WorkflowRow } from "./workflows-list";

export const metadata = { title: "Workflows" };
export const dynamic = "force-dynamic";

export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<{ q?: string; dept?: string; status?: string; flag?: string }> }) {
  const ctx = await requireCtx("workflows:read");
  const sp = await searchParams;
  const raw = await withTenant(ctx.orgId, async (tx) => ({
    workflows: await tx.select({ id: schema.workflows.id, name: schema.workflows.name, departmentId: schema.workflows.departmentId, employeeCount: schema.workflows.employeeCount, runsPerWeek: schema.workflows.runsPerWeek, avgDurationMin: schema.workflows.avgDurationMin, hoursPerWeek: schema.workflows.hoursPerWeek, repetitionScore: schema.workflows.repetitionScore, automationScore: schema.workflows.automationScore, reworkRate: schema.workflows.reworkRate, handoffCount: schema.workflows.handoffCount, requiresJudgment: schema.workflows.requiresJudgment, regulatoryFlag: schema.workflows.regulatoryFlag, duplicateOfWorkflowId: schema.workflows.duplicateOfWorkflowId, basis: schema.workflows.basis, steps: schema.workflows.steps }).from(schema.workflows).where(eq(schema.workflows.orgId, ctx.orgId)),
    departments: await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, ctx.orgId)),
    opps: await tx.select({ id: schema.opportunities.id, workflowId: schema.opportunities.workflowId, status: schema.opportunities.status }).from(schema.opportunities).where(eq(schema.opportunities.orgId, ctx.orgId)),
    agents: await tx.select({ workflowId: schema.agents.workflowId, status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.orgId, ctx.orgId)),
    [`analysis`]: (await tx.select({ finishedAt: schema.analysisRuns.finishedAt }).from(schema.analysisRuns).where(eq(schema.analysisRuns.orgId, ctx.orgId)).limit(1))[0] ?? null,
  }));
  const deptName = new Map(raw.departments.map((d) => [d.id, d.name]));
  const wfName = new Map(raw.workflows.map((w) => [w.id, w.name]));
  const deployed = new Set(raw.agents.filter((a) => a.status === "deployed" && a.workflowId).map((a) => a.workflowId as string));
  const rows: WorkflowRow[] = raw.workflows.map((w) => {
    const opp = raw.opps.find((o) => o.workflowId === w.id);
    return {
      id: w.id, name: w.name, departmentId: w.departmentId, departmentName: w.departmentId ? (deptName.get(w.departmentId) ?? null) : null, people: w.employeeCount,
      runsPerWeek: num(w.runsPerWeek), avgDurationMin: num(w.avgDurationMin), hoursPerWeek: num(w.hoursPerWeek), repetitionScore: num(w.repetitionScore), automationScore: num(w.automationScore), reworkRate: num(w.reworkRate), handoffCount: w.handoffCount ?? 0,
      requiresJudgment: w.requiresJudgment, regulatoryFlag: w.regulatoryFlag, duplicateOf: w.duplicateOfWorkflowId ? { id: w.duplicateOfWorkflowId, name: wfName.get(w.duplicateOfWorkflowId) ?? "another workflow" } : null, basis: w.basis,
      apps: [...new Set((w.steps ?? []).map((s) => s.app))], opportunity: opp ? { id: opp.id, status: opp.status } : null, automated: deployed.has(w.id),
    };
  }).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek);
  return <WorkflowsList rows={rows} departments={raw.departments} initial={{ q: sp.q ?? "", dept: sp.dept ?? "", status: sp.status ?? "", flag: sp.flag ?? "" }} hasAnalysis={!!raw.analysis} />;
}
