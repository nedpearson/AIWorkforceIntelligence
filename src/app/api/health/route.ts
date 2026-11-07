import { sql } from "drizzle-orm";
import { db } from "@/db/client";
export const dynamic = "force-dynamic";
/** Public liveness/readiness probe. Never returns secrets. */
export async function GET() {
  const env = { DATABASE_URL: !!process.env.DATABASE_URL, AUTH_SECRET: !!process.env.AUTH_SECRET, VAULT_KEY: !!process.env.VAULT_KEY, CRON_SECRET: !!process.env.CRON_SECRET, DB_SCHEMA: process.env.DB_SCHEMA || "public" };
  let database: { ok: boolean; migrated?: boolean; orgs?: number; error?: string } = { ok: false };
  try {
    const [m] = await db.execute(sql`select to_regclass('__bb_migrations') is not null as migrated, (select count(*) from pg_tables where tablename='organizations' and schemaname = current_schema()) as t`) as unknown as { migrated: boolean; t: number }[];
    let orgs: number | undefined;
    if (Number(m?.t) > 0) { const [o] = await db.execute(sql`select count(*)::int as n from organizations`) as unknown as { n: number }[]; orgs = Number(o?.n); }
    database = { ok: true, migrated: !!m?.migrated && Number(m?.t) > 0, orgs };
  } catch (e) { database = { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "error" }; }
  return Response.json({ ok: database.ok, version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local", env, database }, { status: database.ok ? 200 : 503 });
}
