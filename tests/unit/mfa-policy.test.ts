/** MFA enrolment policy (task 4) + readiness access rule. Pure. */
import { describe, it, expect } from "vitest";
import { mfaRequirement, mustEnrollMfa, mfaGateAllows, isPlatformOwnerEmail } from "@/lib/mfa-policy";
import { canSeeReadiness } from "@/engine/readiness/access";

const env = { OWNER_EMAIL: "NedPearson@gmail.com" };
describe("mfa policy", () => {
  it("platform owner is always required (case-insensitive), whatever the org setting", () => {
    expect(isPlatformOwnerEmail("nedpearson@gmail.com", env)).toBe(true);
    expect(mfaRequirement({ role: "owner", email: "nedpearson@gmail.com", orgSettings: {} }, env)).toEqual({ required: true, reason: "platform_owner" });
    expect(mfaRequirement({ role: "viewer", email: "nedpearson@gmail.com" }, env).required).toBe(true);
    expect(isPlatformOwnerEmail("x@y.com", {})).toBe(false);
  });
  it("platform-owner grace: banner instead of redirect until OWNER_MFA_GRACE_UNTIL, capped at 14 days, then required again", () => {
    const now = new Date("2026-11-07T22:00:00Z");
    const g = { ...env, OWNER_MFA_GRACE_UNTIL: "2026-11-14T23:59:59-06:00" };
    const r = mfaRequirement({ role: "owner", email: "nedpearson@gmail.com" }, g, now);
    expect(r.required).toBe(false); expect(r.reason).toBe("platform_owner_grace"); expect(r.graceUntil).toBe("2026-11-15T05:59:59.000Z");
    expect(mfaRequirement({ role: "owner", email: "nedpearson@gmail.com" }, g, new Date("2026-11-16T00:00:00Z"))).toEqual({ required: true, reason: "platform_owner" });
    expect(mfaRequirement({ role: "owner", email: "nedpearson@gmail.com" }, { ...env, OWNER_MFA_GRACE_UNTIL: "2027-06-01" }, now).required).toBe(true); // > 14 days ignored
    expect(mfaRequirement({ role: "owner", email: "nedpearson@gmail.com" }, { ...env, OWNER_MFA_GRACE_UNTIL: "garbage" }, now).required).toBe(true);
    expect(mfaRequirement({ role: "owner", email: "someone@else.com", orgSettings: { requireMfaForAdmins: true } }, g, now).reason).toBe("org_policy"); // grace is owner-only
  });
  it("org policy applies to owner/admin/consultant only", () => {
    const s = { requireMfaForAdmins: true };
    for (const r of ["owner", "admin", "consultant"]) expect(mfaRequirement({ role: r, email: "a@b.com", orgSettings: s }, {}).reason).toBe("org_policy");
    for (const r of ["manager", "employee", "viewer"]) expect(mfaRequirement({ role: r, email: "a@b.com", orgSettings: s }, {}).required).toBe(false);
    expect(mfaRequirement({ role: "owner", email: "a@b.com", orgSettings: {} }, {}).required).toBe(false);
  });
  it("never locks out: the enrolment page is always allowed; enrolled users are never redirected", () => {
    expect(mfaGateAllows("/app/settings/security")).toBe(true);
    expect(mustEnrollMfa({ mfaRequired: true, mfaEnabled: false }, "/app/settings/security")).toBe(false);
    expect(mustEnrollMfa({ mfaRequired: true, mfaEnabled: false }, "/app")).toBe(true);
    expect(mustEnrollMfa({ mfaRequired: true, mfaEnabled: false }, "/admin")).toBe(true);
    expect(mustEnrollMfa({ mfaRequired: true, mfaEnabled: true }, "/app")).toBe(false);
    expect(mustEnrollMfa({ mfaRequired: false, mfaEnabled: false }, "/app")).toBe(false);
    expect(mfaGateAllows("/app/settings/securityx")).toBe(false);
  });
  it("readiness center: platform owner or consultancy owner only", () => {
    expect(canSeeReadiness({ email: "nedpearson@gmail.com", consultancyRole: "consultant" }, env)).toBe(true);
    expect(canSeeReadiness({ email: "a@b.com", consultancyRole: "owner" }, {})).toBe(true);
    expect(canSeeReadiness({ email: "a@b.com", consultancyRole: "admin" }, {})).toBe(false);
    expect(canSeeReadiness({ email: "a@b.com", consultancyRole: null }, {})).toBe(false);
  });
});
