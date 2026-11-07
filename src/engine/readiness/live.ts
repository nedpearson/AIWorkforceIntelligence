/**
 * Live readiness checks, computed at request time with the admin handle. Each returns ok + a short detail; nothing
 * here is cached or hard-coded. Env vars are reported by NAME only.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { verifyAuditChain } from "@/lib/audit";
import { isPlatformOwnerEmail } from "@/lib/mfa-policy";
import type { EvidenceRow, FindingRow, LiveCheck } from "./gates";

export const REQUIRED_ENV = ["DATABASE_URL", "AUTH_SECRET", "AUTH_URL", "NEXT_PUBLIC_APP_URL", "VAULT_KEY", "CRON_SECRET"] as const;
export const CRON_MAX_AGE_HOURS = 26;

async function safe(key: LiveCheck["key"], label: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<LiveCheck> {
  try { return { key, label, ...(await fn()) }; } catch (e) { return { key, label, ok: false, detail: `error: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` }; }
}

export async function runLiveChecks(opts: { origin?: string | null; env?: Record<string, string | undefined> } = {}): Promise<LiveCheck[]> {
  const env = opts.env ?? process.env;
  const out: LiveCheck[] = [];
  out.push(await safe("db_reachable", "Database reachable", async () => { await db.execute(sql`select 1`); return { ok: true, detail: "select 1 succeeded" }; }));
  out.push(await safe("migrations_applied", "Migrations applied", async () => {
    const files = readdirSync(path.join(process.cwd(), "drizzle")).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    const rows = [...(await db.execute<{ name: string }>(sql`select name from __bb_migrations`))].map((r) => r.name);
    const missing = files.filter((f) => !rows.includes(f));
    return { ok: missing.length === 0 && files.length > 0, detail: `${rows.length} applied / ${files.length} migration files${missing.length ? `; missing: ${missing.join(", ")}` : ""}` };
  }));
  out.push(await safe("demo_password_accounts", "Demo accounts with a password = 0", async () => {
    const demoOrgUsers = db.select({ id: schema.memberships.userId }).from(schema.memberships).innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId)).where(eq(schema.organizations.isDemo, true));
    const realOrgUsers = db.select({ id: schema.memberships.userId }).from(schema.memberships).innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId)).where(eq(schema.organizations.isDemo, false));
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users).where(and(sql`${schema.users.passwordHash} is not null`,
      sql`(${schema.users.email} like '%.demo' or (${schema.users.id} in (${demoOrgUsers}) and ${schema.users.id} not in (${realOrgUsers})))`));
    return { ok: Number(r.n) === 0, detail: `${r.n} demo account(s) can sign in with a password` };
  }));
  out.push(await safe("owner_mfa", "Platform owner MFA enabled", async () => {
    const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase();
    if (ownerEmail) {
      const [u] = await db.select({ mfa: schema.users.mfaEnabled }).from(schema.users).where(eq(schema.users.email, ownerEmail)).limit(1);
      if (!u) return { ok: false, detail: "OWNER_EMAIL is set but no such user exists" };
      return { ok: u.mfa, detail: u.mfa ? "OWNER_EMAIL account has MFA" : "OWNER_EMAIL account has NO MFA" };
    }
    const owners = await db.select({ email: schema.users.email, mfa: schema.users.mfaEnabled }).from(schema.memberships).innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId)).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(and(eq(schema.organizations.kind, "consultancy"), eq(schema.memberships.role, "owner")));
    if (!owners.length) return { ok: false, detail: "no consultancy owner found (OWNER_EMAIL not set)" };
    const without = owners.filter((o) => !o.mfa && !isPlatformOwnerEmail(o.email, env)).length;
    return { ok: without === 0, detail: `OWNER_EMAIL not set; ${owners.length - without}/${owners.length} consultancy owner(s) have MFA` };
  }));
  out.push(await safe("env_vars", "Required environment variables present", async () => {
    const missing = REQUIRED_ENV.filter((k) => !env[k]);
    return { ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : `all ${REQUIRED_ENV.length} present (${REQUIRED_ENV.join(", ")})` };
  }));
  out.push(await safe("cron_recent", `Scheduler ran within ${CRON_MAX_AGE_HOURS} h`, async () => {
    const [r] = await db.select({ last: sql<string | null>`max(${schema.jobs.updatedAt})` }).from(schema.jobs).where(and(inArray(schema.jobs.kind, ["retention_sweep", "collector_offline_check"]), eq(schema.jobs.status, "done")));
    if (!r?.last) return { ok: false, detail: "no completed housekeeping job (the /api/jobs/run tick has never completed)" };
    const hours = (Date.now() - new Date(r.last).getTime()) / 3_600_000;
    return { ok: hours <= CRON_MAX_AGE_HOURS, detail: `last completed tick ${hours.toFixed(1)} h ago` };
  }));
  out.push(await safe("rls_enabled", "RLS + tenant policy on every tenant table", async () => {
    const tables = schema.TENANT_TABLES as readonly string[];
    const rows = [...(await db.execute<{ t: string; rls: boolean; pol: boolean }>(sql`select c.relname as t, c.relrowsecurity as rls, exists (select 1 from pg_policies p where p.tablename = c.relname and p.schemaname = n.nspname and p.policyname = 'tenant_isolation') as pol from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = current_schema() and c.relkind = 'r'`))];
    const bad = tables.filter((t) => { const r = rows.find((x) => x.t === t); return !r || !r.rls || !r.pol; });
    return { ok: bad.length === 0, detail: bad.length ? `missing on: ${bad.join(", ")}` : `${tables.length}/${tables.length} tenant tables` };
  }));
  out.push(await safe("audit_chain", "Audit hash chains verify", async () => {
    const orgs = [...(await db.execute<{ org_id: string | null }>(sql`select distinct org_id from audit_log where hash is not null`))].map((r) => r.org_id);
    let checked = 0; const broken: string[] = [];
    for (const o of orgs) { const v = await verifyAuditChain(o); checked += v.checked; if (!v.ok) broken.push(`${o ?? "global"}#${v.firstBreak?.id}`); }
    if (!orgs.length) return { ok: false, detail: "no chained audit rows yet" };
    return { ok: broken.length === 0, detail: broken.length ? `broken: ${broken.join(", ")}` : `${orgs.length} chain(s), ${checked} rows verified` };
  }));
  out.push(await safe("csp_header", "Content-Security-Policy served", async () => {
    if (!opts.origin) return { ok: false, detail: "request origin unknown" };
    const r = await fetch(`${opts.origin}/login`, { redirect: "manual", signal: AbortSignal.timeout(4000), headers: { "user-agent": "bridgebox-readiness" } });
    const csp = r.headers.get("content-security-policy") ?? "";
    const ok = /script-src[^;]*'nonce-/.test(csp) && /frame-ancestors 'none'/.test(csp);
    return { ok, detail: ok ? `GET /login → ${r.status}, nonce-based CSP present` : `GET /login → ${r.status}, CSP ${csp ? "present but weak" : "missing"}` };
  }));
  return out;
}

export async function loadEvidence(): Promise<EvidenceRow[]> {
  try { return await db.select().from(schema.readinessEvidence).orderBy(sql`${schema.readinessEvidence.recordedAt} desc`).limit(500); } catch { return []; }
}
export async function loadFindings(): Promise<(FindingRow & { component: string; summary: string; updatedAt: Date })[] | null> {
  try { return await db.select().from(schema.securityFindings); } catch { return null; }
}
