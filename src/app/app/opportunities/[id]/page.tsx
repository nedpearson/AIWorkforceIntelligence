import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { num } from "@/lib/utils";
import { computeOrgFinancials } from "@/engine/finance";
import { recommendTemplate } from "@/engine/agents/templates";
import { OpportunityDetail, type OppDetailData } from "./opportunity-detail";

export const metadata = { title: "Opportunity" };
export const dynamic = "force-dynamic";

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("opportunities:read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [fin, raw] = await Promise.all([
    computeOrgFinancials(ctx.orgId),
    withTenant(ctx.orgId, async (tx) => {
      const [o] = await tx.select().from(schema.opportunities).where(and(eq(schema.opportunities.id, id), eq(schema.opportunities.orgId, ctx.orgId))).limit(1);
      if (!o) return null;
      const [wf] = o.workflowId ? await tx.select().from(schema.workflows).where(and(eq(schema.workflows.id, o.workflowId), eq(schema.workflows.orgId, ctx.orgId))).limit(1) : [];
      const deptId = o.departmentId ?? wf?.departmentId ?? null;
      const [dept] = deptId ? await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.id, deptId)).limit(1) : [];
      const agents = await tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, deployedAt: schema.agents.deployedAt, templateKey: schema.agents.templateKey }).from(schema.agents).where(and(eq(schema.agents.orgId, ctx.orgId), eq(schema.agents.opportunityId, id)));
      const performers = wf ? await tx.select({ id: schema.employees.id, name: schema.employees.displayName, title: schema.employees.title, hoursPerWeek: schema.workflowEmployees.hoursPerWeek }).from(schema.workflowEmployees).innerJoin(schema.employees, eq(schema.employees.id, schema.workflowEmployees.employeeId)).where(and(eq(schema.workflowEmployees.orgId, ctx.orgId), eq(schema.workflowEmployees.workflowId, wf.id))) : [];
      const measurements = agents.length ? await tx.select({ id: schema.savingsMeasurements.id, agentId: schema.savingsMeasurements.agentId, periodStart: schema.savingsMeasurements.periodStart, periodEnd: schema.savingsMeasurements.periodEnd, hoursSaved: schema.savingsMeasurements.hoursSaved, dollarsSaved: schema.savingsMeasurements.dollarsSaved, method: schema.savingsMeasurements.method, basis: schema.savingsMeasurements.basis }).from(schema.savingsMeasurements).where(and(eq(schema.savingsMeasurements.orgId, ctx.orgId), inArray(schema.savingsMeasurements.agentId, agents.map((a) => a.id)))) : [];
      return { o, wf: wf ?? null, dept: dept ?? null, agents, performers, measurements };
    }),
  ]);
  if (!raw) notFound();
  const { o, wf } = raw;
  const line = fin.opportunities.find((l) => l.id === id) ?? null; // null when rejected (out of scope) → stored numbers
  const template = recommendTemplate({ recommendedAgentCategory: o.recommendedAgentCategory, title: o.title, type: o.type }, wf ? { steps: wf.steps, name: wf.name } : null);
  const data: OppDetailData = {
    opp: {
      id, title: o.title, summary: o.summary, type: o.type, status: o.status, rank: o.rank, feasibility: num(o.feasibility), risk: num(o.risk), automationPct: line?.automationPct ?? num(o.automationPct),
      hoursPerWeek: line?.hoursPerWeek ?? num(wf?.hoursPerWeek), hoursRecoverablePerWeek: line?.hoursRecoverablePerWeek ?? num(o.hoursRecoverablePerWeek), grossAnnualSavings: line?.grossAnnualSavings ?? num(o.grossAnnualSavings), realizableAnnualSavings: line?.realizableAnnualSavings ?? num(o.realizableAnnualSavings),
      implementationCost: line?.implementationCost ?? num(o.implementationCost), annualOperatingCost: line?.annualOperatingCost ?? num(o.annualOperatingCost), netAnnualSavings: line?.netAnnualSavings ?? (num(o.realizableAnnualSavings) - num(o.annualOperatingCost)), paybackMonths: line ? line.paybackMonths : (o.paybackMonths == null ? null : num(o.paybackMonths)), roi1y: line?.roi1y ?? 0,
      basis: o.basis, requiresHumanJudgment: o.requiresHumanJudgment, regulatoryFlag: o.regulatoryFlag, recommendedAgentCategory: o.recommendedAgentCategory, deployed: line?.deployed ?? raw.agents.some((a) => a.status === "deployed"),
      departmentId: raw.dept?.id ?? null, departmentName: raw.dept?.name ?? null, workflowName: wf?.name ?? null, createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(), inScope: !!line,
      evidence: { sampleSize: o.evidence?.sampleSize ?? 0, observedFrom: o.evidence?.observedFrom ?? "", observedTo: o.evidence?.observedTo ?? "", eventCount: o.evidence?.eventIds?.length ?? 0, employeeIds: o.evidence?.employeeIds ?? [], notes: o.evidence?.notes ?? [] },
    },
    calculation: line?.tree ?? o.calculation, storedCalculation: o.calculation, liveDiffers: !!line && Math.abs(line.realizableAnnualSavings - num(o.realizableAnnualSavings)) > 1,
    workflow: wf ? { id: wf.id, name: wf.name, processMap: wf.processMap ?? null, steps: wf.steps ?? [], runsPerWeek: num(wf.runsPerWeek), avgDurationMin: num(wf.avgDurationMin), hoursPerWeek: num(wf.hoursPerWeek), repetitionScore: num(wf.repetitionScore), automationScore: num(wf.automationScore), duplicateOf: wf.duplicateOfWorkflowId } : null,
    performers: raw.performers.map((p) => ({ id: p.id, name: p.name, title: p.title, hoursPerWeek: num(p.hoursPerWeek) })).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek),
    agents: raw.agents.map((a) => ({ id: a.id, name: a.name, status: a.status, deployedAt: a.deployedAt?.toISOString() ?? null, templateKey: a.templateKey })),
    measurements: raw.measurements.map((m) => ({ id: m.id, agentId: m.agentId, periodStart: m.periodStart.toISOString(), periodEnd: m.periodEnd.toISOString(), hoursSaved: num(m.hoursSaved), dollarsSaved: num(m.dollarsSaved), method: m.method, basis: m.basis })),
    template: { key: template.key, name: template.name, description: template.description, category: template.category, monthlyCost: template.monthlyCost },
    canWrite: can(ctx.role, "opportunities:write"), canAutomate: can(ctx.role, "agents:write"),
  };
  return <OpportunityDetail data={data} />;
}
