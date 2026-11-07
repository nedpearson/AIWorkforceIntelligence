"use server";
import { startJobSoon } from "@/lib/job-kick";
/** Server actions for /app/collection. Every mutation: zod-validated, permission-checked, tenant-scoped, audited. */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { sha256, randomToken } from "@/lib/crypto";
import { enqueue } from "@/engine/jobs";
import { assertSeatAvailable, SeatLimitError } from "@/engine/billing";
import { DEFAULT_NOTICE_TEXT, DEFAULT_NOTICE_VERSION, CollectorConfigSchema } from "@/collector-protocol/schema";
import { withdrawAndPause, currentNotice } from "./consent-lib";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): Result<never> => ({ ok: false, error });
const uuid = z.string().uuid();
const revalidate = () => { revalidatePath("/app/collection"); revalidatePath("/app/trust"); };

// ---------- authorization ----------
const AuthorizationInput = z.object({ signerName: z.string().min(2).max(120), signerTitle: z.string().min(2).max(120), scope: z.string().min(3).max(500), documentText: z.string().min(20).max(20000), expiresAt: z.string().optional() });
export async function recordAuthorization(raw: unknown): Promise<Result<{ id: string }>> {
  const ctx = await requireCtx("collectors:manage");
  const p = AuthorizationInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid");
  const id = await withTenant(ctx.orgId, async (tx) => {
    const [r] = await tx.insert(schema.authorizations).values({ orgId: ctx.orgId, signedByUserId: ctx.userId, signerName: p.data.signerName, signerTitle: p.data.signerTitle, scope: p.data.scope, documentText: p.data.documentText, expiresAt: p.data.expiresAt ? new Date(p.data.expiresAt) : null }).returning({ id: schema.authorizations.id });
    return r.id;
  });
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "authorization.recorded", entityType: "authorization", entityId: id, details: { signerName: p.data.signerName, scope: p.data.scope } });
  revalidate(); return { ok: true, id };
}

// ---------- notice ----------
const NoticeInput = z.object({ text: z.string().min(50).max(20000), bumpVersion: z.boolean().default(true) });
export async function saveNotice(raw: unknown): Promise<Result<{ version: string }>> {
  const ctx = await requireCtx("collectors:manage");
  const p = NoticeInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid");
  const [org] = await db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1);
  const s = (org?.settings ?? {}) as Record<string, unknown>;
  const prev = String(s.noticeVersion ?? DEFAULT_NOTICE_VERSION);
  const changed = (s.noticeText ?? DEFAULT_NOTICE_TEXT) !== p.data.text;
  const version = changed && p.data.bumpVersion ? String((parseInt(prev, 10) || 1) + 1) : prev;
  await db.update(schema.organizations).set({ settings: { ...s, noticeText: p.data.text, noticeVersion: version } as schema.OrgSettings, updatedAt: new Date() }).where(eq(schema.organizations.id, ctx.orgId));
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "notice.updated", entityType: "organization", entityId: ctx.orgId, details: { version, changed } });
  revalidate(); return { ok: true, version };
}

// ---------- consent ----------
/** "Send" = create a pending consent record for the current notice version (the collector / trust page then acknowledges it). */
export async function sendConsentRequest(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("collectors:manage");
  const p = z.object({ employeeId: uuid }).safeParse(raw); if (!p.success) return fail("invalid employee");
  const notice = await currentNotice(ctx.orgId);
  const found = await withTenant(ctx.orgId, async (tx) => {
    const [emp] = await tx.select({ id: schema.employees.id }).from(schema.employees).where(and(eq(schema.employees.id, p.data.employeeId), eq(schema.employees.orgId, ctx.orgId))).limit(1);
    if (!emp) return false;
    const [latest] = await tx.select().from(schema.consentRecords).where(and(eq(schema.consentRecords.orgId, ctx.orgId), eq(schema.consentRecords.employeeId, emp.id))).orderBy(desc(schema.consentRecords.createdAt)).limit(1);
    if (latest && latest.noticeVersion === notice.version && !latest.withdrawnAt) return true; // already sent/acknowledged for this version
    await tx.insert(schema.consentRecords).values({ orgId: ctx.orgId, employeeId: emp.id, noticeVersion: notice.version, noticeText: notice.text, method: "web" });
    return true;
  });
  if (!found) return fail("employee not found");
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "consent.requested", entityType: "employee", entityId: p.data.employeeId, details: { noticeVersion: notice.version } });
  revalidate(); return { ok: true };
}
export async function withdrawConsentForEmployee(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("collectors:manage");
  const p = z.object({ employeeId: uuid }).safeParse(raw); if (!p.success) return fail("invalid employee");
  await withdrawAndPause(ctx.orgId, p.data.employeeId, ctx.userId, "admin");
  revalidate(); return { ok: true };
}
// ---------- collectors ----------
const EnrollInput = z.object({ employeeId: uuid, name: z.string().min(1).max(80) });
export async function createEnrollmentCode(raw: unknown): Promise<Result<{ collectorId: string; code: string; url: string }>> {
  const ctx = await requireCtx("collectors:manage");
  const p = EnrollInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid");
  try { await assertSeatAvailable(ctx.orgId, p.data.employeeId); } catch (e) { if (e instanceof SeatLimitError) return fail(e.message); throw e; }
  const code = `BB-${randomToken(9).replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase()}`;
  const collectorId = await withTenant(ctx.orgId, async (tx) => {
    const [emp] = await tx.select({ id: schema.employees.id }).from(schema.employees).where(and(eq(schema.employees.id, p.data.employeeId), eq(schema.employees.orgId, ctx.orgId))).limit(1);
    if (!emp) throw new Error("employee not found");
    const [c] = await tx.insert(schema.collectors).values({ orgId: ctx.orgId, employeeId: emp.id, name: p.data.name, platform: "unknown", status: "pending", tokenHash: sha256(randomToken(32)), enrollmentCodeHash: sha256(code), config: {} }).returning({ id: schema.collectors.id });
    return c.id;
  }).catch(() => null);
  if (!collectorId) return fail("employee not found");
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "collector.enrollment_code_created", entityType: "collector", entityId: collectorId, details: { employeeId: p.data.employeeId } });
  revalidate();
  return { ok: true, collectorId, code, url: process.env.NEXT_PUBLIC_APP_URL ?? process.env.AUTH_URL ?? "http://localhost:3000" };
}
const CollectorAction = z.object({ collectorId: uuid, action: z.enum(["pause", "resume", "revoke"]), minutes: z.number().int().min(1).max(7 * 24 * 60).optional() });
export async function collectorAction(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("collectors:manage");
  const p = CollectorAction.safeParse(raw); if (!p.success) return fail("invalid");
  const patch: Partial<typeof schema.collectors.$inferInsert> = { updatedAt: new Date() };
  if (p.data.action === "pause") { patch.status = "paused"; patch.pausedUntil = p.data.minutes ? new Date(Date.now() + p.data.minutes * 60_000) : null; }
  if (p.data.action === "resume") { patch.status = "active"; patch.pausedUntil = null; }
  if (p.data.action === "revoke") { patch.status = "revoked"; patch.pausedUntil = null; patch.enrollmentCodeHash = null; patch.tokenHash = sha256(randomToken(32)); }
  const n = await withTenant(ctx.orgId, async (tx) => (await tx.update(schema.collectors).set(patch).where(and(eq(schema.collectors.id, p.data.collectorId), eq(schema.collectors.orgId, ctx.orgId))).returning({ id: schema.collectors.id })).length);
  if (!n) return fail("collector not found");
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: `collector.${p.data.action}d`, entityType: "collector", entityId: p.data.collectorId, details: { by: "admin", minutes: p.data.minutes } });
  revalidate(); return { ok: true };
}
const CollectorConfigInput = z.object({ collectorId: uuid, config: CollectorConfigSchema });
export async function updateCollectorConfig(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("collectors:manage");
  const p = CollectorConfigInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid config");
  await withTenant(ctx.orgId, (tx) => tx.update(schema.collectors).set({ config: p.data.config, updatedAt: new Date() }).where(and(eq(schema.collectors.id, p.data.collectorId), eq(schema.collectors.orgId, ctx.orgId))));
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "collector.config_updated", entityType: "collector", entityId: p.data.collectorId, details: p.data.config });
  revalidate(); return { ok: true };
}

// ---------- campaigns ----------
const CampaignInput = z.object({
  id: uuid.optional(), name: z.string().min(2).max(120), description: z.string().max(2000).optional(),
  startsAt: z.string().optional(), endsAt: z.string().optional(),
  departmentIds: z.array(uuid).default([]), employeeIds: z.array(uuid).default([]),
  schedule: z.object({ days: z.array(z.number().int().min(0).max(6)), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).optional(),
  titleMode: z.enum(["hash", "category", "none"]).default("hash"),
  blockedApps: z.array(z.string().max(80)).max(200).default([]),
});
export async function upsertCampaign(raw: unknown): Promise<Result<{ id: string }>> {
  const ctx = await requireCtx("campaigns:manage");
  const p = CampaignInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid");
  const d = p.data;
  if (d.startsAt && d.endsAt && new Date(d.startsAt) > new Date(d.endsAt)) return fail("End date must be after start date");
  const [org] = await db.select({ timezone: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1);
  const config: schema.CollectorConfig = { titleMode: d.titleMode, ...(d.schedule ? { schedule: { ...d.schedule, tz: org?.timezone ?? "UTC" } } : {}), ...(d.blockedApps.length ? { blockedApps: d.blockedApps } : {}) };
  const values = { name: d.name, description: d.description ?? null, startsAt: d.startsAt ? new Date(d.startsAt) : null, endsAt: d.endsAt ? new Date(d.endsAt) : null, departmentIds: d.departmentIds, employeeIds: d.employeeIds, config, updatedAt: new Date() };
  const id = await withTenant(ctx.orgId, async (tx) => {
    if (d.id) {
      const [r] = await tx.update(schema.observationCampaigns).set(values).where(and(eq(schema.observationCampaigns.id, d.id), eq(schema.observationCampaigns.orgId, ctx.orgId))).returning({ id: schema.observationCampaigns.id });
      return r?.id ?? null;
    }
    const [r] = await tx.insert(schema.observationCampaigns).values({ ...values, orgId: ctx.orgId, createdBy: ctx.userId, status: "draft" }).returning({ id: schema.observationCampaigns.id });
    return r.id;
  });
  if (!id) return fail("campaign not found");
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: d.id ? "campaign.updated" : "campaign.created", entityType: "campaign", entityId: id, details: { name: d.name, titleMode: d.titleMode } });
  revalidate(); return { ok: true, id };
}
const CampaignStatusInput = z.object({ id: uuid, status: z.enum(["draft", "scheduled", "running", "paused", "completed", "archived"]) });
export async function setCampaignStatus(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("campaigns:manage");
  const p = CampaignStatusInput.safeParse(raw); if (!p.success) return fail("invalid");
  if (p.data.status === "running") {
    const auths = await withTenant(ctx.orgId, (tx) => tx.select({ id: schema.authorizations.id }).from(schema.authorizations).where(eq(schema.authorizations.orgId, ctx.orgId)).limit(1));
    if (!auths.length) return fail("Record a signed authorization before starting a campaign.");
  }
  const n = await withTenant(ctx.orgId, async (tx) => (await tx.update(schema.observationCampaigns).set({ status: p.data.status, updatedAt: new Date() }).where(and(eq(schema.observationCampaigns.id, p.data.id), eq(schema.observationCampaigns.orgId, ctx.orgId))).returning({ id: schema.observationCampaigns.id })).length);
  if (!n) return fail("campaign not found");
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: `campaign.${p.data.status}`, entityType: "campaign", entityId: p.data.id });
  revalidate(); return { ok: true };
}
export async function runAnalysisNow(raw: unknown): Promise<Result<{ jobId: string }>> {
  const ctx = await requireCtx("analysis:run");
  const p = z.object({ campaignId: uuid }).safeParse(raw); if (!p.success) return fail("invalid");
  const [c] = await withTenant(ctx.orgId, (tx) => tx.select({ id: schema.observationCampaigns.id }).from(schema.observationCampaigns).where(and(eq(schema.observationCampaigns.id, p.data.campaignId), eq(schema.observationCampaigns.orgId, ctx.orgId))).limit(1));
  if (!c) return fail("campaign not found");
  const job = await enqueue("analysis", { orgId: ctx.orgId, campaignId: c.id, requestedBy: ctx.userId }, ctx.orgId);
  startJobSoon(job.id);
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "analysis.requested", entityType: "campaign", entityId: c.id, details: { jobId: job.id } });
  revalidate(); return { ok: true, jobId: job.id };
}
