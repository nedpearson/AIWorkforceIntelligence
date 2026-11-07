"use server";
/** Server actions for the client workspace. Every mutation: zod-validated, consultant-checked, parent-checked, tenant-scoped, audited. */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { sha256, randomToken } from "@/lib/crypto";
import { ORG_COOKIE } from "@/lib/session";
import { enqueue } from "@/engine/jobs";
import { generateExecutiveReport, type ReportKind } from "@/engine/finance";
import { createCheckoutSession, createPortalSession, syncSubscriptionFromStripe, seatUsage, PLAN_KEYS, type PlanKey } from "@/engine/billing";
import { createInvitation, OnboardingError } from "@/engine/onboarding";
import { requireClient, appUrl } from "../../_lib";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; missing?: string[] };
const fail = (error: string, missing?: string[]): Result<never> => ({ ok: false, error, missing });
const uuid = z.string().uuid();
const revalidate = (id: string) => { revalidatePath(`/admin/clients/${id}`); revalidatePath("/admin"); revalidatePath("/admin/pipeline"); revalidatePath("/admin/projects"); revalidatePath("/admin/billing"); revalidatePath("/admin/reports"); };

async function guard(raw: unknown) {
  const p = z.object({ clientId: uuid }).safeParse(raw);
  if (!p.success) throw new OnboardingError("invalid client id");
  return requireClient(p.data.clientId);
}

// ---------- switch into the client app ----------
export async function openClientApp(raw: unknown): Promise<Result> {
  const { client } = await guard(raw);
  (await cookies()).set(ORG_COOKIE, client.id, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" });
  return { ok: true };
}

// ---------- collectors ----------
export type IssuedCode = { employeeId: string; employeeName: string; collectorId: string; code: string; url: string };
/** Create one enrollment code for every active employee without a live collector (bounded by remaining plan seats). Mirrors /app/collection createEnrollmentCode. */
export async function bulkEnrollmentCodes(raw: unknown): Promise<Result<{ issued: IssuedCode[]; skippedForSeats: number }>> {
  const { ctx, client } = await guard(raw);
  const usage = await seatUsage(client.id);
  const url = appUrl();
  const out = await withTenant(client.id, async (tx) => {
    const seated = await tx.select({ employeeId: schema.collectors.employeeId }).from(schema.collectors).where(and(eq(schema.collectors.orgId, client.id), inArray(schema.collectors.status, ["pending", "active", "paused", "offline"])));
    const seatedIds = new Set(seated.map((s) => s.employeeId).filter((x): x is string => !!x));
    const emps = await tx.select({ id: schema.employees.id, name: schema.employees.displayName }).from(schema.employees).where(and(eq(schema.employees.orgId, client.id), eq(schema.employees.isActive, true)));
    const todo = emps.filter((e) => !seatedIds.has(e.id));
    const remaining = usage ? Math.max(0, usage.seats - seatedIds.size) : todo.length;
    const issued: IssuedCode[] = [];
    for (const e of todo.slice(0, remaining)) {
      const code = `BB-${randomToken(9).replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase()}`;
      const [c] = await tx.insert(schema.collectors).values({ orgId: client.id, employeeId: e.id, name: `${e.name.split(" ")[0]}'s computer`, platform: "unknown", status: "pending", tokenHash: sha256(randomToken(32)), enrollmentCodeHash: sha256(code), config: {} }).returning({ id: schema.collectors.id });
      issued.push({ employeeId: e.id, employeeName: e.name, collectorId: c.id, code, url });
    }
    return { issued, skippedForSeats: Math.max(0, todo.length - remaining) };
  });
  for (const i of out.issued) await audit({ orgId: client.id, actorUserId: ctx.userId, action: "collector.enrollment_code_created", entityType: "collector", entityId: i.collectorId, details: { employeeId: i.employeeId, by: "consultant_bulk" } });
  revalidate(client.id);
  return { ok: true, ...out };
}

// ---------- campaigns / analysis ----------
export async function runAnalysisAction(raw: unknown): Promise<Result<{ jobId: string }>> {
  const { ctx, client } = await guard(raw);
  const p = z.object({ campaignId: uuid.optional() }).safeParse(raw); if (!p.success) return fail("invalid");
  if (p.data.campaignId) {
    const ok = await withTenant(client.id, async (tx) => (await tx.select({ id: schema.observationCampaigns.id }).from(schema.observationCampaigns).where(and(eq(schema.observationCampaigns.id, p.data.campaignId!), eq(schema.observationCampaigns.orgId, client.id))).limit(1)).length > 0);
    if (!ok) return fail("campaign not found");
  }
  const job = await enqueue("analysis", { orgId: client.id, campaignId: p.data.campaignId }, client.id);
  await audit({ orgId: client.id, actorUserId: ctx.userId, action: "analysis.enqueued", entityType: "job", entityId: job.id, details: { campaignId: p.data.campaignId, by: "consultant" } });
  revalidate(client.id);
  return { ok: true, jobId: job.id };
}

// ---------- opportunities ----------
export async function setOpportunityStatus(raw: unknown): Promise<Result> {
  const { ctx, client } = await guard(raw);
  const p = z.object({ opportunityId: uuid, status: z.enum(["approved", "rejected", "reviewing", "identified"]) }).safeParse(raw); if (!p.success) return fail("invalid");
  const n = await withTenant(client.id, async (tx) => (await tx.update(schema.opportunities).set({ status: p.data.status, updatedAt: new Date() }).where(and(eq(schema.opportunities.id, p.data.opportunityId), eq(schema.opportunities.orgId, client.id))).returning({ id: schema.opportunities.id })).length);
  if (!n) return fail("opportunity not found");
  await audit({ orgId: client.id, actorUserId: ctx.userId, action: `opportunity.${p.data.status}`, entityType: "opportunity", entityId: p.data.opportunityId, details: { by: "consultant" } });
  revalidate(client.id); return { ok: true };
}

// ---------- projects ----------
const ProjectInput = z.object({
  clientId: uuid, id: uuid.optional(), name: z.string().min(2).max(160), status: z.enum(["proposed", "approved", "in_progress", "live", "measuring", "closed"]),
  opportunityIds: z.array(uuid).default([]), agentIds: z.array(uuid).default([]),
  budget: z.number().min(0).max(1e9).nullable().optional(), spent: z.number().min(0).max(1e9).nullable().optional(),
  startDate: z.string().optional().nullable(), targetDate: z.string().optional().nullable(), ownerUserId: uuid.nullable().optional(), notes: z.string().max(5000).optional().nullable(),
});
export async function upsertProject(raw: unknown): Promise<Result<{ id: string }>> {
  const { ctx, client } = await guard(raw);
  const p = ProjectInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid");
  const d = p.data;
  const id = await withTenant(client.id, async (tx) => {
    // only link opportunities/agents that belong to this client
    const opps = d.opportunityIds.length ? (await tx.select({ id: schema.opportunities.id }).from(schema.opportunities).where(and(eq(schema.opportunities.orgId, client.id), inArray(schema.opportunities.id, d.opportunityIds)))).map((o) => o.id) : [];
    const ags = d.agentIds.length ? (await tx.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.orgId, client.id), inArray(schema.agents.id, d.agentIds)))).map((a) => a.id) : [];
    const values = { name: d.name, status: d.status, opportunityIds: opps, agentIds: ags, budget: d.budget != null ? String(d.budget) : null, spent: d.spent != null ? String(d.spent) : "0", startDate: d.startDate ? new Date(d.startDate) : null, targetDate: d.targetDate ? new Date(d.targetDate) : null, ownerUserId: d.ownerUserId ?? null, notes: d.notes ?? null, updatedAt: new Date() };
    if (d.id) { const [r] = await tx.update(schema.projects).set(values).where(and(eq(schema.projects.id, d.id), eq(schema.projects.orgId, client.id))).returning({ id: schema.projects.id }); return r?.id ?? null; }
    const [r] = await tx.insert(schema.projects).values({ ...values, orgId: client.id }).returning({ id: schema.projects.id }); return r.id;
  });
  if (!id) return fail("project not found");
  await audit({ orgId: client.id, actorUserId: ctx.userId, action: d.id ? "project.updated" : "project.created", entityType: "project", entityId: id, details: { name: d.name, status: d.status } });
  revalidate(client.id); return { ok: true, id };
}
export async function deleteProject(raw: unknown): Promise<Result> {
  const { ctx, client } = await guard(raw);
  const p = z.object({ id: uuid }).safeParse(raw); if (!p.success) return fail("invalid");
  const n = await withTenant(client.id, async (tx) => (await tx.delete(schema.projects).where(and(eq(schema.projects.id, p.data.id), eq(schema.projects.orgId, client.id))).returning({ id: schema.projects.id })).length);
  if (!n) return fail("project not found");
  await audit({ orgId: client.id, actorUserId: ctx.userId, action: "project.deleted", entityType: "project", entityId: p.data.id });
  revalidate(client.id); return { ok: true };
}

// ---------- billing ----------
/** Local plan/seat change for subscriptions that are NOT linked to Stripe (trials, manual invoicing). Stripe-linked plans change through the Stripe portal. */
export async function setPlanLocal(raw: unknown): Promise<Result> {
  const { ctx, client, consultancy } = await guard(raw);
  if (!["owner", "admin"].includes(consultancy.role)) return fail("Only consultancy owners/admins can change plans.");
  const p = z.object({ plan: z.enum(PLAN_KEYS as [string, ...string[]]), seats: z.number().int().min(1).max(10_000), agentSlots: z.number().int().min(0).max(1000), status: z.enum(["trialing", "active", "past_due", "canceled", "unpaid"]).optional() }).safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid");
  const plan = p.data.plan as PlanKey;
  const r = await withTenant(client.id, async (tx) => {
    const [sub] = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, client.id)).limit(1);
    if (sub?.stripeSubscriptionId) return "stripe";
    const values = { plan, seats: Math.max(p.data.seats, 1), agentSlots: p.data.agentSlots, status: p.data.status ?? sub?.status ?? "trialing", updatedAt: new Date() };
    if (sub) await tx.update(schema.subscriptions).set(values).where(eq(schema.subscriptions.orgId, client.id));
    else await tx.insert(schema.subscriptions).values({ orgId: client.id, ...values, trialEndsAt: new Date(Date.now() + 14 * 86_400_000) });
    return "ok";
  });
  if (r === "stripe") return fail("This subscription is managed by Stripe. Use 'Manage in Stripe' to change the plan so billing stays in sync.");
  await audit({ orgId: client.id, actorUserId: ctx.userId, action: "billing.plan_set_locally", entityType: "subscription", details: { plan, seats: p.data.seats, agentSlots: p.data.agentSlots, status: p.data.status, note: "not billed through Stripe" } });
  revalidate(client.id); return { ok: true };
}
export async function startCheckout(raw: unknown): Promise<Result<{ url: string }>> {
  const { ctx, client } = await guard(raw);
  const p = z.object({ plan: z.enum(PLAN_KEYS as [string, ...string[]]), seats: z.number().int().min(1).max(10_000).optional() }).safeParse(raw); if (!p.success) return fail("invalid");
  const base = appUrl();
  const r = await createCheckoutSession(client.id, p.data.plan as PlanKey, { successUrl: `${base}/admin/clients/${client.id}?tab=billing&checkout=success`, cancelUrl: `${base}/admin/clients/${client.id}?tab=billing&checkout=canceled`, seats: p.data.seats, actorUserId: ctx.userId, customerEmail: ctx.email });
  if (!r.ok) return fail(r.reason, r.missing);
  return { ok: true, url: r.url };
}
export async function openPortal(raw: unknown): Promise<Result<{ url: string }>> {
  const { ctx, client } = await guard(raw);
  const r = await createPortalSession(client.id, `${appUrl()}/admin/clients/${client.id}?tab=billing`, ctx.userId);
  if (!r.ok) return fail(r.reason, r.missing);
  return { ok: true, url: r.url };
}
export async function syncStripe(raw: unknown): Promise<Result<{ status: string; invoices: number }>> {
  const { ctx, client } = await guard(raw);
  const r = await syncSubscriptionFromStripe(client.id, ctx.userId);
  if (!r.ok) return fail(r.reason, r.missing);
  revalidate(client.id); return { ok: true, status: r.status, invoices: r.invoices };
}

// ---------- reports ----------
export async function generateReportAction(raw: unknown): Promise<Result<{ reportId: string }>> {
  const { ctx, client } = await guard(raw);
  const p = z.object({ kind: z.enum(["executive_roi", "monthly_performance", "investment_proposal"]) }).safeParse(raw); if (!p.success) return fail("invalid");
  try {
    const r = await generateExecutiveReport(client.id, p.data.kind as ReportKind, { generatedBy: ctx.userId });
    await audit({ orgId: client.id, actorUserId: ctx.userId, action: "report.generated", entityType: "report", entityId: r.reportId, details: { kind: p.data.kind, by: "consultant", whiteLabel: !!client.branding?.reportName } });
    revalidate(client.id); return { ok: true, reportId: r.reportId };
  } catch (e) { return fail(`Could not generate the report: ${e instanceof Error ? e.message : String(e)}`); }
}

// ---------- branding ----------
export async function saveBranding(raw: unknown): Promise<Result> {
  const { ctx, client } = await guard(raw);
  const p = z.object({ reportName: z.string().max(120).optional(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().or(z.literal("")), footer: z.string().max(240).optional(), logoUrl: z.string().url().max(500).optional().or(z.literal("")) }).safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid");
  const branding = { reportName: p.data.reportName?.trim() || undefined, primaryColor: p.data.primaryColor || undefined, footer: p.data.footer?.trim() || undefined, logoUrl: p.data.logoUrl || undefined };
  await withTenant(client.id, (tx) => tx.update(schema.organizations).set({ branding, updatedAt: new Date() }).where(eq(schema.organizations.id, client.id)));
  await audit({ orgId: client.id, actorUserId: ctx.userId, action: "branding.updated", entityType: "organization", entityId: client.id, details: branding });
  revalidate(client.id); return { ok: true };
}

// ---------- invitations ----------
export async function inviteClientUser(raw: unknown): Promise<Result<{ url: string }>> {
  const { ctx, client } = await guard(raw);
  const p = z.object({ email: z.string().email(), role: z.enum(["owner", "admin", "manager", "viewer"]) }).safeParse(raw); if (!p.success) return fail("Enter a valid email");
  try { const r = await createInvitation({ orgId: client.id, email: p.data.email, role: p.data.role, invitedBy: ctx.userId, appUrl: appUrl() }); revalidate(client.id); return { ok: true, url: r.url }; }
  catch (e) { return fail(e instanceof Error ? e.message : "could not create invitation"); }
}
