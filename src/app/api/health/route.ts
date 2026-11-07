import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { safeEqual } from "@/lib/crypto";
import { isPlatformOwner } from "@/lib/session";
export const dynamic = "force-dynamic";

const version = () => process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";

/** Detailed diagnostics only for the scheduler secret (Authorization: Bearer $CRON_SECRET) or a platform-owner session. */
async function detailAllowed(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  if (secret && bearer && safeEqual(bearer, secret)) return true;
  try { return await isPlatformOwner(); } catch { return false; }
}

/**
 * Liveness/readiness probe. Public response: `{ ok, version }` only (no env flags, no counts — docs/SECURITY_VERIFICATION.md SEC-002).
 * Detailed response (authorized): env-presence flags (names only), migration state and org count.
 */
export async function GET(req: Request) {
  let database: { ok: boolean; migrated?: boolean; orgs?: number; error?: string } = { ok: false };
  try {
    const [m] = await db.execute(sql`select to_regclass('__bb_migrations') is not null as migrated, (select count(*) from pg_tables where tablename='organizations' and schemaname = current_schema()) as t`) as unknown as { migrated: boolean; t: number }[];
    database = { ok: true, migrated: !!m?.migrated && Number(m?.t) > 0 };
    if (Number(m?.t) > 0) { const [o] = await db.execute(sql`select count(*)::int as n from organizations`) as unknown as { n: number }[]; database.orgs = Number(o?.n); }
  } catch (e) { database = { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "error" }; }
  const status = database.ok ? 200 : 503;
  if (!(await detailAllowed(req))) return Response.json({ ok: database.ok, version: version() }, { status, headers: { "cache-control": "no-store" } });
  const env = { DATABASE_URL: !!process.env.DATABASE_URL, AUTH_SECRET: !!process.env.AUTH_SECRET, VAULT_KEY: !!process.env.VAULT_KEY, CRON_SECRET: !!process.env.CRON_SECRET, DB_SCHEMA: process.env.DB_SCHEMA || "public" };
  return Response.json({ ok: database.ok, version: version(), env, database }, { status, headers: { "cache-control": "no-store" } });
}
