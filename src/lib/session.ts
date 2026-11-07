import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth, type Ctx } from "./auth";
import { db, schema } from "@/db/client";
import { can, type Permission } from "./rbac";

export const ORG_COOKIE = "bb_org";

/** Resolve the signed-in user + active org (from cookie, falling back to first membership). */
export async function getCtx(): Promise<Ctx | null> {
  const s = await auth();
  if (!s?.user?.id) return null;
  const c = await cookies();
  const wanted = c.get(ORG_COOKIE)?.value;
  const rows = await db.select({ orgId: schema.memberships.orgId, role: schema.memberships.role, employeeId: schema.memberships.employeeId, kind: schema.organizations.kind, name: schema.organizations.name, parent: schema.organizations.parentOrgId })
    .from(schema.memberships).innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(eq(schema.memberships.userId, s.user.id));
  if (!rows.length) return null;
  let m = rows.find((r) => r.orgId === wanted) ?? rows[0];
  // Consultancy members may act inside any client org they manage (as 'consultant').
  if (wanted && !rows.some((r) => r.orgId === wanted)) {
    const consultancies = rows.filter((r) => r.kind === "consultancy" && ["owner", "admin", "consultant"].includes(r.role)).map((r) => r.orgId);
    if (consultancies.length) {
      const [client] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, wanted)).limit(1);
      if (client?.parentOrgId && consultancies.includes(client.parentOrgId)) {
        m = { orgId: client.id, role: "consultant", employeeId: null, kind: client.kind, name: client.name, parent: client.parentOrgId };
      }
    }
  }
  return { userId: s.user.id, email: s.user.email, orgId: m.orgId, role: m.role, orgKind: m.kind, orgName: m.name, employeeId: m.employeeId };
}
export async function requireCtx(perm?: Permission): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) redirect("/login");
  if (perm && !can(ctx.role, perm)) redirect("/app?denied=" + perm);
  return ctx;
}
/** For route handlers: returns 401/403 Response instead of redirecting. */
export async function requireApiCtx(perm?: Permission): Promise<Ctx | Response> {
  const ctx = await getCtx();
  if (!ctx) return Response.json({ error: "unauthenticated" }, { status: 401 });
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
