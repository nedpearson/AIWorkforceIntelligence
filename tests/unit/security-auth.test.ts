/**
 * SEC-001 (demo credentials in production), login rate limits and MFA brute-force budget, against real Postgres.
 * Calls authorizeCredentials() — the function Auth.js uses as authorize() — with explicit env objects so the
 * production/non-production policy is tested without changing process.env.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { inArray, like } from "drizzle-orm";
import { generate } from "otplib";
import { db, schema, pg } from "@/db/client";
import { randomToken, encrypt } from "@/lib/crypto";
import { authorizeCredentials, AuthorizeError } from "@/lib/authorize";
import { shouldSeedOnBuild, isDemoAccount, demoLoginsAllowed, isProductionRuntime, DEFAULT_DEMO_PASSWORD } from "@/lib/runtime-env";
import { resolveSeedPassword, SeedPasswordError } from "@/engine/seed";
import { _resetRateLimitsFor, RATE_LIMITS } from "@/lib/rate-limit";
import { mfaSecret } from "@/lib/mfa";

const S = randomToken(5).toLowerCase().replace(/[^a-z0-9]/g, "x");
const PW = "Correct-Horse-Battery-9";
const PROD = { NODE_ENV: "production", VERCEL_ENV: "production" };
const DEV = { NODE_ENV: "test" };
/** The Auth.js error code a rejected authorize() call carries (what the login form receives as `code`). */
const codeOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const req = (ip: string) => ({ headers: new Headers({ "x-forwarded-for": ip }) });
let demoOrg: string, realOrg: string;
const emails = { demoTld: `owner-${S}@acme.demo`, demoOnly: `pat-${S}@example.com`, mixed: `ned-${S}@example.com`, real: `real-${S}@example.com`, mfa: `mfa-${S}@example.com` };
let mfaSecretPlain = "";

beforeAll(async () => {
  process.env.VAULT_KEY ??= Buffer.alloc(32, 7).toString("base64");
  const hash = await bcrypt.hash(PW, 4);
  const [d] = await db.insert(schema.organizations).values({ name: `Demo ${S}`, slug: `demo-${S}`, isDemo: true }).returning();
  const [r] = await db.insert(schema.organizations).values({ name: `Real ${S}`, slug: `real-${S}`, isDemo: false }).returning();
  demoOrg = d.id; realOrg = r.id;
  mfaSecretPlain = mfaSecret();
  const users = await db.insert(schema.users).values([
    { email: emails.demoTld, passwordHash: hash }, { email: emails.demoOnly, passwordHash: hash }, { email: emails.mixed, passwordHash: hash }, { email: emails.real, passwordHash: hash },
    { email: emails.mfa, passwordHash: hash, mfaEnabled: true, mfaSecretEnc: encrypt(mfaSecretPlain) },
  ]).returning();
  const id = (e: string) => users.find((u) => u.email === e)!.id;
  await db.insert(schema.memberships).values([
    { userId: id(emails.demoTld), orgId: realOrg, role: "owner" }, // .demo email even in a real org → demo account
    { userId: id(emails.demoOnly), orgId: demoOrg, role: "owner" },
    { userId: id(emails.mixed), orgId: demoOrg, role: "owner" }, { userId: id(emails.mixed), orgId: realOrg, role: "owner" },
    { userId: id(emails.real), orgId: realOrg, role: "admin" }, { userId: id(emails.mfa), orgId: realOrg, role: "owner" },
  ]);
  await _resetRateLimitsFor("loginIp"); await _resetRateLimitsFor("loginEmailFailures"); await _resetRateLimitsFor("mfaFailures");
});
afterAll(async () => {
  await db.delete(schema.users).where(like(schema.users.email, `%${S}%`));
  await db.delete(schema.organizations).where(inArray(schema.organizations.id, [demoOrg, realOrg]));
  await pg.end({ timeout: 5 });
});

describe("SEC-001 policy (pure)", () => {
  it("build bootstrap seeds only with BOOTSTRAP_SEED_DEMO=1 — never by default on Vercel production", () => {
    expect(shouldSeedOnBuild({ VERCEL_ENV: "production" })).toBe(false);
    expect(shouldSeedOnBuild({ VERCEL_ENV: "production", BOOTSTRAP_SEED_DEMO: "0" })).toBe(false);
    expect(shouldSeedOnBuild({})).toBe(false);
    expect(shouldSeedOnBuild({ BOOTSTRAP_SEED_DEMO: "1" })).toBe(true);
  });
  it("production seeding refuses the README password and short passwords; otherwise random and not printable", () => {
    expect(() => resolveSeedPassword({ ...PROD, SEED_PASSWORD: DEFAULT_DEMO_PASSWORD })).toThrow(SeedPasswordError);
    expect(() => resolveSeedPassword({ NODE_ENV: "production", SEED_PASSWORD: "short-but-15chr" })).toThrow(/at least 16/);
    const ok = resolveSeedPassword({ ...PROD, SEED_PASSWORD: "a-long-random-passphrase-42" });
    expect(ok).toMatchObject({ source: "env", printable: false });
    const rnd = resolveSeedPassword({ NODE_ENV: "production" });
    expect(rnd.source).toBe("random"); expect(rnd.printable).toBe(false); expect(rnd.password).not.toBe(DEFAULT_DEMO_PASSWORD); expect(rnd.password.length).toBeGreaterThanOrEqual(16);
    expect(resolveSeedPassword({ NODE_ENV: "production" }).password).not.toBe(rnd.password);
  });
  it("outside production the documented demo password still works for local dev", () => {
    expect(resolveSeedPassword({ NODE_ENV: "development" })).toMatchObject({ password: DEFAULT_DEMO_PASSWORD, printable: true });
    expect(resolveSeedPassword({ SEED_PASSWORD: "x" })).toMatchObject({ password: "x", source: "env" });
  });
  it("demo account = .demo email, or members of demo orgs only; production detection; ALLOW_DEMO_LOGINS", () => {
    expect(isDemoAccount("a@b.demo", [])).toBe(true);
    expect(isDemoAccount("a@b.com", [{ isDemo: true }])).toBe(true);
    expect(isDemoAccount("a@b.com", [{ isDemo: true }, { isDemo: false }])).toBe(false);
    expect(isDemoAccount("a@b.com", [])).toBe(false);
    expect(isProductionRuntime({ VERCEL_ENV: "production" })).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionRuntime({ VERCEL_ENV: "preview", NODE_ENV: "development" })).toBe(false);
    expect(demoLoginsAllowed(PROD)).toBe(false);
    expect(demoLoginsAllowed({ ...PROD, ALLOW_DEMO_LOGINS: "1" })).toBe(true);
    expect(demoLoginsAllowed(DEV)).toBe(true);
  });
});

describe("authorize() in production", () => {
  it("refuses demo accounts with the correct password (and audits it), allows them with ALLOW_DEMO_LOGINS=1 or outside production", async () => {
    for (const e of [emails.demoTld, emails.demoOnly]) {
      expect(await authorizeCredentials({ email: e, password: PW }, req("10.1.0.1"), PROD)).toBeNull();
      expect(await authorizeCredentials({ email: e, password: PW }, req("10.1.0.1"), { ...PROD, ALLOW_DEMO_LOGINS: "1" })).toMatchObject({ email: e });
      expect(await authorizeCredentials({ email: e, password: PW }, req("10.1.0.1"), DEV)).toMatchObject({ email: e });
    }
    const blocked = await db.select().from(schema.auditLog).where(inArray(schema.auditLog.action, ["auth.login_blocked_demo"]));
    expect(blocked.some((a) => (a.details as { email?: string }).email === emails.demoOnly)).toBe(true);
  });
  it("allows real accounts, incl. a platform owner who is also a member of demo client orgs; returns sessionVersion", async () => {
    const u = await authorizeCredentials({ email: emails.mixed, password: PW }, req("10.1.0.2"), PROD);
    expect(u).toMatchObject({ email: emails.mixed, sessionVersion: 0 });
    expect(await authorizeCredentials({ email: emails.real, password: PW }, req("10.1.0.2"), PROD)).toMatchObject({ email: emails.real });
    expect(await authorizeCredentials({ email: emails.real, password: "wrong-password" }, req("10.1.0.2"), PROD)).toBeNull();
  });
});

describe("login + MFA rate limits (SEC-003)", () => {
  it("locks an email after the failure budget — even the right password is refused until the window ends", async () => {
    await _resetRateLimitsFor("loginEmailFailures");
    const n = RATE_LIMITS.loginEmailFailures.limit;
    for (let i = 0; i < n; i++) expect(await authorizeCredentials({ email: emails.real, password: `bad-${i}` }, req(`10.2.0.${i}`), PROD)).toBeNull();
    expect(await codeOf(authorizeCredentials({ email: emails.real, password: PW }, req("10.2.1.1"), PROD))).toBe("RATE_LIMITED");
    await _resetRateLimitsFor("loginEmailFailures");
    expect(await authorizeCredentials({ email: emails.real, password: PW }, req("10.2.1.1"), PROD)).toMatchObject({ email: emails.real });
  });
  it("limits attempts per source IP across different emails", async () => {
    await _resetRateLimitsFor("loginIp");
    const n = RATE_LIMITS.loginIp.limit;
    for (let i = 0; i < n; i++) await authorizeCredentials({ email: `nobody-${i}-${S}@example.com`, password: "x" }, req("10.3.3.3"), PROD);
    expect(await codeOf(authorizeCredentials({ email: emails.real, password: PW }, req("10.3.3.3"), PROD))).toBe("RATE_LIMITED");
    await expect(authorizeCredentials({ email: emails.real, password: PW }, req("10.3.3.3"), PROD)).rejects.toBeInstanceOf(AuthorizeError);
    expect(await authorizeCredentials({ email: emails.real, password: PW }, req("10.3.3.4"), PROD)).toMatchObject({ email: emails.real });
    await _resetRateLimitsFor("loginEmailFailures");
  });
  it("MFA: requires a code, rejects wrong codes, stops verifying after the budget (MFA_RATE_LIMITED)", async () => {
    expect(await codeOf(authorizeCredentials({ email: emails.mfa, password: PW }, req("10.4.0.1"), PROD))).toBe("MFA_REQUIRED");
    for (let i = 0; i < RATE_LIMITS.mfaFailures.limit; i++) expect(await codeOf(authorizeCredentials({ email: emails.mfa, password: PW, otp: "000000" }, req("10.4.0.1"), PROD))).toBe("MFA_INVALID");
    const good = await generate({ secret: mfaSecretPlain });
    expect(await codeOf(authorizeCredentials({ email: emails.mfa, password: PW, otp: good }, req("10.4.0.1"), PROD))).toBe("MFA_RATE_LIMITED");
    await _resetRateLimitsFor("mfaFailures");
    expect(await authorizeCredentials({ email: emails.mfa, password: PW, otp: await generate({ secret: mfaSecretPlain }) }, req("10.4.0.1"), PROD)).toMatchObject({ email: emails.mfa, mfaEnabled: true });
  });
});
