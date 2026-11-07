/**
 * Business Intelligence engine. Requires DATABASE_URL (own DB, never the seeded default).
 * Fixture org: 2 BUs, 2 locations, 2 departments (with overhead), 3 employees with costs, hand-built activity events.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "@/db/client";
import { computeOrgFinancials } from "@/engine/finance";
import { computeBusinessIntel, resolveScope, percentile } from "@/engine/business-intel";

const ids = { org: "", buA: "", buB: "", locA: "", locB: "", ops: "", fin: "", e1: "", e2: "", e3: "" };
const H = 3_600_000;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

beforeAll(async () => {
  const [org] = await db.insert(schema.organizations).values({ name: "BI Fixtures", slug: `bi-test-${Date.now()}`, kind: "client", isDemo: true }).returning();
  ids.org = org.id;
  const [buA] = await db.insert(schema.businessUnits).values({ orgId: org.id, name: "North", kind: "division" }).returning();
  const [buB] = await db.insert(schema.businessUnits).values({ orgId: org.id, name: "South", kind: "business_unit" }).returning();
  ids.buA = buA.id; ids.buB = buB.id;
  const [locA] = await db.insert(schema.locations).values({ orgId: org.id, name: "HQ", businessUnitId: buA.id }).returning();
  const [locB] = await db.insert(schema.locations).values({ orgId: org.id, name: "Branch", businessUnitId: buB.id }).returning();
  ids.locA = locA.id; ids.locB = locB.id;
  const [ops] = await db.insert(schema.departments).values({ orgId: org.id, name: "Operations", businessUnitId: buA.id, locationId: locA.id, annualOverhead: "50000", overheadBasis: "observed" }).returning();
  const [fin] = await db.insert(schema.departments).values({ orgId: org.id, name: "Finance", businessUnitId: buB.id, locationId: locB.id, annualOverhead: "20000", overheadBasis: "assumed" }).returning();
  ids.ops = ops.id; ids.fin = fin.id;
  const emp = async (name: string, dept: string, base: number, bu?: string) => (await db.insert(schema.employees).values({ orgId: org.id, departmentId: dept, businessUnitId: bu ?? null, displayName: name, baseAnnualCost: String(base), costBasis: "observed", hoursPerWeek: "40" }).returning())[0].id;
  ids.e1 = await emp("Ann", ops.id, 60_000);
  ids.e2 = await emp("Bob", ops.id, 50_000, buB.id); // own BU overrides the department's
  ids.e3 = await emp("Cy", fin.id, 90_000);
  const col = randomUUID();
  const ev = (e: string, ts: string, type: string, app: string, cat: string, ms: number) => ({ orgId: org.id, employeeId: e, collectorId: col, ts: new Date(ts), type: type as "data_entry", app, appCategory: cat, titleCategory: "invoice", durationMs: ms });
  await db.insert(schema.activityEvents).values([
    // Ann, Monday: Excel → QuickBooks → Excel  (2 app changes)
    ev(ids.e1, "2026-10-05T14:00:00Z", "data_entry", "Excel", "spreadsheet", 1 * H),
    ev(ids.e1, "2026-10-05T15:00:00Z", "data_entry", "QuickBooks", "accounting", 0.5 * H),
    ev(ids.e1, "2026-10-05T15:30:00Z", "idle_start", "Idle", "idle", 0.25 * H),
    ev(ids.e1, "2026-10-05T15:45:00Z", "idle_end", "Idle", "idle", 0),
    ev(ids.e1, "2026-10-05T16:00:00Z", "navigation", "Excel", "spreadsheet", 0.5 * H),
    // Bob, Tuesday: Outlook only (0 changes)
    ev(ids.e2, "2026-10-06T14:00:00Z", "email_compose", "Outlook", "email", 2 * H),
    // Cy, following week: Chrome → Excel (1 change)
    ev(ids.e3, "2026-10-13T14:00:00Z", "navigation", "Chrome", "browser", 1 * H),
    ev(ids.e3, "2026-10-13T15:00:00Z", "data_entry", "Excel", "spreadsheet", 1 * H),
  ]);
});
afterAll(async () => {
  if (!ids.org) return;
  await db.delete(schema.activityEvents).where(eq(schema.activityEvents.orgId, ids.org));
  await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org));
});

describe("resolveScope (pure)", () => {
  const depts = [{ id: "d1", name: "A", businessUnitId: "b1", locationId: "l1", annualOverhead: "10", overheadBasis: "assumed" as const }, { id: "d2", name: "B", businessUnitId: "b2", locationId: null, annualOverhead: null, overheadBasis: "assumed" as const }];
  const emps = [{ id: "e1", departmentId: "d1", businessUnitId: null, locationId: null }, { id: "e2", departmentId: "d1", businessUnitId: "b2", locationId: null }, { id: "e3", departmentId: "d2", businessUnitId: null, locationId: "l1" }, { id: "e4", departmentId: "d2", businessUnitId: null, locationId: null, isActive: false }];
  it("employee BU/location fall back to the department's", () => {
    expect(resolveScope(emps, depts, { bu: "b1" }).employees.map((e) => e.id)).toEqual(["e1"]);
    expect(resolveScope(emps, depts, { bu: "b2" }).employees.map((e) => e.id)).toEqual(["e2", "e3"]);
    expect(resolveScope(emps, depts, { loc: "l1" }).employees.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(resolveScope(emps, depts, {}).employees).toHaveLength(3); // inactive excluded
    expect(resolveScope(emps, depts, { loc: "l1" }).departments.map((d) => d.id)).toEqual(["d1"]);
  });
  it("percentile interpolates", () => { expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5); expect(percentile([], 0.9)).toBe(0); expect(percentile([5], 0.9)).toBe(5); });
});

describe("computeBusinessIntel", () => {
  it("labor reconciles with the finance engine and every breakdown sums to the total", async () => {
    const fin = await computeOrgFinancials(ids.org);
    const bi = await computeBusinessIntel(ids.org, {}, { fin });
    expect(fin.totalAnnualLaborAnalyzed).toBeCloseTo((60_000 + 50_000 + 90_000) * 1.3, 4);
    expect(bi.laborAnnual).toBeCloseTo(fin.totalAnnualLaborAnalyzed, 6);
    expect(bi.trees.labor.value).toBeCloseTo(fin.totalAnnualLaborAnalyzed, 6);
    expect(sum(bi.byBusinessUnit.map((r) => r.labor))).toBeCloseTo(bi.laborAnnual, 6);
    expect(sum(bi.byLocation.map((r) => r.labor))).toBeCloseTo(bi.laborAnnual, 6);
    expect(sum(bi.byDepartment.map((r) => r.labor))).toBeCloseTo(bi.laborAnnual, 6);
    expect(bi.overheadAnnual).toBe(70_000);
    expect(bi.enteredOpexAnnual).toBeCloseTo(bi.laborAnnual + 70_000, 6);
    expect(bi.trees.enteredOpex.value).toBeCloseTo(bi.enteredOpexAnnual, 6);
    expect(bi.trees.overhead.basis).toBe("assumed"); // one department's overhead is assumed
    // BU split: Bob's own BU (South) wins over Operations' (North)
    const north = bi.byBusinessUnit.find((r) => r.id === ids.buA)!; const south = bi.byBusinessUnit.find((r) => r.id === ids.buB)!;
    expect(north.labor).toBeCloseTo(60_000 * 1.3, 6); expect(north.overhead).toBe(50_000); expect(north.headcount).toBe(1);
    expect(south.labor).toBeCloseTo(140_000 * 1.3, 6); expect(south.overhead).toBe(20_000); expect(south.headcount).toBe(2);
    expect(bi.headcount).toBe(3);
  });

  it("activity totals reconcile with summed event durations", async () => {
    const bi = await computeBusinessIntel(ids.org);
    const [row] = await db.execute(sql`select coalesce(sum(duration_ms),0)::float8 as ms from activity_events where org_id = ${ids.org} and type not in ('idle_start','idle_end')`) as unknown as { ms: number }[];
    const expected = Number(row.ms) / H;
    expect(expected).toBeCloseTo(6, 9);
    expect(bi.activity.activeHours).toBeCloseTo(expected, 9);
    expect(sum(bi.activity.byCategory.map((r) => r.hours))).toBeCloseTo(expected, 9);
    expect(sum(bi.activity.byActivity.map((r) => r.hours))).toBeCloseTo(expected, 9);
    expect(sum(bi.weekly.map((w) => w.hours))).toBeCloseTo(expected, 9);
    expect(sum(bi.activity.byCategory.map((r) => r.share))).toBeCloseTo(1, 9);
    expect(bi.activity.idleHours).toBeCloseTo(0.25, 9);
    expect(bi.activity.idleShare).toBeCloseTo(0.25 / 6.25, 9);
    expect(bi.activity.activeDays).toBe(3);
    expect(bi.activity.hoursPerWeek).toBeCloseTo(6 / (3 / 5), 9);
    expect(bi.activity.topApps[0]).toMatchObject({ name: "Excel" });
    expect(bi.activity.topApps[0].hours).toBeCloseTo(2.5, 9);
    // no app_switch events → derived from consecutive app changes: Ann 2, Bob 0, Cy 1
    expect(bi.activity.contextSwitches).toMatchObject({ count: 3, method: "derived_app_changes", basis: "estimated" });
    expect(bi.activity.contextSwitches.perHour).toBeCloseTo(3 / 6, 9);
    expect(bi.weekly).toHaveLength(2);
    // workload: each employee ÷ own weeks (1 day → 0.2 wk): Ann 2h, Bob 2h, Cy 2h → 10 hrs/wk each
    expect(bi.workload.employees).toBe(3); expect(bi.workload.p50).toBeCloseTo(10, 9);
    expect(sum(bi.workload.histogram.map((h) => h.employees))).toBe(3);
  });

  it("filters narrow labor, overhead and activity to the selected scope", async () => {
    const fin = await computeOrgFinancials(ids.org);
    const ops = await computeBusinessIntel(ids.org, { dept: ids.ops }, { fin });
    expect(ops.headcount).toBe(2);
    expect(ops.laborAnnual).toBeCloseTo(110_000 * 1.3, 6);
    expect(ops.overheadAnnual).toBe(50_000);
    expect(ops.activity.activeHours).toBeCloseTo(4, 9);
    const south = await computeBusinessIntel(ids.org, { bu: ids.buB }, { fin });
    expect(south.laborAnnual).toBeCloseTo(140_000 * 1.3, 6);
    expect(south.overheadAnnual).toBe(20_000);
    expect(south.activity.activeHours).toBeCloseTo(4, 9); // Bob 2 + Cy 2
    const week2 = await computeBusinessIntel(ids.org, { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-19T00:00:00Z") }, { fin });
    expect(week2.activity.activeHours).toBeCloseTo(2, 9);
    expect(week2.laborAnnual).toBeCloseTo(fin.totalAnnualLaborAnalyzed, 6); // labor is annual, not date-filtered
  });
});
