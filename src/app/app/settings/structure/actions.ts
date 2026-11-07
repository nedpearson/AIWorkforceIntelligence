"use server";
/**
 * Server actions for Settings → Structure (business units, locations, department assignment & overhead, bulk employee assignment).
 * Every mutation: zod-validated, `org:manage` permission, tenant-scoped through withTenant (+ explicit orgId filter), audited.
 */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant, type TenantDb } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const uuid = z.string().uuid();
const optUuid = z.union([uuid, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));
const text = (max: number) => z.string().trim().max(max);
const revalidate = () => { revalidatePath("/app/settings/structure"); revalidatePath("/app/business"); revalidatePath("/app/process-mining"); revalidatePath("/app/departments"); };
const err = (e: unknown): Result<never> => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

async function assertBu(tx: TenantDb, orgId: string, id: string | null) {
  if (!id) return;
  const [r] = await tx.select({ id: schema.businessUnits.id }).from(schema.businessUnits).where(and(eq(schema.businessUnits.id, id), eq(schema.businessUnits.orgId, orgId))).limit(1);
  if (!r) throw new Error("business unit not found in this organization");
}
async function assertLoc(tx: TenantDb, orgId: string, id: string | null) {
  if (!id) return;
  const [r] = await tx.select({ id: schema.locations.id }).from(schema.locations).where(and(eq(schema.locations.id, id), eq(schema.locations.orgId, orgId))).limit(1);
  if (!r) throw new Error("location not found in this organization");
}

// ---------- business units ----------
const BuInput = z.object({
  id: uuid.optional(), name: text(120).min(1, "Name is required"), kind: z.enum(["subsidiary", "division", "business_unit"]),
  parentBusinessUnitId: optUuid, country: text(2).transform((v) => v.toUpperCase()).optional().transform((v) => v || null), currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "Currency must be a 3-letter ISO code").transform((v) => v.toUpperCase()),
});
export async function saveBusinessUnit(raw: unknown): Promise<Result<{ id: string }>> {
  const ctx = await requireCtx("org:manage");
  const p = BuInput.safeParse(raw); if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
  const v = p.data;
  if (v.id && v.parentBusinessUnitId === v.id) return { ok: false, error: "A business unit cannot be its own parent" };
  try {
    const id = await withTenant(ctx.orgId, async (tx) => {
      await assertBu(tx, ctx.orgId, v.parentBusinessUnitId);
      if (v.id && v.parentBusinessUnitId) {
        // reject cycles: walk up from the proposed parent
        const all = await tx.select({ id: schema.businessUnits.id, parent: schema.businessUnits.parentBusinessUnitId }).from(schema.businessUnits).where(eq(schema.businessUnits.orgId, ctx.orgId));
        const parent = new Map(all.map((b) => [b.id, b.parent])); let cur: string | null = v.parentBusinessUnitId; let guard = 0;
        while (cur && guard++ < 100) { if (cur === v.id) throw new Error("That parent would create a cycle"); cur = parent.get(cur) ?? null; }
      }
      const values = { name: v.name, kind: v.kind, parentBusinessUnitId: v.parentBusinessUnitId, country: v.country ?? null, currency: v.currency };
      if (v.id) {
        const [r] = await tx.update(schema.businessUnits).set(values).where(and(eq(schema.businessUnits.id, v.id), eq(schema.businessUnits.orgId, ctx.orgId))).returning({ id: schema.businessUnits.id });
        if (!r) throw new Error("business unit not found in this organization"); return r.id;
      }
      const [r] = await tx.insert(schema.businessUnits).values({ orgId: ctx.orgId, ...values }).returning({ id: schema.businessUnits.id }); return r.id;
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: v.id ? "structure.business_unit_updated" : "structure.business_unit_created", entityType: "business_unit", entityId: id, details: { name: v.name, kind: v.kind, parent: v.parentBusinessUnitId } });
    revalidate(); return { ok: true, id };
  } catch (e) { return err(e); }
}
export async function deleteBusinessUnit(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("org:manage");
  const p = z.object({ id: uuid }).safeParse(raw); if (!p.success) return { ok: false, error: "invalid id" };
  const id = p.data.id;
  try {
    const name = await withTenant(ctx.orgId, async (tx) => {
      const [bu] = await tx.select({ name: schema.businessUnits.name }).from(schema.businessUnits).where(and(eq(schema.businessUnits.id, id), eq(schema.businessUnits.orgId, ctx.orgId))).limit(1);
      if (!bu) throw new Error("business unit not found in this organization");
      // detach dependents first (no FK cascade on these columns)
      await tx.update(schema.businessUnits).set({ parentBusinessUnitId: null }).where(and(eq(schema.businessUnits.orgId, ctx.orgId), eq(schema.businessUnits.parentBusinessUnitId, id)));
      await tx.update(schema.departments).set({ businessUnitId: null }).where(and(eq(schema.departments.orgId, ctx.orgId), eq(schema.departments.businessUnitId, id)));
      await tx.update(schema.employees).set({ businessUnitId: null, updatedAt: new Date() }).where(and(eq(schema.employees.orgId, ctx.orgId), eq(schema.employees.businessUnitId, id)));
      await tx.delete(schema.businessUnits).where(and(eq(schema.businessUnits.id, id), eq(schema.businessUnits.orgId, ctx.orgId)));
      return bu.name;
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "structure.business_unit_deleted", entityType: "business_unit", entityId: id, details: { name } });
    revalidate(); return { ok: true };
  } catch (e) { return err(e); }
}

// ---------- locations ----------
const LocInput = z.object({
  id: uuid.optional(), name: text(120).min(1, "Name is required"), businessUnitId: optUuid,
  city: text(120).optional().transform((v) => v || null), region: text(120).optional().transform((v) => v || null),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, "Country must be a 2-letter ISO code").transform((v) => v.toUpperCase()),
  timezone: z.string().trim().min(1).max(64).refine((tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }, "Unknown IANA time zone"),
});
export async function saveLocation(raw: unknown): Promise<Result<{ id: string }>> {
  const ctx = await requireCtx("org:manage");
  const p = LocInput.safeParse(raw); if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
  const v = p.data;
  try {
    const id = await withTenant(ctx.orgId, async (tx) => {
      await assertBu(tx, ctx.orgId, v.businessUnitId);
      const values = { name: v.name, businessUnitId: v.businessUnitId, city: v.city ?? null, region: v.region ?? null, country: v.country, timezone: v.timezone };
      if (v.id) {
        const [r] = await tx.update(schema.locations).set(values).where(and(eq(schema.locations.id, v.id), eq(schema.locations.orgId, ctx.orgId))).returning({ id: schema.locations.id });
        if (!r) throw new Error("location not found in this organization"); return r.id;
      }
      const [r] = await tx.insert(schema.locations).values({ orgId: ctx.orgId, ...values }).returning({ id: schema.locations.id }); return r.id;
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: v.id ? "structure.location_updated" : "structure.location_created", entityType: "location", entityId: id, details: { name: v.name, businessUnitId: v.businessUnitId, country: v.country, timezone: v.timezone } });
    revalidate(); return { ok: true, id };
  } catch (e) { return err(e); }
}
export async function deleteLocation(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("org:manage");
  const p = z.object({ id: uuid }).safeParse(raw); if (!p.success) return { ok: false, error: "invalid id" };
  const id = p.data.id;
  try {
    const name = await withTenant(ctx.orgId, async (tx) => {
      const [l] = await tx.select({ name: schema.locations.name }).from(schema.locations).where(and(eq(schema.locations.id, id), eq(schema.locations.orgId, ctx.orgId))).limit(1);
      if (!l) throw new Error("location not found in this organization");
      await tx.update(schema.departments).set({ locationId: null }).where(and(eq(schema.departments.orgId, ctx.orgId), eq(schema.departments.locationId, id)));
      await tx.update(schema.employees).set({ locationId: null, updatedAt: new Date() }).where(and(eq(schema.employees.orgId, ctx.orgId), eq(schema.employees.locationId, id)));
      await tx.delete(schema.locations).where(and(eq(schema.locations.id, id), eq(schema.locations.orgId, ctx.orgId)));
      return l.name;
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "structure.location_deleted", entityType: "location", entityId: id, details: { name } });
    revalidate(); return { ok: true };
  } catch (e) { return err(e); }
}

// ---------- departments ----------
const DeptInput = z.object({
  id: uuid, businessUnitId: optUuid, locationId: optUuid,
  annualOverhead: z.union([z.number(), z.string(), z.null()]).optional().transform((v, c) => {
    if (v == null || v === "") return null; const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 1e12) { c.addIssue({ code: "custom", message: "Overhead must be a non-negative amount" }); return z.NEVER; }
    return Math.round(n * 100) / 100;
  }),
  overheadBasis: z.enum(["observed", "estimated", "assumed"]),
});
export async function updateDepartmentStructure(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("org:manage");
  const p = DeptInput.safeParse(raw); if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
  const v = p.data;
  try {
    const before = await withTenant(ctx.orgId, async (tx) => {
      await assertBu(tx, ctx.orgId, v.businessUnitId); await assertLoc(tx, ctx.orgId, v.locationId);
      const [d] = await tx.select().from(schema.departments).where(and(eq(schema.departments.id, v.id), eq(schema.departments.orgId, ctx.orgId))).limit(1);
      if (!d) throw new Error("department not found in this organization");
      await tx.update(schema.departments).set({ businessUnitId: v.businessUnitId, locationId: v.locationId, annualOverhead: v.annualOverhead == null ? null : v.annualOverhead.toFixed(2), overheadBasis: v.overheadBasis }).where(and(eq(schema.departments.id, v.id), eq(schema.departments.orgId, ctx.orgId)));
      return d;
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "structure.department_updated", entityType: "department", entityId: v.id, details: { name: before.name, from: { businessUnitId: before.businessUnitId, locationId: before.locationId, annualOverhead: before.annualOverhead, overheadBasis: before.overheadBasis }, to: { businessUnitId: v.businessUnitId, locationId: v.locationId, annualOverhead: v.annualOverhead, overheadBasis: v.overheadBasis } } });
    revalidate(); return { ok: true };
  } catch (e) { return err(e); }
}

// ---------- bulk employee assignment ----------
const BulkInput = z.object({ departmentId: uuid, businessUnitId: optUuid, locationId: optUuid, setBusinessUnit: z.boolean(), setLocation: z.boolean() })
  .refine((v) => v.setBusinessUnit || v.setLocation, "Choose at least one field to assign");
export async function bulkAssignEmployees(raw: unknown): Promise<Result<{ updated: number }>> {
  const ctx = await requireCtx("org:manage");
  const p = BulkInput.safeParse(raw); if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
  const v = p.data;
  try {
    const r = await withTenant(ctx.orgId, async (tx) => {
      if (v.setBusinessUnit) await assertBu(tx, ctx.orgId, v.businessUnitId);
      if (v.setLocation) await assertLoc(tx, ctx.orgId, v.locationId);
      const [d] = await tx.select({ name: schema.departments.name }).from(schema.departments).where(and(eq(schema.departments.id, v.departmentId), eq(schema.departments.orgId, ctx.orgId))).limit(1);
      if (!d) throw new Error("department not found in this organization");
      const emps = await tx.select({ id: schema.employees.id }).from(schema.employees).where(and(eq(schema.employees.orgId, ctx.orgId), eq(schema.employees.departmentId, v.departmentId)));
      if (!emps.length) return { updated: 0, name: d.name };
      const patch: Partial<typeof schema.employees.$inferInsert> = { updatedAt: new Date() };
      if (v.setBusinessUnit) patch.businessUnitId = v.businessUnitId;
      if (v.setLocation) { patch.locationId = v.locationId; if (v.locationId) { const [l] = await tx.select({ name: schema.locations.name }).from(schema.locations).where(eq(schema.locations.id, v.locationId)).limit(1); patch.location = l?.name ?? null; } }
      await tx.update(schema.employees).set(patch).where(and(eq(schema.employees.orgId, ctx.orgId), inArray(schema.employees.id, emps.map((e) => e.id))));
      return { updated: emps.length, name: d.name };
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "structure.employees_bulk_assigned", entityType: "department", entityId: v.departmentId, details: { department: r.name, updated: r.updated, businessUnitId: v.setBusinessUnit ? v.businessUnitId : "unchanged", locationId: v.setLocation ? v.locationId : "unchanged" } });
    revalidate(); return { ok: true, updated: r.updated };
  } catch (e) { return err(e); }
}
