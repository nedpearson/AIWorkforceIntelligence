import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** Applies drizzle/*.sql (ledger-based, idempotent) + drizzle/rls.sql. Shared by scripts/migrate.ts and the bootstrap API. */
export async function runMigrations(opts: { log?: (m: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const url = process.env.DATABASE_URL!;
  const schemaName = process.env.DB_SCHEMA?.trim() || "public";
  const sql = postgres(url, { max: 1, ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined, ...(schemaName !== "public" ? { connection: { search_path: `${schemaName},public` } } : {}) });
  try {
    if (schemaName !== "public") await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS "${schemaName}"."__bb_migrations" (name text primary key, applied_at timestamptz default now())`);
    const applied = new Set((await sql.unsafe(`SELECT name FROM "${schemaName}"."__bb_migrations"`)).map((r) => r.name as string));
    const dir = path.join(process.cwd(), "drizzle");
    const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const appliedNow: string[] = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      const raw = readFileSync(path.join(dir, f), "utf8").replaceAll('"public".', `"${schemaName}".`);
      const statements = raw.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
      await sql.begin(async (tx) => {
        for (const st of statements) await tx.unsafe(st);
        await tx.unsafe(`INSERT INTO "${schemaName}"."__bb_migrations"(name) VALUES ($1)`, [f]);
      });
      appliedNow.push(f); log("applied " + f);
    }
    const rls = readFileSync(path.join(dir, "rls.sql"), "utf8").replaceAll("__SCHEMA__", schemaName);
    await sql.unsafe(rls);
    log(`migrations + RLS applied to schema "${schemaName}"`);
    return { schema: schemaName, applied: appliedNow, alreadyApplied: [...applied] };
  } finally { await sql.end(); }
}
