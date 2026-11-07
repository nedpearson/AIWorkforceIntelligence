import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { audit } from "@/lib/audit";

/**
 * Ensures a platform owner account exists with full privileges:
 *  - owner of the BridgeBox consultancy org (→ consulting portal + consultant access to every client)
 *  - owner of every client org managed by that consultancy (→ full client privileges, incl. billing & credentials)
 * Driven by env OWNER_EMAIL + OWNER_PASSWORD_HASH (bcrypt). Plain passwords are never stored or read.
 */
export async function ensurePlatformOwner(opts: { email: string; passwordHash: string; name?: string; log?: (m: string) => void }) {
  const log = opts.log ?? console.log;
  const email = opts.email.trim().toLowerCase();
  if (!/^\$2[aby]\$\d{2}\$.{53}$/.test(opts.passwordHash)) throw new Error("OWNER_PASSWORD_HASH must be a bcrypt hash");
  let [u] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  // A changed password hash also revokes every existing session of the owner (session_version, migration 0005).
  if (u) { const changed = u.passwordHash !== opts.passwordHash; await db.update(schema.users).set({ passwordHash: opts.passwordHash, emailVerified: u.emailVerified ?? new Date(), updatedAt: new Date(), ...(changed ? { sessionVersion: u.sessionVersion + 1 } : {}) }).where(eq(schema.users.id, u.id)); }
  else { [u] = await db.insert(schema.users).values({ email, name: opts.name ?? "Ned Pearson", passwordHash: opts.passwordHash, emailVerified: new Date() }).returning(); }
  const [consultancy] = await db.select().from(schema.organizations).where(and(eq(schema.organizations.slug, "bridgebox"), eq(schema.organizations.kind, "consultancy"))).limit(1);
  if (!consultancy) { log("owner: no consultancy org yet — skipped memberships"); return { userId: u.id, orgs: 0 }; }
  const clients = await db.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.parentOrgId, consultancy.id));
  const orgIds = [consultancy.id, ...clients.map((c) => c.id)];
  const existing = await db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, u.id), inArray(schema.memberships.orgId, orgIds)));
  for (const orgId of orgIds) {
    const m = existing.find((x) => x.orgId === orgId);
    if (!m) await db.insert(schema.memberships).values({ userId: u.id, orgId, role: "owner" });
    else if (m.role !== "owner") await db.update(schema.memberships).set({ role: "owner" }).where(eq(schema.memberships.id, m.id));
  }
  await audit({ actorType: "system", action: "owner.ensured", entityType: "user", entityId: u.id, details: { email, orgs: orgIds.length } });
  log(`owner: ${email} is owner of ${orgIds.length} org(s)`);
  return { userId: u.id, orgs: orgIds.length };
}
