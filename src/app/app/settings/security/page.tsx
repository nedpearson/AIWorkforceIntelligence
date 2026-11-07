import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { db, schema } from "@/db/client";
import { SecurityClient } from "./security-client";

export const metadata = { title: "Security" };
export const dynamic = "force-dynamic";

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ mfa?: string }> }) {
  const sp = await searchParams;
  // Reachable for every signed-in user whose MFA is required (never locked out); other settings stay org:manage.
  const ctx = await requireCtx();
  if (!ctx.mfaRequired && !can(ctx.role, "org:manage")) redirect("/app?denied=org:manage");
  const [org] = await db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1);
  const policy = { orgRequiresMfa: !!org?.settings?.requireMfaForAdmins, canEdit: ctx.role === "owner", required: !!ctx.mfaRequired, reason: ctx.mfaRequiredReason ?? null, gateHit: sp.mfa === "required" };
  const [u] = await db.select({ email: schema.users.email, name: schema.users.name, mfaEnabled: schema.users.mfaEnabled, hasPassword: schema.users.passwordHash, ssoSubject: schema.users.ssoSubject, lastLoginAt: schema.users.lastLoginAt, createdAt: schema.users.createdAt }).from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1);
  const sso = { configured: !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID), vars: [["OIDC_ISSUER", !!process.env.OIDC_ISSUER], ["OIDC_CLIENT_ID", !!process.env.OIDC_CLIENT_ID], ["OIDC_CLIENT_SECRET", !!process.env.OIDC_CLIENT_SECRET]] as [string, boolean][] };
  return <SecurityClient user={{ email: u.email, name: u.name ?? "", mfaEnabled: u.mfaEnabled, hasPassword: !!u.hasPassword, sso: !!u.ssoSubject, lastLoginAt: u.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString() }} session={{ role: ctx.role, orgName: ctx.orgName, strategy: "Signed JWT cookie, 12-hour lifetime, HttpOnly, revocable (session version)" }} sso={sso} vaultReady={!!process.env.VAULT_KEY} policy={policy} />;
}
