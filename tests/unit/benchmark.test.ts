/** Benchmarking engine — pure stats + DB-backed internal comparison (own org). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { computeBenchmarks, median, quartileOf, statsFor, METRICS } from "@/engine/benchmark";

describe("benchmark stats", () => {
  it("median & quartiles", () => {
    expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); expect(median([])).toBeNull();
    const all = [10, 20, 30, 40];
    expect(quartileOf(40, all)).toBe(1); expect(quartileOf(30, all)).toBe(2); expect(quartileOf(20, all)).toBe(3); expect(quartileOf(10, all)).toBe(4);
  });
  it("normalizes to median and leaves missing values null", () => {
    const v = (x: number | null) => Object.fromEntries(METRICS.map((m) => [m.key, x])) as never;
    const st = statsFor([{ id: "a", name: "a", type: "department", employees: 1, values: v(10) }, { id: "b", name: "b", type: "department", employees: 1, values: v(30) }, { id: "c", name: "c", type: "department", employees: 1, values: v(null) }]);
    expect(st.realizablePerFte.median).toBe(20);
    expect(st.realizablePerFte.normalized.a).toBeCloseTo(0.5, 9); expect(st.realizablePerFte.normalized.c).toBeNull();
    expect(st.realizablePerFte.quartile.b).toBe(1); expect(st.realizablePerFte.quartile.c).toBeNull();
  });
});

const ids = { org: "", d1: "", d2: "" };
beforeAll(async () => {
  const [org] = await db.insert(schema.organizations).values({ name: "Bench Fixture", slug: `bench-test-${Date.now()}`, kind: "client" }).returning(); ids.org = org.id;
  const [loc] = await db.insert(schema.locations).values({ orgId: org.id, name: "HQ" }).returning();
  const [d1] = await db.insert(schema.departments).values({ orgId: org.id, name: "AP", locationId: loc.id }).returning();
  const [d2] = await db.insert(schema.departments).values({ orgId: org.id, name: "Sales", locationId: loc.id }).returning();
  ids.d1 = d1.id; ids.d2 = d2.id;
  const mk = async (dept: string, base: number, wfHours: number, auto: number) => {
    const [e] = await db.insert(schema.employees).values({ orgId: org.id, departmentId: dept, displayName: "e", baseAnnualCost: String(base), costBasis: "observed", hoursPerWeek: "40" }).returning();
    const [w] = await db.insert(schema.workflows).values({ orgId: org.id, departmentId: dept, name: `w${base}`, signature: `w${base}`, hoursPerWeek: String(wfHours), repetitionScore: "80", automationScore: String(auto), reworkRate: "0.05", handoffCount: 2, employeeCount: 1 }).returning();
    await db.insert(schema.workflowEmployees).values({ orgId: org.id, workflowId: w.id, employeeId: e.id, hoursPerWeek: String(wfHours) });
  };
  await mk(d1.id, 50_000, 20, 80); await mk(d2.id, 100_000, 10, 40);
});
afterAll(async () => { if (ids.org) await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org)); });

describe("computeBenchmarks", () => {
  it("compares departments from engine data, never inventing external values", async () => {
    const bm = await computeBenchmarks(ids.org);
    const set = bm.sets.department!;
    expect(set.entities.map((e) => e.name).sort()).toEqual(["AP", "Sales"]);
    const ap = set.entities.find((e) => e.id === ids.d1)!; const sales = set.entities.find((e) => e.id === ids.d2)!;
    expect(ap.values.laborPerEmployee).toBeCloseTo(50_000 * 1.3, 4);
    expect(ap.values.automationScoreAvg).toBeCloseTo(80, 6);
    expect(set.stats.laborPerEmployee.median).toBeCloseTo((50_000 + 100_000) * 1.3 / 2, 4);
    expect(set.stats.laborPerEmployee.quartile[sales.id]).toBe(1);
    expect(set.stats.automationScoreAvg.normalized[ap.id]).toBeCloseTo(80 / 60, 9);
    expect(bm.sets.location?.entities).toHaveLength(1); // both depts at HQ → one location
    expect(bm.sets.client).toBeUndefined();
    expect(bm.snapshots).toEqual([]);
  });
});
