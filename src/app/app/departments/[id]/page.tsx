import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { num } from "@/lib/utils";
import { computeOrgFinancials } from "@/engine/finance";
import { templateForCategory, CATEGORY_LABELS, type AgentCategory } from "@/engine/agents/templates";
import { DepartmentDetail, type DeptDetailData } from "./department-detail";

export const metadata = { title: "Department" };
export const dynamic = "force-dynamic";

export default async function DepartmentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("workflows:read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const canCost = can(ctx.role, "employees:cost:read");
  const [fin, raw] = await Promise.all([
    computeOrgFinancials(ctx.orgId),
    withTenant(ctx.orgId, async (tx) => {
      const [dept] = await tx.select().from(schema.departments).where(and(eq(schema.departments.id, id), eq(schema.departments.orgId, ctx.orgId))).limit(1);
      if (!dept) return null;
      const employees = await tx.select({ id: schema.employees.id, name: schema.employees.displayName, title: schema.employees.title, managerId: schema.employees.managerEmployeeId, departmentId: schema.employees.departmentId, isActive: schema.employees.isActive }).from(schema.employees).where(eq(schema.employees.orgId, ctx.orgId));
      const workflows = await tx.select({ id: schema.workflows.id, name: schema.workflows.name, hoursPerWeek: schema.workflows.hoursPerWeek, runsPerWeek: schema.workflows.runsPerWeek, avgDurationMin: schema.workflows.avgDurationMin, employeeCount: schema.workflows.employeeCount, repetitionScore: schema.workflows.repetitionScore, automationScore: schema.workflows.automationScore, requiresJudgment: schema.workflows.requiresJudgment, regulatoryFlag: schema.workflows.regulatoryFlag }).from(schema.workflows).where(and(eq(schema.workflows.orgId, ctx.orgId), eq(schema.workflows.departmentId, id)));
      const agents = await tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, workflowId: schema.agents.workflowId, opportunityId: schema.agents.opportunityId, category: schema.agents.category }).from(schema.agents).where(eq(schema.agents.orgId, ctx.orgId));
      const wfIds = workflows.map((w) => w.id);
      const links = wfIds.length ? await tx.select().from(schema.workflowEmployees).where(and(eq(schema.workflowEmployees.orgId, ctx.orgId), inArray(schema.workflowEmployees.workflowId, wfIds))) : [];
      return { dept, employees, workflows, agents, links };
    }),
  ]);
  if (!raw) notFound();
  const { dept, employees, workflows, agents, links } = raw;
  const d = fin.byDepartment.find((x) => x.departmentId === id) ?? { departmentId: id, name: dept.name, employees: 0, laborAnnual: 0, hoursPerWeek: 0, repetitiveHoursPerWeek: 0, recoverableHoursPerWeek: 0, grossAnnual: 0, realizableAnnual: 0, verifiedAnnual: 0, efficiencyGainPct: 0, opportunities: 0 };
  const empFin = new Map(fin.byEmployee.map((e) => [e.employeeId, e]));
  const deployedByWf = new Set(agents.filter((a) => a.status === "deployed" && a.workflowId).map((a) => a.workflowId as string));
  const agentByOpp = new Map(agents.map((a) => [a.opportunityId, a]));
  const deptEmps = employees.filter((e) => e.departmentId === id && e.isActive);
  const deptIds = new Set(deptEmps.map((e) => e.id));
  // org subtree: dept members + their manager (so the tree has a root) — managers outside the dept are shown as context
  const managerIds = new Set(deptEmps.map((e) => e.managerId).filter((m): m is string => !!m && !deptIds.has(m)));
  const treeRows = [...deptEmps, ...employees.filter((e) => managerIds.has(e.id))].map((e) => ({ id: e.id, name: e.name, title: e.title, managerId: e.managerId, departmentName: e.departmentId === id ? null : "other dept", hoursPerWeek: empFin.get(e.id)?.hoursPerWeek, recoverableHoursPerWeek: empFin.get(e.id)?.recoverableHoursPerWeek }));
  const opps = fin.opportunities.filter((o) => o.departmentId === id);
  const data: DeptDetailData = {
    dept: { id, name: dept.name, headEmployeeId: dept.headEmployeeId ?? null, headName: employees.find((e) => e.id === dept.headEmployeeId)?.name ?? null },
    kpis: { employees: d.employees, laborAnnual: d.laborAnnual, hoursPerWeek: d.hoursPerWeek, repetitiveHoursPerWeek: d.repetitiveHoursPerWeek, recoverableHoursPerWeek: d.recoverableHoursPerWeek, grossAnnual: d.grossAnnual, realizableAnnual: d.realizableAnnual, verifiedAnnual: d.verifiedAnnual, efficiencyGainPct: d.efficiencyGainPct, opportunities: d.opportunities },
    canCost,
    workflows: workflows.map((w) => ({ id: w.id, name: w.name, hoursPerWeek: num(w.hoursPerWeek), runsPerWeek: num(w.runsPerWeek), avgDurationMin: num(w.avgDurationMin), people: links.filter((l) => l.workflowId === w.id).length || w.employeeCount, repetitionScore: num(w.repetitionScore), automationScore: num(w.automationScore), requiresJudgment: w.requiresJudgment, regulatoryFlag: w.regulatoryFlag, automated: deployedByWf.has(w.id), opportunityId: opps.find((o) => o.workflowId === w.id)?.id ?? null })).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek),
    employees: deptEmps.map((e) => { const f = empFin.get(e.id); return { id: e.id, name: e.name, title: e.title, hoursPerWeek: f?.hoursPerWeek ?? 0, repetitiveHoursPerWeek: f?.repetitiveHoursPerWeek ?? 0, recoverableHoursPerWeek: f?.recoverableHoursPerWeek ?? 0, realizableAnnual: canCost ? (f?.realizableAnnual ?? 0) : null, laborAnnual: canCost ? (f?.laborAnnual ?? 0) : null, topWorkflow: f?.topWorkflows[0]?.name ?? null }; }).sort((a, b) => b.recoverableHoursPerWeek - a.recoverableHoursPerWeek),
    treeRows,
    opportunities: opps.map((o) => ({ id: o.id, title: o.title, type: o.type, status: o.status, rank: o.rank, feasibility: o.feasibility, risk: o.risk, hoursRecoverablePerWeek: o.hoursRecoverablePerWeek, realizableAnnualSavings: o.realizableAnnualSavings, paybackMonths: o.paybackMonths, basis: o.basis, deployed: o.deployed, agent: agentByOpp.get(o.id) ? { id: agentByOpp.get(o.id)!.id, name: agentByOpp.get(o.id)!.name, status: agentByOpp.get(o.id)!.status } : null, workflowName: o.workflowName })),
    recommendedAgents: [],
    canWriteAgents: can(ctx.role, "agents:write"),
  };
  // Recommended agents: use the stored recommendedAgentCategory on each opportunity (loaded separately to keep it exact).
  const oppRows = await withTenant(ctx.orgId, (tx) => opps.length ? tx.select({ id: schema.opportunities.id, cat: schema.opportunities.recommendedAgentCategory, title: schema.opportunities.title }).from(schema.opportunities).where(and(eq(schema.opportunities.orgId, ctx.orgId), inArray(schema.opportunities.id, opps.map((o) => o.id)))) : Promise.resolve([]));
  const recMap = new Map<string, DeptDetailData["recommendedAgents"][number]>();
  for (const r of oppRows) { if (!r.cat) continue; const t = templateForCategory(r.cat); const cur = recMap.get(r.cat) ?? { category: r.cat, label: CATEGORY_LABELS[r.cat as AgentCategory] ?? r.cat, templateName: t?.name ?? null, templateKey: t?.key ?? null, forOpportunities: [] }; cur.forOpportunities.push(r.title); recMap.set(r.cat, cur); }
  data.recommendedAgents = [...recMap.values()];
  return <DepartmentDetail data={data} />;
}
