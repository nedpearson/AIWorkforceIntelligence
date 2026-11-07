/**
 * Exports engine tests (DB-backed). Requires DATABASE_URL pointing at a non-default DB (e.g. bridgebox_g / bridgebox_test).
 * Fixture org is inserted with the admin handle and removed afterwards (org cascade).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { inflateRawSync } from "node:zlib";
import { db, schema } from "@/db/client";
import { opportunityEconomics } from "@/engine/costing";
import { computeOrgFinancials } from "@/engine/finance";
import { computeSavingsIntelligence } from "@/engine/savings";
import {
  buildDeckSlides, buildExecutiveDeck, buildExecutiveWorkbook, computeExecutiveModel, computePortfolio, deckFromModel, fiveYearProjection,
  resolveDepartmentFilter, sanitizeOverrides, workbookFromModel,
} from "@/engine/exports";

const ids = { org: "", parent: "", bu: "", loc: "", ops: "", fin: "", e1: "", e2: "", e3: "", w1: "", w2: "", o1: "", o2: "", o3: "", agent: "" };

beforeAll(async () => {
  const t = Date.now();
  const [parent] = await db.insert(schema.organizations).values({ name: "Exports Consultancy", slug: `exp-parent-${t}`, kind: "consultancy" }).returning();
  ids.parent = parent.id;
  const [org] = await db.insert(schema.organizations).values({ name: "Exports Fixture Co", slug: `exp-test-${t}`, kind: "client", parentOrgId: parent.id, isDemo: true, branding: { reportName: "Fixture Report", primaryColor: "#7c3aed" } }).returning();
  ids.org = org.id;
  const [bu] = await db.insert(schema.businessUnits).values({ orgId: org.id, name: "North" }).returning(); ids.bu = bu.id;
  const [loc] = await db.insert(schema.locations).values({ orgId: org.id, name: "Houston", businessUnitId: bu.id }).returning(); ids.loc = loc.id;
  const [ops] = await db.insert(schema.departments).values({ orgId: org.id, name: "Operations", businessUnitId: bu.id, locationId: loc.id, annualOverhead: "50000", overheadBasis: "observed" }).returning();
  const [fin] = await db.insert(schema.departments).values({ orgId: org.id, name: "Finance" }).returning();
  ids.ops = ops.id; ids.fin = fin.id;
  const emp = async (name: string, dept: string, base: number) => (await db.insert(schema.employees).values({ orgId: org.id, departmentId: dept, displayName: name, baseAnnualCost: String(base), costBasis: "observed", hoursPerWeek: "40" }).returning())[0].id;
  ids.e1 = await emp("A One", ops.id, 60_000); ids.e2 = await emp("B Two", ops.id, 50_000); ids.e3 = await emp("C Three", fin.id, 90_000);
  const wf = async (name: string, dept: string, hours: number, rep: number, links: [string, number][], sample: number) => {
    const [w] = await db.insert(schema.workflows).values({ orgId: org.id, departmentId: dept, name, signature: name, hoursPerWeek: String(hours), repetitionScore: String(rep), automationScore: "70", employeeCount: links.length, runsPerWeek: "10", avgDurationMin: "30", reworkRate: "0.08", handoffCount: 2, evidence: { eventIds: [], sampleSize: sample, observedFrom: "", observedTo: "" } }).returning();
    for (const [e, h] of links) await db.insert(schema.workflowEmployees).values({ orgId: org.id, workflowId: w.id, employeeId: e, hoursPerWeek: String(h) });
    return w.id;
  };
  ids.w1 = await wf("Order entry", ops.id, 24, 85, [[ids.e1, 14], [ids.e2, 10]], 400);
  ids.w2 = await wf("Reconciliation", fin.id, 12, 70, [[ids.e3, 12]], 30);
  const opp = async (title: string, w: string, dept: string, type: "ai_agent" | "rpa", hours: number, auto: number, sample: number) => {
    const ec = opportunityEconomics({ type, hoursPerWeek: hours, automationPct: auto, avgLoadedHourly: 40, employeeCount: 2, complexity: 0.3 });
    const [o] = await db.insert(schema.opportunities).values({ orgId: org.id, workflowId: w, departmentId: dept, title, summary: title, type, status: "identified", rank: 1, feasibility: "80", risk: "20", automationPct: String(auto), hoursRecoverablePerWeek: ec.hoursRecoverablePerWeek.toFixed(2), grossAnnualSavings: ec.grossAnnualSavings.toFixed(2), realizableAnnualSavings: ec.realizableAnnualSavings.toFixed(2), implementationCost: ec.implementationCost.toFixed(2), annualOperatingCost: ec.annualOperatingCost.toFixed(2), calculation: ec.tree, evidence: { eventIds: [], sampleSize: sample, observedFrom: "", observedTo: "" } }).returning();
    return o.id;
  };
  ids.o1 = await opp("Order agent", ids.w1, ops.id, "ai_agent", 24, 0.6, 400);
  ids.o2 = await opp("Order bot (overlaps)", ids.w1, ops.id, "rpa", 24, 0.6, 120);
  ids.o3 = await opp("Recon bot", ids.w2, fin.id, "rpa", 12, 0.5, 30);
  const [agent] = await db.insert(schema.agents).values({ orgId: org.id, opportunityId: ids.o1, workflowId: ids.w1, name: "Order agent", category: "data_entry", templateKey: "x", status: "deployed", monthlyCost: "149", definition: { nodes: [], edges: [] } }).returning();
  ids.agent = agent.id;
  await db.insert(schema.savingsMeasurements).values({ orgId: org.id, agentId: agent.id, workflowId: ids.w1, periodStart: new Date("2026-10-01"), periodEnd: new Date("2026-10-31"), method: "run_ledger", hoursSaved: "40", dollarsSaved: "1600", basis: "observed", calculation: { label: "x", value: 1600, basis: "observed" } });
  await db.insert(schema.projects).values({ orgId: org.id, name: "Order automation", status: "live", spent: "9000", budget: "12000" });
  await db.insert(schema.savingsLedger).values({ orgId: org.id, tier: "realized_hard", status: "approved", title: "Overtime reduction", annualAmount: "6000", hoursPerYear: "150", dedupeKey: ids.w1, effectiveFrom: new Date("2026-10-01"), evidence: [{ kind: "payroll", ref: "OT-Oct" }] });
});

afterAll(async () => {
  if (ids.org) await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org));
  if (ids.parent) await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.parent));
});

describe("computeExecutiveModel", () => {
  it("reconciles to computeOrgFinancials and the savings engine", async () => {
    const [m, f, s] = await Promise.all([computeExecutiveModel(ids.org, { scenario: "expected" }), computeOrgFinancials(ids.org, { scenario: "expected" }), computeSavingsIntelligence(ids.org, { scenario: "expected" })]);
    expect(m.fin.realizableAnnualSavings).toBeCloseTo(f.realizableAnnualSavings, 6);
    expect(m.headline.automationOpportunity.value).toBeCloseTo(f.grossAnnualSavings, 6);
    expect(m.headline.projectedNet.value).toBeCloseTo(f.netAnnualSavings, 6);
    expect(m.headline.laborExpense.value).toBeCloseTo(f.totalAnnualLaborAnalyzed, 6);
    expect(m.headline.verified.value).toBeCloseTo(s.tiers.verifiedTime.amount, 6);
    expect(m.savings.tiers.net.amount).toBeCloseTo(s.tiers.net.amount, 6);
    expect(m.fin.overlapRemovedAnnual).toBeGreaterThan(0);
    // department + opportunity roll-ups equal the enterprise total
    expect(m.departments.reduce((a, d) => a + d.realizableAnnual, 0)).toBeCloseTo(f.realizableAnnualSavings, 4);
    expect(m.recommendations.reduce((a, r) => a + r.realizableAnnual, 0)).toBeCloseTo(f.realizableAnnualSavings, 4);
    // heatmap cells sum to the same total
    expect(m.heatmap.rows.flatMap((r) => Object.values(r.cells)).reduce((a, c) => a + c.value, 0)).toBeCloseTo(f.realizableAnnualSavings, 4);
    // opex only from entered overhead
    expect(m.opex.show).toBe(true);
    expect(m.opex.total).toBeCloseTo(f.totalAnnualLaborAnalyzed + 50_000, 4);
    // labor tree is aggregated by department — no employee names leave the server
    const names = JSON.stringify(m.headline.laborExpense.tree) + JSON.stringify(m.fin.trees.totalLabor);
    expect(names).not.toContain("A One");
    expect((m as unknown as Record<string, unknown>).byEmployee).toBeUndefined();
    // confidence rule
    expect(m.recommendations.find((r) => r.id === ids.o1)?.confidence).toBe("High");
    expect(m.recommendations.find((r) => r.id === ids.o2)?.confidence).toBe("Medium");
    expect(m.recommendations.find((r) => r.id === ids.o3)?.confidence).toBe("Low");
    // insights are evidence-backed and deterministic
    expect(m.insights.length).toBeGreaterThanOrEqual(3);
    for (const i of m.insights) expect(i.evidence.length).toBeGreaterThan(0);
    expect(m.insights.map((i) => i.key)).toContain("overlap");
    expect(m.tracker.projectsByStatus.live).toBe(1);
    expect(m.tracker.deployedAgents).toBe(1);
  });

  it("five-year projection extends the three-year projection exactly", async () => {
    const m = await computeExecutiveModel(ids.org);
    m.fin.threeYear.years.forEach((y, i) => { expect(m.fiveYear.years[i].net).toBeCloseTo(y.net, 6); expect(m.fiveYear.years[i].cumulative).toBeCloseTo(y.cumulative, 6); });
    expect(m.fiveYear.years).toHaveLength(5);
    expect(m.fiveYear.years[4].net).toBeCloseTo(m.fiveYear.years[2].net, 6);
    const p = fiveYearProjection({ realizableAnnual: 100_000, operatingAnnual: 10_000, implementationCost: 50_000, rampMonths: 0, discountRate: 0, platformAnnual: 0 });
    expect(p.totalNet).toBeCloseTo(5 * 90_000 - 50_000, 6);
  });

  it("filters resolve business unit / location to departments", async () => {
    const m = await computeExecutiveModel(ids.org);
    expect([...resolveDepartmentFilter(m, { bu: ids.bu })!]).toEqual([ids.ops]);
    expect([...resolveDepartmentFilter(m, { loc: ids.loc })!]).toEqual([ids.ops]);
    expect(resolveDepartmentFilter(m, {})).toBeNull();
  });

  it("sanitizes and clamps scenario overrides", () => {
    expect(sanitizeOverrides({ scenario: "evil", automationPct: "9", adoptionRate: "0.1", realizationRate: "x" })).toEqual({ automationPct: 1.5, adoptionRate: 0.3 });
  });
});

describe("presentation deck state", () => {
  it("every slide reflects one shared, consistent model — and updates together when the scenario changes", async () => {
    const base = await computeExecutiveModel(ids.org);
    const tuned = await computeExecutiveModel(ids.org, { automationPct: 1.4, adoptionRate: 0.9, realizationRate: 0.8 });
    const direct = await computeOrgFinancials(ids.org, { automationPct: 1.4, adoptionRate: 0.9, realizationRate: 0.8 });
    expect(tuned.fin.realizableAnnualSavings).toBeGreaterThan(base.fin.realizableAnnualSavings);
    for (const m of [base, tuned]) {
      const slides = buildDeckSlides(m);
      expect(slides).toHaveLength(12);
      const metric = (key: string, label: string) => slides.find((s) => s.key === key)!.metrics.find((x) => x.label === label)!.value;
      expect(metric("projections", "Realizable annual savings")).toBeCloseTo(m.fin.realizableAnnualSavings, 6);
      expect(metric("projections", "Net annual savings")).toBeCloseTo(m.fin.netAnnualSavings, 6);
      expect(metric("time", "Recoverable hours / week")).toBeCloseTo(m.fin.hoursRecoverablePerWeek, 6);
      expect(metric("investment", "Implementation (one-time)")).toBeCloseTo(m.fin.implementationCost, 6);
      expect(metric("roi", "First-year ROI")).toBeCloseTo(m.fin.roi1y, 9);
      expect(metric("roi", "5-year NPV")).toBeCloseTo(m.fiveYear.npv, 6);
      expect(metric("opex", "Spent on automatable work")).toBeCloseTo(m.fin.grossAnnualSavings, 6);
      const deptBars = slides.find((s) => s.key === "departments")!.chart!.bars.reduce((a, b) => a + b.value, 0);
      expect(deptBars).toBeCloseTo(m.fin.realizableAnnualSavings, 4);
      const timeBars = slides.find((s) => s.key === "time")!.chart!.bars.reduce((a, b) => a + b.value, 0);
      expect(timeBars).toBeCloseTo(m.fin.hoursRecoverablePerWeek, 4);
      const phases = slides.find((s) => s.key === "roadmap")!.phases!.reduce((a, p) => a + p.value, 0);
      expect(phases).toBeCloseTo(m.recommendations.filter((r) => !r.deployed).reduce((a, r) => a + r.realizableAnnual, 0), 4);
      const fiveRows = slides.find((s) => s.key === "projections")!.table!.rows;
      expect(fiveRows[4][4]).toBeCloseTo(m.fiveYear.totalNet, 6);
    }
    expect(tuned.fin.realizableAnnualSavings).toBeCloseTo(direct.realizableAnnualSavings, 6);
    expect(tuned.overrides.automationPct).toBe(1.4);
  });
});

describe("exports", () => {
  it("workbook has every sheet and its totals reconcile to the engines", async () => {
    const wb = await buildExecutiveWorkbook(ids.org, { scenario: "conservative" });
    const f = await computeOrgFinancials(ids.org, { scenario: "conservative" });
    const s = await computeSavingsIntelligence(ids.org, { scenario: "conservative" });
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Savings Tiers", "Departments", "Opportunities", "Workflows", "Assumptions", "Reconciliation"]);
    const summary = wb.getWorksheet("Summary")!;
    const val = (label: string) => { let v: unknown; summary.eachRow((r) => { if (r.getCell(1).value === label) v = r.getCell(2).value; }); return v as number; };
    expect(val("Projected realizable savings")).toBeCloseTo(f.realizableAnnualSavings, 6);
    expect(val("Automation opportunity (gross annual savings)")).toBeCloseTo(f.grossAnnualSavings, 6);
    expect(val("Projected net annual savings")).toBeCloseTo(f.netAnnualSavings, 6);
    expect(val("Annual labor expense analyzed")).toBeCloseTo(f.totalAnnualLaborAnalyzed, 6);
    expect(val("Verified savings (annualized)")).toBeCloseTo(s.tiers.verifiedTime.amount, 6);
    expect(val("Net savings kept (savings engine tier 7)")).toBeCloseTo(s.tiers.net.amount, 6);
    expect(typeof val("First-year ROI")).toBe("number");
    expect(summary.getRow(5).getCell(2).numFmt).toContain("$");
    // tiers sheet: 7 tiers, amounts equal the savings engine
    const tiers = wb.getWorksheet("Savings Tiers")!;
    s.order.forEach((k, i) => { expect(tiers.getRow(5 + i).getCell(1).value).toBe(s.tiers[k].label); expect(tiers.getRow(5 + i).getCell(2).value as number).toBeCloseTo(s.tiers[k].amount, 6); });
    // departments + opportunities total rows (formula with cached result) equal realizable
    const deps = wb.getWorksheet("Departments")!; let depTotal = 0;
    deps.eachRow((r) => { if (r.getCell(1).value === "Total") depTotal = (r.getCell(9).value as { result: number }).result; });
    expect(depTotal).toBeCloseTo(f.realizableAnnualSavings, 4);
    const opps = wb.getWorksheet("Opportunities")!; let oppTotal = 0; let oppRows = 0;
    opps.eachRow((r, i) => { if (r.getCell(2).value === "Total") oppTotal = (r.getCell(11).value as { result: number }).result; else if (i > 4) oppRows++; });
    expect(oppTotal).toBeCloseTo(f.realizableAnnualSavings, 4);
    expect(oppRows).toBe(f.opportunities.length);
    // reconciliation sheet: all export-level checks pass
    const rc = wb.getWorksheet("Reconciliation")!; const statuses: Record<string, string> = {};
    rc.eachRow((r, i) => { if (i > 4) statuses[String(r.getCell(1).value)] = String(r.getCell(2).value); });
    expect(statuses["Departments sheet sums to projected realizable"]).toBe("PASS");
    expect(statuses["Opportunities sheet sums to projected realizable"]).toBe("PASS");
    expect(statuses["Potential tier equals finance-engine realizable"]).toBe("PASS");
    expect(statuses["5-year projection years 1–3 equal the 3-year projection"]).toBe("PASS");
    // serializes
    const buf = await wb.xlsx.writeBuffer();
    expect(Buffer.from(buf).subarray(0, 2).toString()).toBe("PK");
  });

  it("deck is a valid PPTX with a cover + 12 content slides, native charts, and branding", async () => {
    const buf = await buildExecutiveDeck(ids.org, { scenario: "aggressive" });
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const entries = zipEntries(buf);
    const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e));
    expect(slides).toHaveLength(13); // cover + 12
    expect(entries.some((e) => /^ppt\/charts\/chart\d+\.xml$/.test(e))).toBe(true);
    const m = await computeExecutiveModel(ids.org, { scenario: "aggressive" });
    const r = await deckFromModel(m);
    expect(r.slides).toBe(12);
    const xml = readZipEntry(r.buffer, "ppt/slides/slide1.xml");
    expect(xml).toContain("FIXTURE REPORT");
    expect(readZipEntry(r.buffer, "ppt/slides/slide2.xml")).toContain("7C3AED");
  });

  it("empty org still produces a graceful 12-slide deck and workbook", async () => {
    const [empty] = await db.insert(schema.organizations).values({ name: "Empty Co", slug: `exp-empty-${Date.now()}`, kind: "client" }).returning();
    try {
      const m = await computeExecutiveModel(empty.id);
      const slides = buildDeckSlides(m);
      expect(slides).toHaveLength(12);
      expect(slides.filter((s) => s.empty).length).toBeGreaterThanOrEqual(8);
      expect(m.gaps.map((g) => g.key)).toEqual(expect.arrayContaining(["employees", "collectors", "workflows", "opportunities", "verified"]));
      const wb = workbookFromModel(m);
      expect(wb.worksheets).toHaveLength(7);
      const deck = await deckFromModel(m);
      expect(zipEntries(deck.buffer).filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e))).toHaveLength(13);
    } finally { await db.delete(schema.organizations).where(eq(schema.organizations.id, empty.id)); }
  });

  it("portfolio lists only the consultancy's own clients", async () => {
    const p = await computePortfolio(ids.parent);
    expect(p.rows.map((r) => r.orgId)).toEqual([ids.org]);
    const f = await computeOrgFinancials(ids.org);
    expect(p.totals.realizable).toBeCloseTo(f.realizableAnnualSavings, 6);
    expect(p.rows[0].deployedAgents).toBe(1);
  });
});

// --- minimal zip reader (central directory) ---
function zipEntries(buf: Buffer): string[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16); const out: string[] = [];
  for (let i = 0; i < count; i++) { const nl = buf.readUInt16LE(off + 28), xl = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32); out.push(buf.subarray(off + 46, off + 46 + nl).toString()); off += 46 + nl + xl + cl; }
  return out;
}
function readZipEntry(buf: Buffer, name: string): string {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), nl = buf.readUInt16LE(off + 28), xl = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32), local = buf.readUInt32LE(off + 42);
    if (buf.subarray(off + 46, off + 46 + nl).toString() === name) {
      const lnl = buf.readUInt16LE(local + 26), lxl = buf.readUInt16LE(local + 28); const data = buf.subarray(local + 30 + lnl + lxl, local + 30 + lnl + lxl + csize);
      return (method === 8 ? inflateRawSync(data) : data).toString();
    }
    off += 46 + nl + xl + cl;
  }
  return "";
}
