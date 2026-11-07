/** POST /api/collect/consent — the employee acknowledged the notice in the collector UI. Writes consent_records.acknowledged_at. */
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { hmacHash } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { ConsentAck } from "@/collector-protocol/schema";
import { authCollector, readJson, err, json, noticeFromSettings, clientIp } from "../_lib";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const c = await authCollector(req);
  if (c instanceof Response) return c;
  const body = await readJson(req, ConsentAck);
  if (body instanceof Response) return body;
  if (body.collectorId !== c.id) return err(403, "collector_id_mismatch");
  if (!c.employeeId) return err(409, "collector_has_no_employee");
  const [org] = await db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, c.orgId)).limit(1);
  const notice = noticeFromSettings(org?.settings);
  if (body.noticeVersion !== notice.version) return err(409, "notice_version_outdated", { currentVersion: notice.version, text: notice.text });
  const employeeId = c.employeeId;
  const ipHash = hmacHash(clientIp(req));
  const id = await withTenant(c.orgId, async (tx) => {
    const [latest] = await tx.select().from(schema.consentRecords)
      .where(and(eq(schema.consentRecords.orgId, c.orgId), eq(schema.consentRecords.employeeId, employeeId), eq(schema.consentRecords.noticeVersion, notice.version)))
      .orderBy(desc(schema.consentRecords.createdAt)).limit(1);
    if (latest && !latest.withdrawnAt) {
      if (!latest.acknowledgedAt) await tx.update(schema.consentRecords).set({ acknowledgedAt: new Date(), method: "collector_ui", ipHash }).where(eq(schema.consentRecords.id, latest.id));
      return latest.id;
    }
    const [row] = await tx.insert(schema.consentRecords).values({ orgId: c.orgId, employeeId, noticeVersion: notice.version, noticeText: notice.text, acknowledgedAt: new Date(), method: "collector_ui", ipHash }).returning({ id: schema.consentRecords.id });
    return row.id;
  });
  await audit({ orgId: c.orgId, actorType: "collector", action: "consent.acknowledged", entityType: "consent_record", entityId: id, details: { employeeId, noticeVersion: notice.version, collectorId: c.id }, ipHash });
  return json({ ok: true, consentRecordId: id, consent: "acknowledged" });
}
