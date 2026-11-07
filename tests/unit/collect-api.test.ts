/**
 * End-to-end collector ingest pipeline against a real Postgres (DATABASE_URL, e.g. bridgebox_c).
 * Calls the route handlers directly: enroll -> consent -> events -> pause -> titleMode -> auth ->
 * retention sweep -> cross-org isolation. Builds its own fixtures; cleans up after itself.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema, pg } from "@/db/client";
import { sha256, randomToken } from "@/lib/crypto";
import { POST as enrollPOST } from "@/app/api/collect/enroll/route";
import { POST as eventsPOST } from "@/app/api/collect/events/route";
import { POST as consentPOST } from "@/app/api/collect/consent/route";
import { POST as pausePOST } from "@/app/api/collect/pause/route";
import { POST as heartbeatPOST } from "@/app/api/collect/heartbeat/route";
import { GET as configGET } from "@/app/api/collect/config/route";
import { POST as jobsRunPOST } from "@/app/api/jobs/run/route";
import { _resetRateLimits } from "@/app/api/collect/_lib";
import { enqueue, runPending } from "@/engine/jobs";
import { isForbiddenMetaKey, MetaSchema } from "@/collector-protocol/schema";
import { inSchedule } from "@/collector-protocol/schedule";
import { withdrawAndPause, acknowledgeFromWeb } from "@/app/app/collection/consent-lib";

const SUFFIX = randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x");
const post = (fn: (r: Request) => Promise<Response>, path: string, body: unknown, token?: string) =>
  fn(new Request(`http://test.local${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
const get = (fn: (r: Request) => Promise<Response>, path: string, token?: string) =>
  fn(new Request(`http://test.local${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));

type Fx = { orgId: string; employeeId: string; collectorId: string; enrollCode: string; campaignId: string; token?: string };
async function makeOrg(name: string, opts: { titleMode?: "hash" | "category" | "none"; retentionDays?: number } = {}): Promise<Fx> {
  const [org] = await db.insert(schema.organizations).values({ name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${SUFFIX}`, retentionDays: opts.retentionDays ?? 180, settings: { noticeText: `Notice for ${name}`, noticeVersion: "7" } as schema.OrgSettings }).returning();
  const [emp] = await db.insert(schema.employees).values({ orgId: org.id, displayName: `Emp ${name}` }).returning();
  const enrollCode = randomToken(12);
  const [col] = await db.insert(schema.collectors).values({ orgId: org.id, employeeId: emp.id, name: `${name} laptop`, platform: "windows", tokenHash: sha256(randomToken(32)), enrollmentCodeHash: sha256(enrollCode), status: "pending" }).returning();
  const [camp] = await db.insert(schema.observationCampaigns).values({ orgId: org.id, name: "Campaign", status: "running", startsAt: new Date(Date.now() - 7 * 86400_000), endsAt: new Date(Date.now() + 7 * 86400_000), config: { titleMode: opts.titleMode ?? "hash" } }).returning();
  return { orgId: org.id, employeeId: emp.id, collectorId: col.id, enrollCode, campaignId: camp.id };
}
const ev = (over: Partial<Record<string, unknown>> = {}) => ({ ts: new Date(Date.now() - 60_000).toISOString(), type: "data_entry", app: "QuickBooks", appCategory: "accounting", titleCategory: "bill entry", titleHash: "abc123", durationMs: 1000, meta: { fieldCount: 3, keysCount: 40 }, ...over });

let A: Fx, B: Fx, N: Fx;
const orgIds: string[] = [];

beforeAll(async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  A = await makeOrg("Org A"); B = await makeOrg("Org B"); N = await makeOrg("Org None", { titleMode: "none" });
  orgIds.push(A.orgId, B.orgId, N.orgId);
  _resetRateLimits();
});
afterAll(async () => {
  await db.delete(schema.activityEvents).where(inArray(schema.activityEvents.orgId, orgIds));
  await db.delete(schema.jobs).where(like(schema.jobs.kind, "%"));
  await db.delete(schema.auditLog).where(inArray(schema.auditLog.orgId, orgIds));
  await db.delete(schema.organizations).where(inArray(schema.organizations.id, orgIds)); // cascades employees/collectors/consent/campaigns
  await pg.end({ timeout: 5 });
});

describe("collector protocol schema", () => {
  it("rejects meta keys that could carry content, allows keysCount", () => {
    expect(isForbiddenMetaKey("keysCount")).toBe(false);
    for (const k of ["keys", "keyLog", "text", "windowTitle", "url", "content", "clipboard"]) expect(isForbiddenMetaKey(k)).toBe(true);
    expect(MetaSchema.safeParse({ keysCount: 3, clicks: 2 }).success).toBe(true);
    expect(MetaSchema.safeParse({ title: "secret" }).success).toBe(false);
    expect(MetaSchema.safeParse({ nested: { a: 1 } }).success).toBe(false);
  });
  it("schedule windows are timezone-aware", () => {
    // 2026-11-04 is a Wednesday. 14:00Z = 08:00 in Chicago (CST).
    const d = new Date("2026-11-04T14:00:00Z");
    expect(inSchedule(d, { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", tz: "America/Chicago" })).toBe(true);
    expect(inSchedule(d, { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", tz: "America/Chicago" })).toBe(false);
    expect(inSchedule(d, { days: [0, 6], start: "00:00", end: "23:59", tz: "America/Chicago" })).toBe(false);
    expect(inSchedule(d, undefined)).toBe(true);
  });
});

describe("enroll", () => {
  it("exchanges a one-time code for a token and returns the org notice", async () => {
    const r = await post(enrollPOST, "/api/collect/enroll", { enrollmentCode: A.enrollCode, platform: "windows", hostname: "LAPTOP-A", version: "0.1.0" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.collectorId).toBe(A.collectorId);
    expect(j.token).toBeTypeOf("string");
    expect(j.notice).toEqual({ version: "7", text: "Notice for Org A" });
    expect(j.config.blockedApps).toContain("1password");
    A.token = j.token;
    const [c] = await db.select().from(schema.collectors).where(eq(schema.collectors.id, A.collectorId));
    expect(c.status).toBe("active"); expect(c.enrollmentCodeHash).toBeNull(); expect(c.tokenHash).toBe(sha256(j.token)); expect(c.hostnameHash).toBeTruthy();
    const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, A.orgId), eq(schema.auditLog.action, "collector.enrolled")));
    expect(audits.length).toBe(1);
  });
  it("rejects a reused or unknown code", async () => {
    const r = await post(enrollPOST, "/api/collect/enroll", { enrollmentCode: A.enrollCode, platform: "windows", hostname: "LAPTOP-A", version: "0.1.0" });
    expect(r.status).toBe(401);
  });
  it("enrolls org B and the titleMode=none org too", async () => {
    for (const fx of [B, N]) {
      const r = await post(enrollPOST, "/api/collect/enroll", { enrollmentCode: fx.enrollCode, platform: "macos", hostname: "mac", version: "0.1.0" });
      expect(r.status).toBe(200); fx.token = (await r.json()).token;
    }
  });
});

describe("auth", () => {
  it("401 on missing / bad token", async () => {
    expect((await post(eventsPOST, "/api/collect/events", { collectorId: A.collectorId, events: [ev()] })).status).toBe(401);
    expect((await post(eventsPOST, "/api/collect/events", { collectorId: A.collectorId, events: [ev()] }, randomToken(32))).status).toBe(401);
    expect((await get(configGET, "/api/collect/config", "nope")).status).toBe(401);
  });
  it("413 on oversized batch", async () => {
    const r = await post(eventsPOST, "/api/collect/events", { collectorId: A.collectorId, events: Array.from({ length: 5001 }, () => ev()) }, A.token);
    expect(r.status).toBe(413);
  });
  it("400 on meta that could carry content", async () => {
    const r = await post(eventsPOST, "/api/collect/events", { collectorId: A.collectorId, events: [ev({ meta: { windowTitle: "Invoice 1234" } })] }, A.token);
    expect(r.status).toBe(400);
  });
});

describe("consent gate + events", () => {
  it("drops events while consent is missing", async () => {
    const r = await post(eventsPOST, "/api/collect/events", { collectorId: A.collectorId, events: [ev()] }, A.token);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ accepted: 0, dropped: 1, reasons: { consent_missing: 1 } });
  });
  it("records consent (acknowledgedAt) and rejects an outdated notice version", async () => {
    const bad = await post(consentPOST, "/api/collect/consent", { collectorId: A.collectorId, noticeVersion: "6" }, A.token);
    expect(bad.status).toBe(409);
    const r = await post(consentPOST, "/api/collect/consent", { collectorId: A.collectorId, noticeVersion: "7" }, A.token);
    expect(r.status).toBe(200);
    const [cr] = await db.select().from(schema.consentRecords).where(eq(schema.consentRecords.employeeId, A.employeeId));
    expect(cr.acknowledgedAt).toBeInstanceOf(Date); expect(cr.noticeVersion).toBe("7"); expect(cr.withdrawnAt).toBeNull();
    for (const fx of [B, N]) expect((await post(consentPOST, "/api/collect/consent", { collectorId: fx.collectorId, noticeVersion: "7" }, fx.token)).status).toBe(200);
  });
  it("config reports consent + campaign windows", async () => {
    const r = await get(configGET, "/api/collect/config", A.token);
    const j = await r.json();
    expect(j.consent).toBe("acknowledged"); expect(j.campaigns.map((c: { id: string }) => c.id)).toContain(A.campaignId); expect(j.notice.version).toBe("7");
  });
  it("accepts a batch, drops blocked apps, out-of-window and future events", async () => {
    const r = await post(eventsPOST, "/api/collect/events", { collectorId: A.collectorId, events: [
      ev(), ev({ type: "app_focus", app: "Excel", appCategory: "spreadsheet", titleCategory: "invoice log", meta: {} }),
      ev({ app: "1Password" }), ev({ app: "Chase Online" }),
      ev({ ts: new Date(Date.now() - 30 * 86400_000).toISOString() }), ev({ ts: new Date(Date.now() + 3600_000).toISOString() }),
    ] }, A.token);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ accepted: 2, dropped: 4, reasons: { blocked_app: 2, outside_campaign_window: 1, future_timestamp: 1 } });
    const rows = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.orgId, A.orgId));
    expect(rows.length).toBe(2);
    expect(rows.every((e) => e.employeeId === A.employeeId && e.collectorId === A.collectorId && e.campaignId === A.campaignId)).toBe(true);
    expect(rows.find((e) => e.app === "QuickBooks")?.titleHash).toBe("abc123");
    const [c] = await db.select().from(schema.collectors).where(eq(schema.collectors.id, A.collectorId));
    expect(c.eventsReceived).toBe(2); expect(c.lastEventAt).toBeInstanceOf(Date); expect(c.lastSeenAt).toBeInstanceOf(Date);
  });
  it("heartbeat updates lastSeenAt/version", async () => {
    const r = await post(heartbeatPOST, "/api/collect/heartbeat", { collectorId: A.collectorId, version: "0.1.1", status: "running", queueDepth: 0 }, A.token);
    expect(r.status).toBe(200);
    const [c] = await db.select().from(schema.collectors).where(eq(schema.collectors.id, A.collectorId));
    expect(c.version).toBe("0.1.1");
  });
});

describe("pause / resume", () => {
  it("blocks events while paused (employee-initiated), audits, and resumes", async () => {
    const p = await post(pausePOST, "/api/collect/pause", { collectorId: A.collectorId, minutes: 30 }, A.token);
    expect(p.status).toBe(200); expect((await p.json()).status).toBe("paused");
    const r = await post(eventsPOST, "/api/collect/events", { collectorId: A.collectorId, events: [ev()] }, A.token);
    expect(await r.json()).toMatchObject({ accepted: 0, dropped: 1, reasons: { collector_paused: 1 } });
    const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, A.orgId), eq(schema.auditLog.action, "collector.paused")));
    expect(audits.length).toBe(1);
    const res = await post(pausePOST, "/api/collect/pause", { collectorId: A.collectorId, resume: true }, A.token);
    expect((await res.json()).status).toBe("active");
    const r2 = await post(eventsPOST, "/api/collect/events", { collectorId: A.collectorId, events: [ev()] }, A.token);
    expect((await r2.json()).accepted).toBe(1);
  });
  it("blocks events after consent is withdrawn", async () => {
    await db.update(schema.consentRecords).set({ withdrawnAt: new Date() }).where(eq(schema.consentRecords.employeeId, B.employeeId));
    const r = await post(eventsPOST, "/api/collect/events", { collectorId: B.collectorId, events: [ev()] }, B.token);
    expect(await r.json()).toMatchObject({ accepted: 0, reasons: { consent_withdrawn: 1 } });
    await db.update(schema.consentRecords).set({ withdrawnAt: null }).where(eq(schema.consentRecords.employeeId, B.employeeId));
  });
  it("Trust-page withdraw: marks consent withdrawn, pauses the collector, blocks events; re-acknowledge restores", async () => {
    await withdrawAndPause(B.orgId, B.employeeId, "00000000-0000-0000-0000-000000000000", "employee");
    const [cr] = await db.select().from(schema.consentRecords).where(eq(schema.consentRecords.employeeId, B.employeeId));
    expect(cr.withdrawnAt).toBeInstanceOf(Date);
    let [c] = await db.select().from(schema.collectors).where(eq(schema.collectors.id, B.collectorId));
    expect(c.status).toBe("paused");
    const r = await post(eventsPOST, "/api/collect/events", { collectorId: B.collectorId, events: [ev()] }, B.token);
    expect(await r.json()).toMatchObject({ accepted: 0, reasons: { collector_paused: 1 } });
    await acknowledgeFromWeb(B.orgId, B.employeeId, "00000000-0000-0000-0000-000000000000");
    await db.update(schema.collectors).set({ status: "active" }).where(eq(schema.collectors.id, B.collectorId));
    [c] = await db.select().from(schema.collectors).where(eq(schema.collectors.id, B.collectorId));
    const r2 = await post(eventsPOST, "/api/collect/events", { collectorId: B.collectorId, events: [ev()] }, B.token);
    expect((await r2.json()).accepted).toBe(1);
    await db.delete(schema.activityEvents).where(eq(schema.activityEvents.orgId, B.orgId));
  });
  it("403 once revoked", async () => {
    await db.update(schema.collectors).set({ status: "revoked" }).where(eq(schema.collectors.id, B.collectorId));
    expect((await post(eventsPOST, "/api/collect/events", { collectorId: B.collectorId, events: [ev()] }, B.token)).status).toBe(403);
    await db.update(schema.collectors).set({ status: "active" }).where(eq(schema.collectors.id, B.collectorId));
  });
});

describe("titleMode", () => {
  it("none: strips titleHash and titleCategory", async () => {
    const r = await post(eventsPOST, "/api/collect/events", { collectorId: N.collectorId, events: [ev()] }, N.token);
    expect((await r.json()).accepted).toBe(1);
    const [row] = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.orgId, N.orgId));
    expect(row.titleHash).toBeNull(); expect(row.titleCategory).toBeNull(); expect(row.app).toBe("QuickBooks");
  });
  it("category: keeps category, drops hash", async () => {
    await db.update(schema.observationCampaigns).set({ config: { titleMode: "category" } }).where(eq(schema.observationCampaigns.id, B.campaignId));
    const r = await post(eventsPOST, "/api/collect/events", { collectorId: B.collectorId, events: [ev()] }, B.token);
    expect((await r.json()).accepted).toBe(1);
    const [row] = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.orgId, B.orgId));
    expect(row.titleHash).toBeNull(); expect(row.titleCategory).toBe("bill entry");
  });
});

describe("cross-org isolation", () => {
  it("a token from org A can never write into org B", async () => {
    const before = (await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.orgId, B.orgId))).length;
    // 1. claim B's collector id with A's token
    const r = await post(eventsPOST, "/api/collect/events", { collectorId: B.collectorId, events: [ev()] }, A.token);
    expect(r.status).toBe(403);
    // 2. consent/pause with B's collector id and A's token
    expect((await post(consentPOST, "/api/collect/consent", { collectorId: B.collectorId, noticeVersion: "7" }, A.token)).status).toBe(403);
    expect((await post(pausePOST, "/api/collect/pause", { collectorId: B.collectorId }, A.token)).status).toBe(403);
    // 3. a valid batch from A lands in A only
    await post(eventsPOST, "/api/collect/events", { collectorId: A.collectorId, events: [ev()] }, A.token);
    const after = (await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.orgId, B.orgId))).length;
    expect(after).toBe(before);
    const aRows = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.orgId, A.orgId));
    expect(aRows.every((e) => e.orgId === A.orgId && e.employeeId === A.employeeId)).toBe(true);
  });
});

describe("jobs", () => {
  it("retention sweep deletes events older than org.retentionDays and audits", async () => {
    await db.update(schema.organizations).set({ retentionDays: 30 }).where(eq(schema.organizations.id, A.orgId));
    await db.insert(schema.activityEvents).values([
      { orgId: A.orgId, employeeId: A.employeeId, collectorId: A.collectorId, ts: new Date(Date.now() - 40 * 86400_000), type: "app_focus", app: "Excel", durationMs: 10 },
      { orgId: A.orgId, employeeId: A.employeeId, collectorId: A.collectorId, ts: new Date(Date.now() - 45 * 86400_000), type: "app_focus", app: "Excel", durationMs: 10 },
      { orgId: B.orgId, employeeId: B.employeeId, collectorId: B.collectorId, ts: new Date(Date.now() - 45 * 86400_000), type: "app_focus", app: "Excel", durationMs: 10 }, // B keeps 180 days
    ]);
    const beforeA = (await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.orgId, A.orgId))).length;
    await enqueue("retention_sweep", { orgId: A.orgId });
    await enqueue("retention_sweep", { orgId: B.orgId });
    const s = await runPending({ limit: 10 });
    expect(s.done.length).toBe(2); expect(s.failed.length).toBe(0);
    const afterA = (await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.orgId, A.orgId))).length;
    expect(beforeA - afterA).toBe(2);
    const bOld = await db.select().from(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, B.orgId), eq(schema.activityEvents.durationMs, 10)));
    expect(bOld.length).toBe(1);
    const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, A.orgId), eq(schema.auditLog.action, "retention.sweep")));
    expect(audits.length).toBe(1); expect(audits[0].details).toMatchObject({ deleted: 2, retentionDays: 30 });
  });
  it("offline check marks stale collectors offline; heartbeat brings them back", async () => {
    await db.update(schema.collectors).set({ lastSeenAt: new Date(Date.now() - 20 * 60_000) }).where(eq(schema.collectors.id, A.collectorId));
    await enqueue("collector_offline_check", {});
    const s = await runPending({ limit: 5 });
    expect(s.done.length).toBe(1);
    let [c] = await db.select().from(schema.collectors).where(eq(schema.collectors.id, A.collectorId));
    expect(c.status).toBe("offline");
    await post(heartbeatPOST, "/api/collect/heartbeat", { collectorId: A.collectorId, version: "0.1.1", status: "running" }, A.token);
    [c] = await db.select().from(schema.collectors).where(eq(schema.collectors.id, A.collectorId));
    expect(c.status).toBe("active");
  });
  it("retries with backoff and fails after maxAttempts; unknown kinds fail", async () => {
    const j = await enqueue("definitely_unknown_kind", {}, null, undefined, { maxAttempts: 2 });
    let s = await runPending({ limit: 5 }); expect(s.retried).toContain(j.id);
    let [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, j.id));
    expect(row.status).toBe("queued"); expect(row.attempts).toBe(1); expect(row.runAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await db.update(schema.jobs).set({ runAfter: new Date() }).where(eq(schema.jobs.id, j.id));
    s = await runPending({ limit: 5 }); expect(s.failed).toContain(j.id);
    [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, j.id));
    expect(row.status).toBe("failed"); expect(row.error).toContain("no handler");
  });
  it("analysis job can be enqueued for a campaign", async () => {
    const j = await enqueue("analysis", { orgId: A.orgId, campaignId: A.campaignId }, A.orgId);
    expect(j.kind).toBe("analysis"); expect(j.status).toBe("queued");
    await db.delete(schema.jobs).where(eq(schema.jobs.id, j.id)); // engine owned elsewhere; not executed here
  });
  it("/api/jobs/run requires the cron secret", async () => {
    const r1 = await jobsRunPOST(new Request("http://test.local/api/jobs/run?housekeeping=0", { method: "POST" }));
    expect(r1.status).toBe(401);
    const r2 = await jobsRunPOST(new Request("http://test.local/api/jobs/run?housekeeping=0", { method: "POST", headers: { "x-cron-secret": "test-cron-secret" } }));
    expect(r2.status).toBe(200); expect((await r2.json()).ok).toBe(true);
  });
});
