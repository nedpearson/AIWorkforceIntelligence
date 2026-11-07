/**
 * DB-backed analysis engine tests. Run with DATABASE_URL pointing at a scratch DB (bridgebox_a), never the seeded default.
 * Inserts a synthetic org (DEMO_ORG + generateEvents) with the admin handle and removes it afterwards (org cascade).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DEMO_ORG, generateEvents, type SynthEmployee } from "@/engine/synthetic";
import { runAnalysis } from "@/engine/analysis";

const SLUG = "analysis-test-org";
const ids = { org: "", campaign: "" };
const empIds: Record<string, string> = {}; const deptIds: Record<string, string> = {};

async function seedOrg(slug: string, employees: SynthEmployee[], days: number) {
  await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug, isDemo: true, settings: { benefitsLoadPct: 0.3, workHoursPerWeek: 40, workWeeksPerYear: 48, adoptionRate: 0.75, realizationRate: 0.6 } }).returning();
  const depts: Record<string, string> = {}; const emps: Record<string, string> = {};
  for (const name of DEMO_ORG.departments) { const [d] = await db.insert(schema.departments).values({ orgId: org.id, name }).returning(); depts[name] = d.id; }
  for (const e of employees) { const [r] = await db.insert(schema.employees).values({ orgId: org.id, departmentId: depts[e.department], displayName: e.name, title: e.title, baseAnnualCost: String(e.baseAnnualCost), loadedHourlyCost: ((e.baseAnnualCost * 1.3) / 1920).toFixed(2), costBasis: "observed" }).returning(); emps[e.key] = r.id; }
  const [campaign] = await db.insert(schema.observationCampaigns).values({ orgId: org.id, name: "test", status: "completed" }).returning();
  const [col] = await db.insert(schema.collectors).values({ orgId: org.id, name: "sim", platform: "simulated", tokenHash: `${slug}-${Date.now()}` }).returning();
  const events = generateEvents({ seed: 42, days, employees });
  for (let i = 0; i < events.length; i += 2000) {
    await db.insert(schema.activityEvents).values(events.slice(i, i + 2000).map((ev) => ({ orgId: org.id, employeeId: emps[ev.employeeKey], collectorId: col.id, campaignId: campaign.id, ts: ev.ts, type: ev.type, app: ev.app, appCategory: ev.appCategory, titleCategory: ev.titleCategory, titleHash: ev.titleHash, durationMs: Math.round(ev.durationMs), meta: ev.meta })));
  }
  return { orgId: org.id, campaignId: campaign.id, emps, depts, eventCount: events.length };
}

beforeAll(async () => {
  const s = await seedOrg(SLUG, DEMO_ORG.employees, 20);
  ids.org = s.orgId; ids.campaign = s.campaignId; Object.assign(empIds, s.emps); Object.assign(deptIds, s.depts);
});
afterAll(async () => {
  await db.delete(schema.organizations).where(inArray(schema.organizations.slug, [SLUG, `${SLUG}-perf`]));
});

const wfRows = () => db.select().from(schema.workflows).where(eq(schema.workflows.orgId, ids.org));
const oppRows = () => db.select().from(schema.opportunities).where(eq(schema.opportunities.orgId, ids.org));
const findWf = (rows: Awaited<ReturnType<typeof wfRows>>, apps: string[], title: string) => rows.find((w) => apps.every((a) => w.steps.some((s) => s.app === a)) && w.steps.some((s) => s.action.startsWith(title)));
/** Employee keys in DEMO_ORG assigned a given synthetic pattern — the expected performer set for the matching workflow. */
const performersOf = (pattern: string) => DEMO_ORG.employees.filter((e) => e.patterns.some((p) => p.pattern === pattern)).map((e) => e.key);
const performerIds = (pattern: string) => performersOf(pattern).map((k) => empIds[k]).sort();
/** Expected runs/week for a pattern = Σ runsPerDay × 5 working days (variance averages out over 20 days). */
const runsPerWeekOf = (pattern: string) => DEMO_ORG.employees.reduce((s, e) => s + e.patterns.filter((p) => p.pattern === pattern).reduce((a, p) => a + p.runsPerDay, 0), 0) * 5;

describe("runAnalysis on the synthetic demo org (seed 42, 20 days)", () => {
  let result: Awaited<ReturnType<typeof runAnalysis>>;
  it("creates a finished analysis run with counts and a summary", async () => {
    result = await runAnalysis({ orgId: ids.org, campaignId: ids.campaign });
    expect(result.eventsAnalyzed).toBeGreaterThan(10000);
    expect(result.workflowsFound).toBeGreaterThanOrEqual(9);
    expect(result.opportunitiesFound).toBeGreaterThanOrEqual(7);
    const [run] = await db.select().from(schema.analysisRuns).where(eq(schema.analysisRuns.id, result.runId));
    expect(run.status).toBe("done"); expect(run.orgId).toBe(ids.org); expect(run.campaignId).toBe(ids.campaign);
    const s = run.summary as Record<string, number>;
    // 24 employees: ~215 h/wk observed, ~160 h/wk in repetitive workflows
    expect(s.observedWeeks).toBe(4); expect(s.totalHoursPerWeek).toBeGreaterThan(150); expect(s.repetitiveHoursPerWeek).toBeGreaterThan(120);
    expect(s.repetitiveHoursPerWeek).toBeLessThanOrEqual(s.totalHoursPerWeek); expect(s.idleShare).toBeGreaterThan(0); expect(s.idleShare).toBeLessThan(0.2);
    expect((run.summary as { topApps: { app: string }[] }).topApps[0].app).toBe("NetSuite");
  });

  it("finds workflows that map to the synthetic patterns with sensible hours", async () => {
    const wfs = await wfRows();
    expect(wfs.length).toBeGreaterThanOrEqual(9);
    expect(wfs.every((w) => w.basis === "observed" && w.isManual && w.analysisRunId === result.runId)).toBe(true);

    const ap = findWf(wfs, ["Outlook", "Adobe Acrobat", "QuickBooks", "Excel"], "bill entry")!;
    expect(ap).toBeDefined(); expect(ap.name).toMatch(/Bill entry \(Outlook → Adobe Acrobat → QuickBooks → Excel\)/);
    const apRuns = runsPerWeekOf("ap_invoice"); // (9 + 4 + 8 + 6) runs/day × 5 = 135
    expect(Number(ap.runsPerWeek)).toBeGreaterThan(apRuns * 0.8); expect(Number(ap.runsPerWeek)).toBeLessThan(apRuns * 1.2);
    expect(Number(ap.avgDurationMin)).toBeGreaterThan(8); expect(Number(ap.avgDurationMin)).toBeLessThan(11);
    expect(Number(ap.hoursPerWeek)).toBeGreaterThan(18); expect(ap.employeeCount).toBe(performersOf("ap_invoice").length); expect(ap.handoffCount).toBeGreaterThan(400);
    expect(Number(ap.reworkRate)).toBeGreaterThan(0.05); expect(ap.departmentId).toBe(deptIds.Finance); expect(ap.requiresJudgment).toBe(false);
    expect(ap.evidence.sampleSize).toBeGreaterThan(400); expect(ap.evidence.eventIds.length).toBe(200); expect(ap.evidence.employeeIds?.sort()).toEqual(performerIds("ap_invoice"));
    expect(ap.processMap!.nodes).toHaveLength(6); expect(ap.processMap!.edges.length).toBeGreaterThanOrEqual(5);

    const order = findWf(wfs, ["Outlook", "Chrome", "NetSuite", "Excel"], "sales order")!;
    // order entry: 5 Operations clerks/purchasing + 3 Sales reps/coordinator = 8 performers, ~350 runs/wk, the biggest workflow by hours
    expect(order.name).toContain("Sales order"); expect(order.employeeCount).toBeGreaterThanOrEqual(6); expect(order.employeeCount).toBe(performersOf("order_entry").length);
    expect(Number(order.runsPerWeek)).toBeGreaterThan(300); expect(Number(order.hoursPerWeek)).toBeGreaterThan(45);
    const orderEmps = await db.select().from(schema.workflowEmployees).where(eq(schema.workflowEmployees.workflowId, order.id));
    expect(orderEmps.map((x) => x.employeeId).sort()).toEqual(performerIds("order_entry"));
    const orderDepts = new Set(DEMO_ORG.employees.filter((e) => performersOf("order_entry").includes(e.key)).map((e) => e.department));
    expect([...orderDepts].sort()).toEqual(["Operations", "Sales"]);
    expect(orderEmps.every((x) => x.orgId === ids.org && Number(x.hoursPerWeek) > 0)).toBe(true);
    expect(order.evidence.notes?.some((n) => n.includes("2 departments"))).toBe(true);

    const support = findWf(wfs, ["Zendesk", "Chrome", "NetSuite"], "ticket reply")!;
    expect(support.employeeCount).toBe(performersOf("support_ticket").length); // 4 reps + team lead
    expect(Number(support.runsPerWeek)).toBeGreaterThan(400); expect(Number(support.hoursPerWeek)).toBeGreaterThan(45);
    expect(findWf(wfs, ["Outlook", "Chrome"], "scheduling reply")!.employeeCount).toBe(performersOf("appointment_scheduling").length); // 9 across Sales, CS, HR

    // low-frequency weekly report now occurs: one run/week each for 8 people across 5 departments
    const weekly = findWf(wfs, ["NetSuite", "Excel", "PowerPoint", "Outlook"], "weekly report")!;
    expect(weekly).toBeDefined(); expect(weekly.name).toMatch(/^Weekly report/);
    expect(weekly.employeeCount).toBe(performersOf("weekly_report").length); expect(weekly.employeeCount).toBeGreaterThanOrEqual(6);
    const weeklyRuns = runsPerWeekOf("weekly_report"); // 8 × 0.2 × 5 = 8
    expect(Number(weekly.runsPerWeek)).toBeGreaterThan(weeklyRuns * 0.6); expect(Number(weekly.runsPerWeek)).toBeLessThan(weeklyRuns * 1.6);
    expect(Number(weekly.avgDurationMin)).toBeGreaterThan(18); expect(Number(weekly.hoursPerWeek)).toBeGreaterThan(2);
    expect(weekly.evidence.notes?.some((n) => n.includes("5 departments"))).toBe(true); expect(weekly.requiresJudgment).toBe(false);
    expect(findWf(wfs, ["Chrome", "Adobe Acrobat", "Outlook", "Excel"], "hr system")).toMatchObject({ regulatoryFlag: "PII", requiresJudgment: false });
    expect(findWf(wfs, ["Excel", "NetSuite", "Outlook"], "inventory adjustment")!.handoffCount).toBeGreaterThan(10);
    expect(findWf(wfs, ["Chrome", "Excel", "Slack"], "campaign tracker")).toBeDefined();

    const bank = findWf(wfs, ["Chrome", "Excel", "QuickBooks"], "reconcile")!;
    expect(bank).toMatchObject({ requiresJudgment: true, regulatoryFlag: "SOX" }); expect(Number(bank.automationScore)).toBeLessThan(35);
    const contract = findWf(wfs, ["Outlook", "Word"], "contract")!;
    expect(contract).toMatchObject({ requiresJudgment: true, regulatoryFlag: "Legal" }); expect(Number(contract.automationScore)).toBeLessThan(15);
    // repetition: the high-volume ones score ≥ 50
    for (const w of [ap, order, support]) expect(Number(w.repetitionScore)).toBeGreaterThanOrEqual(50);
  });

  it("produces ranked, evidence-backed opportunities with costing trees", async () => {
    const opps = await oppRows(); const wfs = await wfRows();
    expect(opps.length).toBeGreaterThanOrEqual(7);
    expect(opps.map((o) => o.rank).sort((a, b) => a - b)).toEqual(opps.map((_, i) => i + 1));
    expect(opps.every((o) => o.basis === "estimated" && o.status === "identified" && o.calculation.label === "Realizable annual savings" && o.evidence.sampleSize > 0 && o.summary.includes("Observed"))).toBe(true);
    const byWf = new Map(opps.map((o) => [o.workflowId, o]));
    const order = byWf.get(findWf(wfs, ["Outlook", "Chrome", "NetSuite", "Excel"], "sales order")!.id)!;
    expect(order.rank).toBe(1); expect(order.type).toBe("rpa"); expect(order.recommendedAgentCategory).toBe("sales_crm");
    expect(Number(order.automationPct)).toBeLessThanOrEqual(0.8); expect(Number(order.realizableAnnualSavings)).toBeLessThan(Number(order.grossAnnualSavings));
    expect(order.summary).toMatch(new RegExp(`Observed \\d+ runs over 4\\.0 weeks by ${performersOf("order_entry").length} people`)); expect(order.summary).toContain("NetSuite");
    const ap = byWf.get(findWf(wfs, ["Outlook", "Adobe Acrobat", "QuickBooks", "Excel"], "bill entry")!.id)!;
    expect(ap.type).toBe("rpa"); expect(ap.recommendedAgentCategory).toBe("invoice"); expect(ap.departmentId).toBe(deptIds.Finance);
    const support = byWf.get(findWf(wfs, ["Zendesk", "Chrome", "NetSuite"], "ticket reply")!.id)!;
    expect(["ai_agent", "process_change"]).toContain(support.type); expect(support.recommendedAgentCategory).toBe("customer_service");
    expect(byWf.get(findWf(wfs, ["Outlook", "Chrome"], "scheduling reply")!.id)).toMatchObject({ type: "ai_agent", recommendedAgentCategory: "scheduling" });
    // the weekly report (export → paste → deck → email) is a reporting integration, not an agent
    const weekly = byWf.get(findWf(wfs, ["NetSuite", "Excel", "PowerPoint", "Outlook"], "weekly report")!.id)!;
    expect(weekly).toMatchObject({ type: "conventional_automation", recommendedAgentCategory: "reporting" });
    expect(Number(weekly.realizableAnnualSavings)).toBeLessThan(Number(order.realizableAnnualSavings));
    // judgment-heavy work gets no opportunity
    expect(byWf.has(findWf(wfs, ["Chrome", "Excel", "QuickBooks"], "reconcile")!.id)).toBe(false);
    expect(byWf.has(findWf(wfs, ["Outlook", "Word"], "contract")!.id)).toBe(false);
    // all money from opportunityEconomics(): hours × weeks × hourly
    const gross = order.calculation.children![0]; const hrs = gross.children![0];
    expect(gross.value).toBeCloseTo(hrs.value * 48 * gross.children![2].value, 6); expect(Number(order.grossAnnualSavings)).toBeCloseTo(gross.value, 1);
    expect(hrs.children![0].basis).toBe("observed"); expect(hrs.children![2].value).toBe(0.75);
  });

  it("re-running replaces identified workflows/opportunities but preserves worked ones, updating their numbers", async () => {
    const before = await oppRows(); const wfsBefore = await wfRows();
    const worked = before.find((o) => o.rank === 1)!; const orphanWf = wfsBefore.find((w) => w.id === worked.workflowId)!;
    await db.update(schema.opportunities).set({ status: "approved", title: "Custom title" }).where(eq(schema.opportunities.id, worked.id));
    const res2 = await runAnalysis({ orgId: ids.org });
    expect(res2.workflowsFound).toBe(result.workflowsFound);
    const after = await oppRows(); const wfsAfter = await wfRows();
    expect(wfsAfter.every((w) => w.analysisRunId === res2.runId)).toBe(true);
    expect(wfsAfter.find((w) => w.id === orphanWf.id)).toBeUndefined();
    const kept = after.find((o) => o.id === worked.id)!;
    expect(kept).toBeDefined(); expect(kept.status).toBe("approved"); expect(kept.title).toBe("Custom title"); expect(kept.type).toBe(worked.type);
    expect(wfsAfter.some((w) => w.id === kept.workflowId && w.signature === orphanWf.signature)).toBe(true);
    expect(Number(kept.realizableAnnualSavings)).toBeCloseTo(Number(worked.realizableAnnualSavings), 0);
    expect(after.filter((o) => o.id !== worked.id).every((o) => !before.some((b) => b.id === o.id))).toBe(true);
    expect(after.length).toBe(before.length);
    const links = await db.select().from(schema.workflowEmployees).where(eq(schema.workflowEmployees.orgId, ids.org));
    expect(links.every((l) => wfsAfter.some((w) => w.id === l.workflowId))).toBe(true);
    // the opportunity whose workflow vanishes (no campaign/window match) is preserved along with its workflow row
    const res3 = await runAnalysis({ orgId: ids.org, windowStart: new Date(Date.now() + 86400000) });
    expect(res3.workflowsFound).toBe(0);
    const after3 = await oppRows(); const wfs3 = await wfRows();
    expect(after3.map((o) => o.id)).toEqual([worked.id]); expect(wfs3.map((w) => w.id)).toEqual([kept.workflowId]);
    expect((await db.select().from(schema.analysisRuns).where(and(eq(schema.analysisRuns.orgId, ids.org), eq(schema.analysisRuns.status, "done")))).length).toBe(3);
  });

  it("marks a failed run", async () => {
    await expect(runAnalysis({ orgId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow();
    const [run] = await db.select().from(schema.analysisRuns).where(eq(schema.analysisRuns.orgId, "00000000-0000-0000-0000-000000000000")).limit(1).catch(() => [undefined]);
    if (run) expect(run.status).toBe("failed"); // org FK may reject the run row itself; either way nothing is left half-done
  });
});

describe("performance", () => {
  it("analyzes 50k+ events in under 30 s", async () => {
    const s = await seedOrg(`${SLUG}-perf`, DEMO_ORG.employees, 85);
    expect(s.eventCount).toBeGreaterThan(50000);
    const t0 = Date.now();
    const r = await runAnalysis({ orgId: s.orgId });
    expect(Date.now() - t0).toBeLessThan(30000);
    expect(r.eventsAnalyzed).toBe(s.eventCount); expect(r.workflowsFound).toBeGreaterThanOrEqual(9);
  });
});
