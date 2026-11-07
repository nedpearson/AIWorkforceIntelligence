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

/** AI employee row (read-only) by persona key, for read-back assertions in the AI Workforce specs. */
export async function aiEmployeeByPersona(orgId: string, personaKey: string): Promise<{ id: string; status: string; permissionLevel: string; agentId: string | null; portraitUrl: string | null } | null> {
  const [r] = await conn()<{ id: string; status: string; permission_level: string; agent_id: string | null; portrait_url: string | null }[]>`select id, status, permission_level, agent_id, portrait_url from ai_employees where org_id = ${orgId} and persona_key = ${personaKey} limit 1`;
  return r ? { id: r.id, status: r.status, permissionLevel: r.permission_level, agentId: r.agent_id, portraitUrl: r.portrait_url } : null;
}
export async function skillRunCount(aiEmployeeId: string, mode: "sandbox" | "live", status = "succeeded"): Promise<number> {
  const [r] = await conn()<{ n: number }[]>`select count(*)::int as n from skill_runs where ai_employee_id = ${aiEmployeeId} and mode = ${mode} and status = ${status}`;
  return r.n;
}
/** agent_runs rows the skills engine mirrored from the given skill run (trigger "skill"). Sandbox runs must have none. */
export async function agentRunsForSkillRun(skillRunId: string): Promise<{ id: string; agentId: string; minutesSaved: number }[]> {
  const rows = await conn()<{ id: string; agent_id: string; minutes_saved: string }[]>`select id, agent_id, minutes_saved from agent_runs where trigger = 'skill' and input->>'skillRunId' = ${skillRunId}`;
  return rows.map((r) => ({ id: r.id, agentId: r.agent_id, minutesSaved: Number(r.minutes_saved) }));
}
export async function countWhere(table: "workflows" | "opportunities" | "ai_employees", orgId: string): Promise<number> {
  const [r] = await conn()<{ n: number }[]>`select count(*)::int as n from ${conn()(table)} where org_id = ${orgId}`;
  return r.n;
}
export async function auditCount(orgId: string, action: string, entityId: string): Promise<number> {
  const [r] = await conn()<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${orgId} and action = ${action} and entity_id = ${entityId}`;
  return r.n;
}
export async function brainDocByTitle(orgId: string, title: string): Promise<{ id: string; title: string } | null> {
  const [r] = await conn()<{ id: string; title: string }[]>`select id, title from knowledge_documents where org_id = ${orgId} and title = ${title} order by created_at desc limit 1`;
  return r ?? null;
}
export async function skillRunStatus(id: string): Promise<string | null> {
  const [r] = await conn()<{ status: string }[]>`select status from skill_runs where id = ${id}`;
  return r?.status ?? null;
}
export async function latestSkillRunId(aiEmployeeId: string): Promise<string | null> {
  const [r] = await conn()<{ id: string }[]>`select id from skill_runs where ai_employee_id = ${aiEmployeeId} order by created_at desc limit 1`;
  return r?.id ?? null;
}
