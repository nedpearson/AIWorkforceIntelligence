/**
 * Credentials sign-in (Auth.js `authorize()`), extracted so it is unit-testable. Order of checks:
 *  1. per-IP rate limit (every attempt) and per-email failure budget (peek before bcrypt)
 *  2. user exists with a password hash
 *  3. SEC-001: demo accounts (`*.demo`, or members of `is_demo` orgs only) are refused in production unless
 *     ALLOW_DEMO_LOGINS=1 — refused like a wrong password, audited `auth.login_blocked_demo`
 *  4. bcrypt; failures count against the email budget and are audited
 *  5. TOTP when enabled; failures count against a per-user MFA budget (`MFA_RATE_LIMITED` once exhausted)
 * Returns the Auth.js user incl. `sessionVersion` (embedded in the JWT as `sv`).
 */
import { eq } from "drizzle-orm";
import { CredentialsSignin } from "@auth/core/errors";
import bcrypt from "bcryptjs";
import { db, schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { decrypt, hmacHash } from "@/lib/crypto";
import { mfaVerify } from "@/lib/mfa";
import { hit, peek, requestIp } from "@/lib/rate-limit";
import { demoLoginsAllowed, isDemoAccount } from "@/lib/runtime-env";

export type AuthorizedUser = { id: string; email: string; name: string | null; mfaEnabled: boolean; sessionVersion: number };
/** A CredentialsSignin whose `code` reaches the client as `signIn(...).code` (Auth.js v5 contract). */
export class AuthorizeError extends CredentialsSignin {
  constructor(code: "MFA_REQUIRED" | "MFA_INVALID" | "MFA_RATE_LIMITED" | "RATE_LIMITED") { super(code); this.code = code; }
}

export async function authorizeCredentials(c: Partial<Record<"email" | "password" | "otp", unknown>> | undefined, req?: Request | { headers: Headers } | null, env: Record<string, string | undefined> = process.env): Promise<AuthorizedUser | null> {
  const email = String(c?.email ?? "").toLowerCase().trim();
  const password = String(c?.password ?? "");
  const otp = String(c?.otp ?? "").trim();
  if (!email || !password || email.length > 320 || password.length > 1000) return null;
  const ip = requestIp(req);
  const ipHash = hmacHash(ip);

  const ipBudget = await hit("loginIp", ip);
  if (!ipBudget.ok) { await audit({ action: "auth.login_rate_limited", details: { bucket: "ip" }, ipHash }); throw new AuthorizeError("RATE_LIMITED"); }
  const emailBudget = await peek("loginEmailFailures", email);
  if (!emailBudget.ok) { await audit({ action: "auth.login_rate_limited", details: { bucket: "email", email }, ipHash }); throw new AuthorizeError("RATE_LIMITED"); }

  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!u?.passwordHash) { await hit("loginEmailFailures", email); return null; }

  if (!demoLoginsAllowed(env)) {
    const ms = await db.select({ isDemo: schema.organizations.isDemo }).from(schema.memberships)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId)).where(eq(schema.memberships.userId, u.id));
    if (isDemoAccount(u.email, ms)) { await audit({ actorUserId: u.id, action: "auth.login_blocked_demo", details: { email }, ipHash }); return null; }
  }

  const ok = await bcrypt.compare(password, u.passwordHash);
  if (!ok) { await hit("loginEmailFailures", email); await audit({ action: "auth.login_failed", details: { email }, ipHash }); return null; }
  if (u.mfaEnabled) {
    if (!u.mfaSecretEnc || !otp) throw new AuthorizeError("MFA_REQUIRED");
    const mfaBudget = await peek("mfaFailures", u.id);
    if (!mfaBudget.ok) { await audit({ actorUserId: u.id, action: "auth.mfa_rate_limited", ipHash }); throw new AuthorizeError("MFA_RATE_LIMITED"); }
    const valid = await mfaVerify(decrypt(u.mfaSecretEnc), otp);
    if (!valid) { await hit("mfaFailures", u.id); await audit({ actorUserId: u.id, action: "auth.mfa_failed", ipHash }); throw new AuthorizeError("MFA_INVALID"); }
  }
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, u.id));
  await audit({ actorUserId: u.id, action: "auth.login", ipHash });
  return { id: u.id, email: u.email, name: u.name, mfaEnabled: u.mfaEnabled, sessionVersion: u.sessionVersion };
}
