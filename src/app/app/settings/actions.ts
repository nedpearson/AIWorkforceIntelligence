"use server";
/**
 * Settings server actions. Every mutation: zod-validated, permission-checked via requireCtx, audited.
 * Tenant rows go through withTenant; the `users` table (identity, not tenant data) uses the admin handle
 * strictly for the signed-in user's own row.
 */
import { z } from "zod";
import { and, eq, lt, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { encrypt, decrypt, randomToken, sha256 } from "@/lib/crypto";
import { mfaSecret, mfaUri, mfaVerify } from "@/lib/mfa";
import { checkConnection } from "@/engine/agents/n8n";
import type { OrgSettings } from "@/db/schema";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): Result<never> => ({ ok: false, error });
const ROLES = ["owner", "admin", "manager", "employee", "consultant", "viewer"] as const;

// ---------------------------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------------------------
const OrgInput = z.object({
  name: z.string().trim().min(2).max(120),
  industry: z.string().trim().max(120).optional().or(z.literal("")),
  timezone: z.string().trim().min(2).max(64),
  currency: z.string().trim().length(3).toUpperCase(),
  retentionDays: z.number().int().min(30).max(730),
  workHoursPerWeek: z.number().min(1).max(80),
  workWeeksPerYear: z.number().min(30).max(52),
  benefitsLoadPct: z.number().min(0).max(1),
  branding: z.object({
    reportName: z.string().trim().max(120).optional().or(z.literal("")),
    primaryColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional().or(z.literal("")),
    footer: z.string().trim().max(200).optional().or(z.literal("")),
    logoUrl: z.string().trim().url().max(500).optional().or(z.literal("")),
  }),
});
export async function updateOrganization(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("org:manage");
  const p = OrgInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid input");
  try { Intl.DateTimeFormat(undefined, { timeZone: p.data.timezone }); } catch { return fail("unknown timezone"); }
  const d = p.data;
  const branding = Object.fromEntries(Object.entries(d.branding).filter(([, v]) => !!v));
  const before = await withTenant(ctx.orgId, async (tx) => (await tx.select({ name: schema.organizations.name, industry: schema.organizations.industry, timezone: schema.organizations.timezone, currency: schema.organizations.currency, retentionDays: schema.organizations.retentionDays, settings: schema.organizations.settings, branding: schema.organizations.branding }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1))[0]);
  if (!before) return fail("organization not found");
  const settings: OrgSettings = { ...(before.settings ?? {}), workHoursPerWeek: d.workHoursPerWeek, workWeeksPerYear: d.workWeeksPerYear, benefitsLoadPct: d.benefitsLoadPct };
  await withTenant(ctx.orgId, (tx) => tx.update(schema.organizations).set({ name: d.name, industry: d.industry || null, timezone: d.timezone, currency: d.currency, retentionDays: d.retentionDays, settings, branding, updatedAt: new Date() }).where(eq(schema.organizations.id, ctx.orgId)));
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "org.updated", entityType: "organization", entityId: ctx.orgId, details: { before: { name: before.name, industry: before.industry, timezone: before.timezone, currency: before.currency, retentionDays: before.retentionDays, settings: before.settings, branding: before.branding }, after: { name: d.name, industry: d.industry || null, timezone: d.timezone, currency: d.currency, retentionDays: d.retentionDays, settings, branding } } });
  revalidatePath("/app/settings"); revalidatePath("/app", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Members & invitations
// ---------------------------------------------------------------------------------------------
const InviteInput = z.object({ email: z.string().trim().toLowerCase().email().max(200), role: z.enum(ROLES), employeeId: z.string().uuid().optional().or(z.literal("")) });
export async function inviteMember(raw: unknown): Promise<Result<{ link: string; expiresAt: string; invitationId: string }>> {
  const ctx = await requireCtx("members:invite");
  const p = InviteInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid input");
  if (p.data.role === "owner" && ctx.role !== "owner") return fail("only an owner can invite another owner");
  const token = randomToken(32); const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);
  let id: string;
  try { id = await withTenant(ctx.orgId, async (tx) => {
    const existing = await tx.select({ id: schema.memberships.id }).from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(and(eq(schema.memberships.orgId, ctx.orgId), eq(schema.users.email, p.data.email))).limit(1);
    if (existing.length) throw new Error("that person is already a member of this organization");
    if (p.data.employeeId) {
      const [emp] = await tx.select({ id: schema.employees.id }).from(schema.employees).where(and(eq(schema.employees.id, p.data.employeeId), eq(schema.employees.orgId, ctx.orgId))).limit(1);
      if (!emp) throw new Error("employee not found in this organization");
    }
    const [row] = await tx.insert(schema.invitations).values({ orgId: ctx.orgId, email: p.data.email, role: p.data.role, employeeId: p.data.employeeId || null, tokenHash, invitedBy: ctx.userId, expiresAt }).returning({ id: schema.invitations.id });
    return row.id;
  }); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "invitation.created", entityType: "invitation", entityId: id, details: { role: p.data.role, employeeLinked: !!p.data.employeeId, expiresAt: expiresAt.toISOString() } });
  revalidatePath("/app/settings/members");
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? process.env.AUTH_URL ?? "").replace(/\/+$/, "");
  return { ok: true, link: `${base}/invite/${token}`, expiresAt: expiresAt.toISOString(), invitationId: id };
}
export async function revokeInvitation(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("members:invite");
  const p = z.object({ id: z.string().uuid() }).safeParse(raw); if (!p.success) return fail("invalid input");
  const n = await withTenant(ctx.orgId, async (tx) => (await tx.delete(schema.invitations).where(and(eq(schema.invitations.id, p.data.id), eq(schema.invitations.orgId, ctx.orgId))).returning({ id: schema.invitations.id })).length);
  if (!n) return fail("invitation not found");
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "invitation.revoked", entityType: "invitation", entityId: p.data.id });
  revalidatePath("/app/settings/members");
  return { ok: true };
}
const RoleInput = z.object({ membershipId: z.string().uuid(), role: z.enum(ROLES) });
export async function changeMemberRole(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("members:invite");
  const p = RoleInput.safeParse(raw); if (!p.success) return fail("invalid input");
  try {
    const before = await withTenant(ctx.orgId, async (tx) => {
      const [m] = await tx.select().from(schema.memberships).where(and(eq(schema.memberships.id, p.data.membershipId), eq(schema.memberships.orgId, ctx.orgId))).limit(1);
      if (!m) throw new Error("membership not found");
      if ((m.role === "owner" || p.data.role === "owner") && ctx.role !== "owner") throw new Error("only an owner can change owner roles");
      if (m.role === "owner" && p.data.role !== "owner") {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.memberships).where(and(eq(schema.memberships.orgId, ctx.orgId), eq(schema.memberships.role, "owner")));
        if (n <= 1) throw new Error("an organization needs at least one owner");
      }
      await tx.update(schema.memberships).set({ role: p.data.role }).where(eq(schema.memberships.id, m.id));
      return m;
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "membership.role_changed", entityType: "membership", entityId: p.data.membershipId, details: { userId: before.userId, from: before.role, to: p.data.role } });
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  revalidatePath("/app/settings/members");
  return { ok: true };
}
export async function removeMember(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("members:invite");
  const p = z.object({ membershipId: z.string().uuid() }).safeParse(raw); if (!p.success) return fail("invalid input");
  try {
    const m = await withTenant(ctx.orgId, async (tx) => {
      const [m] = await tx.select().from(schema.memberships).where(and(eq(schema.memberships.id, p.data.membershipId), eq(schema.memberships.orgId, ctx.orgId))).limit(1);
      if (!m) throw new Error("membership not found");
      if (m.userId === ctx.userId) throw new Error("you cannot remove yourself");
      if (m.role === "owner" && ctx.role !== "owner") throw new Error("only an owner can remove an owner");
      if (m.role === "owner") {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.memberships).where(and(eq(schema.memberships.orgId, ctx.orgId), eq(schema.memberships.role, "owner")));
        if (n <= 1) throw new Error("an organization needs at least one owner");
      }
      await tx.delete(schema.memberships).where(eq(schema.memberships.id, m.id));
      return m;
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "membership.removed", entityType: "membership", entityId: p.data.membershipId, details: { userId: m.userId, role: m.role } });
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  revalidatePath("/app/settings/members");
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Security (signed-in user)
// ---------------------------------------------------------------------------------------------
export async function mfaStart(): Promise<Result<{ qrDataUrl: string; manualKey: string }>> {
  const ctx = await requireCtx();
  const [u] = await db.select({ id: schema.users.id, email: schema.users.email, mfaEnabled: schema.users.mfaEnabled }).from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1);
  if (!u) return fail("user not found");
  if (u.mfaEnabled) return fail("MFA is already enabled; disable it first to re-enroll");
  const secret = mfaSecret();
  let enc: string; try { enc = encrypt(secret); } catch (e) { return fail(`vault unavailable: ${e instanceof Error ? e.message : String(e)} (set VAULT_KEY)`); }
  await db.update(schema.users).set({ mfaSecretEnc: enc, mfaEnabled: false, updatedAt: new Date() }).where(eq(schema.users.id, u.id));
  const qrDataUrl = await QRCode.toDataURL(mfaUri(secret, u.email), { margin: 1, width: 192 });
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "mfa.enrollment_started", entityType: "user", entityId: u.id });
  return { ok: true, qrDataUrl, manualKey: secret };
}
export async function mfaConfirm(raw: unknown): Promise<Result> {
  const ctx = await requireCtx();
  const p = z.object({ code: z.string().trim().regex(/^\d{6}$/, "enter the 6-digit code") }).safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid code");
  const [u] = await db.select({ id: schema.users.id, mfaSecretEnc: schema.users.mfaSecretEnc, mfaEnabled: schema.users.mfaEnabled }).from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1);
  if (!u?.mfaSecretEnc) return fail("start enrollment first");
  let ok = false; try { ok = await mfaVerify(decrypt(u.mfaSecretEnc), p.data.code); } catch { return fail("could not read the stored secret (VAULT_KEY changed?)"); }
  if (!ok) { await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "mfa.confirm_failed", entityType: "user", entityId: u.id }); return fail("that code is not valid — check the time on your phone and try again"); }
  await db.update(schema.users).set({ mfaEnabled: true, updatedAt: new Date() }).where(eq(schema.users.id, u.id));
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "mfa.enabled", entityType: "user", entityId: u.id });
  revalidatePath("/app/settings/security");
  return { ok: true };
}
export async function mfaDisable(raw: unknown): Promise<Result> {
  const ctx = await requireCtx();
  const p = z.object({ password: z.string().min(1), code: z.string().trim().regex(/^\d{6}$/, "enter the 6-digit code") }).safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid input");
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1);
  if (!u) return fail("user not found");
  if (!u.mfaEnabled || !u.mfaSecretEnc) return fail("MFA is not enabled");
  if (!u.passwordHash || !(await bcrypt.compare(p.data.password, u.passwordHash))) { await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "mfa.disable_failed", entityType: "user", entityId: u.id, details: { reason: "password" } }); return fail("password is incorrect"); }
  let ok = false; try { ok = await mfaVerify(decrypt(u.mfaSecretEnc), p.data.code); } catch { return fail("could not read the stored secret"); }
  if (!ok) { await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "mfa.disable_failed", entityType: "user", entityId: u.id, details: { reason: "code" } }); return fail("that code is not valid"); }
  await db.update(schema.users).set({ mfaEnabled: false, mfaSecretEnc: null, updatedAt: new Date() }).where(eq(schema.users.id, u.id));
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "mfa.disabled", entityType: "user", entityId: u.id });
  revalidatePath("/app/settings/security");
  return { ok: true };
}
const PasswordInput = z.object({ current: z.string().min(1), next: z.string().min(10, "use at least 10 characters").max(200), confirm: z.string() }).refine((d) => d.next === d.confirm, { message: "new passwords do not match", path: ["confirm"] });
export async function changePassword(raw: unknown): Promise<Result> {
  const ctx = await requireCtx();
  const p = PasswordInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid input");
  const [u] = await db.select({ id: schema.users.id, passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1);
  if (!u) return fail("user not found");
  if (!u.passwordHash) return fail("this account signs in with SSO and has no password");
  if (!(await bcrypt.compare(p.data.current, u.passwordHash))) { await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "password.change_failed", entityType: "user", entityId: u.id }); return fail("current password is incorrect"); }
  if (p.data.current === p.data.next) return fail("new password must differ from the current one");
  await db.update(schema.users).set({ passwordHash: await bcrypt.hash(p.data.next, 12), updatedAt: new Date() }).where(eq(schema.users.id, u.id));
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "password.changed", entityType: "user", entityId: u.id });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------------------------
const N8nInput = z.object({ baseUrl: z.string().trim().url().max(500), apiKey: z.string().trim().min(8).max(4000) });
export async function saveN8n(raw: unknown): Promise<Result<{ connected: boolean; message: string }>> {
  const ctx = await requireCtx("org:manage");
  const p = N8nInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid input");
  const baseUrl = p.data.baseUrl.replace(/\/+$/, "");
  let secretEnc: string; try { secretEnc = encrypt(JSON.stringify({ apiKey: p.data.apiKey })); } catch (e) { return fail(`vault unavailable: ${e instanceof Error ? e.message : String(e)} (set VAULT_KEY)`); }
  const credentialId = await withTenant(ctx.orgId, async (tx) => {
    const [cred] = await tx.insert(schema.credentials).values({ orgId: ctx.orgId, name: `n8n API key (${new URL(baseUrl).host})`, provider: "n8n", secretEnc, fields: ["apiKey"], createdBy: ctx.userId }).returning({ id: schema.credentials.id });
    const [row] = await tx.select({ id: schema.integrations.id, credentialId: schema.integrations.credentialId, config: schema.integrations.config }).from(schema.integrations).where(and(eq(schema.integrations.orgId, ctx.orgId), eq(schema.integrations.provider, "n8n"))).limit(1);
    const config = { ...((row?.config as Record<string, unknown>) ?? {}), baseUrl, source: "integration" };
    if (row) {
      await tx.update(schema.integrations).set({ credentialId: cred.id, config, status: "configured", lastError: null, updatedAt: new Date() }).where(eq(schema.integrations.id, row.id));
      if (row.credentialId) await tx.delete(schema.credentials).where(and(eq(schema.credentials.id, row.credentialId), eq(schema.credentials.orgId, ctx.orgId)));
    } else await tx.insert(schema.integrations).values({ orgId: ctx.orgId, provider: "n8n", credentialId: cred.id, config, status: "configured" });
    return cred.id;
  });
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "integration.configured", entityType: "integration", entityId: "n8n", details: { baseUrl, credentialId } });
  const r = await checkConnection(ctx.orgId);
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "integration.tested", entityType: "integration", entityId: "n8n", details: { ok: r.ok, reason: r.ok ? null : r.reason } });
  revalidatePath("/app/settings/integrations");
  return { ok: true, connected: r.ok, message: r.ok ? `Connected to ${r.baseUrl}` : r.reason };
}
export async function testN8n(): Promise<Result<{ connected: boolean; message: string }>> {
  const ctx = await requireCtx("org:manage");
  const r = await checkConnection(ctx.orgId);
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "integration.tested", entityType: "integration", entityId: "n8n", details: { ok: r.ok, reason: r.ok ? null : r.reason } });
  revalidatePath("/app/settings/integrations");
  return { ok: true, connected: r.ok, message: r.ok ? `Connected to ${r.baseUrl} (${r.source})` : r.reason };
}
export async function disconnectN8n(): Promise<Result> {
  const ctx = await requireCtx("org:manage");
  await withTenant(ctx.orgId, async (tx) => {
    const [row] = await tx.select({ id: schema.integrations.id, credentialId: schema.integrations.credentialId }).from(schema.integrations).where(and(eq(schema.integrations.orgId, ctx.orgId), eq(schema.integrations.provider, "n8n"))).limit(1);
    if (!row) return;
    await tx.update(schema.integrations).set({ credentialId: null, config: {}, status: "not_configured", lastError: null, updatedAt: new Date() }).where(eq(schema.integrations.id, row.id));
    if (row.credentialId) await tx.delete(schema.credentials).where(and(eq(schema.credentials.id, row.credentialId), eq(schema.credentials.orgId, ctx.orgId)));
  });
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "integration.disconnected", entityType: "integration", entityId: "n8n" });
  revalidatePath("/app/settings/integrations");
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Data & privacy
// ---------------------------------------------------------------------------------------------
export async function deleteAllActivityEvents(raw: unknown): Promise<Result<{ deleted: number }>> {
  const ctx = await requireCtx("org:manage");
  if (ctx.role !== "owner") return fail("only the organization owner can delete activity events");
  const p = z.object({ confirmName: z.string() }).safeParse(raw); if (!p.success) return fail("invalid input");
  if (p.data.confirmName.trim() !== ctx.orgName.trim()) return fail("type the organization name exactly to confirm");
  const deleted = await withTenant(ctx.orgId, async (tx) => {
    const r = await tx.delete(schema.activityEvents).where(eq(schema.activityEvents.orgId, ctx.orgId)).returning({ id: schema.activityEvents.id });
    await tx.update(schema.collectors).set({ eventsReceived: 0, lastEventAt: null }).where(eq(schema.collectors.orgId, ctx.orgId));
    return r.length;
  });
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "privacy.activity_events_deleted", entityType: "organization", entityId: ctx.orgId, details: { deleted } });
  revalidatePath("/app/settings/data"); revalidatePath("/app/collection");
  return { ok: true, deleted };
}
export async function runRetentionNow(): Promise<Result<{ deleted: number; cutoff: string }>> {
  const ctx = await requireCtx("org:manage");
  const [org] = await withTenant(ctx.orgId, (tx) => tx.select({ retentionDays: schema.organizations.retentionDays }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1));
  if (!org) return fail("organization not found");
  const cutoff = new Date(Date.now() - org.retentionDays * 86_400_000);
  const deleted = await withTenant(ctx.orgId, async (tx) => (await tx.delete(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, ctx.orgId), lt(schema.activityEvents.ts, cutoff))).returning({ id: schema.activityEvents.id })).length);
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "privacy.retention_sweep", entityType: "organization", entityId: ctx.orgId, details: { deleted, cutoff: cutoff.toISOString(), retentionDays: org.retentionDays } });
  revalidatePath("/app/settings/data");
  return { ok: true, deleted, cutoff: cutoff.toISOString() };
}
/** Org data export as JSON. Excludes secrets (credential ciphertext, token hashes, MFA secrets, password hashes, raw PDF bytes). */
export async function exportOrgData(): Promise<Result<{ json: string; filename: string }>> {
  const ctx = await requireCtx("org:manage");
  const data = await withTenant(ctx.orgId, async (tx) => {
    const o = ctx.orgId;
    const [organization] = await tx.select().from(schema.organizations).where(eq(schema.organizations.id, o)).limit(1);
    const [departments, employees, workflows, workflowEmployees, opportunities, agents, agentRuns, measurements, financialModels, projects, reports, integrations, collectors, campaigns, consents, memberships, invitations] = await Promise.all([
      tx.select().from(schema.departments).where(eq(schema.departments.orgId, o)),
      tx.select().from(schema.employees).where(eq(schema.employees.orgId, o)),
      tx.select().from(schema.workflows).where(eq(schema.workflows.orgId, o)),
      tx.select().from(schema.workflowEmployees).where(eq(schema.workflowEmployees.orgId, o)),
      tx.select().from(schema.opportunities).where(eq(schema.opportunities.orgId, o)),
      tx.select().from(schema.agents).where(eq(schema.agents.orgId, o)),
      tx.select({ id: schema.agentRuns.id, agentId: schema.agentRuns.agentId, status: schema.agentRuns.status, trigger: schema.agentRuns.trigger, minutesSaved: schema.agentRuns.minutesSaved, humanMinutes: schema.agentRuns.humanMinutes, startedAt: schema.agentRuns.startedAt, finishedAt: schema.agentRuns.finishedAt, error: schema.agentRuns.error }).from(schema.agentRuns).where(eq(schema.agentRuns.orgId, o)),
      tx.select().from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, o)),
      tx.select().from(schema.financialModels).where(eq(schema.financialModels.orgId, o)),
      tx.select().from(schema.projects).where(eq(schema.projects.orgId, o)),
      tx.select({ id: schema.reports.id, kind: schema.reports.kind, title: schema.reports.title, periodStart: schema.reports.periodStart, periodEnd: schema.reports.periodEnd, data: schema.reports.data, createdAt: schema.reports.createdAt }).from(schema.reports).where(eq(schema.reports.orgId, o)),
      tx.select({ provider: schema.integrations.provider, status: schema.integrations.status, config: schema.integrations.config, lastCheckedAt: schema.integrations.lastCheckedAt, lastError: schema.integrations.lastError }).from(schema.integrations).where(eq(schema.integrations.orgId, o)),
      tx.select({ id: schema.collectors.id, employeeId: schema.collectors.employeeId, name: schema.collectors.name, platform: schema.collectors.platform, status: schema.collectors.status, version: schema.collectors.version, config: schema.collectors.config, lastSeenAt: schema.collectors.lastSeenAt, eventsReceived: schema.collectors.eventsReceived, createdAt: schema.collectors.createdAt }).from(schema.collectors).where(eq(schema.collectors.orgId, o)),
      tx.select().from(schema.observationCampaigns).where(eq(schema.observationCampaigns.orgId, o)),
      tx.select({ id: schema.consentRecords.id, employeeId: schema.consentRecords.employeeId, noticeVersion: schema.consentRecords.noticeVersion, acknowledgedAt: schema.consentRecords.acknowledgedAt, withdrawnAt: schema.consentRecords.withdrawnAt, method: schema.consentRecords.method }).from(schema.consentRecords).where(eq(schema.consentRecords.orgId, o)),
      tx.select({ id: schema.memberships.id, role: schema.memberships.role, employeeId: schema.memberships.employeeId, email: schema.users.email, name: schema.users.name, createdAt: schema.memberships.createdAt }).from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(eq(schema.memberships.orgId, o)),
      tx.select({ id: schema.invitations.id, email: schema.invitations.email, role: schema.invitations.role, expiresAt: schema.invitations.expiresAt, acceptedAt: schema.invitations.acceptedAt }).from(schema.invitations).where(eq(schema.invitations.orgId, o)),
    ]);
    const [{ n: activityEventCount }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.activityEvents).where(eq(schema.activityEvents.orgId, o));
    return { exportedAt: new Date().toISOString(), note: "Secrets excluded: credential ciphertext, collector/invitation token hashes, MFA secrets, password hashes and stored PDF bytes are never exported. Raw activity events are summarized by count; use the retention tools to purge them.", organization, memberships, invitations, departments, employees, workflows, workflowEmployees, opportunities, agents, agentRuns, savingsMeasurements: measurements, financialModels, projects, reports, integrations, collectors, observationCampaigns: campaigns, consentRecords: consents, activityEventCount };
  });
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "privacy.export", entityType: "organization", entityId: ctx.orgId, details: { tables: Object.keys(data).length } });
  return { ok: true, json: JSON.stringify(data, null, 2), filename: `${ctx.orgName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-export-${new Date().toISOString().slice(0, 10)}.json` };
}
