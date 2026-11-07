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

export type MfaRequirement = { required: boolean; reason: "org_policy" | "platform_owner" | null };

export function isPlatformOwnerEmail(email: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  return !!owner && !!email && email.trim().toLowerCase() === owner;
}

export function mfaRequirement(input: { role: string; email: string; orgSettings?: { requireMfaForAdmins?: boolean } | null }, env: Record<string, string | undefined> = process.env): MfaRequirement {
  if (isPlatformOwnerEmail(input.email, env)) return { required: true, reason: "platform_owner" };
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
