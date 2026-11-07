/**
 * POST /api/collect/events — ingest a batch of metadata-only activity events.
 * Server-side enforcement (the collector also filters, but the server never trusts it):
 *   - collector must be active and not paused; employee consent must be acknowledged and not withdrawn
 *   - each event must fall inside an active campaign's date range + schedule for this employee
 *   - blocked apps are dropped; titleMode strips titleHash/titleCategory as configured
 *   - meta keys that could carry content are rejected by the schema
 * Events are inserted in one multi-row insert inside withTenant(orgId).
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { EventBatch, type EventBatchResponse } from "@/collector-protocol/schema";
import { inDateRange, inSchedule } from "@/collector-protocol/schedule";
import { authCollector, readJson, err, json, isPaused, consentState, campaignsForEmployee, effectiveConfig } from "../_lib";

export const runtime = "nodejs";

type Reason = "collector_paused" | "no_employee" | "consent_missing" | "consent_withdrawn" | "no_active_campaign" | "outside_campaign_window" | "blocked_app" | "future_timestamp";

export async function POST(req: Request) {
  const c = await authCollector(req);
  if (c instanceof Response) return c;
  const body = await readJson(req, EventBatch);
  if (body instanceof Response) return body;
  if (body.collectorId !== c.id) return err(403, "collector_id_mismatch");

  const reasons: Partial<Record<Reason, number>> = {};
  const drop = (r: Reason, n = 1) => { reasons[r] = (reasons[r] ?? 0) + n; };
  const touch = async () => { await db.update(schema.collectors).set({ lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(schema.collectors.id, c.id)); };
  const respond = async (accepted: number): Promise<Response> => { const dropped = body.events.length - accepted; const r: EventBatchResponse = { accepted, dropped, reasons }; return json(r); };

  if (isPaused(c)) { drop("collector_paused", body.events.length); await touch(); return respond(0); }
  if (!c.employeeId) { drop("no_employee", body.events.length); await touch(); return respond(0); }
  const consent = await consentState(c.orgId, c.employeeId);
  if (consent !== "acknowledged") { drop(consent === "withdrawn" ? "consent_withdrawn" : "consent_missing", body.events.length); await touch(); return respond(0); }

  const [org] = await db.select({ timezone: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, c.orgId)).limit(1);
  const tz = org?.timezone ?? "UTC";
  const campaigns = await campaignsForEmployee(c.orgId, c.employeeId);
  if (!campaigns.length) { drop("no_active_campaign", body.events.length); await touch(); return respond(0); }
  const now = Date.now() + 5 * 60_000; // tolerate 5 min clock skew

  const rows: (typeof schema.activityEvents.$inferInsert)[] = [];
  for (const ev of body.events) {
    const ts = new Date(ev.ts);
    if (ts.getTime() > now) { drop("future_timestamp"); continue; }
    const camp = campaigns.find((k) => k.status === "running" && inDateRange(ts, k.startsAt, k.endsAt) && inSchedule(ts, effectiveConfig(c, k.config).schedule, tz));
    if (!camp) { drop("outside_campaign_window"); continue; }
    const cfg = effectiveConfig(c, camp.config);
    const appLc = ev.app.toLowerCase();
    if (appLc && cfg.blockedApps.some((b) => appLc.includes(b))) { drop("blocked_app"); continue; }
    const titleHash = cfg.titleMode === "hash" ? ev.titleHash ?? null : null;
    const titleCategory = cfg.titleMode === "none" ? null : ev.titleCategory ?? null;
    rows.push({ orgId: c.orgId, employeeId: c.employeeId, collectorId: c.id, campaignId: camp.id, ts, type: ev.type, app: ev.app, appCategory: ev.appCategory ?? null, titleCategory, titleHash, durationMs: ev.durationMs, meta: ev.meta ?? {} });
  }

  if (rows.length) {
    await withTenant(c.orgId, async (tx) => {
      // one multi-row insert; chunk to stay under Postgres' parameter limit
      for (let i = 0; i < rows.length; i += 1000) await tx.insert(schema.activityEvents).values(rows.slice(i, i + 1000));
    });
    const lastTs = rows.reduce((m, r) => (r.ts > m ? r.ts : m), rows[0].ts as Date);
    await db.update(schema.collectors).set({
      eventsReceived: sql`${schema.collectors.eventsReceived} + ${rows.length}`, lastEventAt: lastTs, lastSeenAt: new Date(), updatedAt: new Date(),
      ...(c.status === "offline" ? { status: "active" as const } : {}),
    }).where(eq(schema.collectors.id, c.id));
  } else await touch();
  return respond(rows.length);
}
