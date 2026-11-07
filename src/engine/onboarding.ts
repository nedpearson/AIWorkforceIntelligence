/**
 * Onboarding engine — creating client organizations under a consultancy and accepting invitations.
 *
 *  - assertClientOfConsultancy(consultancyId, clientId) → throws unless the client's parentOrgId is the consultancy
 *  - createClientOrg(input)                              → org + subscription (14-day trial) + default financial model
 *                                                          + integration rows + owner invitation (+ optional CSV employees,
 *                                                          + optional synthetic demo data labelled isDemo)
 *  - parseEmployeeCsv(text)                              → validated rows from "name,email,title,department,baseAnnualCost"
 *  - lookupInvitation(token) / acceptInvitation(...)     → public invite flow used by /invite/[token]
 *
 * Organization rows are not tenant-scoped (they ARE the tenant), so they are written with the admin handle.
 * Everything that carries org_id is written through withTenant(). Never import "server-only" here (tests + scripts).
 */
import { and, eq, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { sha256, randomToken } from "@/lib/crypto";
import { slugify } from "@/lib/utils";
import { ensureDefaultFinancialModel } from "./finance";
import { enqueue } from "./jobs";
import { DEMO_ORG, generateEvents, type SynthEmployee } from "./synthetic";
import { PLANS, type PlanKey } from "./billing";

export class OnboardingError extends Error { constructor(msg: string, public code: "forbidden" | "invalid" | "expired" | "accepted" | "not_found" | "exists" = "invalid") { super(msg); } }

const uuidRe = /^[0-9a-f-]{36}$/i;
const INVITE_DAYS = 14;
const TRIAL_DAYS = 14;

/** The one cross-org check the consulting portal relies on. Uses the admin handle on purpose (CONVENTIONS → parent/child views). */
export async function assertClientOfConsultancy(consultancyId: string, clientId: string): Promise<typeof schema.organizations.$inferSelect> {
  if (!uuidRe.test(consultancyId) || !uuidRe.test(clientId)) throw new OnboardingError("invalid organization id", "invalid");
  const [client] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, clientId)).limit(1);
  if (!client || client.kind !== "client" || client.parentOrgId !== consultancyId) throw new OnboardingError("This client is not managed by your consultancy.", "forbidden");
  return client;
}

// ---------- CSV ----------
export type EmployeeCsvRow = { name: string; email: string | null; title: string | null; department: string | null; baseAnnualCost: number | null };
/** Parse "name,email,title,department,baseAnnualCost". A header row is optional. Returns rows + per-line problems. */
export function parseEmployeeCsv(text: string): { rows: EmployeeCsvRow[]; errors: string[] } {
  const rows: EmployeeCsvRow[] = []; const errors: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    const cells = splitCsvLine(line);
    if (i === 0 && /^name\b/i.test(cells[0] ?? "")) return; // header
    const [name, email, title, department, cost] = cells.map((c) => c.trim());
    if (!name) { errors.push(`Line ${i + 1}: name is required`); return; }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errors.push(`Line ${i + 1}: "${email}" is not an email address`); return; }
    const baseAnnualCost = cost ? Number(cost.replace(/[$,\s]/g, "")) : null;
    if (cost && (baseAnnualCost == null || !Number.isFinite(baseAnnualCost) || baseAnnualCost < 0 || baseAnnualCost > 5_000_000)) { errors.push(`Line ${i + 1}: base annual cost "${cost}" is not a number`); return; }
    rows.push({ name, email: email?.toLowerCase() || null, title: title || null, department: department || null, baseAnnualCost });
  });
  return { rows, errors };
}
function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}

// ---------- create client ----------
export type CreateClientInput = {
  consultancyId: string;
  name: string;
  industry?: string | null;
  timezone?: string;
  adminEmail: string;
  adminName?: string | null;
  plan: PlanKey;
  seats?: number;
  employees?: EmployeeCsvRow[];
  demo?: boolean;
  actorUserId?: string | null;
  appUrl?: string;
};
export type CreateClientResult = {
  orgId: string; slug: string; invitationId: string; inviteToken: string; inviteUrl: string;
  employeesCreated: number; departmentsCreated: number;
  demo: null | { events: number; collectors: number; campaignId: string; analysisJobId: string };
};

export async function createClientOrg(input: CreateClientInput): Promise<CreateClientResult> {
  if (!uuidRe.test(input.consultancyId)) throw new OnboardingError("invalid consultancy id");
  const [consultancy] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, input.consultancyId)).limit(1);
  if (!consultancy || consultancy.kind !== "consultancy") throw new OnboardingError("Consultancy not found", "not_found");
  const name = input.name.trim(); if (name.length < 2) throw new OnboardingError("Client name is too short");
  const adminEmail = input.adminEmail.trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) throw new OnboardingError("Admin email is not valid");
  const plan = PLANS[input.plan]; if (!plan) throw new OnboardingError("Unknown plan");
  const seats = Math.max(1, Math.min(10_000, Math.round(input.seats ?? plan.seats)));
  const slug = await uniqueSlug(name);
  const isDemo = !!input.demo;
  const displayName = isDemo && !/synthetic demo/i.test(name) ? `${name} (Synthetic Demo)` : name;

  const [org] = await db.insert(schema.organizations).values({
    name: displayName, slug, kind: "client", parentOrgId: consultancy.id, industry: input.industry?.trim() || null,
    timezone: input.timezone || "America/Chicago", isDemo,
    settings: { benefitsLoadPct: 0.3, workHoursPerWeek: 40, workWeeksPerYear: 48, adoptionRate: 0.75, realizationRate: 0.6 },
    branding: { primaryColor: consultancy.branding?.primaryColor, reportName: consultancy.branding?.reportName, footer: consultancy.branding?.footer },
  }).returning();

  const inviteToken = randomToken(32);
  const invitationId = await withTenant(org.id, async (tx) => {
    await tx.insert(schema.subscriptions).values({ orgId: org.id, plan: input.plan, status: "trialing", seats, agentSlots: plan.agents, trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000) });
    for (const provider of ["n8n", "stripe", "anthropic", "power_automate", "uipath", "mimica"] as const) {
      const status = provider === "power_automate" || provider === "uipath" || provider === "mimica" ? "license_required" : "not_configured";
      await tx.insert(schema.integrations).values({ orgId: org.id, provider, status });
    }
    const [inv] = await tx.insert(schema.invitations).values({ orgId: org.id, email: adminEmail, role: "owner", tokenHash: sha256(inviteToken), invitedBy: input.actorUserId ?? null, expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) }).returning({ id: schema.invitations.id });
    return inv.id;
  });
  await ensureDefaultFinancialModel(org.id);

  // optional CSV employees
  let employeesCreated = 0; let departmentsCreated = 0;
  if (input.employees?.length) {
    const r = await importEmployees(org.id, input.employees);
    employeesCreated = r.employees; departmentsCreated = r.departments;
  }

  // optional synthetic demo data (smaller employee set) — always labelled is_demo
  let demo: CreateClientResult["demo"] = null;
  if (isDemo) demo = await seedDemoData(org.id, input.actorUserId ?? null);

  const base = (input.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const inviteUrl = `${base}/invite/${inviteToken}`;
  await audit({ orgId: consultancy.id, actorUserId: input.actorUserId ?? null, action: "client.created", entityType: "organization", entityId: org.id, details: { name: displayName, plan: input.plan, seats, adminEmail, employeesCreated, demo: isDemo } });
  await audit({ orgId: org.id, actorUserId: input.actorUserId ?? null, action: "org.created_by_consultancy", entityType: "organization", entityId: org.id, details: { consultancyId: consultancy.id, plan: input.plan, demo: isDemo } });
  await audit({ orgId: org.id, actorUserId: input.actorUserId ?? null, action: "invitation.created", entityType: "invitation", entityId: invitationId, details: { email: adminEmail, role: "owner" } });
  return { orgId: org.id, slug, invitationId, inviteToken, inviteUrl, employeesCreated, departmentsCreated, demo };
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name) || "client";
  for (let i = 0; i < 50; i++) {
    const s = i === 0 ? base : `${base}-${i + 1}`;
    const [hit] = await db.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.slug, s)).limit(1);
    if (!hit) return s;
  }
  return `${base}-${randomToken(4).toLowerCase()}`;
}

/** Insert departments + employees for a client from parsed CSV rows. Loaded hourly cost uses the org's settings. */
export async function importEmployees(orgId: string, rows: EmployeeCsvRow[]): Promise<{ employees: number; departments: number }> {
  const [org] = await db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
  const s = org?.settings ?? {};
  const load = s.benefitsLoadPct ?? 0.3, hpw = s.workHoursPerWeek ?? 40, wpy = s.workWeeksPerYear ?? 48;
  return withTenant(orgId, async (tx) => {
    const existingDepts = await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, orgId));
    const deptIds = new Map(existingDepts.map((d) => [d.name.toLowerCase(), d.id]));
    let departments = 0, employees = 0;
    for (const r of rows) {
      let departmentId: string | null = null;
      if (r.department) {
        const key = r.department.toLowerCase();
        if (!deptIds.has(key)) { const [d] = await tx.insert(schema.departments).values({ orgId, name: r.department }).returning({ id: schema.departments.id }); deptIds.set(key, d.id); departments++; }
        departmentId = deptIds.get(key)!;
      }
      const loaded = r.baseAnnualCost != null ? (r.baseAnnualCost * (1 + load)) / (hpw * wpy) : null;
      await tx.insert(schema.employees).values({ orgId, departmentId, displayName: r.name, email: r.email, title: r.title, baseAnnualCost: r.baseAnnualCost != null ? String(r.baseAnnualCost) : null, loadedHourlyCost: loaded != null ? loaded.toFixed(2) : null, costBasis: r.baseAnnualCost != null ? "observed" : "assumed", hoursPerWeek: "40" });
      employees++;
    }
    return { employees, departments };
  });
}

/** Seeds a SMALL synthetic data set (6 of the demo employees, 10 workdays) and enqueues analysis. Marks the org isDemo. */
export async function seedDemoData(orgId: string, actorUserId: string | null): Promise<NonNullable<CreateClientResult["demo"]>> {
  const demoEmployees = DEMO_ORG.employees.slice(0, 6) as SynthEmployee[];
  const events = generateEvents({ seed: 7, days: 10, employees: demoEmployees });
  await db.update(schema.organizations).set({ isDemo: true, updatedAt: new Date() }).where(eq(schema.organizations.id, orgId));
  const noticeText = "Notice of workflow observation (synthetic demo): application usage metadata only. No keystroke contents, passwords, message bodies or screenshots.";
  const result = await withTenant(orgId, async (tx) => {
    const deptIds: Record<string, string> = {};
    const existing = await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, orgId));
    for (const d of existing) deptIds[d.name] = d.id;
    for (const name of [...new Set(demoEmployees.map((e) => e.department))]) {
      if (!deptIds[name]) { const [d] = await tx.insert(schema.departments).values({ orgId, name }).returning({ id: schema.departments.id }); deptIds[name] = d.id; }
    }
    const empIds: Record<string, string> = {}; const collectorIds: Record<string, string> = {};
    const [campaign] = await tx.insert(schema.observationCampaigns).values({ orgId, name: "Synthetic baseline (demo)", description: "Generated demonstration data — 10 workdays", status: "completed", startsAt: new Date(Date.now() - 15 * 86_400_000), endsAt: new Date(Date.now() - 86_400_000), departmentIds: Object.values(deptIds), createdBy: actorUserId }).returning({ id: schema.observationCampaigns.id });
    for (const e of demoEmployees) {
      const loaded = (e.baseAnnualCost * 1.3) / (40 * 48);
      const [row] = await tx.insert(schema.employees).values({ orgId, departmentId: deptIds[e.department], displayName: e.name, title: e.title, email: `${e.key}@${orgId.slice(0, 8)}.demo`, baseAnnualCost: String(e.baseAnnualCost), loadedHourlyCost: loaded.toFixed(2), costBasis: "observed", hoursPerWeek: "40" }).returning({ id: schema.employees.id });
      empIds[e.key] = row.id;
      await tx.insert(schema.consentRecords).values({ orgId, employeeId: row.id, noticeVersion: "demo-1", noticeText, acknowledgedAt: new Date(Date.now() - 16 * 86_400_000), method: "collector_ui" });
      const n = events.filter((x) => x.employeeKey === e.key).length;
      const [c] = await tx.insert(schema.collectors).values({ orgId, employeeId: row.id, name: `${e.name.split(" ")[0]}'s workstation (simulated)`, platform: "simulated", tokenHash: sha256(randomToken()), status: "active", version: "0.1.0-sim", lastSeenAt: new Date(Date.now() - 3_600_000), lastEventAt: new Date(Date.now() - 86_400_000), eventsReceived: n, config: { titleMode: "category" } }).returning({ id: schema.collectors.id });
      collectorIds[e.key] = c.id;
    }
    await tx.update(schema.observationCampaigns).set({ employeeIds: Object.values(empIds) }).where(eq(schema.observationCampaigns.id, campaign.id));
    const BATCH = 2000;
    for (let i = 0; i < events.length; i += BATCH) {
      await tx.insert(schema.activityEvents).values(events.slice(i, i + BATCH).map((ev) => ({ orgId, employeeId: empIds[ev.employeeKey], collectorId: collectorIds[ev.employeeKey], campaignId: campaign.id, ts: ev.ts, type: ev.type, app: ev.app, appCategory: ev.appCategory, titleCategory: ev.titleCategory, titleHash: ev.titleHash, durationMs: ev.durationMs, meta: ev.meta })));
    }
    await tx.insert(schema.authorizations).values({ orgId, signedByUserId: actorUserId, signerName: "Synthetic demo", signerTitle: "Demo authorization", scope: "Synthetic demonstration data only", documentText: "This organization is a synthetic demonstration. No real devices or people are observed." });
    return { campaignId: campaign.id, collectors: Object.keys(collectorIds).length };
  });
  const job = await enqueue("analysis", { orgId, campaignId: result.campaignId }, orgId);
  await audit({ orgId, actorUserId, actorType: "user", action: "demo_data.generated", entityType: "organization", entityId: orgId, details: { events: events.length, employees: demoEmployees.length, campaignId: result.campaignId, jobId: job.id } });
  return { events: events.length, collectors: result.collectors, campaignId: result.campaignId, analysisJobId: job.id };
}

// ---------- invitations ----------
export type InvitationLookup = {
  ok: true; invitationId: string; orgId: string; orgName: string; email: string; role: typeof schema.invitations.$inferSelect["role"]; userExists: boolean; expiresAt: Date;
} | { ok: false; reason: "not_found" | "expired" | "accepted" };

export async function lookupInvitation(token: string): Promise<InvitationLookup> {
  if (!token || token.length < 16 || token.length > 200) return { ok: false, reason: "not_found" };
  // Token lookup by hash crosses tenants by nature (the user is not signed in yet) — admin handle, same as collector-token lookup.
  const [inv] = await db.select({ inv: schema.invitations, orgName: schema.organizations.name }).from(schema.invitations).innerJoin(schema.organizations, eq(schema.organizations.id, schema.invitations.orgId)).where(eq(schema.invitations.tokenHash, sha256(token))).limit(1);
  if (!inv) return { ok: false, reason: "not_found" };
  if (inv.inv.acceptedAt) return { ok: false, reason: "accepted" };
  if (inv.inv.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, inv.inv.email)).limit(1);
  return { ok: true, invitationId: inv.inv.id, orgId: inv.inv.orgId, orgName: inv.orgName, email: inv.inv.email, role: inv.inv.role, userExists: !!user, expiresAt: inv.inv.expiresAt };
}

export type AcceptInput = { token: string } & ({ mode: "existing"; userId: string } | { mode: "new"; name: string; password: string });
/** Accept an invitation: create the user when needed, create the membership (linking employeeId), mark accepted, audit. */
export async function acceptInvitation(input: AcceptInput): Promise<{ userId: string; orgId: string; membershipId: string; role: string }> {
  const look = await lookupInvitation(input.token);
  if (!look.ok) throw new OnboardingError(look.reason === "expired" ? "This invitation has expired." : look.reason === "accepted" ? "This invitation was already used." : "Invitation not found.", look.reason);
  const [inv] = await db.select().from(schema.invitations).where(eq(schema.invitations.id, look.invitationId)).limit(1);
  let userId: string;
  if (input.mode === "existing") {
    const [u] = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, input.userId)).limit(1);
    if (!u) throw new OnboardingError("User not found", "not_found");
    if (u.email.toLowerCase() !== inv.email.toLowerCase()) throw new OnboardingError(`This invitation was sent to ${inv.email}. Sign in with that email to accept it.`, "forbidden");
    userId = u.id;
  } else {
    if (look.userExists) throw new OnboardingError("An account with this email already exists. Sign in to accept.", "exists");
    const name = input.name.trim(); if (name.length < 2) throw new OnboardingError("Please enter your name.");
    if (input.password.length < 10) throw new OnboardingError("Password must be at least 10 characters.");
    const [u] = await db.insert(schema.users).values({ email: inv.email, name, passwordHash: await bcrypt.hash(input.password, 10), emailVerified: new Date() }).returning({ id: schema.users.id });
    userId = u.id;
    await audit({ actorUserId: userId, action: "auth.user_created_via_invite", details: { invitationId: inv.id } });
  }
  const membershipId = await withTenant(inv.orgId, async (tx) => {
    const [existing] = await tx.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.orgId, inv.orgId))).limit(1);
    let id = existing?.id;
    if (!id) { const [m] = await tx.insert(schema.memberships).values({ userId, orgId: inv.orgId, role: inv.role, employeeId: inv.employeeId }).returning({ id: schema.memberships.id }); id = m.id; }
    if (inv.employeeId) await tx.update(schema.employees).set({ userId, updatedAt: new Date() }).where(and(eq(schema.employees.id, inv.employeeId), eq(schema.employees.orgId, inv.orgId)));
    await tx.update(schema.invitations).set({ acceptedAt: new Date() }).where(and(eq(schema.invitations.id, inv.id), isNull(schema.invitations.acceptedAt)));
    return id!;
  });
  await audit({ orgId: inv.orgId, actorUserId: userId, action: "invitation.accepted", entityType: "invitation", entityId: inv.id, details: { role: inv.role, membershipId, newUser: input.mode === "new" } });
  return { userId, orgId: inv.orgId, membershipId, role: inv.role };
}

/** Create an invitation into any org (used by the Team page for consultants and by the client workspace). */
export async function createInvitation(p: { orgId: string; email: string; role: typeof schema.invitations.$inferSelect["role"]; employeeId?: string | null; invitedBy?: string | null; appUrl?: string }): Promise<{ invitationId: string; token: string; url: string }> {
  const email = p.email.trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new OnboardingError("Email is not valid");
  const token = randomToken(32);
  const invitationId = await withTenant(p.orgId, async (tx) => {
    const [inv] = await tx.insert(schema.invitations).values({ orgId: p.orgId, email, role: p.role, employeeId: p.employeeId ?? null, tokenHash: sha256(token), invitedBy: p.invitedBy ?? null, expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) }).returning({ id: schema.invitations.id });
    return inv.id;
  });
  const base = (p.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
  await audit({ orgId: p.orgId, actorUserId: p.invitedBy ?? null, action: "invitation.created", entityType: "invitation", entityId: invitationId, details: { email, role: p.role } });
  return { invitationId, token, url: `${base}/invite/${token}` };
}
