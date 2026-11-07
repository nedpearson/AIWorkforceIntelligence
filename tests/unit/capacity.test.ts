/** Capacity engine: department/role sums reconcile with the finance engine's recoverable hours (± 0.5), hiring-avoidance math. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { opportunityEconomics } from "@/engine/costing";
import { computeOrgFinancials } from "@/engine/finance";
import { computeCapacity, hiringAvoidance, CAPACITY_DISCLAIMER } from "@/engine/capacity";

const ids = { org: "" };

beforeAll(async () => {
  const [org] = await db.insert(schema.organizations).values({ name: "Capacity Fixtures", slug: `cap-test-${Date.now()}`, kind: "client", isDemo: true }).returning();
  ids.org = org.id;
  const [ops] = await db.insert(schema.departments).values({ orgId: org.id, name: "Ops" }).returning();
  const [fin] = await db.insert(schema.departments).values({ orgId: org.id, name: "Finance" }).returning();
  const emp = async (name: string, dept: string, title: string, base: number) => (await db.insert(schema.employees).values({ orgId: org.id, departmentId: dept, displayName: name, title, baseAnnualCost: String(base), costBasis: "observed", hoursPerWeek: "40" }).returning())[0].id;
  const e1 = await emp("A", ops.id, "Coordinator", 50_000), e2 = await emp("B", ops.id, "Coordinator", 52_000), e3 = await emp("C", fin.id, "Accountant", 80_000);
  const wf = async (name: string, dept: string, hours: number, links: [string, number][]) => {
    const [w] = await db.insert(schema.workflows).values({ orgId: org.id, departmentId: dept, name, signature: name, hoursPerWeek: String(hours), repetitionScore: "80", automationScore: "70", employeeCount: links.length, runsPerWeek: "10", avgDurationMin: "30" }).returning();
    for (const [e, h] of links) await db.insert(schema.workflowEmployees).values({ orgId: org.id, workflowId: w.id, employeeId: e, hoursPerWeek: String(h) });
    return w.id;
  };
  const w1 = await wf("Orders", ops.id, 20, [[e1, 12], [e2, 8]]);
  const w2 = await wf("Close", fin.id, 10, [[e3, 10]]);
  const w3 = await wf("Orphan", fin.id, 6, []); // no performer links → unattributed
  const opp = async (title: string, wfId: string, dept: string, auto: number) => {
    const ec = opportunityEconomics({ type: "rpa", hoursPerWeek: 20, automationPct: auto, avgLoadedHourly: 35, employeeCount: 2, complexity: 0.2 });
    await db.insert(schema.opportunities).values({ orgId: org.id, workflowId: wfId, departmentId: dept, title, summary: title, type: "rpa", feasibility: "70", risk: "20", automationPct: String(auto), hoursRecoverablePerWeek: ec.hoursRecoverablePerWeek.toFixed(2), grossAnnualSavings: ec.grossAnnualSavings.toFixed(2), realizableAnnualSavings: ec.realizableAnnualSavings.toFixed(2), implementationCost: ec.implementationCost.toFixed(2), annualOperatingCost: ec.annualOperatingCost.toFixed(2), calculation: ec.tree, evidence: { eventIds: [], sampleSize: 60, observedFrom: "", observedTo: "" } });
  };
  await opp("Order bot", w1, ops.id, 0.7);
  await opp("Order agent (overlaps)", w1, ops.id, 0.6); // overlap de-dup applies
  await opp("Close bot", w2, fin.id, 0.5);
  await opp("Orphan bot", w3, fin.id, 0.5);
});
afterAll(async () => { if (ids.org) await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org)); });

describe("computeCapacity", () => {
  it("department and role sums equal finance recoverable hours (± 0.5)", async () => {
    const [cap, f] = await Promise.all([computeCapacity(ids.org), computeOrgFinancials(ids.org)]);
    const dept = cap.departments.reduce((s, d) => s + d.recoverableHoursPerWeek, 0) + cap.unattributed.recoverableHoursPerWeek;
    const role = cap.roles.reduce((s, d) => s + d.recoverableHoursPerWeek, 0) + cap.unattributed.recoverableHoursPerWeek;
    expect(Math.abs(dept - f.hoursRecoverablePerWeek)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(role - f.hoursRecoverablePerWeek)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(cap.totals.recoverableHoursPerWeek - f.hoursRecoverablePerWeek)).toBeLessThanOrEqual(0.5);
    expect(cap.unattributed.recoverableHoursPerWeek).toBeGreaterThan(0); // the orphan workflow
    expect(cap.totals.fteReleased).toBeCloseTo(cap.totals.recoverableHoursPerWeek / cap.hoursPerFte, 9);
    expect(cap.roles.map((r) => r.name).sort()).toEqual(["Accountant", "Coordinator"]);
    expect(cap.disclaimer).toBe(CAPACITY_DISCLAIMER);
    // small groups never expose an individual's pay: departments under 3 people use the org average
    expect(cap.departments.every((d) => d.costSource === "org_average")).toBe(true);
    // role notes reference tasks (workflows), never people
    expect(cap.roleNotes.find((r) => r.role === "Coordinator")!.tasks[0].workflow).toBe("Orders");
  });
});

describe("hiringAvoidance", () => {
  it("avoided hires = min(planned, FTE × utilization), valued at loaded cost", () => {
    const h = hiringAvoidance({ plannedHires: 2, fteReleased: 1.5, utilization: 0.8, loadedCostPerFte: 70_000 });
    expect(h.avoidedHires).toBeCloseTo(1.2, 9); expect(h.value).toBeCloseTo(84_000, 6);
    const capped = hiringAvoidance({ plannedHires: 1, fteReleased: 3, utilization: 1, loadedCostPerFte: 60_000 });
    expect(capped.avoidedHires).toBe(1); expect(capped.value).toBe(60_000);
    expect(hiringAvoidance({ plannedHires: 0, fteReleased: 3, utilization: 1, loadedCostPerFte: 60_000 }).value).toBe(0);
    expect(hiringAvoidance({ plannedHires: 5, fteReleased: 2, utilization: 7, loadedCostPerFte: 10 }).avoidedHires).toBe(2); // utilization capped at 100%
  });
});
