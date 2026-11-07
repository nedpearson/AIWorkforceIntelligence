import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { auth, type Ctx } from "./auth";
import { db, schema } from "@/db/client";
import { can, type Permission } from "./rbac";
import { DEFAULT_TIME_ZONE } from "./datetime";
import { sessionStillValid } from "./sessions";
import { mfaRequirement, mustEnrollMfa, MFA_ENROLL_PATH, isPlatformOwnerEmail } from "./mfa-policy";
import { headers } from "next/headers";

export const ORG_COOKIE = "bb_org";

/** auth() plus the server-side revocation check, for callers that need the user but not an org (org switch, invitations). */
export async function getValidSession() {
  const s = await auth();
  if (!s?.user?.id) return null;
  const [u] = await db.select({ sessionVersion: schema.users.sessionVersion, hasPassword: sql<boolean>`${schema.users.passwordHash} is not null`, ssoSubject: schema.users.ssoSubject }).from(schema.users).where(eq(schema.users.id, s.user.id)).limit(1);
  return sessionStillValid(s.user.sv, u) ? s : null;
}

/** Resolve the signed-in user + active org (from cookie, falling back to first membership). */
export async function getCtx(): Promise<Ctx | null> {
  const s = await auth();
  if (!s?.user?.id) return null;
  const c = await cookies();
  const wanted = c.get(ORG_COOKIE)?.value;
  // One query: memberships + the user's session_version / sign-in ability (server-side revocation, src/lib/sessions.ts).
  const rows = await db.select({ orgId: schema.memberships.orgId, role: schema.memberships.role, employeeId: schema.memberships.employeeId, kind: schema.organizations.kind, name: schema.organizations.name, parent: schema.organizations.parentOrgId, sessionVersion: schema.users.sessionVersion, hasPassword: sql<boolean>`${schema.users.passwordHash} is not null`, ssoSubject: schema.users.ssoSubject, mfaEnabled: schema.users.mfaEnabled, settings: schema.organizations.settings })
    .from(schema.memberships).innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId)).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.userId, s.user.id));
  if (!rows.length) return null;
  if (!sessionStillValid(s.user.sv, rows[0])) return null;
  let m = rows.find((r) => r.orgId === wanted) ?? rows[0];
  // Consultancy members may act inside any client org they manage (as 'consultant').
  if (wanted && !rows.some((r) => r.orgId === wanted)) {
    const consultancies = rows.filter((r) => r.kind === "consultancy" && ["owner", "admin", "consultant"].includes(r.role)).map((r) => r.orgId);
    if (consultancies.length) {
      const [client] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, wanted)).limit(1);
      if (client?.parentOrgId && consultancies.includes(client.parentOrgId)) {
        m = { ...m, orgId: client.id, role: "consultant", employeeId: null, kind: client.kind, name: client.name, parent: client.parentOrgId, settings: client.settings };
      }
    }
  }
  const mfa = mfaRequirement({ role: m.role, email: s.user.email, orgSettings: m.settings });
  return { userId: s.user.id, email: s.user.email, orgId: m.orgId, role: m.role, orgKind: m.kind, orgName: m.name, employeeId: m.employeeId, mfaEnabled: rows[0].mfaEnabled, mfaRequired: mfa.required, mfaRequiredReason: mfa.reason, mfaGraceUntil: mfa.graceUntil ?? null };
}

/**
 * Server-side MFA enrolment gate for page layouts. Returns true when the layout must render <MfaRedirect/> instead
 * of the page. Layouts must NOT call redirect() here: layout segments are reused across client navigations, which
 * replayed the redirect on the enrolment page itself and looped (see src/components/mfa-redirect.tsx).
 */
export async function mfaEnrollmentBlocks(ctx: Ctx): Promise<boolean> {
  const path = (await headers()).get("x-bb-path");
  return mustEnrollMfa(ctx, path);
}
/**
 * Page-level MFA gate: redirect an MFA-required, un-enrolled user to the enrolment page. Safe in PAGES (they re-render
 * on every navigation, so the redirect can't be replayed). Never call from a layout — use mfaEnrollmentBlocks there.
 */
export async function gateMfaForPage(ctx: Ctx) {
  if (await mfaEnrollmentBlocks(ctx)) redirect(MFA_ENROLL_PATH + "?mfa=required");
}
/** Pages: requireCtx(perm). Layouts must pass { skipMfaGate: true } and render <MfaRedirect/> themselves. */
export async function requireCtx(perm?: Permission, opts: { skipMfaGate?: boolean } = {}): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) redirect("/login");
  if (!opts.skipMfaGate) await gateMfaForPage(ctx);
  if (perm && !can(ctx.role, perm)) redirect("/app?denied=" + perm);
  return ctx;
}
/** For route handlers: returns 401/403 Response instead of redirecting. */
export async function requireApiCtx(perm?: Permission): Promise<Ctx | Response> {
  const ctx = await getCtx();
  if (!ctx) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (ctx.mfaRequired && !ctx.mfaEnabled) return Response.json({ error: "mfa_enrollment_required", enroll: MFA_ENROLL_PATH }, { status: 403 });
  if (perm && !can(ctx.role, perm)) return Response.json({ error: "forbidden", permission: perm }, { status: 403 });
  return ctx;
}
export async function listUserOrgs(userId: string) {
  const own = await db.select({ id: schema.organizations.id, name: schema.organizations.name, kind: schema.organizations.kind, role: schema.memberships.role, parentOrgId: schema.organizations.parentOrgId })
    .from(schema.memberships).innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId)).where(eq(schema.memberships.userId, userId));
  const consultancyIds = own.filter((o) => o.kind === "consultancy").map((o) => o.id);
  const clients = consultancyIds.length
    ? await db.select({ id: schema.organizations.id, name: schema.organizations.name, kind: schema.organizations.kind, parentOrgId: schema.organizations.parentOrgId }).from(schema.organizations).where(and(eq(schema.organizations.kind, "client")))
    : [];
  const managed = clients.filter((c) => c.parentOrgId && consultancyIds.includes(c.parentOrgId) && !own.some((o) => o.id === c.id)).map((c) => ({ ...c, role: "consultant" as const }));
  return [...own, ...managed];
}

/** The organization's IANA time zone (organizations.timezone) for server-side date formatting; see src/lib/datetime.ts. */
export async function getOrgTimeZone(orgId: string): Promise<string> {
  const [o] = await db.select({ timezone: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
  return o?.timezone ?? DEFAULT_TIME_ZONE;
}

/** Platform owner: OWNER_EMAIL, or an owner of a consultancy organization. Used for operator-only diagnostics. */
export async function isPlatformOwner(ctxOrNull?: Ctx | null): Promise<boolean> {
  const ctx = ctxOrNull === undefined ? await getCtx() : ctxOrNull;
  if (!ctx) return false;
  if (isPlatformOwnerEmail(ctx.email)) return true;
  const own = await listUserOrgs(ctx.userId);
  return own.some((o) => o.kind === "consultancy" && o.role === "owner");
}
