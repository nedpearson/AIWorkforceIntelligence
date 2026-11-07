/**
 * Tiny DB-backed job queue on the `jobs` table.
 *  - enqueue(kind, payload, orgId?, runAfter?)
 *  - runPending({ limit }) claims rows with FOR UPDATE SKIP LOCKED (safe across many workers),
 *    runs the registered handler, retries with exponential backoff up to max_attempts.
 *  - registerJob(kind, fn) adds a handler. Built-ins: retention_sweep, collector_offline_check, analysis.
 * Uses the admin db handle on purpose (system code, see CONVENTIONS). Never import server-only here:
 * scripts/worker.ts runs this under tsx.
 */
import { and, eq, lt, sql, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { hostname } from "node:os";

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
const workerId = () => `${hostname()}:${process.pid}`;

/** Claim up to `limit` due jobs atomically. Returns the claimed rows (status already 'running'). */
async function claim(limit: number): Promise<JobRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx.execute<{ id: string }>(sql`
      select id from jobs where status = 'queued' and run_after <= now()
      order by run_after asc limit ${limit} for update skip locked`);
    const ids = [...due].map((r) => r.id);
    if (!ids.length) return [];
    return tx.update(schema.jobs)
      .set({ status: "running", lockedAt: new Date(), lockedBy: workerId(), attempts: sql`${schema.jobs.attempts} + 1`, updatedAt: new Date() })
      .where(inArray(schema.jobs.id, ids)).returning();
  });
}

export type RunSummary = { claimed: number; done: string[]; failed: string[]; retried: string[] };
export async function runPending({ limit = 10 }: { limit?: number } = {}): Promise<RunSummary> {
  const jobsClaimed = await claim(limit);
  const out: RunSummary = { claimed: jobsClaimed.length, done: [], failed: [], retried: [] };
  for (const job of jobsClaimed) {
    const fn = registry.get(job.kind);
    try {
      if (!fn) throw new Error(`no handler registered for job kind "${job.kind}"`);
      const result = (await fn(job.payload ?? {}, job)) ?? {};
      await db.update(schema.jobs).set({ status: "done", result, error: null, lockedAt: null, lockedBy: null, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
      out.done.push(job.id);
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}`.slice(0, 4000) : String(e);
      const exhausted = job.attempts >= job.maxAttempts;
      await db.update(schema.jobs).set({
        status: exhausted ? "failed" : "queued", error: msg, lockedAt: null, lockedBy: null, updatedAt: new Date(),
        runAfter: exhausted ? job.runAfter : new Date(Date.now() + backoffMs(job.attempts)),
      }).where(eq(schema.jobs.id, job.id));
      (exhausted ? out.failed : out.retried).push(job.id);
    }
  }
  return out;
}

/** Jobs stuck in 'running' for longer than `staleMin` (crashed worker) go back to queued. */
export async function requeueStale(staleMin = 30) {
  const r = await db.update(schema.jobs).set({ status: "queued", lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(and(eq(schema.jobs.status, "running"), lt(schema.jobs.lockedAt, new Date(Date.now() - staleMin * 60_000)))).returning({ id: schema.jobs.id });
  return r.length;
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
