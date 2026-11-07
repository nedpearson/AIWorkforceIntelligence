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
