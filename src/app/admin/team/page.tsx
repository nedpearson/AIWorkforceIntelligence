import { desc, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import { requireConsultant } from "../_lib";
import { TeamView } from "@/components/admin/team-view";

export const metadata = { title: "Team — Consulting Portal" };
export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const { ctx, consultancy } = await requireConsultant();
  const { members, invites } = await withTenant(consultancy.id, async (tx) => ({
    members: await tx.select().from(schema.memberships).where(eq(schema.memberships.orgId, consultancy.id)).orderBy(schema.memberships.createdAt),
    invites: await tx.select().from(schema.invitations).where(eq(schema.invitations.orgId, consultancy.id)).orderBy(desc(schema.invitations.createdAt)).limit(50),
  }));
  const userIds = members.map((m) => m.userId);
  const users = userIds.length ? await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, lastLoginAt: schema.users.lastLoginAt, mfaEnabled: schema.users.mfaEnabled }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return <TeamView
    me={{ userId: ctx.userId, role: consultancy.role }}
    members={members.map((m) => ({ id: m.id, userId: m.userId, role: m.role, name: byId.get(m.userId)?.name ?? null, email: byId.get(m.userId)?.email ?? "", lastLoginAt: byId.get(m.userId)?.lastLoginAt?.toISOString() ?? null, mfa: !!byId.get(m.userId)?.mfaEnabled, createdAt: m.createdAt.toISOString() }))}
    invites={invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString(), acceptedAt: i.acceptedAt?.toISOString() ?? null, createdAt: i.createdAt.toISOString() }))} />;
}
