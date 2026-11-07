/** Every non-invoice skill: runs on its synthetic sample, rejects invalid input, cites approved knowledge when it exists,
 *  and the analytical skills use the real engines in live mode. Plus unit checks of the deterministic calculators. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { runSkill, SKILLS, getSkill } from "@/engine/skills";
import { reconcile } from "@/engine/skills/finance-skills";
import { findSlots, reorderPlan, analyzeTranscript, reviewText } from "@/engine/skills/ops-skills";
import { unsupportedClaims, normalizeRecord, scoreLead } from "@/engine/skills/sales-skills";
import { makeFixtures, type Fx } from "./skills-fixtures";

let fx: Fx; let empA = ""; let empLive = ""; let empEmpty = "";
beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  fx = await makeFixtures("catalog");
  empA = (await fx.mkEmp({ status: "sandbox", permissionLevel: "draft_only" })).id;
  empLive = (await fx.mkEmp({ status: "active", permissionLevel: "draft_only" })).id;
  empEmpty = (await fx.mkEmp({ status: "sandbox", knowledgeScope: { categories: ["goal"] } })).id; // scope with no knowledge
});
afterAll(async () => { await fx.cleanup(); });

const OTHERS = SKILLS.filter((s) => s.key !== "process_invoice").map((s) => s.key);
const INVALID: Record<string, unknown> = {
  prepare_invoice: { customer: { name: "A" }, items: [] }, reconcile_transactions: { bank: "date,amount\n", ledger: [] }, draft_customer_email: { customerName: "Al", purpose: "spam", context: "hi" },
  generate_proposal: { client: "X", scope: [] }, analyze_financials: { statements: { periods: [] } }, schedule_appointment: { title: "x", durationMinutes: 5, window: { start: "2026-11-10", end: "2026-11-01" }, attendees: [] },
  weekly_report: { weekEnding: "last friday" }, summarize_meeting: { transcript: "too short" }, review_document: { text: "short" }, follow_up_lead: { lead: { name: "" } },
  purchasing_recommendation: { items: [] }, update_crm: { records: [] }, generate_marketing: { product: "x", audience: "", channel: "fax" }, analyze_operations: { top: 0 },
};

describe("every other skill", () => {
  it.each(OTHERS)("%s: runs on its synthetic sample with steps, summary, savings, and cites approved knowledge", async (key) => {
    const r = await runSkill({ orgId: fx.orgA, aiEmployeeId: empA, skillKey: key, mode: "sandbox", actorUserId: fx.owner, actorRole: "owner" });
    expect(r.error).toBeUndefined(); expect(r.ok).toBe(true); expect(r.synthetic).toBe(true);
    expect(r.summary.length).toBeGreaterThan(20);
    expect(r.steps.at(-1)?.key).toBe("savings"); expect(r.steps.filter((s) => s.status === "failed")).toHaveLength(0);
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.manualBaselineMinutes).toBe(getSkill(key)!.manualBaselineMinutes);
  });
  it.each(OTHERS)("%s: rejects invalid input with a readable error", async (key) => {
    const r = await runSkill({ orgId: fx.orgA, aiEmployeeId: empA, skillKey: key, mode: "sandbox", input: INVALID[key], actorUserId: fx.owner, actorRole: "owner" });
    expect(r.ok).toBe(false); expect(r.error).toMatch(/Invalid input/);
  });
  it("knowledge scope is enforced: an employee scoped to an empty category gets no Brain citations", async () => {
    const r = await runSkill({ orgId: fx.orgA, aiEmployeeId: empEmpty, skillKey: "draft_customer_email", mode: "sandbox", actorUserId: fx.owner, actorRole: "owner" });
    expect(r.ok).toBe(true); expect(r.citations.filter((c) => c.type === "document" || c.type === "fact")).toHaveLength(0);
  });
});

describe("live analytical skills use the real engines", () => {
  it("analyze_operations ranks the org's observed workflow and values it with the finance engine", async () => {
    const r = await runSkill({ orgId: fx.orgA, aiEmployeeId: empLive, skillKey: "analyze_operations", mode: "live", input: { top: 3 }, actorUserId: fx.owner, actorRole: "owner" });
    expect(r.ok).toBe(true); expect(r.synthetic).toBe(false);
    const b = r.output.bottlenecks as { workflowId: string; name: string }[];
    expect(b[0].workflowId).toBe(fx.wf); expect(r.citations.some((c) => c.type === "workflow" && c.id === fx.wf)).toBe(true);
    expect(r.steps.some((s) => s.key === "value")).toBe(true);
  });
  it("analyze_financials (no statements) reads computeOrgFinancials; weekly_report reads runs + savings tiers", async () => {
    const f = await runSkill({ orgId: fx.orgA, aiEmployeeId: empLive, skillKey: "analyze_financials", mode: "live", input: {}, actorUserId: fx.owner, actorRole: "owner" });
    expect(f.ok).toBe(true); expect((f.output.model as { totalAnnualLaborAnalyzed: number }).totalAnnualLaborAnalyzed).toBeGreaterThan(0);
    const w = await runSkill({ orgId: fx.orgA, aiEmployeeId: empLive, skillKey: "weekly_report", mode: "live", input: {}, actorUserId: fx.owner, actorRole: "owner" });
    expect(w.ok).toBe(true); expect(String(w.output.report)).not.toMatch(/Synthetic/); expect(w.citations.some((c) => c.id === "savings-intelligence")).toBe(true);
  });
  it("update_crm in live draft_only stores the change set but never applies it; sandbox runs create no agent runs", async () => {
    const r = await runSkill({ orgId: fx.orgA, aiEmployeeId: empLive, skillKey: "update_crm", mode: "live", input: { records: [{ name: "Real Person", email: "real@example.com" }] }, actorUserId: fx.owner, actorRole: "owner" });
    expect(r.ok).toBe(true); expect(r.steps.find((s) => s.key === "apply_changes")?.status).toBe("skipped");
    expect(await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.orgId, fx.orgA))).toHaveLength(0);
  });
  it("update_crm in act_with_approval/autonomous always asks before applying (alwaysApprove)", async () => {
    const auto = await fx.mkEmp({ status: "active", permissionLevel: "autonomous" });
    const r = await runSkill({ orgId: fx.orgA, aiEmployeeId: auto.id, skillKey: "update_crm", mode: "live", input: { records: [{ name: "Real Person", email: "real@example.com" }] }, actorUserId: fx.owner, actorRole: "owner" });
    expect(r.status).toBe("awaiting_approval");
  });
});

describe("deterministic calculators", () => {
  it("reconcile: exact, date-shifted and batched matches; unexplained difference is zero", () => {
    const s = getSkill("reconcile_transactions")!.sampleInput() as { bank: { date: string; description: string; amount: number }[]; ledger: { date: string; description: string; amount: number }[] };
    const T = (xs: typeof s.bank) => xs.map((x, i) => ({ i, ...x }));
    const r = reconcile(T(s.bank), T(s.ledger), 3);
    expect(r.matched.some((m) => m.kind === "combined" && m.ledger.length === 2)).toBe(true);
    expect(r.unmatchedBank.map((u) => u.description)).toEqual(expect.arrayContaining(["MONTHLY SERVICE CHARGE", "INTEREST PAID", "DEPOSIT GULF MARINE"]));
    expect(r.unmatchedBank.find((u) => /SERVICE/.test(u.description))?.suggestion).toMatch(/bank fee/);
    expect(Math.abs(r.unexplained)).toBeLessThan(0.01);
  });
  it("scheduling finds the earliest common slot respecting buffers", () => {
    const input = getSkill("schedule_appointment")!.sampleInput() as Parameters<typeof findSlots>[0];
    const r = findSlots(input);
    expect(r.slots[0].start).toBe("2026-11-09 15:45"); // Dana busy until 15:30 + 15 min buffer
  });
  it("reorder plan, transcript analysis, document review, claims, CRM normalization, lead scoring", () => {
    const p = reorderPlan([{ sku: "A", description: "", onHand: 40, onOrder: 0, avgDailyUsage: 6, leadTimeDays: 10, safetyStockDays: 5, targetDaysOfCover: 30, moq: 50 }]);
    expect(p[0]).toMatchObject({ reorderPoint: 90, recommendQty: 200, urgency: "stockout_risk" });
    const t = analyzeTranscript("Alex: We agreed to extend the pilot.\nJordan: I will send the list by Friday.\nSam: Do we need IT?");
    expect(t.decisions).toHaveLength(1); expect(t.actions[0]).toMatchObject({ owner: "Jordan", due: "Friday" }); expect(t.questions).toHaveLength(1);
    const d = reviewText("This agreement will automatically renew. Payment terms: Net 60.", [{ item: "Governing law", re: /governing law/i }], 30);
    expect(d.missing).toEqual(["Governing law"]); expect(d.risks[0].label).toBe("Automatic renewal"); expect(d.conflicts[0]).toMatch(/Net 60.*Net 30/);
    expect(unsupportedClaims("We offer 15% off and guaranteed delivery", ["Standard terms are net 30"])).toEqual(expect.arrayContaining(["15%", "guaranteed"]));
    expect(normalizeRecord({ name: "morgan ellis", email: "MORGAN@X.COM", phone: "251.555.0142" })).toMatchObject({ name: "Morgan Ellis", email: "morgan@x.com", phone: "+1 (251) 555-0142" });
    expect(scoreLead({ name: "x", interest: "pricing for maintenance", notes: "wants a demo next month", lastContactDate: "2026-11-06" }, "2026-11-07", []).priority).toBe("hot");
  });
});
