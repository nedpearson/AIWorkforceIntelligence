import { desc, eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { MembersClient } from "./members-client";

export const metadata = { title: "Members" };
export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const ctx = await requireCtx("members:invite");
  const data = await withTenant(ctx.orgId, async (tx) => {
    const members = await tx.select({ id: schema.memberships.id, userId: schema.memberships.userId, role: schema.memberships.role, employeeId: schema.memberships.employeeId, email: schema.users.email, name: schema.users.name, lastLoginAt: schema.users.lastLoginAt, mfaEnabled: schema.users.mfaEnabled, createdAt: schema.memberships.createdAt })
      .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(eq(schema.memberships.orgId, ctx.orgId)).orderBy(schema.users.email);
    const invitations = await tx.select({ id: schema.invitations.id, email: schema.invitations.email, role: schema.invitations.role, employeeId: schema.invitations.employeeId, expiresAt: schema.invitations.expiresAt, acceptedAt: schema.invitations.acceptedAt, createdAt: schema.invitations.createdAt }).from(schema.invitations).where(eq(schema.invitations.orgId, ctx.orgId)).orderBy(desc(schema.invitations.createdAt)).limit(100);
    const employees = await tx.select({ id: schema.employees.id, displayName: schema.employees.displayName, title: schema.employees.title }).from(schema.employees).where(eq(schema.employees.orgId, ctx.orgId)).orderBy(schema.employees.displayName);
    return { members, invitations, employees };
  });
  const emp = new Map(data.employees.map((e) => [e.id, e]));
  return (
    <MembersClient
      me={ctx.userId} myRole={ctx.role}
      members={data.members.map((m) => ({ id: m.id, userId: m.userId, role: m.role, email: m.email, name: m.name ?? "", lastLoginAt: m.lastLoginAt?.toISOString() ?? null, mfaEnabled: m.mfaEnabled, employeeId: m.employeeId, employeeName: m.employeeId ? (emp.get(m.employeeId)?.displayName ?? null) : null, createdAt: m.createdAt.toISOString() }))}
      invitations={data.invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, employeeName: i.employeeId ? (emp.get(i.employeeId)?.displayName ?? null) : null, expiresAt: i.expiresAt.toISOString(), acceptedAt: i.acceptedAt?.toISOString() ?? null, createdAt: i.createdAt.toISOString() }))}
      employees={data.employees.map((e) => ({ id: e.id, name: e.displayName, title: e.title ?? "" }))}
    />
  );
}
