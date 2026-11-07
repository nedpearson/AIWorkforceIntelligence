/** POST /api/collect/heartbeat — liveness + version; returns the current server-side status so the collector can react. */
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { Heartbeat } from "@/collector-protocol/schema";
import { authCollector, readJson, err, json, isPaused } from "../_lib";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const c = await authCollector(req);
  if (c instanceof Response) return c;
  const body = await readJson(req, Heartbeat);
  if (body instanceof Response) return body;
  if (body.collectorId !== c.id) return err(403, "collector_id_mismatch");
  const patch: Partial<typeof schema.collectors.$inferInsert> = { lastSeenAt: new Date(), version: body.version, updatedAt: new Date() };
  // An offline collector that heartbeats again becomes active (unless paused on the server side).
  if (c.status === "offline") patch.status = isPaused(c) ? "paused" : "active";
  // A server-side pause that has expired clears itself.
  if (c.status === "paused" && c.pausedUntil && c.pausedUntil.getTime() <= Date.now()) { patch.status = "active"; patch.pausedUntil = null; }
  await db.update(schema.collectors).set(patch).where(eq(schema.collectors.id, c.id));
  return json({ ok: true, status: patch.status ?? c.status, pausedUntil: (patch.pausedUntil === null ? null : c.pausedUntil)?.toISOString() ?? null, serverTime: new Date().toISOString() });
}
