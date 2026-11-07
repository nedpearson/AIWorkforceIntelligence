/**
 * Read-only Postgres helper for the e2e suite. Used ONLY to look up ids of seeded rows
 * (e.g. a Gulf Coast workflow id) so a spec can prove cross-tenant access is refused.
 * Never writes. Connection string comes from .env (DATABASE_URL), same as the app.
 */
import postgres from "postgres";
import { config as loadEnv } from "dotenv";
import path from "node:path";

loadEnv({ path: path.join(__dirname, "..", "..", ".env") });

let sql: ReturnType<typeof postgres> | null = null;
function conn() {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (expected in .env)");
    sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  }
  return sql;
}
export async function closeDb() { if (sql) { await sql.end({ timeout: 2 }); sql = null; } }

export const GULF_SLUG = "gulf-coast-supply-demo";
export const BAYOU_SLUG = "bayou-dental-demo";

export async function orgIdBySlug(slug: string): Promise<string> {
  const rows = await conn()<{ id: string }[]>`select id from organizations where slug = ${slug} limit 1`;
  if (!rows[0]) throw new Error(`org with slug ${slug} not found — run npm run db:reset`);
  return rows[0].id;
}
export async function orgByName(nameLike: string): Promise<{ id: string; slug: string; name: string }> {
  const rows = await conn()<{ id: string; slug: string; name: string }[]>`select id, slug, name from organizations where name ilike ${"%" + nameLike + "%"} order by created_at limit 1`;
  if (!rows[0]) throw new Error(`org named like ${nameLike} not found`);
  return rows[0];
}

export type SeededIds = { orgId: string; workflowId: string; opportunityId: string; employeeId: string; agentId: string | null; reportId: string | null };
/** One id of each tenant-scoped entity for the given org (first by creation). */
export async function seededIdsFor(orgId: string): Promise<SeededIds> {
  const s = conn();
  const [wf] = await s<{ id: string }[]>`select id from workflows where org_id = ${orgId} order by hours_per_week desc limit 1`;
  const [op] = await s<{ id: string }[]>`select id from opportunities where org_id = ${orgId} order by rank limit 1`;
  const [em] = await s<{ id: string }[]>`select id from employees where org_id = ${orgId} order by created_at limit 1`;
  const [ag] = await s<{ id: string }[]>`select id from agents where org_id = ${orgId} order by created_at limit 1`;
  const [rp] = await s<{ id: string }[]>`select id from reports where org_id = ${orgId} and pdf_bytes is not null order by created_at desc limit 1`;
  if (!wf || !op || !em) throw new Error(`org ${orgId} is missing seeded workflows/opportunities/employees`);
  return { orgId, workflowId: wf.id, opportunityId: op.id, employeeId: em.id, agentId: ag?.id ?? null, reportId: rp?.id ?? null };
}
