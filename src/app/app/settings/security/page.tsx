import { eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { db, schema } from "@/db/client";
import { SecurityClient } from "./security-client";

export const metadata = { title: "Security" };
export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const ctx = await requireCtx("org:manage");
  const [u] = await db.select({ email: schema.users.email, name: schema.users.name, mfaEnabled: schema.users.mfaEnabled, hasPassword: schema.users.passwordHash, ssoSubject: schema.users.ssoSubject, lastLoginAt: schema.users.lastLoginAt, createdAt: schema.users.createdAt }).from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1);
  const sso = { configured: !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID), vars: [["OIDC_ISSUER", !!process.env.OIDC_ISSUER], ["OIDC_CLIENT_ID", !!process.env.OIDC_CLIENT_ID], ["OIDC_CLIENT_SECRET", !!process.env.OIDC_CLIENT_SECRET]] as [string, boolean][] };
  return <SecurityClient user={{ email: u.email, name: u.name ?? "", mfaEnabled: u.mfaEnabled, hasPassword: !!u.hasPassword, sso: !!u.ssoSubject, lastLoginAt: u.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString() }} session={{ role: ctx.role, orgName: ctx.orgName, strategy: "Signed JWT cookie, 12-hour lifetime, HttpOnly" }} sso={sso} vaultReady={!!process.env.VAULT_KEY} />;
}
