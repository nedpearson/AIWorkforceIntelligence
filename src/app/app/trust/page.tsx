import { and, desc, eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import { PERMISSIONS, type Role } from "@/lib/rbac";
import { PageHeader } from "@/components/ui";
import { DEFAULT_BLOCKED_APPS, DEFAULT_NOTICE_TEXT, DEFAULT_NOTICE_VERSION } from "@/collector-protocol/schema";
import { TrustClient, type TrustData } from "./trust-client";

export const metadata = { title: "Trust & Privacy" };
export const dynamic = "force-dynamic";

/** Which roles can see what. Rendered as a plain-English matrix from the real PERMISSIONS table. */
const VISIBILITY: { label: string; perm: keyof typeof PERMISSIONS; explain: string }[] = [
  { label: "Your own consent & collector status", perm: "self:read", explain: "Everyone can see and change their own." },
  { label: "Workflow patterns (aggregated)", perm: "workflows:read", explain: "Discovered process steps, durations and repetition — grouped, not per-keystroke." },
  { label: "People list & roles", perm: "employees:read", explain: "Names, titles, departments." },
  { label: "Pay / loaded cost inputs", perm: "employees:cost:read", explain: "Used only for savings math; never shown to peers or managers." },
  { label: "Raw activity events (apps, categories, timings)", perm: "collectors:manage", explain: "Only to run and audit collection. Never contains content." },
  { label: "Audit log", perm: "audit:read", explain: "Every change to notice, consent, collectors and campaigns." },
];

export default async function TrustPage() {
  const ctx = await requireCtx("self:read");
  const [org] = await db.select({ name: schema.organizations.name, settings: schema.organizations.settings, retentionDays: schema.organizations.retentionDays }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1);
  const s = (org?.settings ?? {}) as Record<string, unknown>;
  const notice = { version: String(s.noticeVersion ?? DEFAULT_NOTICE_VERSION), text: String(s.noticeText ?? DEFAULT_NOTICE_TEXT) };
  const data = await withTenant(ctx.orgId, async (tx): Promise<TrustData> => {
    const [authorization] = await tx.select({ signerName: schema.authorizations.signerName, signerTitle: schema.authorizations.signerTitle, signedAt: schema.authorizations.signedAt, scope: schema.authorizations.scope }).from(schema.authorizations).where(eq(schema.authorizations.orgId, ctx.orgId)).orderBy(desc(schema.authorizations.signedAt)).limit(1);
    const running = await tx.select({ id: schema.observationCampaigns.id, name: schema.observationCampaigns.name, startsAt: schema.observationCampaigns.startsAt, endsAt: schema.observationCampaigns.endsAt, config: schema.observationCampaigns.config, employeeIds: schema.observationCampaigns.employeeIds, departmentIds: schema.observationCampaigns.departmentIds }).from(schema.observationCampaigns).where(and(eq(schema.observationCampaigns.orgId, ctx.orgId), eq(schema.observationCampaigns.status, "running")));
    let me: TrustData["me"] = null;
    if (ctx.employeeId) {
      const [emp] = await tx.select({ id: schema.employees.id, displayName: schema.employees.displayName, departmentId: schema.employees.departmentId }).from(schema.employees).where(and(eq(schema.employees.id, ctx.employeeId), eq(schema.employees.orgId, ctx.orgId))).limit(1);
      if (emp) {
        const [consent] = await tx.select().from(schema.consentRecords).where(and(eq(schema.consentRecords.orgId, ctx.orgId), eq(schema.consentRecords.employeeId, emp.id))).orderBy(desc(schema.consentRecords.createdAt)).limit(1);
        const cols = await tx.select({ id: schema.collectors.id, name: schema.collectors.name, status: schema.collectors.status, platform: schema.collectors.platform, lastSeenAt: schema.collectors.lastSeenAt, pausedUntil: schema.collectors.pausedUntil, eventsReceived: schema.collectors.eventsReceived }).from(schema.collectors).where(and(eq(schema.collectors.orgId, ctx.orgId), eq(schema.collectors.employeeId, emp.id)));
        const myCampaigns = running.filter((c) => (!(c.employeeIds ?? []).length && !(c.departmentIds ?? []).length) || (c.employeeIds ?? []).includes(emp.id) || (!!emp.departmentId && (c.departmentIds ?? []).includes(emp.departmentId)));
        const state: NonNullable<TrustData["me"]>["consent"] = !consent ? "missing" : consent.withdrawnAt ? "withdrawn" : consent.noticeVersion !== notice.version ? "outdated" : consent.acknowledgedAt ? "acknowledged" : "sent";
        me = { displayName: emp.displayName, consent: state, consentVersion: consent?.noticeVersion ?? null, acknowledgedAt: consent?.acknowledgedAt?.toISOString() ?? null, withdrawnAt: consent?.withdrawnAt?.toISOString() ?? null, method: consent?.method ?? null,
          collectors: cols.map((c) => ({ ...c, lastSeenAt: c.lastSeenAt?.toISOString() ?? null, pausedUntil: c.pausedUntil?.toISOString() ?? null })),
          campaigns: myCampaigns.map((c) => ({ id: c.id, name: c.name, startsAt: c.startsAt?.toISOString() ?? null, endsAt: c.endsAt?.toISOString() ?? null, schedule: c.config?.schedule ?? null, titleMode: c.config?.titleMode ?? "hash" })) };
      }
    }
    return {
      orgName: org?.name ?? "", retentionDays: org?.retentionDays ?? 180, notice, role: ctx.role, blockedApps: DEFAULT_BLOCKED_APPS,
      authorization: authorization ? { ...authorization, signedAt: authorization.signedAt.toISOString() } : null,
      runningCampaigns: running.length, me,
      visibility: VISIBILITY.map((v) => ({ ...v, roles: [...(PERMISSIONS[v.perm] as readonly Role[])] })),
      roles: ["owner", "admin", "manager", "employee", "consultant", "viewer"],
    };
  });
  return (
    <div>
      <PageHeader title="Trust & Privacy" subtitle={`How ${data.orgName} uses BridgeBox, in plain English — and your own controls.`} />
      <TrustClient data={data} />
    </div>
  );
}
