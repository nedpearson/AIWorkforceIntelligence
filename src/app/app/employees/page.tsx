import { eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { computeOrgFinancials } from "@/engine/finance";
import { EmployeesList, type EmployeeRow } from "./employees-list";

export const metadata = { title: "People" };
export const dynamic = "force-dynamic";

export default async function EmployeesPage({ searchParams }: { searchParams: Promise<{ q?: string; dept?: string }> }) {
  const ctx = await requireCtx("employees:read");
  const sp = await searchParams;
  const canCost = can(ctx.role, "employees:cost:read");
  const [fin, raw] = await Promise.all([
    computeOrgFinancials(ctx.orgId),
    withTenant(ctx.orgId, async (tx) => ({
      employees: await tx.select({ id: schema.employees.id, name: schema.employees.displayName, title: schema.employees.title, departmentId: schema.employees.departmentId, managerId: schema.employees.managerEmployeeId, isActive: schema.employees.isActive, location: schema.employees.location }).from(schema.employees).where(eq(schema.employees.orgId, ctx.orgId)),
      departments: await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, ctx.orgId)),
    })),
  ]);
  const deptName = new Map(raw.departments.map((d) => [d.id, d.name]));
  const finById = new Map(fin.byEmployee.map((e) => [e.employeeId, e]));
  const rows: EmployeeRow[] = raw.employees.filter((e) => e.isActive).map((e) => {
    const f = finById.get(e.id);
    return {
      id: e.id, name: e.name, title: e.title, departmentId: e.departmentId, departmentName: e.departmentId ? (deptName.get(e.departmentId) ?? null) : null, managerId: e.managerId, observed: !!f,
      hoursPerWeek: f?.hoursPerWeek ?? 0, repetitivePct: f && f.hoursPerWeek > 0 ? f.repetitiveHoursPerWeek / f.hoursPerWeek : 0, recoverableHoursPerWeek: f?.recoverableHoursPerWeek ?? 0,
      realizableAnnual: canCost ? (f?.realizableAnnual ?? 0) : null, laborAnnual: canCost ? (f?.laborAnnual ?? 0) : null, loadedHourly: canCost ? (f?.loadedHourly ?? 0) : null, costBasis: f?.costBasis ?? "assumed",
      topWorkflow: f?.topWorkflows[0] ? { id: f.topWorkflows[0].workflowId, name: f.topWorkflows[0].name } : null,
    };
  });
  const deptTotals = fin.byDepartment.map((d) => ({ id: d.departmentId, name: d.name, realizableAnnual: d.realizableAnnual, laborAnnual: d.laborAnnual }));
  return <EmployeesList rows={rows} departments={raw.departments} deptTotals={deptTotals} canCost={canCost} initialQ={sp.q ?? ""} initialDept={sp.dept ?? ""} />;
}
