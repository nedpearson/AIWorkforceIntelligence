/**
 * Tiny DB-backed job queue on the `jobs` table.
 *  - enqueue(kind, payload, orgId?, runAfter?)
 *  - runPending({ limit, ids?, budgetMs? }) claims rows with FOR UPDATE SKIP LOCKED (safe across many workers and
 *    concurrent cron/after() kicks), runs the registered handler, retries with exponential backoff up to max_attempts.
 *    Each claim carries a unique lock token; completion only applies while that token still owns the row, so a job
 *    recovered by requeueStale() and re-run elsewhere is never overwritten by a late finisher (idempotent completion).
 *    `budgetMs` stops claiming further jobs once the time budget is used (Vercel Hobby functions stop at 60 s).
 *  - requeueStale(): 'running' rows whose lock is older than JOB_STALE_MINUTES (default 10) go back to 'queued',
 *    or to 'failed' once attempts are exhausted (a job that always times out cannot loop forever).
 *  - registerJob(kind, fn) adds a handler. Built-ins: retention_sweep, collector_offline_check, analysis.
 * Uses the admin db handle on purpose (system code, see CONVENTIONS). Never import server-only here:
 * scripts/worker.ts runs this under tsx.
 */
import { and, eq, lt, sql, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

export type JobRow = typeof schema.jobs.$inferSelect;
export type JobHandler = (payload: Record<string, unknown>, job: JobRow) => Promise<Record<string, unknown> | void>;

const registry = new Map<string, JobHandler>();
export function registerJob(kind: string, fn: JobHandler) { registry.set(kind, fn); }
export function registeredJobKinds(): string[] { return [...registry.keys()]; }

export async function enqueue(kind: string, payload: Record<string, unknown> = {}, orgId?: string | null, runAfter?: Date, opts: { maxAttempts?: number } = {}) {
  const [row] = await db.insert(schema.jobs).values({ kind, payload, orgId: orgId ?? null, runAfter: runAfter ?? new Date(), maxAttempts: opts.maxAttempts ?? 3 }).returning();
  return row;
}

export const backoffMs = (attempt: number) => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
const lockToken = () => `${hostname()}:${process.pid}:${randomBytes(6).toString("hex")}`;

/** Claim up to `limit` due jobs atomically (optionally only `ids`). Returns the claimed rows (status already 'running'). */
async function claim(limit: number, ids?: string[]): Promise<JobRow[]> {
  if (ids && !ids.length) return [];
  return db.transaction(async (tx) => {
    const due = await tx.execute<{ id: string }>(sql`
      select id from jobs where status = 'queued' and run_after <= now()
      ${ids ? sql`and id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``}
      order by run_after asc limit ${limit} for update skip locked`);
    const claimed = [...due].map((r) => r.id);
    if (!claimed.length) return [];
    return tx.update(schema.jobs)
      .set({ status: "running", lockedAt: new Date(), lockedBy: lockToken(), attempts: sql`${schema.jobs.attempts} + 1`, updatedAt: new Date() })
      .where(inArray(schema.jobs.id, claimed)).returning();
  });
}

export type RunSummary = { claimed: number; done: string[]; failed: string[]; retried: string[]; lost: string[]; budgetExhausted: boolean };
/** Run due jobs one claim at a time until `limit` jobs ran or `budgetMs` elapsed. */
export async function runPending({ limit = 10, ids, budgetMs }: { limit?: number; ids?: string[]; budgetMs?: number } = {}): Promise<RunSummary> {
  const started = Date.now();
  const out: RunSummary = { claimed: 0, done: [], failed: [], retried: [], lost: [], budgetExhausted: false };
  while (out.claimed < limit) {
    if (budgetMs !== undefined && Date.now() - started >= budgetMs) { out.budgetExhausted = true; break; }
    const [job] = await claim(1, ids);
    if (!job) break;
    out.claimed++;
    const fn = registry.get(job.kind);
    const owned = and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, "running"), eq(schema.jobs.lockedBy, job.lockedBy!));
    try {
      if (!fn) throw new Error(`no handler registered for job kind "${job.kind}"`);
      const result = (await fn(job.payload ?? {}, job)) ?? {};
      const upd = await db.update(schema.jobs).set({ status: "done", result, error: null, lockedAt: null, lockedBy: null, updatedAt: new Date() }).where(owned).returning({ id: schema.jobs.id });
      (upd.length ? out.done : out.lost).push(job.id);
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}`.slice(0, 4000) : String(e);
      const exhausted = job.attempts >= job.maxAttempts;
      const upd = await db.update(schema.jobs).set({
        status: exhausted ? "failed" : "queued", error: msg, lockedAt: null, lockedBy: null, updatedAt: new Date(),
        runAfter: exhausted ? job.runAfter : new Date(Date.now() + backoffMs(job.attempts)),
      }).where(owned).returning({ id: schema.jobs.id });
      (!upd.length ? out.lost : exhausted ? out.failed : out.retried).push(job.id);
    }
  }
  return out;
}

export const staleMinutes = (env: Record<string, string | undefined> = process.env) => { const n = Number(env.JOB_STALE_MINUTES); return Number.isFinite(n) && n > 0 ? n : 10; };
/** Jobs stuck in 'running' longer than `staleMin` (crashed worker / killed function) → queued, or failed when out of attempts. */
export async function requeueStale(staleMin = staleMinutes()) {
  const cutoff = new Date(Date.now() - staleMin * 60_000);
  const stale = and(eq(schema.jobs.status, "running"), lt(schema.jobs.lockedAt, cutoff));
  const failed = await db.update(schema.jobs).set({ status: "failed", error: sql`coalesce(${schema.jobs.error}, '') || ${`\nstale lock recovered after ${staleMin} min; attempts exhausted`}`, lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(and(stale, sql`${schema.jobs.attempts} >= ${schema.jobs.maxAttempts}`)).returning({ id: schema.jobs.id });
  const r = await db.update(schema.jobs).set({ status: "queued", lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(stale).returning({ id: schema.jobs.id });
  return r.length + failed.length;
}

// ---------- built-in handlers ----------

/** Delete activity_events older than each org's retention_days. payload.orgId limits to one org. */
registerJob("retention_sweep", async (payload) => {
  const orgs = payload.orgId
    ? await db.select({ id: schema.organizations.id, retentionDays: schema.organizations.retentionDays }).from(schema.organizations).where(eq(schema.organizations.id, String(payload.orgId)))
    : await db.select({ id: schema.organizations.id, retentionDays: schema.organizations.retentionDays }).from(schema.organizations);
  const perOrg: Record<string, number> = {};
  for (const o of orgs) {
    const days = Math.max(1, o.retentionDays || 180);
    const cutoff = new Date(Date.now() - days * 86400_000);
    const deleted = await db.delete(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, o.id), lt(schema.activityEvents.ts, cutoff))).returning({ id: schema.activityEvents.id });
    perOrg[o.id] = deleted.length;
    if (deleted.length) await audit({ orgId: o.id, actorType: "system", action: "retention.sweep", entityType: "activity_events", details: { deleted: deleted.length, retentionDays: days, cutoff: cutoff.toISOString() } });
  }
  return { perOrg, total: Object.values(perOrg).reduce((a, b) => a + b, 0) };
});

/** Mark active collectors offline when they have not been seen for 15 minutes. */
registerJob("collector_offline_check", async (payload) => {
  const minutes = Number(payload.minutes ?? 15);
  const cutoff = new Date(Date.now() - minutes * 60_000);
  const rows = await db.update(schema.collectors).set({ status: "offline", updatedAt: new Date() })
    .where(and(eq(schema.collectors.status, "active"), lt(schema.collectors.lastSeenAt, cutoff))).returning({ id: schema.collectors.id, orgId: schema.collectors.orgId });
  for (const r of rows) await audit({ orgId: r.orgId, actorType: "system", action: "collector.offline", entityType: "collector", entityId: r.id, details: { minutes } });
  return { markedOffline: rows.length };
});

/**
 * Workflow analysis — owned by src/engine/analysis.ts (another engineer). Imported lazily so this
 * module (and the worker) load even while that module is absent.
 */
registerJob("analysis", async (payload) => {
  const orgId = String(payload.orgId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error("analysis job requires payload.orgId");
  const campaignId = payload.campaignId ? String(payload.campaignId) : undefined;
  const modName = "analysis";
  let mod: { runAnalysis?: (a: { orgId: string; campaignId?: string }) => Promise<unknown> };
  try { mod = await import(/* @vite-ignore */ `./${modName}`); } catch (e) { throw new Error(`analysis engine not available: ${e instanceof Error ? e.message : String(e)}`); }
  if (typeof mod.runAnalysis !== "function") throw new Error("analysis engine does not export runAnalysis");
  const result = await mod.runAnalysis({ orgId, campaignId });
  return (result && typeof result === "object" ? (result as Record<string, unknown>) : { result }) as Record<string, unknown>;
});
