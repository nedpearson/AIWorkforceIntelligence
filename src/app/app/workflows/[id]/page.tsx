import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { num } from "@/lib/utils";
import { WorkflowDetail, type WorkflowDetailData } from "./workflow-detail";

export const metadata = { title: "Workflow" };
export const dynamic = "force-dynamic";

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("workflows:read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const raw = await withTenant(ctx.orgId, async (tx) => {
    const [wf] = await tx.select().from(schema.workflows).where(and(eq(schema.workflows.id, id), eq(schema.workflows.orgId, ctx.orgId))).limit(1);
    if (!wf) return null;
    const [dept] = wf.departmentId ? await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.id, wf.departmentId)).limit(1) : [];
    const [dup] = wf.duplicateOfWorkflowId ? await tx.select({ id: schema.workflows.id, name: schema.workflows.name }).from(schema.workflows).where(eq(schema.workflows.id, wf.duplicateOfWorkflowId)).limit(1) : [];
    const dupOf = await tx.select({ id: schema.workflows.id, name: schema.workflows.name }).from(schema.workflows).where(and(eq(schema.workflows.orgId, ctx.orgId), eq(schema.workflows.duplicateOfWorkflowId, id)));
    const links = await tx.select({ employeeId: schema.workflowEmployees.employeeId, runsPerWeek: schema.workflowEmployees.runsPerWeek, hoursPerWeek: schema.workflowEmployees.hoursPerWeek, avgDurationMin: schema.workflowEmployees.avgDurationMin, name: schema.employees.displayName, title: schema.employees.title, departmentId: schema.employees.departmentId })
      .from(schema.workflowEmployees).innerJoin(schema.employees, eq(schema.employees.id, schema.workflowEmployees.employeeId)).where(and(eq(schema.workflowEmployees.orgId, ctx.orgId), eq(schema.workflowEmployees.workflowId, id)));
    const opps = await tx.select().from(schema.opportunities).where(and(eq(schema.opportunities.orgId, ctx.orgId), eq(schema.opportunities.workflowId, id)));
    const agents = await tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, opportunityId: schema.agents.opportunityId }).from(schema.agents).where(and(eq(schema.agents.orgId, ctx.orgId), eq(schema.agents.workflowId, id)));
    const sampleIds = (wf.evidence?.eventIds ?? []).slice(0, 50);
    const events = sampleIds.length ? await tx.select({ id: schema.activityEvents.id, ts: schema.activityEvents.ts, app: schema.activityEvents.app, type: schema.activityEvents.type, durationMs: schema.activityEvents.durationMs, employeeId: schema.activityEvents.employeeId }).from(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, ctx.orgId), inArray(schema.activityEvents.id, sampleIds))).orderBy(schema.activityEvents.ts) : [];
    const departments = await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, ctx.orgId));
    return { wf, dept: dept ?? null, dup: dup ?? null, dupOf, links, opps, agents, events, departments };
  });
  if (!raw) notFound();
  const { wf } = raw;
  const deptName = new Map(raw.departments.map((d) => [d.id, d.name]));
  const empName = new Map(raw.links.map((l) => [l.employeeId, l.name]));
  const data: WorkflowDetailData = {
    workflow: {
      id, name: wf.name, description: wf.description, departmentId: wf.departmentId, departmentName: raw.dept?.name ?? null, steps: wf.steps ?? [], processMap: wf.processMap ?? null,
      avgDurationMin: num(wf.avgDurationMin), runsPerWeek: num(wf.runsPerWeek), hoursPerWeek: num(wf.hoursPerWeek), employeeCount: wf.employeeCount, repetitionScore: num(wf.repetitionScore), automationScore: num(wf.automationScore),
      reworkRate: num(wf.reworkRate), handoffCount: wf.handoffCount ?? 0, isManual: wf.isManual, requiresJudgment: wf.requiresJudgment, regulatoryFlag: wf.regulatoryFlag, basis: wf.basis,
      evidence: { sampleSize: wf.evidence?.sampleSize ?? 0, observedFrom: wf.evidence?.observedFrom ?? "", observedTo: wf.evidence?.observedTo ?? "", eventCount: wf.evidence?.eventIds?.length ?? 0, employeeIds: wf.evidence?.employeeIds ?? [], notes: wf.evidence?.notes ?? [] },
      duplicateOf: raw.dup, duplicatedBy: raw.dupOf, updatedAt: wf.updatedAt.toISOString(),
    },
    performers: raw.links.map((l) => ({ id: l.employeeId, name: l.name, title: l.title, departmentName: l.departmentId ? (deptName.get(l.departmentId) ?? null) : null, runsPerWeek: num(l.runsPerWeek), hoursPerWeek: num(l.hoursPerWeek), avgDurationMin: num(l.avgDurationMin) })).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek),
    opportunities: raw.opps.map((o) => ({ id: o.id, title: o.title, summary: o.summary, type: o.type, status: o.status, rank: o.rank, feasibility: num(o.feasibility), risk: num(o.risk), hoursRecoverablePerWeek: num(o.hoursRecoverablePerWeek), grossAnnualSavings: num(o.grossAnnualSavings), realizableAnnualSavings: num(o.realizableAnnualSavings), implementationCost: num(o.implementationCost), paybackMonths: o.paybackMonths == null ? null : num(o.paybackMonths), basis: o.basis, requiresHumanJudgment: o.requiresHumanJudgment, regulatoryFlag: o.regulatoryFlag, agent: raw.agents.find((a) => a.opportunityId === o.id) ? { id: raw.agents.find((a) => a.opportunityId === o.id)!.id, name: raw.agents.find((a) => a.opportunityId === o.id)!.name, status: raw.agents.find((a) => a.opportunityId === o.id)!.status } : null })),
    agents: raw.agents.map((a) => ({ id: a.id, name: a.name, status: a.status })),
    sampleEvents: raw.events.map((e) => ({ id: e.id, ts: e.ts.toISOString(), app: e.app, type: e.type, durationMs: e.durationMs, employee: empName.get(e.employeeId) ?? "—" })),
    canWriteAgents: can(ctx.role, "agents:write"),
  };
  return <WorkflowDetail data={data} />;
}
