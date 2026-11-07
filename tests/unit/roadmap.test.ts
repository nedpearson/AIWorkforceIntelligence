/**
 * Roadmap engine tests: prioritization ordering (pure), project actual-savings lineage reconciliation (pure + DB),
 * attention list and dependency cycles. DB fixtures use the admin handle and are removed afterwards (org cascade).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { opportunityEconomics } from "@/engine/costing";
import { computeSavingsIntelligence, submitLedgerEntry, decideLedgerEntry, type LineageItem, type Tier } from "@/engine/savings";
import {
  roadmapPriority, prioritizeCandidates, PRIORITY_WEIGHTS, projectActualSavings, attentionItems, createsCycle, verificationBlocker,
  createProject, upsertMilestone, upsertRisk, verifyProject, loadRoadmap, loadSavingsLinks, type CandidateInput, type SavingsLinks,
} from "@/engine/roadmap";

const cand = (id: string, p: Partial<CandidateInput>): CandidateInput => ({ opportunityId: id, title: id, realizableAnnual: 10_000, maxRealizable: 20_000, complexity: 0.3, risk: 30, hoursRecoverablePerWeek: 5, maxHours: 10, integrationCount: 3, dataReadiness: 60, paybackMonths: 12, ...p });

describe("roadmap prioritization", () => {
  it("weights sum to 100 and score is bounded", () => {
    expect(Object.values(PRIORITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const best = roadmapPriority(cand("x", { realizableAnnual: 20_000, complexity: 0, risk: 0, hoursRecoverablePerWeek: 10, integrationCount: 1, dataReadiness: 100, paybackMonths: 0 }));
    expect(best.score).toBe(100);
    const worst = roadmapPriority(cand("y", { realizableAnnual: 0, complexity: 1, risk: 100, hoursRecoverablePerWeek: 0, integrationCount: 9, dataReadiness: 0, paybackMonths: null }));
    expect(worst.score).toBe(0);
  });
  it("orders by priority, then realizable, then id", () => {
    const out = prioritizeCandidates([
      cand("c-low", { realizableAnnual: 2_000, risk: 70, paybackMonths: null }),
      cand("a-high", { realizableAnnual: 20_000, complexity: 0.1, risk: 10, paybackMonths: 3 }),
      cand("b-mid", {}),
      cand("b-mid-twin", {}),
    ]);
    expect(out.map((c) => c.opportunityId)).toEqual(["a-high", "b-mid", "b-mid-twin", "c-low"]);
    for (let i = 1; i < out.length; i++) expect(out[i - 1].priorityScore).toBeGreaterThanOrEqual(out[i].priorityScore);
  });
  it("higher financial impact ranks higher when all else equal", () => {
    const out = prioritizeCandidates([cand("small", { realizableAnnual: 5_000 }), cand("big", { realizableAnnual: 15_000 })]);
    expect(out[0].opportunityId).toBe("big");
  });
});

describe("projectActualSavings (pure lineage filter)", () => {
  const li = (type: LineageItem["type"], id: string, amount: number, hours = 0): LineageItem => ({ type, id, label: id, href: "#", amount, hours, basis: "observed" });
  const tier = (lineage: LineageItem[]): Tier => ({ key: "potential", label: "", description: "", amount: lineage.reduce((s, x) => s + x.amount, 0), basis: "observed", color: "gold", tree: { label: "", value: 0, basis: "observed" }, lineage });
  const si = { tiers: {
    potential: tier([]), net: tier([]), capacityReleased: tier([]),
    verifiedTime: tier([li("measurement", "m1", 100, 4), li("measurement", "m2", 50, 2), li("measurement", "m3", 30, 1)]),
    approved: tier([li("ledger", "l1", 1_000), li("ledger", "l2", 2_000)]),
    costAvoidance: tier([li("ledger", "l3", 500)]), realizedHard: tier([li("ledger", "l4", 700)]),
  } };
  const links: SavingsLinks = {
    measurementAgent: new Map([["m1", "agA"], ["m2", "agB"], ["m3", null]]),
    ledger: new Map([["l1", { opportunityId: "o1", projectId: null, agentId: null }], ["l2", { opportunityId: "o2", projectId: null, agentId: null }], ["l3", { opportunityId: null, projectId: "p1", agentId: null }], ["l4", { opportunityId: null, projectId: null, agentId: "agB" }]]),
    agentOpportunity: new Map([["agA", "o1"], ["agB", "o2"]]),
  };
  it("filters to the project's opportunities and agents, and partitions reconcile with tier lineage", () => {
    const p1 = projectActualSavings({ id: "p1", opportunityIds: ["o1"], agentIds: [] }, si, links);
    const p2 = projectActualSavings({ id: "p2", opportunityIds: ["o2"], agentIds: [] }, si, links);
    expect(p1.agentIds).toEqual(["agA"]);
    expect(p1.verifiedTime.amount).toBe(100); expect(p1.verifiedTime.hours).toBe(4);
    expect(p1.approved.amount).toBe(1_000); expect(p1.costAvoidance.amount).toBe(500); expect(p1.realizedHard.amount).toBe(0);
    expect(p2.verifiedTime.amount).toBe(50); expect(p2.approved.amount).toBe(2_000); expect(p2.realizedHard.amount).toBe(700);
    // every project bucket equals the Σ of the exact lineage items it cites
    for (const p of [p1, p2]) for (const b of [p.verifiedTime, p.approved, p.costAvoidance, p.realizedHard]) expect(b.amount).toBe(b.items.reduce((s, i) => s + i.amount, 0));
    // disjoint projects: Σ projects + unlinked items = tier lineage total
    const unlinkedVerified = 30; // m3 has no agent
    expect(p1.verifiedTime.amount + p2.verifiedTime.amount + unlinkedVerified).toBe(si.tiers.verifiedTime.lineage.reduce((s, x) => s + x.amount, 0));
    expect(p1.approved.amount + p2.approved.amount).toBe(si.tiers.approved.amount);
  });
  it("blocks verification until a linked agent has a measurement", () => {
    expect(verificationBlocker({ agents: [], verifiedAt: null })).toMatch(/No agents/);
    expect(verificationBlocker({ agents: [{ id: "a", name: "a", status: "deployed", measurements: 0 }], verifiedAt: null })).toMatch(/measurement/);
    expect(verificationBlocker({ agents: [{ id: "a", name: "a", status: "deployed", measurements: 1 }], verifiedAt: null })).toBeNull();
  });
});

describe("attention + dependencies", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  it("flags overdue, blocked dependencies and unmitigated high risks", () => {
    const items = attentionItems([
      { id: "m1", projectId: "p", name: "Design", status: "in_progress", startDate: "2026-10-01T00:00:00Z", dueDate: "2026-11-01T00:00:00Z", dependsOnMilestoneId: null },
      { id: "m2", projectId: "p", name: "Build", status: "in_progress", startDate: "2026-11-02T00:00:00Z", dueDate: "2026-12-01T00:00:00Z", dependsOnMilestoneId: "m1" },
      { id: "m3", projectId: "p", name: "Done thing", status: "done", startDate: null, dueDate: "2026-10-01T00:00:00Z", dependsOnMilestoneId: null },
    ], [
      { id: "r1", projectId: "p", title: "Data quality", severity: 5, likelihood: 4, mitigation: "", status: "open" },
      { id: "r2", projectId: "p", title: "Mitigated", severity: 5, likelihood: 5, mitigation: "Plan B", status: "open" },
      { id: "r3", projectId: "p", title: "Low", severity: 2, likelihood: 2, mitigation: null, status: "open" },
    ], now);
    expect(items.map((i) => `${i.kind}:${i.refId}`).sort()).toEqual(["blocked_dependency:m2", "high_risk:r1", "overdue:m1"]);
  });
  it("detects dependency cycles", () => {
    const ms = [{ id: "a", dependsOnMilestoneId: null }, { id: "b", dependsOnMilestoneId: "a" }, { id: "c", dependsOnMilestoneId: "b" }];
    expect(createsCycle(ms, "a", "c")).toBe(true);
    expect(createsCycle(ms, "a", "a")).toBe(true);
    expect(createsCycle(ms, "c", "a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// DB: reconciliation against the real Savings Intelligence Engine
// ---------------------------------------------------------------------------------------------
const ids = { org: "", user: "", approver: "", dept: "", w1: "", w2: "", e1: "", o1: "", o2: "", a1: "", p1: "" };

beforeAll(async () => {
  const [org] = await db.insert(schema.organizations).values({ name: "Roadmap Fixtures", slug: `roadmap-test-${Date.now()}`, kind: "client", isDemo: true }).returning();
  ids.org = org.id;
  const [u] = await db.insert(schema.users).values({ email: `rm-owner-${Date.now()}@test.local`, name: "Owner" }).returning(); ids.user = u.id;
  const [u2] = await db.insert(schema.users).values({ email: `rm-cfo-${Date.now()}@test.local`, name: "CFO" }).returning(); ids.approver = u2.id;
  await db.insert(schema.memberships).values([{ userId: u.id, orgId: org.id, role: "owner" }, { userId: u2.id, orgId: org.id, role: "admin" }]);
  const [d] = await db.insert(schema.departments).values({ orgId: org.id, name: "Ops" }).returning(); ids.dept = d.id;
  const [e] = await db.insert(schema.employees).values({ orgId: org.id, departmentId: d.id, displayName: "Pat", baseAnnualCost: "60000", costBasis: "observed", hoursPerWeek: "40" }).returning(); ids.e1 = e.id;
  const mkWf = async (name: string) => { const [w] = await db.insert(schema.workflows).values({ orgId: org.id, departmentId: d.id, name, signature: name, hoursPerWeek: "10", repetitionScore: "80", automationScore: "70", employeeCount: 1, runsPerWeek: "10", avgDurationMin: "60" }).returning(); await db.insert(schema.workflowEmployees).values({ orgId: org.id, workflowId: w.id, employeeId: e.id, hoursPerWeek: "10" }); return w.id; };
  ids.w1 = await mkWf("Invoices"); ids.w2 = await mkWf("Reports");
  const mkOpp = async (title: string, wf: string) => { const ec = opportunityEconomics({ type: "ai_agent", hoursPerWeek: 10, automationPct: 0.5, avgLoadedHourly: 40.625, employeeCount: 1, complexity: 0.2 }); const [o] = await db.insert(schema.opportunities).values({ orgId: org.id, workflowId: wf, departmentId: d.id, title, summary: title, type: "ai_agent", feasibility: "70", risk: "20", automationPct: "0.5", hoursRecoverablePerWeek: ec.hoursRecoverablePerWeek.toFixed(2), grossAnnualSavings: ec.grossAnnualSavings.toFixed(2), realizableAnnualSavings: ec.realizableAnnualSavings.toFixed(2), implementationCost: ec.implementationCost.toFixed(2), annualOperatingCost: ec.annualOperatingCost.toFixed(2), calculation: ec.tree, evidence: { eventIds: [], sampleSize: 50, observedFrom: "", observedTo: "" } }).returning(); return o.id; };
  ids.o1 = await mkOpp("Invoice agent", ids.w1); ids.o2 = await mkOpp("Report agent", ids.w2);
  const [a] = await db.insert(schema.agents).values({ orgId: org.id, opportunityId: ids.o1, workflowId: ids.w1, name: "Invoice bot", category: "invoice", templateKey: "invoice", status: "deployed", definition: { nodes: [], edges: [] } }).returning(); ids.a1 = a.id;
  const tree = { label: "m", value: 1, basis: "observed" as const };
  await db.insert(schema.savingsMeasurements).values([
    { orgId: org.id, agentId: a.id, workflowId: ids.w1, periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-10-01"), method: "run_ledger", runs: 20, hoursSaved: "12", dollarsSaved: "480", calculation: tree },
    { orgId: org.id, agentId: null, workflowId: ids.w2, periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-10-01"), method: "manual_attestation", runs: 0, hoursSaved: "3", dollarsSaved: "120", calculation: tree },
  ]);
  const l1 = await submitLedgerEntry(org.id, u.id, { tier: "approved", title: "Invoice case", annualAmount: 5_000, opportunityId: ids.o1, workflowId: ids.w1, effectiveFrom: new Date(), evidence: [] });
  await decideLedgerEntry(org.id, u2.id, l1.id, "approve");
  const l2 = await submitLedgerEntry(org.id, u.id, { tier: "approved", title: "Report case", annualAmount: 3_000, opportunityId: ids.o2, workflowId: ids.w2, effectiveFrom: new Date(), evidence: [] });
  await decideLedgerEntry(org.id, u2.id, l2.id, "approve");
});
afterAll(async () => {
  if (ids.org) await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org));
  for (const id of [ids.user, ids.approver]) if (id) await db.delete(schema.users).where(eq(schema.users.id, id));
});

describe("roadmap (DB)", () => {
  it("project actual savings reconcile with the Savings Intelligence lineage", async () => {
    const p = await createProject(ids.org, ids.user, { name: "Invoice automation", opportunityIds: [ids.o1], targetAnnualSavings: 6_000 });
    ids.p1 = p.id;
    const [si, links] = await Promise.all([computeSavingsIntelligence(ids.org), loadSavingsLinks(ids.org)]);
    const s = projectActualSavings({ id: p.id, opportunityIds: [ids.o1], agentIds: [] }, si, links);
    expect(s.agentIds).toEqual([ids.a1]);
    // only the measurement on the linked agent, at exactly the amount the savings engine reports for it
    const [mine] = si.tiers.verifiedTime.lineage.filter((x) => links.measurementAgent.get(x.id) === ids.a1);
    const other = si.tiers.verifiedTime.lineage.filter((x) => links.measurementAgent.get(x.id) !== ids.a1);
    expect(s.verifiedTime.items).toHaveLength(1);
    expect(s.verifiedTime.amount).toBeCloseTo(mine.amount, 6);
    expect(s.verifiedTime.hours).toBeCloseTo(mine.hours ?? 0, 6);
    expect(s.verifiedTime.amount).toBeGreaterThanOrEqual(480); // ≥ raw dollars (engine annualizes)
    expect(s.approved.amount).toBeCloseTo(5_000, 6);
    const tierVerified = si.tiers.verifiedTime.lineage.reduce((t, x) => t + x.amount, 0);
    expect(s.verifiedTime.amount + other.reduce((t, x) => t + x.amount, 0)).toBeCloseTo(tierVerified, 6);
    expect(s.verifiedTime.items.every((i) => si.tiers.verifiedTime.lineage.some((x) => x.id === i.id && x.amount === i.amount))).toBe(true);
    const rm = await loadRoadmap(ids.org);
    const proj = rm.projects.find((x) => x.id === p.id)!;
    expect(proj.savings.verifiedTime.amount).toBeCloseTo(mine.amount, 6);
    expect(proj.agents.map((a) => a.measurements)).toEqual([1]);
    expect(rm.candidates.map((c) => c.opportunityId)).toEqual([ids.o2]); // o1 already in a project
  });
  it("milestones, risks and verification", async () => {
    const m1 = await upsertMilestone(ids.org, ids.user, ids.p1, { name: "Build", startDate: new Date("2026-10-01"), dueDate: new Date("2026-10-20"), status: "done" });
    const m2 = await upsertMilestone(ids.org, ids.user, ids.p1, { name: "Pilot", startDate: new Date("2026-10-21"), dueDate: new Date("2026-11-30"), dependsOnMilestoneId: m1.id });
    await expect(upsertMilestone(ids.org, ids.user, ids.p1, { name: "Build", dependsOnMilestoneId: m2.id }, m1.id)).rejects.toThrow(/cycle/);
    await upsertRisk(ids.org, ids.user, ids.p1, { title: "Vendor API limits", severity: 4, likelihood: 4 });
    const rm = await loadRoadmap(ids.org);
    expect(rm.attention.some((a) => a.kind === "high_risk")).toBe(true);
    const v = await verifyProject(ids.org, ids.user, ids.p1);
    expect(v.verifiedAt).toBeTruthy();
    await expect(verifyProject(ids.org, ids.user, ids.p1)).rejects.toThrow(/already/);
  });
  it("refuses to verify a project whose agents have no measurement", async () => {
    const p = await createProject(ids.org, ids.user, { name: "Reports", opportunityIds: [ids.o2] });
    await expect(verifyProject(ids.org, ids.user, p.id)).rejects.toThrow(/no linked agent/);
  });
});
