/**
 * DB-backed finance engine tests. Requires DATABASE_URL (use bridgebox_b / bridgebox_test, never the seeded default).
 * Fixtures are inserted with the admin handle and removed afterwards (org cascade).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { inflateSync } from "node:zlib";
import { db, schema } from "@/db/client";
import { opportunityEconomics } from "@/engine/costing";
import { ensureDefaultFinancialModel, computeOrgFinancials, recordSavingsFromRunLedger, generateExecutiveReport } from "@/engine/finance";

const ids = { org: "", ops: "", fin: "", e1: "", e2: "", e3: "", e4: "", w1: "", w2: "", w3: "", o1: "", o2: "", o3: "", a1: "" };

// hand values
const H1 = (60_000 * 1.3) / 1920; // 40.625
const H2 = (48_000 * 1.3) / 1920; // 32.5
const H3 = (96_000 * 1.3) / 1920; // 65
const W1_AVG = (H1 * 12 + H2 * 8) / 20; // 37.375
const LABOR = 60_000 * 1.3 + 48_000 * 1.3 + 96_000 * 1.3; // 265,200
const O1_REC = 20 * 0.5 * 0.75; // 7.5
const O1_GROSS = O1_REC * 48 * W1_AVG; // 13,455
const O2_REC = 10 * 0.6 * 0.75; // 4.5
const O2_GROSS = O2_REC * 48 * H3; // 14,040
const GROSS = O1_GROSS + O2_GROSS;
const REALIZABLE = GROSS * 0.6;
const IMPL = (40 * 1.5 * 175 + 1500) + (60 * 1.2 * 175 + 3000); // 12,000 + 15,600
const OPEX = 149 * 12 + 220 * 12; // 1,788 + 2,640
const PLATFORM_BASE = 499 * 12;
const NET = REALIZABLE - OPEX - PLATFORM_BASE;

/** Decompress every FlateDecode stream in a pdfkit buffer and decode its hex-encoded TJ text runs into plain strings. */
function pdfText(buf: Buffer): string {
  const streams: string[] = []; const s = buf.toString("latin1"); let i = 0;
  while (true) {
    const a = s.indexOf("stream\n", i); if (a < 0) break;
    const b = s.indexOf("endstream", a); if (b < 0) break;
    const raw = buf.subarray(a + 7, b);
    try { streams.push(inflateSync(raw).toString("latin1")); } catch { streams.push(raw.toString("latin1")); }
    i = b + 9;
  }
  const lines: string[] = [];
  for (const m of streams.join("\n").matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    lines.push([...m[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join(""));
  }
  return lines.join("\n");
}

beforeAll(async () => {
  const slug = `fin-test-${Date.now()}`;
  const [org] = await db.insert(schema.organizations).values({ name: "Acme Fixtures Inc", slug, kind: "client", isDemo: true, branding: { reportName: "Acme Workforce Report", primaryColor: "#1d4ed8", footer: "Acme — internal" } }).returning();
  ids.org = org.id;
  const [ops] = await db.insert(schema.departments).values({ orgId: org.id, name: "Operations" }).returning();
  const [fin] = await db.insert(schema.departments).values({ orgId: org.id, name: "Finance" }).returning();
  ids.ops = ops.id; ids.fin = fin.id;
  const emp = async (name: string, dept: string, base: number) => (await db.insert(schema.employees).values({ orgId: org.id, departmentId: dept, displayName: name, baseAnnualCost: String(base), loadedHourlyCost: ((base * 1.3) / 1920).toFixed(2), costBasis: "observed", hoursPerWeek: "40" }).returning())[0].id;
  ids.e1 = await emp("Erin One", ops.id, 60_000);
  ids.e2 = await emp("Eli Two", ops.id, 48_000);
  ids.e3 = await emp("Eva Three", fin.id, 96_000);
  ids.e4 = await emp("Ed Four (no activity)", fin.id, 200_000);
  const wf = async (name: string, dept: string, hours: number, rep: number, links: [string, number][]) => {
    const [w] = await db.insert(schema.workflows).values({ orgId: org.id, departmentId: dept, name, signature: name.toLowerCase().replace(/\s+/g, "-"), hoursPerWeek: String(hours), repetitionScore: String(rep), automationScore: "70", employeeCount: links.length, runsPerWeek: "10", avgDurationMin: String((hours * 60) / 10) }).returning();
    for (const [eid, h] of links) await db.insert(schema.workflowEmployees).values({ orgId: org.id, workflowId: w.id, employeeId: eid, hoursPerWeek: String(h), runsPerWeek: "5", avgDurationMin: String((h * 60) / 5) });
    return w.id;
  };
  ids.w1 = await wf("Invoice entry", ops.id, 20, 80, [[ids.e1, 12], [ids.e2, 8]]);
  ids.w2 = await wf("Month-end reconciliation", fin.id, 10, 70, [[ids.e3, 10]]);
  ids.w3 = await wf("Ad-hoc customer calls", ops.id, 15, 20, [[ids.e1, 10], [ids.e2, 5]]);
  const opp = async (title: string, wfId: string, dept: string, type: "ai_agent" | "rpa" | "process_change", hours: number, auto: number, hourly: number, n: number, complexity: number, status: "identified" | "rejected") => {
    const ec = opportunityEconomics({ type, hoursPerWeek: hours, automationPct: auto, avgLoadedHourly: hourly, employeeCount: n, complexity });
    const [o] = await db.insert(schema.opportunities).values({ orgId: org.id, workflowId: wfId, departmentId: dept, title, summary: title, type, status, rank: 1, feasibility: "80", risk: "20", automationPct: String(auto), hoursRecoverablePerWeek: ec.hoursRecoverablePerWeek.toFixed(2), grossAnnualSavings: ec.grossAnnualSavings.toFixed(2), realizableAnnualSavings: ec.realizableAnnualSavings.toFixed(2), implementationCost: ec.implementationCost.toFixed(2), annualOperatingCost: ec.annualOperatingCost.toFixed(2), paybackMonths: ec.paybackMonths?.toFixed(1) ?? null, calculation: ec.tree, evidence: { eventIds: [], sampleSize: 100, observedFrom: "2026-09-01", observedTo: "2026-09-30" } }).returning();
    return o.id;
  };
  ids.o1 = await opp("Automate invoice entry", ids.w1, ops.id, "ai_agent", 20, 0.5, W1_AVG, 2, 0.5, "identified");
  ids.o2 = await opp("Bot for month-end reconciliation", ids.w2, fin.id, "rpa", 10, 0.6, H3, 1, 0.2, "identified");
  ids.o3 = await opp("Rejected idea", ids.w3, ops.id, "process_change", 15, 0.3, W1_AVG, 2, 0, "rejected");
  const [agent] = await db.insert(schema.agents).values({ orgId: org.id, opportunityId: ids.o1, workflowId: ids.w1, name: "Invoice agent", category: "ap_ar", templateKey: "invoice_entry", status: "deployed", monthlyCost: "149", definition: { nodes: [], edges: [] }, deployedAt: new Date("2026-09-25T00:00:00Z") }).returning();
  ids.a1 = agent.id;
  const run = (status: "succeeded" | "failed", minutesSaved: number, humanMinutes: number, finishedAt: string) =>
    db.insert(schema.agentRuns).values({ orgId: org.id, agentId: agent.id, status, minutesSaved: String(minutesSaved), humanMinutes: String(humanMinutes), startedAt: new Date(finishedAt), finishedAt: new Date(finishedAt) });
  await run("succeeded", 60, 10, "2026-10-03T10:00:00Z");
  await run("succeeded", 90, 10, "2026-10-15T10:00:00Z");
  await run("succeeded", 30, 0, "2026-10-28T10:00:00Z");
  await run("failed", 100, 0, "2026-10-20T10:00:00Z"); // ignored
  await run("succeeded", 500, 0, "2026-11-05T10:00:00Z"); // outside period
});

afterAll(async () => {
  if (ids.org) await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org));
});

describe("ensureDefaultFinancialModel", () => {
  it("creates one default model and is idempotent", async () => {
    const m1 = await ensureDefaultFinancialModel(ids.org);
    const m2 = await ensureDefaultFinancialModel(ids.org);
    expect(m1.id).toBe(m2.id);
    expect(m1.isDefault).toBe(true);
    expect(m1.assumptions).toMatchObject({ automationPct: 1, adoptionRate: 0.75, realizationRate: 0.6, benefitsLoadPct: 0.3, platformFeeMonthly: 499, perAgentMonthly: 149, consultingHourly: 175, workWeeksPerYear: 48, rampMonths: 3, discountRate: 0.08 });
    const rows = await db.select().from(schema.financialModels).where(eq(schema.financialModels.orgId, ids.org));
    expect(rows).toHaveLength(1);
  });
});

describe("computeOrgFinancials", () => {
  it("matches hand calculation", async () => {
    const f = await computeOrgFinancials(ids.org);
    expect(f.employeesAnalyzed).toBe(3);
    expect(f.totalAnnualLaborAnalyzed).toBeCloseTo(LABOR, 4);
    expect(f.hoursObservedPerWeek).toBeCloseTo(45, 6);
    expect(f.repetitiveHoursPerWeek).toBeCloseTo(30, 6);
    expect(f.repetitiveSharePct).toBeCloseTo(30 / 45, 9);
    expect(f.opportunityCount).toBe(2); // rejected excluded
    expect(f.hoursRecoverablePerWeek).toBeCloseTo(O1_REC + O2_REC, 6);
    expect(f.grossAnnualSavings).toBeCloseTo(GROSS, 4);
    expect(f.realizableAnnualSavings).toBeCloseTo(REALIZABLE, 4);
    expect(f.implementationCost).toBeCloseTo(IMPL, 4);
    expect(f.annualOperatingCost).toBeCloseTo(OPEX, 4);
    expect(f.deployedAgents).toBe(1);
    expect(f.platformAnnual).toBeCloseTo(PLATFORM_BASE + 149 * 12, 4);
    expect(f.netAnnualSavings).toBeCloseTo(NET, 4);
    expect(f.roi1y).toBeCloseTo((NET - IMPL) / IMPL, 9);
    expect(f.paybackMonths).toBeCloseTo(IMPL / (NET / 12), 6);
    expect(f.deploymentCompletionPct).toBeCloseTo(0.5, 9);
    expect(f.verifiedAnnualizedSavings).toBe(0);
    expect(f.automationCompletionPct).toBe(0);
    // departments
    const ops = f.byDepartment.find((d) => d.name === "Operations")!; const fin = f.byDepartment.find((d) => d.name === "Finance")!;
    expect(ops.employees).toBe(2); expect(fin.employees).toBe(1);
    expect(ops.laborAnnual).toBeCloseTo(60_000 * 1.3 + 48_000 * 1.3, 4);
    expect(ops.hoursPerWeek).toBeCloseTo(35, 6); expect(ops.repetitiveHoursPerWeek).toBeCloseTo(20, 6);
    expect(ops.recoverableHoursPerWeek).toBeCloseTo(O1_REC, 6); expect(ops.realizableAnnual).toBeCloseTo(O1_GROSS * 0.6, 4);
    expect(ops.efficiencyGainPct).toBeCloseTo(O1_REC / 35, 9);
    expect(fin.realizableAnnual).toBeCloseTo(O2_GROSS * 0.6, 4);
    // employees: e1 gets 12/20 of O1, e4 excluded
    const e1 = f.byEmployee.find((e) => e.employeeId === ids.e1)!;
    expect(e1.laborAnnual).toBeCloseTo(78_000, 4); expect(e1.loadedHourly).toBeCloseTo(H1, 6);
    expect(e1.hoursPerWeek).toBeCloseTo(22, 6); expect(e1.repetitiveHoursPerWeek).toBeCloseTo(12, 6);
    expect(e1.recoverableHoursPerWeek).toBeCloseTo(O1_REC * 12 / 20, 6);
    expect(e1.topWorkflows[0].name).toBe("Invoice entry");
    expect(f.byEmployee.find((e) => e.employeeId === ids.e4)).toBeUndefined();
    // trees and bases
    expect(f.trees.totalLabor.value).toBeCloseTo(LABOR, 4); expect(f.trees.totalLabor.basis).toBe("observed");
    expect(f.trees.realizableSavings.value).toBeCloseTo(REALIZABLE, 4);
    expect(f.trees.netSavings.value).toBeCloseTo(NET, 4);
    for (const t of Object.values(f.trees)) { expect(t.basis).toBeTruthy(); expect(t.formula).toBeTruthy(); }
    expect(f.basisSummary.observed + f.basisSummary.estimated + f.basisSummary.assumed).toBeGreaterThan(20);
    // scenarios monotonic; expected equals main
    expect(f.scenarios.expected.realizableAnnualSavings).toBeCloseTo(f.realizableAnnualSavings, 6);
    expect(f.scenarios.conservative.realizableAnnualSavings).toBeLessThan(f.scenarios.expected.realizableAnnualSavings);
    expect(f.scenarios.expected.realizableAnnualSavings).toBeLessThan(f.scenarios.aggressive.realizableAnnualSavings);
    expect(f.scenarios.conservative.implementationCost).toBeCloseTo(IMPL * 1.3, 4);
    expect(f.threeYear.years).toHaveLength(3);
    expect(f.threeYear.years[0].costs).toBeCloseTo(OPEX + PLATFORM_BASE + IMPL, 4);
  });

  it("sliders change numbers predictably", async () => {
    const adoption = await computeOrgFinancials(ids.org, { adoptionRate: 1 });
    expect(adoption.hoursRecoverablePerWeek).toBeCloseTo(20 * 0.5 + 10 * 0.6, 6);
    const realization = await computeOrgFinancials(ids.org, { realizationRate: 1 });
    expect(realization.realizableAnnualSavings).toBeCloseTo(realization.grossAnnualSavings, 4);
    const benefits = await computeOrgFinancials(ids.org, { benefitsLoadPct: 0 });
    expect(benefits.totalAnnualLaborAnalyzed).toBeCloseTo(204_000, 4);
    expect(benefits.grossAnnualSavings).toBeCloseTo(GROSS / 1.3, 4);
    const consulting = await computeOrgFinancials(ids.org, { consultingHourly: 100 });
    expect(consulting.implementationCost).toBeCloseTo((40 * 1.5 * 100 + 1500) + (60 * 1.2 * 100 + 3000), 4);
    const perAgent = await computeOrgFinancials(ids.org, { perAgentMonthly: 99 });
    expect(perAgent.annualOperatingCost).toBeCloseTo(99 * 12 + 220 * 12, 4);
    expect(perAgent.platformAnnual).toBeCloseTo(PLATFORM_BASE + 99 * 12, 4);
    const auto = await computeOrgFinancials(ids.org, { automationPct: 0.5 });
    expect(auto.hoursRecoverablePerWeek).toBeCloseTo((O1_REC + O2_REC) / 2, 6);
    const cons = await computeOrgFinancials(ids.org, { scenario: "conservative" });
    expect(cons.hoursRecoverablePerWeek).toBeCloseTo(20 * 0.35 * 0.6 + 10 * 0.42 * 0.6, 6);
    expect(cons.implementationCost).toBeCloseTo(IMPL * 1.3, 4);
    expect(cons.assumptions.realizationRate).toBe(0.45);
    const consExplicit = await computeOrgFinancials(ids.org, { scenario: "conservative", adoptionRate: 1 });
    expect(consExplicit.hoursRecoverablePerWeek).toBeCloseTo(20 * 0.35 + 10 * 0.42, 6); // explicit wins over scenario
    const subset = await computeOrgFinancials(ids.org, { opportunityIds: [ids.o1] });
    expect(subset.opportunityCount).toBe(1);
    expect(subset.hoursRecoverablePerWeek).toBeCloseTo(O1_REC, 6);
    expect(subset.implementationCost).toBeCloseTo(12_000, 4);
    const override = await computeOrgFinancials(ids.org, { implementationCostOverride: 5000, annualOpexOverride: 100 });
    expect(override.implementationCost).toBe(5000); expect(override.annualOperatingCost).toBe(100);
  });
});

describe("recordSavingsFromRunLedger", () => {
  const start = new Date("2026-10-01T00:00:00Z"), end = new Date("2026-10-31T00:00:00Z");
  it("sums succeeded runs in period, prices at performer loaded hourly, idempotent", async () => {
    const m = await recordSavingsFromRunLedger(ids.org, ids.a1, start, end);
    expect(m.method).toBe("run_ledger"); expect(m.basis).toBe("observed"); expect(m.runs).toBe(3);
    expect(Number(m.hoursSaved)).toBeCloseTo(3, 2);
    expect(Number(m.hoursAfter)).toBeCloseTo(20 / 60, 2);
    expect(Number(m.dollarsSaved)).toBeCloseTo(3 * W1_AVG, 2);
    expect(Number(m.costIncurred)).toBeCloseTo(149 * (30 / (365.25 / 12)), 2);
    expect(m.calculation.basis).toBe("observed");
    expect(m.calculation.children?.find((c) => c.label === "Average loaded hourly cost")?.value).toBeCloseTo(W1_AVG, 6);
    const again = await recordSavingsFromRunLedger(ids.org, ids.a1, start, end);
    expect(again.id).toBe(m.id);
    const rows = await db.select().from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, ids.org));
    expect(rows).toHaveLength(1);
  });
  it("verified stays separate from projected and feeds completion", async () => {
    const f = await computeOrgFinancials(ids.org);
    const annualized = 3 * W1_AVG * (365.25 / 30);
    expect(f.verifiedMeasurements).toBe(1);
    expect(f.verifiedHoursSaved).toBeCloseTo(3, 2);
    expect(f.verifiedDollarsSaved).toBeCloseTo(3 * W1_AVG, 2);
    expect(f.verifiedAnnualizedSavings).toBeCloseTo(annualized, 0); // dollarsSaved is stored to 2 decimals
    expect(f.automationCompletionPct).toBeCloseTo(annualized / REALIZABLE, 4);
    // projected untouched
    expect(f.realizableAnnualSavings).toBeCloseTo(REALIZABLE, 4);
    expect(f.grossAnnualSavings).toBeCloseTo(GROSS, 4);
    expect(f.netAnnualSavings).toBeCloseTo(NET, 4);
    expect(f.trees.verifiedSavings.basis).toBe("observed");
    expect(f.byDepartment.find((d) => d.name === "Operations")!.verifiedAnnual).toBeCloseTo(annualized, 0);
    expect(f.byDepartment.find((d) => d.name === "Finance")!.verifiedAnnual).toBe(0);
    // period filter excludes it
    const out = await computeOrgFinancials(ids.org, { periodStart: new Date("2026-12-01T00:00:00Z"), periodEnd: new Date("2026-12-31T00:00:00Z") });
    expect(out.verifiedMeasurements).toBe(0); expect(out.verifiedAnnualizedSavings).toBe(0);
  });
});

describe("generateExecutiveReport", () => {
  it("renders a white-label PDF and stores the report row", async () => {
    const { reportId, pdf } = await generateExecutiveReport(ids.org, "executive_roi");
    expect(pdf.length).toBeGreaterThan(10_000);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(pdf);
    expect(text).toContain("Executive ROI Summary");
    expect(text).toContain("Acme Workforce Report".toUpperCase());
    expect(text).toContain("SYNTHETIC DEMO DATA");
    expect(text).toContain("Assumptions");
    expect(text).toContain("Methodology");
    expect(text).toContain("Automate invoice entry"); // top opportunity title appears
    expect(text).toContain("Bot for month-end reconciliation");
    expect(text).toContain("Operations");
    expect(text).not.toContain("BridgeBox");
    const [row] = await db.select().from(schema.reports).where(eq(schema.reports.id, reportId));
    expect(row.orgId).toBe(ids.org); expect(row.kind).toBe("executive_roi");
    expect(row.pdfBytes?.length).toBeGreaterThan(10_000);
    const data = row.data as { headline: { realizableAnnualSavings: number; verifiedAnnualizedSavings: number }; byDepartment: unknown[]; topOpportunities: unknown[]; scenarios: Record<string, unknown> };
    expect(data.headline.realizableAnnualSavings).toBeCloseTo(REALIZABLE, 4);
    expect(data.byDepartment).toHaveLength(2); expect(data.topOpportunities).toHaveLength(2);
    expect(Object.keys(data.scenarios).sort()).toEqual(["aggressive", "conservative", "expected"]);
    expect(JSON.stringify(row.data)).not.toContain("byEmployee");
  });
  it("renders the other kinds", async () => {
    const prop = await generateExecutiveReport(ids.org, "investment_proposal", { scenario: "conservative" });
    expect(pdfText(prop.pdf)).toContain("Automation Investment Proposal");
    const monthly = await generateExecutiveReport(ids.org, "monthly_performance", { periodStart: new Date("2026-10-01T00:00:00Z"), periodEnd: new Date("2026-10-31T00:00:00Z") });
    expect(pdfText(monthly.pdf)).toContain("Monthly Automation Performance");
    const [row] = await db.select().from(schema.reports).where(eq(schema.reports.id, monthly.reportId));
    expect((row.data as { headline: { verifiedHoursSaved: number } }).headline.verifiedHoursSaved).toBeCloseTo(3, 2);
    const all = await db.select({ id: schema.reports.id }).from(schema.reports).where(eq(schema.reports.orgId, ids.org));
    expect(all).toHaveLength(3);
  });
});
