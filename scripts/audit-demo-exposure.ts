/**
 * READ-ONLY production audit: do seeded demo accounts exist, does the documented demo password match,
 * what memberships do they hold, and have they ever logged in? Prints no secrets.
 * Usage: DATABASE_URL=... npx tsx scripts/audit-demo-exposure.ts
 */
import postgres from "postgres";
import bcrypt from "bcryptjs";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const sql = postgres(url, { ssl: process.env.DATABASE_SSL === "0" ? false : "require", max: 1 });
  const users = await sql`select id, email, password_hash, mfa_enabled, last_login_at from users order by created_at`;
  const known = process.env.SEED_PASSWORD ?? "Demo!Pass123";
  const out: unknown[] = [];
  for (const u of users) {
    const demoPwd = u.password_hash ? await bcrypt.compare(known, u.password_hash) : false;
    const mem = await sql`select o.name, o.kind, m.role from memberships m join organizations o on o.id = m.org_id where m.user_id = ${u.id}`;
    const logins = await sql`select count(*)::int n, max(ts) last from audit_log where actor_user_id = ${u.id} and action = 'auth.login'`;
    out.push({ email: u.email, documentedDemoPasswordWorks: demoPwd, mfa: u.mfa_enabled, lastLoginAt: u.last_login_at, loginEvents: logins[0].n, lastLoginEvent: logins[0].last, memberships: mem.map((m) => `${m.role}@${m.name}(${m.kind})`) });
  }
  const orgs = await sql`select name, kind, is_demo from organizations`;
  const failed = await sql`select count(*)::int n from audit_log where action = 'auth.login_failed'`;
  console.log(JSON.stringify({ users: out, orgs, failedLoginsTotal: failed[0].n }, null, 2));
  await sql.end();
}
main().catch((e) => { console.error("audit failed:", e.message); process.exit(1); });
