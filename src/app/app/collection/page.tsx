import { desc, eq, and, gte, sql, inArray } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import { PageHeader } from "@/components/ui";
import { DEFAULT_NOTICE_TEXT, DEFAULT_NOTICE_VERSION } from "@/collector-protocol/schema";
import { CollectionClient, type CollectionData } from "./collection-client";
/** Server actions on this page may start an analysis job via after() (src/lib/job-kick.ts): Vercel Hobby cap. */
export const maxDuration = 60;

export const metadata = { title: "Data Collection" };
export const dynamic = "force-dynamic";

export default async function CollectionPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireCtx("collectors:manage");
  const sp = await searchParams;
  const [org] = await db.select({ settings: schema.organizations.settings, timezone: schema.organizations.timezone, retentionDays: schema.organizations.retentionDays }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1);
  const s = (org?.settings ?? {}) as Record<string, unknown>;
  const notice = { version: String(s.noticeVersion ?? DEFAULT_NOTICE_VERSION), text: String(s.noticeText ?? DEFAULT_NOTICE_TEXT) };

  const data = await withTenant(ctx.orgId, async (tx): Promise<CollectionData> => {
    const since24h = new Date(Date.now() - 86400_000);
    const [authorization] = await tx.select().from(schema.authorizations).where(eq(schema.authorizations.orgId, ctx.orgId)).orderBy(desc(schema.authorizations.signedAt)).limit(1);
    const departments = await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, ctx.orgId)).orderBy(schema.departments.name);
    const employees = await tx.select({ id: schema.employees.id, displayName: schema.employees.displayName, title: schema.employees.title, departmentId: schema.employees.departmentId, isActive: schema.employees.isActive }).from(schema.employees).where(eq(schema.employees.orgId, ctx.orgId)).orderBy(schema.employees.displayName);
    const consents = await tx.select().from(schema.consentRecords).where(eq(schema.consentRecords.orgId, ctx.orgId)).orderBy(desc(schema.consentRecords.createdAt));
    const latestConsent = new Map<string, (typeof consents)[number]>();
    for (const c of consents) if (!latestConsent.has(c.employeeId)) latestConsent.set(c.employeeId, c);
    const collectors = await tx.select().from(schema.collectors).where(eq(schema.collectors.orgId, ctx.orgId)).orderBy(desc(schema.collectors.createdAt));
    const campaigns = await tx.select().from(schema.observationCampaigns).where(eq(schema.observationCampaigns.orgId, ctx.orgId)).orderBy(desc(schema.observationCampaigns.createdAt));
    const runs = await tx.select().from(schema.analysisRuns).where(eq(schema.analysisRuns.orgId, ctx.orgId)).orderBy(desc(schema.analysisRuns.createdAt)).limit(200);
    const latestRun = new Map<string, (typeof runs)[number]>();
    for (const r of runs) if (r.campaignId && !latestRun.has(r.campaignId)) latestRun.set(r.campaignId, r);
    const analysisJobs = await tx.select({ id: schema.jobs.id, status: schema.jobs.status, payload: schema.jobs.payload, createdAt: schema.jobs.createdAt, error: schema.jobs.error }).from(schema.jobs)
      .where(and(eq(schema.jobs.orgId, ctx.orgId), eq(schema.jobs.kind, "analysis"))).orderBy(desc(schema.jobs.createdAt)).limit(100);
    const latestJob = new Map<string, (typeof analysisJobs)[number]>();
    for (const j of analysisJobs) { const cid = String((j.payload as Record<string, unknown>)?.campaignId ?? ""); if (cid && !latestJob.has(cid)) latestJob.set(cid, j); }
    const [ev24] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, ctx.orgId), gte(schema.activityEvents.receivedAt, since24h)));
    const perCampaign = campaigns.length ? await tx.select({ campaignId: schema.activityEvents.campaignId, n: sql<number>`count(*)::int` }).from(schema.activityEvents)
      .where(and(eq(schema.activityEvents.orgId, ctx.orgId), inArray(schema.activityEvents.campaignId, campaigns.map((c) => c.id)))).groupBy(schema.activityEvents.campaignId) : [];
    const consentStatus = (empId: string): CollectionData["employees"][number]["consent"] => {
      const c = latestConsent.get(empId);
      if (!c) return "missing";
      if (c.withdrawnAt) return "withdrawn";
      if (c.noticeVersion !== notice.version) return "outdated";
      return c.acknowledgedAt ? "acknowledged" : "sent";
    };
    const empName = (id: string | null) => employees.find((e) => e.id === id)?.displayName ?? null;
    return {
      orgTimezone: org?.timezone ?? "UTC", retentionDays: org?.retentionDays ?? 180, notice, appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      authorization: authorization ? { ...authorization, signedAt: authorization.signedAt.toISOString(), expiresAt: authorization.expiresAt?.toISOString() ?? null } : null,
      departments,
      employees: employees.map((e) => ({ ...e, departmentName: departments.find((d) => d.id === e.departmentId)?.name ?? null, consent: consentStatus(e.id), consentAt: latestConsent.get(e.id)?.acknowledgedAt?.toISOString() ?? null, withdrawnAt: latestConsent.get(e.id)?.withdrawnAt?.toISOString() ?? null })),
      collectors: collectors.map((c) => ({ id: c.id, name: c.name, employeeId: c.employeeId, employeeName: empName(c.employeeId), platform: c.platform, status: c.status, version: c.version, lastSeenAt: c.lastSeenAt?.toISOString() ?? null, lastEventAt: c.lastEventAt?.toISOString() ?? null, eventsReceived: c.eventsReceived, pausedUntil: c.pausedUntil?.toISOString() ?? null, config: c.config ?? {}, createdAt: c.createdAt.toISOString() })),
      health: { active: collectors.filter((c) => c.status === "active").length, offline: collectors.filter((c) => c.status === "offline").length, pending: collectors.filter((c) => c.status === "pending").length, paused: collectors.filter((c) => c.status === "paused").length, revoked: collectors.filter((c) => c.status === "revoked").length, events24h: ev24?.n ?? 0 },
      campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, description: c.description, status: c.status, startsAt: c.startsAt?.toISOString() ?? null, endsAt: c.endsAt?.toISOString() ?? null, departmentIds: c.departmentIds ?? [], employeeIds: c.employeeIds ?? [], config: c.config ?? {}, events: perCampaign.find((p) => p.campaignId === c.id)?.n ?? 0,
        lastRun: latestRun.get(c.id) ? { status: latestRun.get(c.id)!.status, finishedAt: latestRun.get(c.id)!.finishedAt?.toISOString() ?? null, eventsAnalyzed: latestRun.get(c.id)!.eventsAnalyzed ?? 0, workflowsFound: latestRun.get(c.id)!.workflowsFound ?? 0, opportunitiesFound: latestRun.get(c.id)!.opportunitiesFound ?? 0, error: latestRun.get(c.id)!.error } : null,
        lastJob: latestJob.get(c.id) ? { status: latestJob.get(c.id)!.status, createdAt: latestJob.get(c.id)!.createdAt.toISOString(), error: latestJob.get(c.id)!.error } : null })),
    };
  });

  return (
    <div>
      <PageHeader title="Data Collection" subtitle="Authorization, employee notice & consent, desktop collectors and observation campaigns. Nothing is recorded until all three gates are open." />
      <CollectionClient data={data} initialTab={sp.tab} />
    </div>
  );
}
