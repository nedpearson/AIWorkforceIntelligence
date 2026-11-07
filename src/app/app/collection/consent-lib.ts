import "server-only";
/** Consent helpers shared by the admin Data Collection page and the employee Trust page. NOT server actions. */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { DEFAULT_NOTICE_TEXT, DEFAULT_NOTICE_VERSION } from "@/collector-protocol/schema";

export async function currentNotice(orgId: string) {
  const [org] = await db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
  const s = (org?.settings ?? {}) as Record<string, unknown>;
  return { version: String(s.noticeVersion ?? DEFAULT_NOTICE_VERSION), text: String(s.noticeText ?? DEFAULT_NOTICE_TEXT) };
}

/** Mark every consent record for the employee withdrawn and pause their collectors. Audited. */
export async function withdrawAndPause(orgId: string, employeeId: string, actorUserId: string, by: "admin" | "employee") {
  await withTenant(orgId, async (tx) => {
    await tx.update(schema.consentRecords).set({ withdrawnAt: new Date() }).where(and(eq(schema.consentRecords.orgId, orgId), eq(schema.consentRecords.employeeId, employeeId)));
    await tx.update(schema.collectors).set({ status: "paused", pausedUntil: null, updatedAt: new Date() }).where(and(eq(schema.collectors.orgId, orgId), eq(schema.collectors.employeeId, employeeId)));
  });
  await audit({ orgId, actorUserId, action: "consent.withdrawn", entityType: "employee", entityId: employeeId, details: { by } });
}

/** Employee re-acknowledges the current notice from the web (Trust page). */
export async function acknowledgeFromWeb(orgId: string, employeeId: string, actorUserId: string, ipHash?: string) {
  const notice = await currentNotice(orgId);
  const id = await withTenant(orgId, async (tx) => {
    const [r] = await tx.insert(schema.consentRecords).values({ orgId, employeeId, noticeVersion: notice.version, noticeText: notice.text, acknowledgedAt: new Date(), method: "web", ipHash }).returning({ id: schema.consentRecords.id });
    return r.id;
  });
  await audit({ orgId, actorUserId, action: "consent.acknowledged", entityType: "consent_record", entityId: id, details: { employeeId, noticeVersion: notice.version, method: "web" } });
  return id;
}
