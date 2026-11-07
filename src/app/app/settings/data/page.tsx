import { and, eq, lt, sql } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { DataPrivacyClient } from "./data-client";

export const metadata = { title: "Data & privacy" };
export const dynamic = "force-dynamic";

export default async function DataPrivacyPage() {
  const ctx = await requireCtx("org:manage");
  const data = await withTenant(ctx.orgId, async (tx) => {
    const [org] = await tx.select({ retentionDays: schema.organizations.retentionDays, name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1);
    const cutoff = new Date(Date.now() - org.retentionDays * 86_400_000);
    const [{ total, oldest, newest }] = await tx.select({ total: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${schema.activityEvents.ts})`, newest: sql<string | null>`max(${schema.activityEvents.ts})` }).from(schema.activityEvents).where(eq(schema.activityEvents.orgId, ctx.orgId));
    const [{ expired }] = await tx.select({ expired: sql<number>`count(*)::int` }).from(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, ctx.orgId), lt(schema.activityEvents.ts, cutoff)));
    const [{ consents }] = await tx.select({ consents: sql<number>`count(*)::int` }).from(schema.consentRecords).where(and(eq(schema.consentRecords.orgId, ctx.orgId), sql`${schema.consentRecords.acknowledgedAt} is not null and ${schema.consentRecords.withdrawnAt} is null`));
    return { retentionDays: org.retentionDays, orgName: org.name, total, oldest: oldest ? new Date(oldest).toISOString() : null, newest: newest ? new Date(newest).toISOString() : null, expired, cutoff: cutoff.toISOString(), consents };
  });
  return <DataPrivacyClient stats={data} isOwner={ctx.role === "owner"} />;
}
