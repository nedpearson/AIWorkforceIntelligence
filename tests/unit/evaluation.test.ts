/** Business Evaluation engine — pure helpers + DB-backed fixture (own org, cascade-deleted). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { opportunityEconomics } from "@/engine/costing";
import { computeEvaluation, compositeScore, confidenceFrom, compareSnapshots, DIMENSION_WEIGHTS } from "@/engine/evaluation";

const ids = { org: "" };
beforeAll(async () => {
  const [org] = await db.insert(schema.organizations).values({ name: "Eval Fixture", slug: `eval-test-${Date.now()}`, kind: "client", industry: "Distribution" }).returning();
  ids.org = org.id;
  const [d] = await db.insert(schema.departments).values({ orgId: org.id, name: "Ops", annualOverhead: "10000" }).returning();
  const [e] = await db.insert(schema.employees).values({ orgId: org.id, departmentId: d.id, displayName: "E", baseAnnualCost: "50000", costBasis: "observed", hoursPerWeek: "40" }).returning();
  await db.insert(schema.employees).values({ orgId: org.id, departmentId: d.id, displayName: "No cost", costBasis: "assumed" });
  const [w] = await db.insert(schema.workflows).values({ orgId: org.id, departmentId: d.id, name: "W", signature: "w", hoursPerWeek: "10", repetitionScore: "80", automationScore: "60", reworkRate: "0.1", handoffCount: 3, employeeCount: 1, steps: [{ idx: 0, app: "Excel", action: "a", avgMs: 1, share: 0.5 }, { idx: 1, app: "QuickBooks", action: "b", avgMs: 1, share: 0.5 }] }).returning();
  await db.insert(schema.workflowEmployees).values({ orgId: org.id, workflowId: w.id, employeeId: e.id, hoursPerWeek: "10" });
  const ec = opportunityEconomics({ type: "rpa", hoursPerWeek: 10, automationPct: 0.5, avgLoadedHourly: 33.85, employeeCount: 1, complexity: 0.2 });
  await db.insert(schema.opportunities).values({ orgId: org.id, workflowId: w.id, departmentId: d.id, title: "O", summary: "O", type: "rpa", status: "identified", feasibility: "80", risk: "30", automationPct: "0.5", hoursRecoverablePerWeek: ec.hoursRecoverablePerWeek.toFixed(2), grossAnnualSavings: ec.grossAnnualSavings.toFixed(2), realizableAnnualSavings: ec.realizableAnnualSavings.toFixed(2), implementationCost: ec.implementationCost.toFixed(2), annualOperatingCost: ec.annualOperatingCost.toFixed(2), calculation: ec.tree, evidence: { eventIds: [], sampleSize: 1, observedFrom: "", observedTo: "" } });
});
afterAll(async () => { if (ids.org) await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org)); });

describe("evaluation helpers", () => {
  it("weights sum to 1", () => expect(Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9));
  it("composite re-normalizes over dimensions with data", () => {
    expect(compositeScore([{ score: 80, weight: 0.5 }, { score: null, weight: 0.3 }, { score: 40, weight: 0.2 }])).toBeCloseTo((80 * 0.5 + 40 * 0.2) / 0.7, 9);
    expect(compositeScore([{ score: null, weight: 1 }])).toBeNull();
  });
  it("confidence follows evidence volume", () => {
    expect(confidenceFrom(0, 10, 3, "x").level).toBe("none");
    expect(confidenceFrom(2, 10, 3, "x").level).toBe("low");
    expect(confidenceFrom(5, 10, 3, "x").level).toBe("medium");
    expect(confidenceFrom(10, 10, 3, "x").level).toBe("high");
  });
});

describe("computeEvaluation", () => {
  it("computes 16 live steps and 9 explained dimensions", async () => {
    const ev = await computeEvaluation(ids.org);
    expect(ev.steps).toHaveLength(16);
    const s = Object.fromEntries(ev.steps.map((x) => [x.key, x.done]));
    expect(s).toMatchObject({ profile: true, structure: true, systems: false, financials: true, collectors: false, workflows: true, inefficiencies: true, potential: true, agents_recommended: true, savings: true, roadmap: false, report: false, presented: false, approved: false, deployed: false, measured: false });
    expect(ev.progressPct).toBeCloseTo((8 / 16) * 100, 9);
    expect(ev.dimensions).toHaveLength(9);
    for (const d of ev.dimensions) { expect(d.methodology.length).toBeGreaterThan(5); expect(d.inputs.length).toBeGreaterThan(0); }
    const dim = Object.fromEntries(ev.dimensions.map((d) => [d.key, d]));
    expect(dim.automationReadiness.score).toBeCloseTo(60, 6);
    expect(dim.integrationComplexity.score).toBeCloseTo(100 * (1 - 1 / 5), 6); // 2 apps
    expect(dim.technologyReadiness.score).toBeNull(); // no integrations, no collectors → excluded, not guessed
    expect(ev.excluded).toContain("technologyReadiness");
    expect(dim.dataMaturity.missingEvidence.join(" ")).toMatch(/1 employees without compensation/);
    expect(ev.score).toBeCloseTo(compositeScore(ev.dimensions)!, 9);
  });
  it("compareSnapshots returns per-dimension deltas", async () => {
    const ev = await computeEvaluation(ids.org);
    const older = { ...ev.snapshot, score: (ev.snapshot.score ?? 0) - 10, savings: { ...ev.snapshot.savings, potential: ev.snapshot.savings.potential - 1000 } };
    const c = compareSnapshots(older, ev.snapshot);
    expect(c.score).toBeCloseTo(10, 9); expect(c.savings.potential).toBeCloseTo(1000, 6);
    expect(c.dimensions.technologyReadiness).toBeNull();
  });
});
