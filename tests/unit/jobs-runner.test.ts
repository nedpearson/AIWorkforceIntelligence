/** Job runner hardening (task 9): targeted claims for after() kicks, no double execution under concurrency,
 *  lock-token-guarded completion, stale-lock recovery with max attempts, time budget. */
import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { db, schema, pg } from "@/db/client";
import { enqueue, registerJob, runPending, requeueStale } from "@/engine/jobs";
import { randomToken } from "@/lib/crypto";

const K = `test_${randomToken(4).replace(/[^a-z0-9]/gi, "")}`;
const runs = new Map<string, number>();
registerJob(`${K}_count`, async (_p, job) => { runs.set(job.id, (runs.get(job.id) ?? 0) + 1); await new Promise((r) => setTimeout(r, 30)); return { ok: true }; });
registerJob(`${K}_slow`, async () => { await new Promise((r) => setTimeout(r, 300)); return {}; });
let release: (() => void) | null = null;
registerJob(`${K}_hold`, () => new Promise((r) => { release = () => r({ held: true }); }));

afterAll(async () => { await db.delete(schema.jobs).where(like(schema.jobs.kind, `${K}%`)); await pg.end({ timeout: 5 }); });
const row = async (id: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0];

describe("job runner", () => {
  it("runPending({ ids }) runs exactly the kicked job and leaves others queued", async () => {
    const a = await enqueue(`${K}_count`), b = await enqueue(`${K}_count`);
    const s = await runPending({ ids: [a.id], limit: 5 });
    expect(s.done).toEqual([a.id]);
    expect((await row(b.id)).status).toBe("queued");
    await runPending({ ids: [b.id] });
  });
  it("concurrent runners (cron tick + after() kicks) never execute a job twice", async () => {
    const jobs = await Promise.all(Array.from({ length: 8 }, () => enqueue(`${K}_count`)));
    const ids = jobs.map((j) => j.id);
    await Promise.all([runPending({ ids, limit: 8 }), runPending({ ids, limit: 8 }), runPending({ ids, limit: 8 }), ...ids.map((id) => runPending({ ids: [id], limit: 1 }))]);
    for (const id of ids) expect(runs.get(id)).toBe(1);
    const rows = await db.select().from(schema.jobs).where(inArray(schema.jobs.id, ids));
    expect(rows.every((r) => r.status === "done" && r.attempts === 1 && r.lockedBy === null)).toBe(true);
  });
  it("a finisher whose lock was recovered by requeueStale() does not overwrite the new owner (idempotent completion)", async () => {
    const j = await enqueue(`${K}_hold`);
    const p = runPending({ ids: [j.id], limit: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect((await row(j.id)).status).toBe("running");
    await db.update(schema.jobs).set({ lockedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.jobs.id, j.id));
    expect(await requeueStale(10)).toBeGreaterThanOrEqual(1);
    expect((await row(j.id)).status).toBe("queued");
    release!();
    const s = await p;
    expect(s.lost).toEqual([j.id]);
    expect((await row(j.id)).status).toBe("queued"); // still owned by the sweeper; runs once more later
    release = null;
    const again = runPending({ ids: [j.id], limit: 1 }); await new Promise((r) => setTimeout(r, 100)); release!(); expect((await again).done).toEqual([j.id]);
  });
  it("stale recovery marks a job failed once its attempts are exhausted (no infinite timeout loop)", async () => {
    const j = await enqueue(`${K}_count`, {}, null, new Date(), { maxAttempts: 2 });
    await db.update(schema.jobs).set({ status: "running", attempts: 2, lockedAt: new Date(Date.now() - 60 * 60_000), lockedBy: "dead-worker" }).where(eq(schema.jobs.id, j.id));
    await requeueStale(10);
    const r = await row(j.id);
    expect(r.status).toBe("failed"); expect(r.error).toMatch(/stale lock recovered/);
    const fresh = await enqueue(`${K}_count`);
    await db.update(schema.jobs).set({ status: "running", attempts: 1, lockedAt: new Date(Date.now() - 2 * 60_000), lockedBy: "busy" }).where(eq(schema.jobs.id, fresh.id));
    await requeueStale(10);
    expect((await row(fresh.id)).status).toBe("running"); // not stale yet
    await db.update(schema.jobs).set({ status: "done" }).where(eq(schema.jobs.id, fresh.id));
  });
  it("stops claiming new jobs when the time budget is used (Vercel 60 s cap)", async () => {
    const jobs = await Promise.all(Array.from({ length: 4 }, () => enqueue(`${K}_slow`)));
    const s = await runPending({ ids: jobs.map((j) => j.id), limit: 10, budgetMs: 350 });
    expect(s.budgetExhausted).toBe(true);
    expect(s.claimed).toBeGreaterThanOrEqual(1); expect(s.claimed).toBeLessThan(4);
    await runPending({ ids: jobs.map((j) => j.id), limit: 10 });
  });
});
