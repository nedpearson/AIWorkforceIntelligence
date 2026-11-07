/** Risk register — DB-backed fixture with deliberate control failures (own org). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { computeRiskRegister, riskScore } from "@/engine/risk";

const ids = { org: "" };
const now = new Date("2026-11-07T12:00:00Z");
beforeAll(async () => {
  const [org] = await db.insert(schema.organizations).values({ name: "Risk Fixture", slug: `risk-test-${Date.now()}`, kind: "client", retentionDays: 30 }).returning(); ids.org = org.id;
  const [e1] = await db.insert(schema.employees).values({ orgId: org.id, displayName: "Consented" }).returning();
  const [e2] = await db.insert(schema.employees).values({ orgId: org.id, displayName: "Not consented" }).returning();
  await db.insert(schema.consentRecords).values({ orgId: org.id, employeeId: e1.id, noticeVersion: "1", noticeText: "n", acknowledgedAt: new Date("2026-09-01") });
  const [c] = await db.insert(schema.collectors).values({ orgId: org.id, employeeId: e1.id, name: "c", platform: "simulated", tokenHash: `t-${Date.now()}`, status: "offline" }).returning();
  for (const [emp, ts] of [[e1.id, "2026-08-01T10:00:00Z"], [e2.id, "2026-11-01T10:00:00Z"]] as const) await db.insert(schema.activityEvents).values({ orgId: org.id, employeeId: emp, collectorId: c.id, ts: new Date(ts), type: "app_focus", app: "Excel" });
  const [w] = await db.insert(schema.workflows).values({ orgId: org.id, name: "Payroll", signature: "p", regulatoryFlag: "PII" }).returning();
  await db.insert(schema.agents).values({ orgId: org.id, workflowId: w.id, name: "Payroll bot", category: "data_entry", templateKey: "x", status: "deployed", approvalPolicy: { mode: "none" }, definition: { nodes: [{ id: "n", type: "action", label: "pay", config: {}, sensitive: true }], edges: [] } });
  await db.insert(schema.credentials).values({ orgId: org.id, name: "Old SMTP", provider: "smtp", secretEnc: "x", createdAt: new Date("2026-01-01"), lastUsedAt: new Date("2026-03-01") });
});
afterAll(async () => { if (ids.org) await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org)); });

describe("risk register", () => {
  it("score = 100 − Σ open penalties", () => {
    expect(riskScore([{ severity: "critical", open: true }, { severity: "medium", open: true }, { severity: "ok", open: false }])).toBe(70);
    expect(riskScore(Array(5).fill({ severity: "critical", open: true }))).toBe(0);
  });
  it("detects each failing control from data", async () => {
    const r = await computeRiskRegister(ids.org, now);
    const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
    expect(by.consent.severity).toBe("critical"); // 1 of 2 observed (50%) without consent
    expect(by.consent.metric).toMatchObject({ value: 1, of: 2 });
    expect(by.authorization.severity).toBe("critical"); // observing with no authorization
    expect(by.sensitive_no_approval.severity).toBe("critical"); // deployed, mode none, sensitive node
    expect(by.regulated_gates.severity).toBe("high");
    expect(by.stale_credentials.severity).toBe("low");
    expect(by.retention.severity).toBe("high"); // oldest 98 days vs 30-day policy
    expect(by.collectors_offline.severity).toBe("medium");
    expect(r.items[0].severity).toBe("critical"); // sorted
    expect(r.score).toBe(riskScore(r.items));
    expect(r.heatmap.reduce((s, c) => s + c.count, 0)).toBe(r.items.filter((i) => i.open).length);
    expect(r.audit.daily).toHaveLength(30);
    for (const i of r.items) { expect(i.href).toMatch(/^\//); expect(i.evidence.length).toBeGreaterThan(5); }
  });
});
