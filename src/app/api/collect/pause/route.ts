/** POST /api/collect/pause — employee-initiated pause/resume from the collector. Sets collectors.paused_until. Audited. */
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { PauseRequest } from "@/collector-protocol/schema";
import { authCollector, readJson, err, json } from "../_lib";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const c = await authCollector(req);
  if (c instanceof Response) return c;
  const body = await readJson(req, PauseRequest);
  if (body instanceof Response) return body;
  if (body.collectorId !== c.id) return err(403, "collector_id_mismatch");
  if (body.resume) {
    await db.update(schema.collectors).set({ pausedUntil: null, status: c.status === "paused" ? "active" : c.status, lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(schema.collectors.id, c.id));
    await audit({ orgId: c.orgId, actorType: "collector", action: "collector.resumed", entityType: "collector", entityId: c.id, details: { by: "employee" } });
    return json({ ok: true, status: "active", pausedUntil: null });
  }
  const minutes = body.minutes ?? 60;
  const until = new Date(Date.now() + minutes * 60_000);
  await db.update(schema.collectors).set({ pausedUntil: until, status: "paused", lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(schema.collectors.id, c.id));
  await audit({ orgId: c.orgId, actorType: "collector", action: "collector.paused", entityType: "collector", entityId: c.id, details: { by: "employee", minutes } });
  return json({ ok: true, status: "paused", pausedUntil: until.toISOString() });
}
