import { requireCtx } from "@/lib/session";
import { computeOrgFinancials } from "@/engine/finance";
import { DepartmentsList, type DeptRow } from "./departments-list";

export const metadata = { title: "Departments" };
export const dynamic = "force-dynamic";

export default async function DepartmentsPage() {
  const ctx = await requireCtx("workflows:read");
  const fin = await computeOrgFinancials(ctx.orgId);
  const rows: DeptRow[] = fin.byDepartment.map((d) => ({
    id: d.departmentId, name: d.name, employees: d.employees, laborAnnual: d.laborAnnual, hoursPerWeek: d.hoursPerWeek, repetitiveHoursPerWeek: d.repetitiveHoursPerWeek,
    recoverableHoursPerWeek: d.recoverableHoursPerWeek, realizableAnnual: d.realizableAnnual, verifiedAnnual: d.verifiedAnnual, efficiencyGainPct: d.efficiencyGainPct, opportunities: d.opportunities,
  }));
  return <DepartmentsList rows={rows} totals={{ recoverable: fin.hoursRecoverablePerWeek, realizable: fin.realizableAnnualSavings, verified: fin.verifiedAnnualizedSavings }} />;
}
