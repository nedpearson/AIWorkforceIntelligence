/** Who may open the Production Readiness Command Center (/admin/readiness): the platform owner (OWNER_EMAIL) or an owner of the consultancy org. */
import { isPlatformOwnerEmail } from "@/lib/mfa-policy";
export function canSeeReadiness(u: { email: string; consultancyRole: string | null | undefined }, env: Record<string, string | undefined> = process.env): boolean {
  return isPlatformOwnerEmail(u.email, env) || u.consultancyRole === "owner";
}
