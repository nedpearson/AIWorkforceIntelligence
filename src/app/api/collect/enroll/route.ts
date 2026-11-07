/**
 * POST /api/collect/enroll — exchange a one-time enrollment code for a long-lived collector token.
 * No bearer auth (the code IS the credential). Rate-limited per source IP.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { sha256, hmacHash, randomToken } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { EnrollRequest, type EnrollResponse } from "@/collector-protocol/schema";
import { readJson, err, json, rateLimitOk, clientIp, noticeFromSettings, effectiveConfig } from "../_lib";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimitOk(`enroll:${ip}`, 20)) return err(429, "rate_limited", { retryAfterSec: 60 });
  const body = await readJson(req, EnrollRequest);
  if (body instanceof Response) return body;

  const codeHash = sha256(body.enrollmentCode.trim());
  const [c] = await db.select().from(schema.collectors)
    .where(and(eq(schema.collectors.enrollmentCodeHash, codeHash), eq(schema.collectors.status, "pending"))).limit(1);
  if (!c) { await audit({ actorType: "collector", action: "collector.enroll_failed", ipHash: hmacHash(ip) }); return err(401, "invalid_or_used_enrollment_code"); }
  // Codes expire 7 days after creation.
  if (Date.now() - c.createdAt.getTime() > 7 * 86400_000) return err(401, "enrollment_code_expired");

  const token = randomToken(32);
  await db.update(schema.collectors).set({
    tokenHash: sha256(token), enrollmentCodeHash: null, status: "active", platform: body.platform,
    hostnameHash: hmacHash(body.hostname.toLowerCase()), version: body.version, lastSeenAt: new Date(), updatedAt: new Date(),
  }).where(eq(schema.collectors.id, c.id));

  const [org] = await db.select({ settings: schema.organizations.settings, timezone: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, c.orgId)).limit(1);
  const cfg = effectiveConfig(c);
  if (cfg.schedule && !cfg.schedule.tz) cfg.schedule = { ...cfg.schedule, tz: org?.timezone ?? "UTC" };
  await audit({ orgId: c.orgId, actorType: "collector", action: "collector.enrolled", entityType: "collector", entityId: c.id, details: { platform: body.platform, version: body.version }, ipHash: hmacHash(ip) });

  const res: EnrollResponse = { collectorId: c.id, token, config: cfg, notice: noticeFromSettings(org?.settings) };
  return json(res);
}
