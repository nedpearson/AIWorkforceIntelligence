/**
 * MFA enrolment policy.
 *  - An organization can require MFA for its owners/admins (and consultancy staff acting inside it as `consultant`):
 *    organizations.settings.requireMfaForAdmins.
 *  - The platform owner (OWNER_EMAIL, see src/engine/owner.ts) is always required.
 * Enforcement never locks anyone out: an affected user without MFA is sent to /app/settings/security (the enrolment
 * page, always reachable) and API routes answer 403 `mfa_enrollment_required`; sign-in itself is never blocked.
 * Pure (no DB): getCtx() supplies the inputs.
 */
export const MFA_ENROLL_PATH = "/app/settings/security";
export const MFA_ADMIN_ROLES = ["owner", "admin", "consultant"] as const;

export type MfaReason = "org_policy" | "platform_owner" | "platform_owner_grace" | null;
export type MfaRequirement = { required: boolean; reason: MfaReason; graceUntil?: string };

/** Max grace the platform owner can be given, whatever OWNER_MFA_GRACE_UNTIL says (it cannot be used to switch MFA off). */
export const MAX_OWNER_GRACE_DAYS = 14;
/**
 * Optional, time-boxed grace for the platform owner: OWNER_MFA_GRACE_UNTIL (ISO date-time). While it is in the future
 * (and no more than MAX_OWNER_GRACE_DAYS ahead) the owner is NOT redirected — every page shows a reminder banner
 * instead. When it passes, MFA is required again automatically. Unset/invalid/too-far → no grace.
 */
export function ownerGraceUntil(env: Record<string, string | undefined> = process.env, now: Date = new Date()): Date | null {
  const raw = env.OWNER_MFA_GRACE_UNTIL?.trim(); if (!raw) return null;
  const d = new Date(raw); if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() <= now.getTime()) return null;
  if (d.getTime() - now.getTime() > MAX_OWNER_GRACE_DAYS * 86_400_000) return null;
  return d;
}

export function isPlatformOwnerEmail(email: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  return !!owner && !!email && email.trim().toLowerCase() === owner;
}

export function mfaRequirement(input: { role: string; email: string; orgSettings?: { requireMfaForAdmins?: boolean } | null }, env: Record<string, string | undefined> = process.env, now: Date = new Date()): MfaRequirement {
  if (isPlatformOwnerEmail(input.email, env)) {
    const g = ownerGraceUntil(env, now);
    return g ? { required: false, reason: "platform_owner_grace", graceUntil: g.toISOString() } : { required: true, reason: "platform_owner" };
  }
  if (input.orgSettings?.requireMfaForAdmins && (MFA_ADMIN_ROLES as readonly string[]).includes(input.role)) return { required: true, reason: "org_policy" };
  return { required: false, reason: null };
}

/** Paths an un-enrolled, MFA-required user may still open (the enrolment page itself). */
export function mfaGateAllows(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === MFA_ENROLL_PATH || pathname.startsWith(MFA_ENROLL_PATH + "/");
}

/** Should this request be redirected to enrolment? */
export function mustEnrollMfa(ctx: { mfaRequired?: boolean; mfaEnabled?: boolean }, pathname: string | null | undefined): boolean {
  return !!ctx.mfaRequired && !ctx.mfaEnabled && !mfaGateAllows(pathname);
}
