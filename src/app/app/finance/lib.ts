import "server-only";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import type { FinancialAssumptions } from "@/db/schema";
import { num } from "@/lib/utils";
import { DEFAULTS, loadedHourlyCost } from "@/engine/costing";
import type { OrgFinancials } from "@/engine/finance";

export type WorkflowCostRow = { id: string; name: string; departmentName: string | null; hoursPerWeek: number; employeeCount: number; repetitionScore: number; requiresJudgment: boolean; basis: "observed" | "estimated" | "assumed"; loadedCostPerYear: number; costBasis: "observed" | "estimated" | "assumed"; opportunityId: string | null; opportunityTitle: string | null; realizableAnnual: number | null };
export type MonthPoint = { month: string; projectedMonthly: number; verified: number; measurements: number };
export type OpportunityOption = { id: string; title: string; type: string; status: string; departmentName: string | null; realizableAnnual: number };

/** Loaded cost per year of each discovered workflow = Σ performer hours/wk × performer loaded hourly (costing.loadedHourlyCost) × weeks/yr. */
export async function workflowCosts(orgId: string, a: FinancialAssumptions, fin: OrgFinancials): Promise<WorkflowCostRow[]> {
  const rows = await withTenant(orgId, async (tx) => {
    const [workflows, links, employees, departments] = await Promise.all([
      tx.select().from(schema.workflows).where(eq(schema.workflows.orgId, orgId)),
      tx.select().from(schema.workflowEmployees).where(eq(schema.workflowEmployees.orgId, orgId)),
      tx.select({ id: schema.employees.id, baseAnnualCost: schema.employees.baseAnnualCost, loadedHourlyCost: schema.employees.loadedHourlyCost, hoursPerWeek: schema.employees.hoursPerWeek, costBasis: schema.employees.costBasis }).from(schema.employees).where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.isActive, true))),
      tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, orgId)),
    ]);
    return { workflows, links, employees, departments };
  });
  const dept = new Map(rows.departments.map((d) => [d.id, d.name]));
  const emp = new Map(rows.employees.map((e) => [e.id, e]));
  const byWf = new Map<string, typeof rows.links>();
  for (const l of rows.links) { const arr = byWf.get(l.workflowId) ?? []; arr.push(l); byWf.set(l.workflowId, arr); }
  const oppByWf = new Map(fin.opportunities.filter((o) => o.workflowId).map((o) => [o.workflowId as string, o]));
  return rows.workflows.map((w) => {
    let cost = 0; let allObserved = true; let any = false;
    for (const l of byWf.get(w.id) ?? []) {
      const e = emp.get(l.employeeId); if (!e) continue;
      const base = num(e.baseAnnualCost); const hpw = num(e.hoursPerWeek) || DEFAULTS.workHoursPerWeek;
      const hourly = base > 0 ? loadedHourlyCost(base, a.benefitsLoadPct, hpw, a.workWeeksPerYear).value : num(e.loadedHourlyCost);
      if (hourly <= 0) continue;
      any = true; if (e.costBasis !== "observed") allObserved = false;
      cost += num(l.hoursPerWeek) * hourly * a.workWeeksPerYear;
    }
    const o = oppByWf.get(w.id);
    return { id: w.id, name: w.name, departmentName: w.departmentId ? (dept.get(w.departmentId) ?? null) : null, hoursPerWeek: num(w.hoursPerWeek), employeeCount: w.employeeCount, repetitionScore: num(w.repetitionScore), requiresJudgment: w.requiresJudgment, basis: w.basis, loadedCostPerYear: cost, costBasis: (!any ? "assumed" : allObserved ? "observed" : "estimated") as WorkflowCostRow["costBasis"], opportunityId: o?.id ?? null, opportunityTitle: o?.title ?? null, realizableAnnual: o?.realizableAnnualSavings ?? null };
  }).sort((x, y) => y.loadedCostPerYear - x.loadedCostPerYear);
}

/** Last 12 months: projected monthly run-rate (realizable ÷ 12) vs verified dollars from savings_measurements bucketed by period end. */
export async function realizedVsProjected(orgId: string, realizableAnnual: number): Promise<MonthPoint[]> {
  const ms = await withTenant(orgId, (tx) => tx.select({ periodEnd: schema.savingsMeasurements.periodEnd, dollarsSaved: schema.savingsMeasurements.dollarsSaved }).from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId)));
  const now = new Date(); const points: MonthPoint[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    const inMonth = ms.filter((m) => m.periodEnd.toISOString().slice(0, 7) === key);
    points.push({ month: key, projectedMonthly: realizableAnnual / 12, verified: inMonth.reduce((s, m) => s + num(m.dollarsSaved), 0), measurements: inMonth.length });
  }
  return points;
}
