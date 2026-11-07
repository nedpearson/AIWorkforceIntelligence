/**
 * Production remediation (SEC-001): disable password login for seeded demo accounts (emails ending in ".demo").
 * Sets password_hash = NULL (Credentials authorize() rejects users without a hash) and writes an audit record.
 * Non-destructive: users, memberships and all data are kept.
 * Usage: DATABASE_URL=... npx tsx scripts/revoke-demo-credentials.ts [--apply]
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const apply = process.argv.includes("--apply");
  const sql = postgres(url, { ssl: process.env.DATABASE_SSL === "0" ? false : "require", max: 1 });
  const targets = await sql`select id, email from users where email like '%.demo' and password_hash is not null`;
  console.log(`${targets.length} demo account(s) with password login:`, targets.map((t) => t.email).join(", ") || "none");
  if (apply && targets.length) {
    await sql.begin(async (tx) => {
      for (const t of targets) {
        await tx`update users set password_hash = null where id = ${t.id}`;
        await tx`insert into audit_log (actor_type, action, entity_type, entity_id, details)
                 values ('system', 'security.demo_credentials_revoked', 'user', ${t.id},
                         ${tx.json({ email: t.email, reason: "documented demo password exposed on public production", finding: "SEC-001" })})`;
      }
    });
    const left = await sql`select count(*)::int n from users where email like '%.demo' and password_hash is not null`;
    console.log("applied; demo accounts still with password:", left[0].n);
  } else if (!apply) console.log("dry run — pass --apply to revoke");
  await sql.end();
}
main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
