/**
 * Organization-wide process mining. Pure merge/handoff tests + a DB fixture (requires DATABASE_URL, own DB).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "@/db/client";
import type { ProcessMap } from "@/db/schema";
import { mergeProcessMaps, resolveHandoffTarget, weeklyScale, computeOrgProcessMining, type WorkflowInput } from "@/engine/process-mining-org";

const mapA: ProcessMap = {
  nodes: [{ id: "Outlook:invoice:document_open", label: "Outlook: invoice (document open)", count: 100, avgMs: 30_000 }, { id: "QuickBooks:bill:data_entry", label: "QuickBooks: bill (data entry)", count: 100, avgMs: 120_000 }, { id: "Outlook:approval:handoff", label: "Outlook: approval (handoff)", count: 40, avgMs: 10_000 }],
  edges: [{ from: "Outlook:invoice:document_open", to: "QuickBooks:bill:data_entry", count: 100 }, { from: "QuickBooks:bill:data_entry", to: "Outlook:approval:handoff", count: 40 }, { from: "Outlook:approval:handoff", to: "QuickBooks:bill:data_entry", count: 10 }],
};
const mapB: ProcessMap = {
  nodes: [{ id: "Outlook:invoice:document_open", label: "Outlook: invoice (document open)", count: 50, avgMs: 60_000 }, { id: "Excel:log:data_entry", label: "Excel: log (data entry)", count: 50, avgMs: 20_000 }],
  edges: [{ from: "Outlook:invoice:document_open", to: "Excel:log:data_entry", count: 50 }],
};
const wfA: WorkflowInput = { id: "A", name: "Bill entry", departmentId: null, processMap: mapA, runsPerWeek: 25, hoursPerWeek: 4, reworkRate: 0.2, evidence: { sampleSize: 100 } };
const wfB: WorkflowInput = { id: "B", name: "Invoice log", departmentId: null, processMap: mapB, runsPerWeek: 10, hoursPerWeek: 1, reworkRate: 0, evidence: { sampleSize: 50 } };

describe("mergeProcessMaps (pure)", () => {
  it("node/edge counts equal the distinct steps/transitions across workflow maps", () => {
    const g = mergeProcessMaps([wfA, wfB]);
    const distinctNodes = new Set([...mapA.nodes, ...mapB.nodes].map((n) => n.id));
    const distinctEdges = new Set([...mapA.edges, ...mapB.edges].map((e) => `${e.from}→${e.to}`));
    expect(g.nodes).toHaveLength(distinctNodes.size); // 4
    expect(g.edges).toHaveLength(distinctEdges.size); // 4
    const shared = g.nodes.find((n) => n.id === "Outlook:invoice:document_open")!;
    expect(shared.count).toBe(150);
    expect(shared.avgMs).toBeCloseTo((100 * 30_000 + 50 * 60_000) / 150, 9); // count-weighted
    expect(shared.workflowIds.sort()).toEqual(["A", "B"]);
    expect(shared.perWeek).toBeCloseTo(100 * 0.25 + 50 * 0.2, 9);
    expect(shared.reworkRate).toBeCloseTo((0.2 * 100 + 0 * 50) / 150, 9);
    expect(shared).toMatchObject({ app: "Outlook", type: "document_open", action: "invoice (document open)" });
    expect(sum(g.edges.map((e) => e.count))).toBe(sum([...mapA.edges, ...mapB.edges].map((e) => e.count)));
  });
  it("weekly scale = runs/week ÷ observed runs", () => {
    expect(weeklyScale(wfA)).toBeCloseTo(0.25, 9);
    expect(weeklyScale({ ...wfA, evidence: null })).toBeCloseTo(25 / 100, 9); // falls back to busiest node count
    expect(mergeProcessMaps([{ ...wfA, processMap: null }])).toEqual({ nodes: [], edges: [] });
  });
});
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("resolveHandoffTarget (pure)", () => {
  const depts = [{ id: "d-fin", name: "Finance" }, { id: "d-ops", name: "Operations" }];
  it("maps manager → manager's dept (else sender's), team names → departments, keeps unknown teams visible", () => {
    expect(resolveHandoffTarget("manager", "d-ops", "d-fin", depts)).toEqual({ key: "d-fin", name: "Finance", mapped: true });
    expect(resolveHandoffTarget("manager", "d-ops", null, depts)).toEqual({ key: "d-ops", name: "Operations", mapped: true });
    expect(resolveHandoffTarget("finance", "d-ops", null, depts)).toEqual({ key: "d-fin", name: "Finance", mapped: true });
    expect(resolveHandoffTarget("Operations", "d-fin", null, depts)).toEqual({ key: "d-ops", name: "Operations", mapped: true });
    expect(resolveHandoffTarget("it", "d-fin", null, depts)).toEqual({ key: "ext:it", name: "IT (outside mapped departments)", mapped: false });
  });
});

const ids = { org: "", ops: "", fin: "", e1: "", e2: "", wA: "", wB: "" };
beforeAll(async () => {
  const [org] = await db.insert(schema.organizations).values({ name: "PM Fixtures", slug: `pm-test-${Date.now()}`, kind: "client", isDemo: true }).returning();
  ids.org = org.id;
  const [ops] = await db.insert(schema.departments).values({ orgId: org.id, name: "Operations" }).returning();
  const [fin] = await db.insert(schema.departments).values({ orgId: org.id, name: "Finance" }).returning();
  ids.ops = ops.id; ids.fin = fin.id;
  ids.e1 = (await db.insert(schema.employees).values({ orgId: org.id, departmentId: ops.id, displayName: "Olive", baseAnnualCost: "50000" }).returning())[0].id;
  ids.e2 = (await db.insert(schema.employees).values({ orgId: org.id, departmentId: fin.id, displayName: "Fred", baseAnnualCost: "70000" }).returning())[0].id;
  const wf = async (name: string, dept: string, pm: ProcessMap, rework: string, runs: string, hours: string, sample: number) => (await db.insert(schema.workflows).values({ orgId: org.id, departmentId: dept, name, signature: pm.nodes.map((n) => n.id).join(">"), processMap: pm, steps: pm.nodes.map((n, idx) => ({ idx, app: n.id.split(":")[0], action: n.label, avgMs: n.avgMs, share: 0 })), runsPerWeek: runs, hoursPerWeek: hours, reworkRate: rework, evidence: { eventIds: [], sampleSize: sample, observedFrom: "2026-10-05", observedTo: "2026-10-09" } }).returning())[0].id;
  ids.wA = await wf("Bill entry", ops.id, mapA, "0.2000", "25", "4", 100);
  ids.wB = await wf("Invoice log", fin.id, mapB, "0", "10", "1", 50);
  await db.insert(schema.workflowEmployees).values([{ orgId: org.id, workflowId: ids.wA, employeeId: ids.e1, hoursPerWeek: "4" }, { orgId: org.id, workflowId: ids.wB, employeeId: ids.e2, hoursPerWeek: "1" }]);
  await db.insert(schema.opportunities).values({ orgId: org.id, workflowId: ids.wA, departmentId: ops.id, title: "Automate bill entry", summary: "x", type: "rpa", feasibility: "80", risk: "20", automationPct: "0.5", hoursRecoverablePerWeek: "1.5", grossAnnualSavings: "3000", realizableAnnualSavings: "1800", implementationCost: "5000", annualOperatingCost: "500", calculation: { label: "x", value: 1800, basis: "estimated" }, evidence: { eventIds: [], sampleSize: 0, observedFrom: "", observedTo: "" } });
  const col = randomUUID();
  const ev = (e: string, day: string, to: string) => ({ orgId: org.id, employeeId: e, collectorId: col, ts: new Date(`2026-10-${day}T15:00:00Z`), type: "handoff" as const, app: "Outlook", appCategory: "email", titleCategory: "approval", durationMs: 1000, meta: { to } });
  // 5 active days → 1 observed week. Olive (Ops) hands 3 approvals to finance, 1 to manager (no manager → own dept).
  await db.insert(schema.activityEvents).values([ev(ids.e1, "05", "finance"), ev(ids.e1, "06", "finance"), ev(ids.e1, "07", "finance"), ev(ids.e1, "08", "manager"), ev(ids.e2, "09", "it")]);
});
afterAll(async () => {
  if (!ids.org) return;
  await db.delete(schema.activityEvents).where(eq(schema.activityEvents.orgId, ids.org));
  await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org));
});

describe("computeOrgProcessMining", () => {
  it("graph node/edge counts match the merged workflow maps", async () => {
    const pm = await computeOrgProcessMining(ids.org);
    const expected = mergeProcessMaps([{ ...wfA, id: ids.wA }, { ...wfB, id: ids.wB }]);
    expect(pm.graph.nodes).toHaveLength(expected.nodes.length);
    expect(pm.graph.edges).toHaveLength(expected.edges.length);
    expect(pm.kpis).toMatchObject({ processes: 2, steps: 4, edges: 4 });
    expect(pm.kpis.reworkHoursPerWeek).toBeCloseTo(4 * 0.2, 9);
    expect(pm.conformance.map((c) => c.workflowId)).toEqual([ids.wA]); // > 15% rework
    expect(pm.conformance[0].hint).toMatch(/QuickBooks: bill \(data entry\)/); // loop-back edge handoff → data entry
    const detail = pm.nodeDetails["Outlook:invoice:document_open"];
    expect(detail.workflows).toHaveLength(2);
    expect(detail.performers.map((p) => p.name).sort()).toEqual(["Fred", "Olive"]);
    expect(pm.nodeDetails["QuickBooks:bill:data_entry"].opportunities.map((o) => o.title)).toEqual(["Automate bill entry"]);
  });
  it("hand-off matrix and per-week rates come from handoff events", async () => {
    const pm = await computeOrgProcessMining(ids.org);
    expect(pm.handoffs.weeks).toBeCloseTo(1, 9);
    expect(pm.handoffs.total).toBe(5);
    expect(pm.kpis.handoffsPerWeek).toBeCloseTo(5, 9);
    const cell = (f: string, t: string) => pm.handoffs.matrix.find((m) => m.from === f && m.to === t)?.count ?? 0;
    expect(cell(ids.ops, ids.fin)).toBe(3);
    expect(cell(ids.ops, ids.ops)).toBe(1);
    expect(cell(ids.fin, "ext:it")).toBe(1);
    expect(pm.handoffs.crossDeptPerWeek).toBeCloseTo(4, 9);
    const hb = pm.bottlenecks.find((b) => b.nodeId === "Outlook:approval:handoff")!;
    expect(hb.crossDeptHandoffsPerWeek).toBeCloseTo(4, 9);
  });
  it("filters by workflow and department", async () => {
    const onlyB = await computeOrgProcessMining(ids.org, { wf: ids.wB });
    expect(onlyB.graph.nodes).toHaveLength(mapB.nodes.length);
    expect(onlyB.handoffs.total).toBe(0); // no handoff step in workflow B
    const fin = await computeOrgProcessMining(ids.org, { dept: ids.fin });
    expect(fin.workflows.map((w) => w.id)).toEqual([ids.wB]);
    expect(fin.handoffs.total).toBe(1);
  });
});
