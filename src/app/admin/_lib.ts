import "server-only";
/**
 * Consulting portal helpers.
 *  - requireConsultant(): the signed-in user must hold owner/admin/consultant in a `consultancy` org.
 *  - requireClient(id):   that client must have parentOrgId === the consultancy (admin `db` only for this check).
 * Every client-scoped read after that goes through withTenant(client.id, ...).
 */
import { redirect, notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { getCtx, listUserOrgs } from "@/lib/session";
import { db, schema } from "@/db/client";
import { assertClientOfConsultancy, OnboardingError } from "@/engine/onboarding";
import type { Ctx } from "@/lib/auth";

export const CONSULTANT_ROLES = ["owner", "admin", "consultant"] as const;
export type ConsultantRole = (typeof CONSULTANT_ROLES)[number];
export type ConsultantCtx = { ctx: Ctx; consultancy: { id: string; name: string; role: ConsultantRole; branding: NonNullable<typeof schema.organizations.$inferSelect["branding"]> }; orgs: Awaited<ReturnType<typeof listUserOrgs>> };

export async function getConsultant(): Promise<ConsultantCtx | null> {
  const ctx = await getCtx(); if (!ctx) return null;
  const orgs = await listUserOrgs(ctx.userId);
  const c = orgs.find((o) => o.kind === "consultancy" && (CONSULTANT_ROLES as readonly string[]).includes(o.role));
  if (!c) return null;
  const [org] = await db.select({ branding: schema.organizations.branding }).from(schema.organizations).where(eq(schema.organizations.id, c.id)).limit(1);
  return { ctx, consultancy: { id: c.id, name: c.name, role: c.role as ConsultantRole, branding: org?.branding ?? {} }, orgs };
}
export async function requireConsultant(): Promise<ConsultantCtx> {
  const ctx = await getCtx(); if (!ctx) redirect("/login?next=/admin");
  const c = await getConsultant(); if (!c) redirect("/app?denied=consultancy");
  return c;
}
/** Client org managed by the caller's consultancy, or 404. */
export async function requireClient(clientId: string): Promise<ConsultantCtx & { client: typeof schema.organizations.$inferSelect }> {
  const c = await requireConsultant();
  try { const client = await assertClientOfConsultancy(c.consultancy.id, clientId); return { ...c, client }; }
  catch (e) { if (e instanceof OnboardingError) notFound(); throw e; }
}
/** All clients of the consultancy (organizations table is not tenant-scoped; the parent filter IS the check). */
export async function listClients(consultancyId: string) {
  return db.select().from(schema.organizations).where(and(eq(schema.organizations.kind, "client"), eq(schema.organizations.parentOrgId, consultancyId))).orderBy(schema.organizations.name);
}
export const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
