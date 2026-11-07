import { eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { num } from "@/lib/utils";
import { computeOrgFinancials } from "@/engine/finance";
import { OpportunitiesList, type OppRow } from "./opportunities-list";

export const metadata = { title: "Opportunities" };
export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<{ type?: string; status?: string; dept?: string }> }) {
  const ctx = await requireCtx("opportunities:read");
  const sp = await searchParams;
  const [fin, raw] = await Promise.all([
    computeOrgFinancials(ctx.orgId),
    withTenant(ctx.orgId, async (tx) => ({
      opps: await tx.select({ id: schema.opportunities.id, summary: schema.opportunities.summary, status: schema.opportunities.status, requiresHumanJudgment: schema.opportunities.requiresHumanJudgment, regulatoryFlag: schema.opportunities.regulatoryFlag, recommendedAgentCategory: schema.opportunities.recommendedAgentCategory, workflowId: schema.opportunities.workflowId, departmentId: schema.opportunities.departmentId, title: schema.opportunities.title, type: schema.opportunities.type, rank: schema.opportunities.rank, feasibility: schema.opportunities.feasibility, risk: schema.opportunities.risk, hoursRecoverablePerWeek: schema.opportunities.hoursRecoverablePerWeek, grossAnnualSavings: schema.opportunities.grossAnnualSavings, realizableAnnualSavings: schema.opportunities.realizableAnnualSavings, implementationCost: schema.opportunities.implementationCost, paybackMonths: schema.opportunities.paybackMonths, basis: schema.opportunities.basis }).from(schema.opportunities).where(eq(schema.opportunities.orgId, ctx.orgId)),
      agents: await tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, opportunityId: schema.agents.opportunityId }).from(schema.agents).where(eq(schema.agents.orgId, ctx.orgId)),
      departments: await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, ctx.orgId)),
      workflows: await tx.select({ id: schema.workflows.id, duplicateOfWorkflowId: schema.workflows.duplicateOfWorkflowId, name: schema.workflows.name, departmentId: schema.workflows.departmentId }).from(schema.workflows).where(eq(schema.workflows.orgId, ctx.orgId)),
    })),
  ]);
  const lineById = new Map(fin.opportunities.map((l) => [l.id, l]));
  const deptName = new Map(raw.departments.map((d) => [d.id, d.name]));
  const wfById = new Map(raw.workflows.map((w) => [w.id, w]));
  const rows: OppRow[] = raw.opps.map((o) => {
    const l = lineById.get(o.id); // rejected opportunities are out of the finance scope → fall back to stored numbers
    const wf = o.workflowId ? wfById.get(o.workflowId) : undefined; const agent = raw.agents.find((a) => a.opportunityId === o.id);
    const deptId = o.departmentId ?? wf?.departmentId ?? null;
    return {
      id: o.id, title: o.title, summary: o.summary, type: o.type, status: o.status, rank: o.rank, feasibility: num(o.feasibility), risk: num(o.risk),
      hoursRecoverablePerWeek: l?.hoursRecoverablePerWeek ?? num(o.hoursRecoverablePerWeek), grossAnnualSavings: l?.grossAnnualSavings ?? num(o.grossAnnualSavings), realizableAnnualSavings: l?.realizableAnnualSavings ?? num(o.realizableAnnualSavings),
      implementationCost: l?.implementationCost ?? num(o.implementationCost), paybackMonths: l ? l.paybackMonths : (o.paybackMonths == null ? null : num(o.paybackMonths)), basis: o.basis, deployed: l?.deployed ?? agent?.status === "deployed",
      requiresHumanJudgment: o.requiresHumanJudgment, regulatoryFlag: o.regulatoryFlag, duplicate: !!wf?.duplicateOfWorkflowId, departmentId: deptId, departmentName: deptId ? (deptName.get(deptId) ?? null) : null, workflowName: wf?.name ?? null,
      agent: agent ? { id: agent.id, name: agent.name, status: agent.status } : null,
    };
  }).sort((a, b) => (a.rank || 999) - (b.rank || 999));
  return <OpportunitiesList rows={rows} departments={raw.departments} canWrite={can(ctx.role, "opportunities:write")} canAutomate={can(ctx.role, "agents:write")} initial={{ type: sp.type ?? "", status: sp.status ?? "", dept: sp.dept ?? "" }} totals={{ realizable: fin.realizableAnnualSavings, hours: fin.hoursRecoverablePerWeek }} />;
}
