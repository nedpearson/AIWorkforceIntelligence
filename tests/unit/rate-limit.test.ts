/** Postgres fixed-window limiter (src/lib/rate-limit.ts): counting, windows, peek, atomicity under concurrency, sweep. */
import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, pg } from "@/db/client";
import { hit, peek, sweepRateLimits, _resetRateLimitsFor } from "@/lib/rate-limit";
import { randomToken } from "@/lib/crypto";

const B = `t${randomToken(4).replace(/[^a-z0-9]/gi, "")}`;
afterAll(async () => { await _resetRateLimitsFor(B); await pg.end({ timeout: 5 }); });

describe("rate limiter", () => {
  it("counts hits within a window and refuses past the limit", async () => {
    const rule = { limit: 3, windowSec: 600 };
    const r = [];
    for (let i = 0; i < 5; i++) r.push(await hit(B, "alice", rule));
    expect(r.map((x) => x.count)).toEqual([1, 2, 3, 4, 5]);
    expect(r.map((x) => x.ok)).toEqual([true, true, true, false, false]);
    expect(r[4].retryAfterSec).toBeGreaterThan(0);
    expect((await hit(B, "bob", rule)).count).toBe(1); // keys are independent
  });
  it("stores only HMAC-hashed keys (no emails/IPs in clear)", async () => {
    await hit(B, "someone@example.com", { limit: 1, windowSec: 60 });
    const rows = [...(await db.execute<{ key: string }>(sql`select key from rate_limits where key like ${B + ":%"}`))];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => /^[^:]+:[0-9a-f]{32}$/.test(x.key) && !x.key.includes("@"))).toBe(true);
  });
  it("peek reads without incrementing", async () => {
    const rule = { limit: 2, windowSec: 600 };
    expect((await peek(B, "carol", rule)).ok).toBe(true);
    await hit(B, "carol", rule); await hit(B, "carol", rule);
    const p = await peek(B, "carol", rule);
    expect(p.count).toBe(2); expect(p.ok).toBe(false);
    expect((await peek(B, "carol", rule)).count).toBe(2);
  });
  it("a new window resets the count", async () => {
    const rule = { limit: 1, windowSec: 1 };
    await hit(B, "dave", rule);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await hit(B, "dave", rule)).count).toBe(1);
  });
  it("is atomic under concurrency: 50 parallel hits → counts 1..50, exactly `limit` allowed", async () => {
    const rule = { limit: 20, windowSec: 600 };
    const res = await Promise.all(Array.from({ length: 50 }, () => hit(B, "concurrent", rule)));
    expect(res.map((x) => x.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(res.filter((x) => x.ok).length).toBe(20);
  });
  it("sweep removes expired windows only", async () => {
    await db.execute(sql`insert into rate_limits (key, window_start, hits, expires_at) values (${B + ":expired"}, now() - interval '2 hours', 3, now() - interval '1 hour') on conflict (key) do nothing`);
    const n = await sweepRateLimits();
    expect(n).toBeGreaterThanOrEqual(1);
    const left = [...(await db.execute<{ key: string }>(sql`select key from rate_limits where key = ${B + ":expired"}`))];
    expect(left.length).toBe(0);
    expect((await peek(B, "concurrent", { limit: 20, windowSec: 600 })).count).toBe(50);
  });
});
