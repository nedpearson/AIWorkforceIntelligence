"use server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { createInvitation } from "@/engine/onboarding";
import { bumpSessionVersion } from "@/lib/sessions";
import { requireConsultant, appUrl } from "../_lib";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export async function inviteConsultant(raw: unknown): Promise<Result<{ url: string }>> {
  const { ctx, consultancy } = await requireConsultant();
  if (!["owner", "admin"].includes(consultancy.role)) return { ok: false, error: "Only owners and admins can invite team members." };
  const p = z.object({ email: z.string().email(), role: z.enum(["admin", "consultant", "viewer"]) }).safeParse(raw); if (!p.success) return { ok: false, error: "Enter a valid email and role." };
  try { const r = await createInvitation({ orgId: consultancy.id, email: p.data.email, role: p.data.role, invitedBy: ctx.userId, appUrl: appUrl() }); revalidatePath("/admin/team"); return { ok: true, url: r.url }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : "could not create invitation" }; }
}

export async function setMemberRole(raw: unknown): Promise<Result> {
  const { ctx, consultancy } = await requireConsultant();
  if (consultancy.role !== "owner") return { ok: false, error: "Only the owner can change roles." };
  const p = z.object({ membershipId: z.string().uuid(), role: z.enum(["owner", "admin", "consultant", "viewer"]) }).safeParse(raw); if (!p.success) return { ok: false, error: "invalid" };
  const n = await withTenant(consultancy.id, async (tx) => (await tx.update(schema.memberships).set({ role: p.data.role }).where(and(eq(schema.memberships.id, p.data.membershipId), eq(schema.memberships.orgId, consultancy.id))).returning({ id: schema.memberships.id })).length);
  if (!n) return { ok: false, error: "member not found" };
  await audit({ orgId: consultancy.id, actorUserId: ctx.userId, action: "membership.role_changed", entityType: "membership", entityId: p.data.membershipId, details: { role: p.data.role } });
  revalidatePath("/admin/team"); return { ok: true };
}

export async function removeMember(raw: unknown): Promise<Result> {
  const { ctx, consultancy } = await requireConsultant();
  if (consultancy.role !== "owner") return { ok: false, error: "Only the owner can remove members." };
  const p = z.object({ membershipId: z.string().uuid() }).safeParse(raw); if (!p.success) return { ok: false, error: "invalid" };
  const n = await withTenant(consultancy.id, async (tx) => {
    const [m] = await tx.select({ userId: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.id, p.data.membershipId), eq(schema.memberships.orgId, consultancy.id))).limit(1);
    if (!m || m.userId === ctx.userId) return null;
    const removed = (await tx.delete(schema.memberships).where(eq(schema.memberships.id, p.data.membershipId)).returning({ id: schema.memberships.id })).length;
    return removed ? m.userId : null;
  });
  if (!n) return { ok: false, error: "member not found (you cannot remove yourself)" };
  await audit({ orgId: consultancy.id, actorUserId: ctx.userId, action: "membership.removed", entityType: "membership", entityId: p.data.membershipId });
  await bumpSessionVersion([n], "membership_removed", { orgId: consultancy.id, actorUserId: ctx.userId });
  revalidatePath("/admin/team"); return { ok: true };
}

export async function revokeInvitation(raw: unknown): Promise<Result> {
  const { ctx, consultancy } = await requireConsultant();
  if (!["owner", "admin"].includes(consultancy.role)) return { ok: false, error: "Only owners and admins can revoke invitations." };
  const p = z.object({ invitationId: z.string().uuid() }).safeParse(raw); if (!p.success) return { ok: false, error: "invalid" };
  const n = await withTenant(consultancy.id, async (tx) => (await tx.update(schema.invitations).set({ expiresAt: new Date(0) }).where(and(eq(schema.invitations.id, p.data.invitationId), eq(schema.invitations.orgId, consultancy.id))).returning({ id: schema.invitations.id })).length);
  if (!n) return { ok: false, error: "invitation not found" };
  await audit({ orgId: consultancy.id, actorUserId: ctx.userId, action: "invitation.revoked", entityType: "invitation", entityId: p.data.invitationId });
  revalidatePath("/admin/team"); return { ok: true };
}
