import { desc, eq, inArray, sql } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import { ReportsClient, type ReportRow } from "./reports-client";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const ctx = await requireCtx("finance:read");
  const { rows, branding } = await withTenant(ctx.orgId, async (tx) => {
    const rows = await tx.select({ id: schema.reports.id, kind: schema.reports.kind, title: schema.reports.title, periodStart: schema.reports.periodStart, periodEnd: schema.reports.periodEnd, generatedBy: schema.reports.generatedBy, createdAt: schema.reports.createdAt, data: schema.reports.data, hasPdf: sql<boolean>`${schema.reports.pdfBytes} is not null` })
      .from(schema.reports).where(eq(schema.reports.orgId, ctx.orgId)).orderBy(desc(schema.reports.createdAt)).limit(200);
    const [org] = await tx.select({ branding: schema.organizations.branding, name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1);
    return { rows, branding: { ...(org?.branding ?? {}), orgName: org?.name ?? "" } };
  });
  const userIds = [...new Set(rows.map((r) => r.generatedBy).filter((x): x is string => !!x))];
  // users is reachable by the admin handle; only members of this org are resolved (memberships check keeps it tenant-safe).
  const users = userIds.length ? await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, orgId: schema.memberships.orgId }).from(schema.users).innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id)).where(inArray(schema.users.id, userIds)) : [];
  const who = new Map(users.filter((u) => u.orgId === ctx.orgId).map((u) => [u.id, u.name || u.email]));
  const list: ReportRow[] = rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, periodStart: r.periodStart?.toISOString() ?? null, periodEnd: r.periodEnd?.toISOString() ?? null, generatedBy: r.generatedBy ? (who.get(r.generatedBy) ?? "member") : "system", createdAt: r.createdAt.toISOString(), scenario: String((r.data as Record<string, unknown>)?.scenario ?? ""), hasPdf: !!r.hasPdf }));
  return <ReportsClient rows={list} canGenerate={can(ctx.role, "reports:generate")} branding={branding} />;
}
