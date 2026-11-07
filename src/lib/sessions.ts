/**
 * Server-side session revocation for Auth.js JWT sessions.
 * Every token carries `sv` = users.session_version at sign-in. getCtx() re-reads the version in the same query that
 * loads memberships and rejects a token whose `sv` differs, or whose user can no longer sign in at all (no password
 * hash and no SSO subject — e.g. SEC-001's revoked demo accounts). Bumping the version signs the user out everywhere.
 * No `server-only`: unit tests import it.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { audit } from "@/lib/audit";

export type SessionRevocationReason = "password_changed" | "mfa_enabled" | "mfa_disabled" | "membership_removed" | "sign_out_all" | "sign_out_org" | "admin";

/** Tokens issued before migration 0005 carry no `sv`; they are treated as version 0 (valid until the first bump). */
export function tokenSessionVersion(sv: unknown): number {
  const n = Number(sv ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

/** Pure decision used by getCtx(): may this token still act for this user row? */
export function sessionStillValid(tokenSv: unknown, user: { sessionVersion: number; hasPassword: boolean; ssoSubject: string | null } | null | undefined): boolean {
  if (!user) return false;
  if (!user.hasPassword && !user.ssoSubject) return false;
  return tokenSessionVersion(tokenSv) === user.sessionVersion;
}

/** Increment session_version for the given users; returns the new versions. Audited per user. */
export async function bumpSessionVersion(userIds: string[], reason: SessionRevocationReason, actor: { orgId?: string | null; actorUserId?: string | null } = {}): Promise<Record<string, number>> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return {};
  const rows = await db.update(schema.users).set({ sessionVersion: sql`${schema.users.sessionVersion} + 1`, updatedAt: new Date() }).where(inArray(schema.users.id, ids)).returning({ id: schema.users.id, sv: schema.users.sessionVersion });
  for (const r of rows) await audit({ orgId: actor.orgId ?? null, actorUserId: actor.actorUserId ?? null, action: "auth.sessions_revoked", entityType: "user", entityId: r.id, details: { reason, sessionVersion: r.sv } });
  return Object.fromEntries(rows.map((r) => [r.id, r.sv]));
}

export async function currentSessionVersion(userId: string): Promise<number | null> {
  const [u] = await db.select({ sv: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return u ? u.sv : null;
}
