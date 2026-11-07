/**
 * Savings Intelligence Engine — DB-backed. Run with DATABASE_URL pointing at a scratch DB (never the seeded default).
 * Own fixture org; removed afterwards (org cascade). Users are created and deleted explicitly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { opportunityEconomics, DEFAULTS } from "@/engine/costing";
import { computeOrgFinancials, MAX_AUTOMATABLE_SHARE } from "@/engine/finance";
import { computeSavingsIntelligence, submitLedgerEntry, decideLedgerEntry } from "@/engine/savings";

const ids = { org: "", ops: "", w1: "", w2: "", w3: "", oA: "", oB: "", oC: "", oU: "", agent: "", u1: "", u2: "", proj: "" };
const HOURLY = (60_000 * 1.3) / 1920;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(schema.organizations).values({ name: "Savings Fixture Co", slug: `sav-test-${stamp}`, kind: "client", isDemo: true }).returning();
  ids.org = org.id;
  const [u1] = await db.insert(schema.users).values({ email: `sav-sub-${stamp}@test.local`, name: "Submitter" }).returning();
  const [u2] = await db.insert(schema.users).values({ email: `sav-cfo-${stamp}@test.local`, name: "CFO" }).returning();
  ids.u1 = u1.id; ids.u2 = u2.id;
  await db.insert(schema.memberships).values([{ userId: u1.id, orgId: org.id, role: "admin" }, { userId: u2.id, orgId: org.id, role: "owner" }]);
  const [ops] = await db.insert(schema.departments).values({ orgId: org.id, name: "Operations" }).returning(); ids.ops = ops.id;
  const [e1] = await db.insert(schema.employees).values({ orgId: org.id, departmentId: ops.id, displayName: "Erin", baseAnnualCost: "60000", loadedHourlyCost: HOURLY.toFixed(2), costBasis: "observed", hoursPerWeek: "40" }).returning();
  const [e2] = await db.insert(schema.employees).values({ orgId: org.id, departmentId: null, displayName: "Una (no dept)", baseAnnualCost: "60000", loadedHourlyCost: HOURLY.toFixed(2), costBasis: "observed", hoursPerWeek: "40" }).returning();
  const wf = async (name: string, dept: string | null, hours: number, emp: string) => {
    const [w] = await db.insert(schema.workflows).values({ orgId: org.id, departmentId: dept, name, signature: name, hoursPerWeek: String(hours), repetitionScore: "80", automationScore: "70", employeeCount: 1, runsPerWeek: "10", avgDurationMin: String((hours * 60) / 10) }).returning();
    await db.insert(schema.workflowEmployees).values({ orgId: org.id, workflowId: w.id, employeeId: emp, hoursPerWeek: String(hours), runsPerWeek: "10", avgDurationMin: "6" });
    return w.id;
  };
  ids.w1 = await wf("Invoice entry", ops.id, 20, e1.id);
  ids.w2 = await wf("Reconciliation", ops.id, 10, e1.id);
  ids.w3 = await wf("Unassigned filing", null, 8, e2.id);
  const opp = async (title: string, wfId: string, dept: string | null, auto: number) => {
    const ec = opportunityEconomics({ type: "rpa", hoursPerWeek: 20, automationPct: auto, avgLoadedHourly: HOURLY, employeeCount: 1, complexity: 0.2 });
    const [o] = await db.insert(schema.opportunities).values({ orgId: org.id, workflowId: wfId, departmentId: dept, title, summary: title, type: "rpa", status: "identified", rank: 1, feasibility: "80", risk: "20", automationPct: String(auto), hoursRecoverablePerWeek: ec.hoursRecoverablePerWeek.toFixed(2), grossAnnualSavings: ec.grossAnnualSavings.toFixed(2), realizableAnnualSavings: ec.realizableAnnualSavings.toFixed(2), implementationCost: ec.implementationCost.toFixed(2), annualOperatingCost: ec.annualOperatingCost.toFixed(2), calculation: ec.tree, evidence: { eventIds: [], sampleSize: 50, observedFrom: "2026-09-01", observedTo: "2026-09-30" } }).returning();
    return o.id;
  };
  // A and B share workflow w1 and together claim (0.8 + 0.6) × 20 × 0.75 = 21 hrs/wk > cap 20 × 0.9 × 0.75 = 13.5.
  ids.oA = await opp("Bot A on invoice entry", ids.w1, ops.id, 0.8);
  ids.oB = await opp("Bot B on invoice entry", ids.w1, ops.id, 0.6);
  ids.oC = await opp("Reconciliation bot", ids.w2, ops.id, 0.5);
  ids.oU = await opp("Unassigned filing bot", ids.w3, null, 0.5);
  const [agent] = await db.insert(schema.agents).values({ orgId: org.id, opportunityId: ids.oC, workflowId: ids.w2, name: "Recon agent", category: "ap_ar", templateKey: "x", status: "deployed", monthlyCost: "100", definition: { nodes: [], edges: [] } }).returning();
  ids.agent = agent.id;
  // 30-day measurement: 40 hrs, $1,600 → annualized × 365.25/30
  await db.insert(schema.savingsMeasurements).values({ orgId: org.id, agentId: agent.id, workflowId: ids.w2, periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-10-01T00:00:00Z"), method: "run_ledger", runs: 40, hoursSaved: "40", dollarsSaved: "1600", calculation: { label: "m", value: 1600, basis: "observed" } });
  const [p] = await db.insert(schema.projects).values({ orgId: org.id, name: "Recon rollout", status: "live", spent: "9000" }).returning(); ids.proj = p.id;
});

afterAll(async () => {
  if (ids.org) await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org));
  const u = [ids.u1, ids.u2].filter(Boolean); if (u.length) await db.delete(schema.users).where(inArray(schema.users.id, u));
});

const VERIFIED_HOURS = 40 * (365.25 / 30);
const VERIFIED_USD = 1600 * (365.25 / 30);

describe("Savings Intelligence Engine", () => {
  it("overlap de-dup caps shared workflows and never double counts", async () => {
    const si = await computeSavingsIntelligence(ids.org);
    const fin = await computeOrgFinancials(ids.org);
    const a = fin.opportunities.find((o) => o.id === ids.oA)!; const b = fin.opportunities.find((o) => o.id === ids.oB)!;
    expect(a.hoursRecoverablePerWeek + b.hoursRecoverablePerWeek).toBeCloseTo(20 * MAX_AUTOMATABLE_SHARE * 0.75, 6);
    expect(a.overlap).toBeDefined(); expect(b.overlap).toBeDefined();
    expect(si.overlapRemovedAnnual).toBeGreaterThan(0);
    expect(si.tiers.potential.amount).toBeCloseTo(fin.opportunities.reduce((s, o) => s + o.realizableAnnualSavings, 0), 6);
    expect(si.checks.find((c) => c.key === "overlap")!.status).toBe("pass");
    expect(si.checks.find((c) => c.key === "opp_rollup")!.status).toBe("pass");
  });

  it("department roll-up check passes with an unassigned opportunity (counted once)", async () => {
    const si = await computeSavingsIntelligence(ids.org);
    const c = si.checks.find((x) => x.key === "dept_rollup")!;
    expect(c.status).toBe("pass");
    expect(c.detail).toMatch(/unassigned \$[1-9]/);
  });

  it("evidence is required for realized hard and cost avoidance (blank rows do not count)", async () => {
    await expect(submitLedgerEntry(ids.org, ids.u1, { tier: "realized_hard", title: "x hard", annualAmount: 100, effectiveFrom: new Date("2026-10-01"), evidence: [] })).rejects.toThrow(/evidence/);
    await expect(submitLedgerEntry(ids.org, ids.u1, { tier: "cost_avoidance", title: "x avoid", annualAmount: 100, effectiveFrom: new Date("2026-10-01"), evidence: [{ kind: "invoice", ref: "  " }] })).rejects.toThrow(/evidence/);
    const ok = await submitLedgerEntry(ids.org, ids.u1, { tier: "approved", title: "Approved case without evidence", annualAmount: 5000, opportunityId: ids.oC, effectiveFrom: new Date("2026-10-01"), evidence: [] });
    expect(ok.status).toBe("submitted");
    await decideLedgerEntry(ids.org, ids.u2, ok.id, "approve");
  });

  it("tiers never mix: ledger entries move only their own tier", async () => {
    const before = await computeSavingsIntelligence(ids.org);
    const e = await submitLedgerEntry(ids.org, ids.u1, { tier: "cost_avoidance", title: "Req not opened", annualAmount: 7000, hoursPerYear: 100, workflowId: ids.w2, effectiveFrom: new Date("2026-10-01"), evidence: [{ kind: "headcount_plan", ref: "HC-2026-14" }] });
    await decideLedgerEntry(ids.org, ids.u2, e.id, "approve");
    const after = await computeSavingsIntelligence(ids.org);
    expect(after.tiers.costAvoidance.amount - before.tiers.costAvoidance.amount).toBeCloseTo(7000, 6);
    for (const k of ["potential", "approved", "verifiedTime", "realizedHard"] as const) expect(after.tiers[k].amount).toBeCloseTo(before.tiers[k].amount, 6);
    expect(after.tiers.approved.amount).toBeCloseTo(5000, 6);
    expect(after.tiers.verifiedTime.amount).toBeCloseTo(VERIFIED_USD, 4);
  });

  it("ledger dedupe: two approved entries on the same workflow+tier → only the newest counts, check warns", async () => {
    const first = await submitLedgerEntry(ids.org, ids.u1, { tier: "realized_hard", title: "Overtime cut (Q3)", annualAmount: 4000, hoursPerYear: 50, workflowId: ids.w2, effectiveFrom: new Date("2026-09-15"), evidence: [{ kind: "payroll_report", ref: "PR-Q3" }] });
    await decideLedgerEntry(ids.org, ids.u2, first.id, "approve");
    await new Promise((r) => setTimeout(r, 20));
    const second = await submitLedgerEntry(ids.org, ids.u1, { tier: "realized_hard", title: "Overtime cut (restated)", annualAmount: 6000, hoursPerYear: 80, workflowId: ids.w2, effectiveFrom: new Date("2026-10-01"), evidence: [{ kind: "payroll_report", ref: "PR-Q4" }] });
    await decideLedgerEntry(ids.org, ids.u2, second.id, "approve");
    const si = await computeSavingsIntelligence(ids.org);
    expect(si.tiers.realizedHard.amount).toBeCloseTo(6000, 6);
    expect(si.tiers.realizedHard.lineage.map((l) => l.id)).toEqual([second.id]);
    expect(si.checks.find((c) => c.key === "ledger_dupes")!.status).toBe("warn");
  });

  it("capacity released = verified hours − converted hours; net = hard + avoidance − attributable", async () => {
    const si = await computeSavingsIntelligence(ids.org, {}, { amortizationYears: 3 });
    const converted = 100 + 80; // cost avoidance 100 h + newest realized hard 80 h
    expect(si.tiers.verifiedTime.hours).toBeCloseTo(VERIFIED_HOURS, 4);
    expect(si.tiers.capacityReleased.hours).toBeCloseTo(VERIFIED_HOURS - converted, 4);
    expect(si.tiers.capacityReleased.amount).toBeCloseTo((VERIFIED_HOURS - converted) * (VERIFIED_USD / VERIFIED_HOURS), 4);
    const platform = DEFAULTS.platformFeeMonthly * 12;
    const attributable = 9000 / 3 + 100 * 12 + platform;
    expect(si.attributableCost.total).toBeCloseTo(attributable, 6);
    expect(si.tiers.net.amount).toBeCloseTo(6000 + 7000 - attributable, 6);
    // lineage of net reconciles to the tier (incl. platform fee assumption row)
    expect(si.tiers.net.lineage.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(si.tiers.net.amount, 4);
    // amortization changes only the attributable cost
    const si5 = await computeSavingsIntelligence(ids.org, {}, { amortizationYears: 5 });
    expect(si5.tiers.net.amount - si.tiers.net.amount).toBeCloseTo(9000 / 3 - 9000 / 5, 6);
    expect(si.checks.find((c) => c.key === "capacity_nonnegative")!.status).toBe("pass");
    expect(si.checks.find((c) => c.key === "evidence")!.status).toBe("pass");
  });

  it("segregation of duties: self-approval is allowed but flagged", async () => {
    let si = await computeSavingsIntelligence(ids.org);
    expect(si.checks.find((c) => c.key === "sod")!.status).toBe("pass");
    const e = await submitLedgerEntry(ids.org, ids.u2, { tier: "realized_hard", title: "Vendor fee reduction", annualAmount: 1200, opportunityId: ids.oA, effectiveFrom: new Date("2026-10-01"), evidence: [{ kind: "vendor_contract", ref: "VC-88" }] });
    si = await computeSavingsIntelligence(ids.org);
    expect(si.pendingApprovals.find((p) => p.id === e.id)?.submittedById).toBe(ids.u2);
    await decideLedgerEntry(ids.org, ids.u2, e.id, "approve");
    si = await computeSavingsIntelligence(ids.org);
    expect(si.checks.find((c) => c.key === "sod")!.status).toBe("warn");
    const [log] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, e.id)).orderBy(schema.auditLog.ts);
    expect(log).toBeDefined();
    const approvals = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "savings.approved"));
    expect(approvals.find((a) => a.entityId === e.id)?.details).toMatchObject({ selfApproval: true });
  });

  it("future-dated hard savings are excluded until in effect; rejected entries never count", async () => {
    const before = await computeSavingsIntelligence(ids.org);
    const f = await submitLedgerEntry(ids.org, ids.u1, { tier: "realized_hard", title: "Next year contract", annualAmount: 99_000, opportunityId: ids.oU, effectiveFrom: new Date(Date.now() + 90 * 86_400_000), evidence: [{ kind: "vendor_contract", ref: "VC-2027" }] });
    await decideLedgerEntry(ids.org, ids.u2, f.id, "approve");
    const r = await submitLedgerEntry(ids.org, ids.u1, { tier: "realized_hard", title: "Rejected claim", annualAmount: 50_000, projectId: ids.proj, effectiveFrom: new Date("2026-10-01"), evidence: [{ kind: "invoice", ref: "INV-1" }] });
    await decideLedgerEntry(ids.org, ids.u2, r.id, "reject", "No GL support");
    await expect(decideLedgerEntry(ids.org, ids.u2, r.id, "approve")).rejects.toThrow(/already rejected/);
    const after = await computeSavingsIntelligence(ids.org);
    expect(after.tiers.realizedHard.amount).toBeCloseTo(before.tiers.realizedHard.amount, 6);
    expect(after.checks.find((c) => c.key === "in_effect")!.detail).toMatch(/1 approved entry/);
  });
});
