/** Session revocation (SEC-004): pure validity rule + session_version bumps (password, MFA, removal, sign-out-all). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, like, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, schema, pg } from "@/db/client";
import { randomToken } from "@/lib/crypto";
import { sessionStillValid, tokenSessionVersion, bumpSessionVersion, currentSessionVersion } from "@/lib/sessions";
import { authorizeCredentials } from "@/lib/authorize";
import { _resetRateLimitsFor } from "@/lib/rate-limit";

const S = randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x");
let userId = ""; let other = "";
beforeAll(async () => {
  const [u] = await db.insert(schema.users).values({ email: `sess-${S}@example.com`, passwordHash: await bcrypt.hash("Password-123456", 4) }).returning();
  const [o] = await db.insert(schema.users).values({ email: `sess2-${S}@example.com`, passwordHash: await bcrypt.hash("Password-123456", 4) }).returning();
  userId = u.id; other = o.id;
  await _resetRateLimitsFor("loginEmailFailures");
});
afterAll(async () => { await db.delete(schema.users).where(like(schema.users.email, `%${S}@example.com`)); await pg.end({ timeout: 5 }); });

describe("sessionStillValid", () => {
  const u = { sessionVersion: 2, hasPassword: true, ssoSubject: null };
  it("accepts only the current version", () => {
    expect(sessionStillValid(2, u)).toBe(true);
    expect(sessionStillValid(1, u)).toBe(false);
    expect(sessionStillValid(3, u)).toBe(false);
    expect(sessionStillValid("2", u)).toBe(true);
  });
  it("treats tokens issued before migration 0005 (no sv) as version 0", () => {
    expect(tokenSessionVersion(undefined)).toBe(0);
    expect(sessionStillValid(undefined, { ...u, sessionVersion: 0 })).toBe(true);
    expect(sessionStillValid(undefined, u)).toBe(false);
    expect(tokenSessionVersion("garbage")).toBe(-1);
  });
  it("rejects users that can no longer sign in (no password hash and no SSO subject) and missing users", () => {
    expect(sessionStillValid(0, { sessionVersion: 0, hasPassword: false, ssoSubject: null })).toBe(false);
    expect(sessionStillValid(0, { sessionVersion: 0, hasPassword: false, ssoSubject: "sub-1" })).toBe(true);
    expect(sessionStillValid(0, null)).toBe(false);
  });
});

describe("bumpSessionVersion", () => {
  it("increments only the targeted users, audits each, and invalidates their existing token version", async () => {
    const before = (await authorizeCredentials({ email: `sess-${S}@example.com`, password: "Password-123456" }, null, { NODE_ENV: "test" }))!;
    expect(before.sessionVersion).toBe(0);
    const out = await bumpSessionVersion([userId], "password_changed");
    expect(out[userId]).toBe(1);
    expect(await currentSessionVersion(other)).toBe(0);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(sessionStillValid(before.sessionVersion, { sessionVersion: row.sessionVersion, hasPassword: true, ssoSubject: null })).toBe(false);
    const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, "auth.sessions_revoked"), eq(schema.auditLog.entityId, userId)));
    expect(audits[0]?.details).toMatchObject({ reason: "password_changed", sessionVersion: 1 });
    // A fresh sign-in carries the new version and is valid again.
    const after = (await authorizeCredentials({ email: `sess-${S}@example.com`, password: "Password-123456" }, null, { NODE_ENV: "test" }))!;
    expect(after.sessionVersion).toBe(1);
  });
  it("bumps several users at once (owner 'sign out everyone') and de-duplicates ids", async () => {
    const out = await bumpSessionVersion([userId, other, other], "sign_out_org");
    expect(Object.keys(out).length).toBe(2);
    expect(out[userId]).toBe(2); expect(out[other]).toBe(1);
    expect(await bumpSessionVersion([], "admin")).toEqual({});
  });
});
