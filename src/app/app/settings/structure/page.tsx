import { eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { num } from "@/lib/utils";
import { computeOrgFinancials } from "@/engine/finance";
import { StructureClient, type StructureData } from "./structure-client";

export const metadata = { title: "Locations & Business Units" };
export const dynamic = "force-dynamic";

export default async function StructurePage() {
  const ctx = await requireCtx("org:manage");
  const [fin, raw] = await Promise.all([
    computeOrgFinancials(ctx.orgId),
    withTenant(ctx.orgId, async (tx) => ({
      org: (await tx.select({ name: schema.organizations.name, currency: schema.organizations.currency, timezone: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1))[0],
      bus: await tx.select().from(schema.businessUnits).where(eq(schema.businessUnits.orgId, ctx.orgId)),
      locs: await tx.select().from(schema.locations).where(eq(schema.locations.orgId, ctx.orgId)),
      depts: await tx.select().from(schema.departments).where(eq(schema.departments.orgId, ctx.orgId)),
      emps: await tx.select({ id: schema.employees.id, departmentId: schema.employees.departmentId, businessUnitId: schema.employees.businessUnitId, locationId: schema.employees.locationId, isActive: schema.employees.isActive }).from(schema.employees).where(eq(schema.employees.orgId, ctx.orgId)),
    })),
  ]);
  const labor = new Map(fin.byEmployee.map((e) => [e.employeeId, e.laborAnnual]));
  const active = raw.emps.filter((e) => e.isActive);
  const data: StructureData = {
    orgName: raw.org?.name ?? ctx.orgName, orgCurrency: raw.org?.currency ?? "USD", orgTimezone: raw.org?.timezone ?? "America/Chicago",
    businessUnits: raw.bus.map((b) => ({ id: b.id, name: b.name, kind: b.kind, parentBusinessUnitId: b.parentBusinessUnitId, country: b.country, currency: b.currency })).sort((a, b) => a.name.localeCompare(b.name)),
    locations: raw.locs.map((l) => ({ id: l.id, name: l.name, businessUnitId: l.businessUnitId, city: l.city, region: l.region, country: l.country, timezone: l.timezone })).sort((a, b) => a.name.localeCompare(b.name)),
    departments: raw.depts.map((d) => {
      const es = active.filter((e) => e.departmentId === d.id);
      return { id: d.id, name: d.name, businessUnitId: d.businessUnitId, locationId: d.locationId, annualOverhead: d.annualOverhead == null ? null : num(d.annualOverhead), overheadBasis: d.overheadBasis, headcount: es.length, laborAnnual: es.reduce((s, e) => s + (labor.get(e.id) ?? 0), 0),
        employeesOffBu: es.filter((e) => d.businessUnitId && e.businessUnitId !== d.businessUnitId).length, employeesOffLoc: es.filter((e) => d.locationId && e.locationId !== d.locationId).length };
    }).sort((a, b) => a.name.localeCompare(b.name)),
    unassignedEmployees: active.filter((e) => !e.departmentId).length,
    laborTotal: fin.totalAnnualLaborAnalyzed,
  };
  return <StructureClient data={data} />;
}
