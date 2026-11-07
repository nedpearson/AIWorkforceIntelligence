import { notFound, redirect } from "next/navigation";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { num } from "@/lib/utils";
import { computeOrgFinancials } from "@/engine/finance";
import { templateForCategory, CATEGORY_LABELS, type AgentCategory } from "@/engine/agents/templates";
import type { CalcTree } from "@/db/schema";
import { EmployeeDetail, type EmployeeDetailData } from "./employee-detail";

export const metadata = { title: "Employee" };
export const dynamic = "force-dynamic";

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  // Access: anyone with employees:read, or a person looking at their own record (self:read).
  const isSelf = ctx.employeeId === id;
  if (!can(ctx.role, "employees:read")) { if (!(isSelf && can(ctx.role, "self:read"))) redirect("/app?denied=employees:read"); }
  const canCost = can(ctx.role, "employees:cost:read");

  const [fin, raw] = await Promise.all([
    computeOrgFinancials(ctx.orgId),
    withTenant(ctx.orgId, async (tx) => {
      const [emp] = await tx.select().from(schema.employees).where(and(eq(schema.employees.id, id), eq(schema.employees.orgId, ctx.orgId))).limit(1);
      if (!emp) return null;
      const [dept] = emp.departmentId ? await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.id, emp.departmentId)).limit(1) : [];
      const [manager] = emp.managerEmployeeId ? await tx.select({ id: schema.employees.id, name: schema.employees.displayName, title: schema.employees.title }).from(schema.employees).where(eq(schema.employees.id, emp.managerEmployeeId)).limit(1) : [];
      const reports = await tx.select({ id: schema.employees.id, name: schema.employees.displayName, title: schema.employees.title }).from(schema.employees).where(and(eq(schema.employees.orgId, ctx.orgId), eq(schema.employees.managerEmployeeId, id), eq(schema.employees.isActive, true)));
      const links = await tx.select().from(schema.workflowEmployees).where(and(eq(schema.workflowEmployees.orgId, ctx.orgId), eq(schema.workflowEmployees.employeeId, id)));
      const wfIds = links.map((l) => l.workflowId);
      const workflows = wfIds.length ? await tx.select({ id: schema.workflows.id, name: schema.workflows.name, hoursPerWeek: schema.workflows.hoursPerWeek, runsPerWeek: schema.workflows.runsPerWeek, avgDurationMin: schema.workflows.avgDurationMin, repetitionScore: schema.workflows.repetitionScore, automationScore: schema.workflows.automationScore, isManual: schema.workflows.isManual, departmentId: schema.workflows.departmentId }).from(schema.workflows).where(and(eq(schema.workflows.orgId, ctx.orgId), inArray(schema.workflows.id, wfIds))) : [];
      const wfTotals = wfIds.length ? await tx.select({ workflowId: schema.workflowEmployees.workflowId, hours: sql<string>`sum(${schema.workflowEmployees.hoursPerWeek})` }).from(schema.workflowEmployees).where(and(eq(schema.workflowEmployees.orgId, ctx.orgId), inArray(schema.workflowEmployees.workflowId, wfIds))).groupBy(schema.workflowEmployees.workflowId) : [];
      const opps = wfIds.length ? await tx.select({ id: schema.opportunities.id, workflowId: schema.opportunities.workflowId, title: schema.opportunities.title, status: schema.opportunities.status, recommendedAgentCategory: schema.opportunities.recommendedAgentCategory, type: schema.opportunities.type }).from(schema.opportunities).where(and(eq(schema.opportunities.orgId, ctx.orgId), inArray(schema.opportunities.workflowId, wfIds))) : [];
      const agents = wfIds.length ? await tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, workflowId: schema.agents.workflowId }).from(schema.agents).where(and(eq(schema.agents.orgId, ctx.orgId), inArray(schema.agents.workflowId, wfIds))) : [];
      const byCategory = await tx.select({ category: sql<string>`coalesce(${schema.activityEvents.appCategory}, 'other')`, ms: sql<string>`sum(${schema.activityEvents.durationMs})` }).from(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, ctx.orgId), eq(schema.activityEvents.employeeId, id))).groupBy(sql`coalesce(${schema.activityEvents.appCategory}, 'other')`);
      const byDay = await tx.select({ day: sql<string>`to_char(date_trunc('day', ${schema.activityEvents.ts}), 'YYYY-MM-DD')`, ms: sql<string>`sum(${schema.activityEvents.durationMs})` }).from(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, ctx.orgId), eq(schema.activityEvents.employeeId, id))).groupBy(sql`date_trunc('day', ${schema.activityEvents.ts})`).orderBy(sql`date_trunc('day', ${schema.activityEvents.ts})`);
      const [evWindow] = await tx.select({ n: sql<string>`count(*)`, from: sql<string | null>`min(${schema.activityEvents.ts})`, to: sql<string | null>`max(${schema.activityEvents.ts})` }).from(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, ctx.orgId), eq(schema.activityEvents.employeeId, id)));
      return { emp, dept: dept ?? null, manager: manager ?? null, reports, links, workflows, wfTotals, opps, agents, byCategory, byDay, evWindow };
    }),
  ]);
  if (!raw) notFound();
  const { emp } = raw;
  const f = fin.byEmployee.find((e) => e.employeeId === id);
  const lineByWf = new Map<string, typeof fin.opportunities>();
  for (const l of fin.opportunities) if (l.workflowId) { const a = lineByWf.get(l.workflowId) ?? []; a.push(l); lineByWf.set(l.workflowId, a); }
  const wfTotal = new Map(raw.wfTotals.map((t) => [t.workflowId, num(t.hours)]));
  const deployedWf = new Set(raw.agents.filter((a) => a.status === "deployed" && a.workflowId).map((a) => a.workflowId as string));

  // Potential financial impact tree: this person's share of each opportunity on the workflows they perform.
  const children: CalcTree[] = []; let recoverable = 0, realizable = 0;
  for (const l of raw.links) {
    const tot = wfTotal.get(l.workflowId) ?? 0; const share = tot > 0 ? num(l.hoursPerWeek) / tot : 0;
    for (const line of lineByWf.get(l.workflowId) ?? []) {
      const r = line.hoursRecoverablePerWeek * share, $ = line.realizableAnnualSavings * share; recoverable += r; realizable += $;
      children.push({ label: line.title, value: canCost ? $ : r, unit: canCost ? "usd" : "hours", basis: "estimated", formula: `${canCost ? "opportunity realizable $" : "opportunity recoverable hrs/wk"} × share of workflow hours (${num(l.hoursPerWeek).toFixed(1)} ÷ ${tot.toFixed(1)} = ${(share * 100).toFixed(0)}%)`, children: [
        { label: "This person's hours per week on the workflow", value: num(l.hoursPerWeek), unit: "hours", basis: "observed", source: "workflow_employees" },
        { label: "All performers' hours per week", value: tot, unit: "hours", basis: "observed" },
        ...(canCost ? [line.tree] : [{ label: "Hours recoverable per week (whole workflow)", value: line.hoursRecoverablePerWeek, unit: "hours", basis: "estimated" as const }]),
      ] });
    }
  }
  const impactTree: CalcTree = canCost
    ? { label: "Potential financial impact (annual, realizable)", value: realizable, unit: "usd", basis: "estimated", formula: "Σ opportunity realizable $ × this person's share of the workflow hours", source: "Time saved ≠ payroll cut — this is capacity that can be reassigned", children }
    : { label: "Hours recoverable per week", value: recoverable, unit: "hours", basis: "estimated", formula: "Σ opportunity recoverable hrs/wk × this person's share of the workflow hours", children };

  const recommended = new Map<string, { category: string; label: string; templateName: string | null; templateKey: string | null; forOpportunities: string[] }>();
  for (const o of raw.opps) { if (!o.recommendedAgentCategory) continue; const t = templateForCategory(o.recommendedAgentCategory); const cur = recommended.get(o.recommendedAgentCategory) ?? { category: o.recommendedAgentCategory, label: CATEGORY_LABELS[o.recommendedAgentCategory as AgentCategory] ?? o.recommendedAgentCategory, templateName: t?.name ?? null, templateKey: t?.key ?? null, forOpportunities: [] }; cur.forOpportunities.push(o.title); recommended.set(o.recommendedAgentCategory, cur); }

  const data: EmployeeDetailData = {
    employee: { id, name: emp.displayName, title: emp.title, email: emp.email, location: emp.location, departmentId: raw.dept?.id ?? null, departmentName: raw.dept?.name ?? null, manager: raw.manager, reports: raw.reports, hoursContract: num(emp.hoursPerWeek) || 40, isSelf },
    cost: canCost ? { baseAnnualCost: num(emp.baseAnnualCost), loadedHourlyCost: f?.loadedHourly ?? num(emp.loadedHourlyCost), laborAnnual: f?.laborAnnual ?? 0, basis: emp.costBasis } : null,
    kpis: { hoursPerWeek: f?.hoursPerWeek ?? 0, repetitiveHoursPerWeek: f?.repetitiveHoursPerWeek ?? 0, recoverableHoursPerWeek: recoverable, realizableAnnual: canCost ? realizable : null, efficiencyGainPct: f?.efficiencyGainPct ?? 0 },
    impactTree,
    workflows: raw.links.map((l) => { const w = raw.workflows.find((x) => x.id === l.workflowId); const opp = raw.opps.find((o) => o.workflowId === l.workflowId); const ag = raw.agents.find((a) => a.workflowId === l.workflowId); return { id: l.workflowId, name: w?.name ?? "", hoursPerWeek: num(l.hoursPerWeek), runsPerWeek: num(l.runsPerWeek), avgDurationMin: num(l.avgDurationMin), repetitionScore: num(w?.repetitionScore), automationScore: num(w?.automationScore), automated: deployedWf.has(l.workflowId), agent: ag ? { id: ag.id, name: ag.name, status: ag.status } : null, opportunity: opp ? { id: opp.id, title: opp.title, status: opp.status } : null }; }).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek),
    opportunities: fin.opportunities.filter((o) => o.workflowId && raw.links.some((l) => l.workflowId === o.workflowId)).map((o) => ({ id: o.id, title: o.title, type: o.type, status: o.status, rank: o.rank, feasibility: o.feasibility, risk: o.risk, hoursRecoverablePerWeek: o.hoursRecoverablePerWeek, realizableAnnualSavings: o.realizableAnnualSavings, paybackMonths: o.paybackMonths, basis: o.basis, deployed: o.deployed, workflowName: o.workflowName })),
    recommendedAgents: [...recommended.values()],
    byCategory: raw.byCategory.map((c) => ({ name: c.category, hours: num(c.ms) / 3_600_000 })).filter((c) => c.hours > 0),
    byDay: raw.byDay.map((d) => ({ day: d.day, hours: num(d.ms) / 3_600_000 })),
    evidence: { events: num(raw.evWindow?.n), from: raw.evWindow?.from ? new Date(raw.evWindow.from).toISOString() : null, to: raw.evWindow?.to ? new Date(raw.evWindow.to).toISOString() : null },
    canWriteAgents: can(ctx.role, "agents:write"), canCost,
  };
  return <EmployeeDetail data={data} />;
}
