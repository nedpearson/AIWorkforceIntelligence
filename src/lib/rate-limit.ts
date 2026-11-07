/**
 * Postgres-backed fixed-window rate limiter (table `rate_limits`, migration 0005). Shared by every instance, survives
 * restarts. One atomic upsert per hit: the row lock taken by ON CONFLICT DO UPDATE serialises concurrent callers, so
 * N parallel hits on one key yield counts 1..N exactly. Keys are HMAC-hashed (emails / IPs never stored in clear).
 * The window start is computed by the database clock so instances with skewed clocks agree.
 *
 * Failure policy: if the limiter itself errors (e.g. table missing before migration 0005), the call is allowed and
 * the error is logged — every protected path also needs the same database, so failing closed would add nothing.
 * No `server-only`: imported by route handlers, the auth module and unit tests.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { hmacHash } from "@/lib/crypto";

export type RateLimitRule = { limit: number; windowSec: number };
export type RateLimitResult = { ok: boolean; count: number; limit: number; remaining: number; retryAfterSec: number };

/** Named budgets. Changing a number here changes it everywhere (documented in docs/SECURITY.md §9). */
export const RATE_LIMITS = {
  loginEmailFailures: { limit: 10, windowSec: 15 * 60 },
  loginIp: { limit: 100, windowSec: 15 * 60 },
  mfaFailures: { limit: 5, windowSec: 15 * 60 },
  collectorRequests: { limit: 60, windowSec: 60 },
  collectorEnrollIp: { limit: 20, windowSec: 60 },
  assistantAsk: { limit: 30, windowSec: 60 },
  skillRun: { limit: 20, windowSec: 60 },
  upload: { limit: 20, windowSec: 10 * 60 },
} satisfies Record<string, RateLimitRule>;
export type RateLimitName = keyof typeof RATE_LIMITS;

const keyFor = (bucket: string, id: string) => `${bucket}:${hmacHash(id.toLowerCase())}`;

type Row = { count: number; window_end: Date | string };
function result(rule: RateLimitRule, row: Row | undefined): RateLimitResult {
  const count = Number(row?.count ?? 0);
  const end = row ? new Date(row.window_end).getTime() : Date.now();
  return { ok: count <= rule.limit, count, limit: rule.limit, remaining: Math.max(0, rule.limit - count), retryAfterSec: Math.max(1, Math.ceil((end - Date.now()) / 1000)) };
}

/** Count one hit against `bucket:id` and report whether it is within the budget. */
export async function hit(bucket: RateLimitName | string, id: string, rule: RateLimitRule = RATE_LIMITS[bucket as RateLimitName]): Promise<RateLimitResult> {
  const key = keyFor(bucket, id);
  const w = Math.max(1, Math.floor(rule.windowSec));
  try {
    const rows = await db.execute<Row>(sql`
      insert into rate_limits (key, window_start, hits, expires_at)
      values (${key}, to_timestamp(floor(extract(epoch from now()) / ${w}::int) * ${w}::int), 1, to_timestamp(floor(extract(epoch from now()) / ${w}::int) * ${w}::int + ${w}::int))
      on conflict (key) do update set
        hits = case when rate_limits.window_start = excluded.window_start then rate_limits.hits + 1 else 1 end,
        window_start = excluded.window_start,
        expires_at = excluded.expires_at
      returning hits as count, expires_at as window_end`);
    return result(rule, [...rows][0]);
  } catch (e) {
    console.error("[rate-limit] hit failed; allowing", bucket, e instanceof Error ? e.message : e);
    return { ok: true, count: 0, limit: rule.limit, remaining: rule.limit, retryAfterSec: 0 };
  }
}

/** Read the current window's count without incrementing (used to block before an expensive check, e.g. bcrypt). */
export async function peek(bucket: RateLimitName | string, id: string, rule: RateLimitRule = RATE_LIMITS[bucket as RateLimitName]): Promise<RateLimitResult> {
  const key = keyFor(bucket, id);
  const w = Math.max(1, Math.floor(rule.windowSec));
  try {
    const rows = await db.execute<Row>(sql`
      select hits as count, expires_at as window_end from rate_limits
      where key = ${key} and window_start = to_timestamp(floor(extract(epoch from now()) / ${w}::int) * ${w}::int)`);
    const row = [...rows][0];
    // A peek is "ok" while the budget is not yet used up (the next failure would be number count+1).
    const r = result(rule, row);
    return { ...r, ok: r.count < rule.limit };
  } catch (e) {
    console.error("[rate-limit] peek failed; allowing", bucket, e instanceof Error ? e.message : e);
    return { ok: true, count: 0, limit: rule.limit, remaining: rule.limit, retryAfterSec: 0 };
  }
}

/** Drop expired windows (called from the scheduler tick). */
export async function sweepRateLimits(): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`with d as (delete from rate_limits where expires_at < now() - interval '1 minute' returning 1) select count(*)::int as n from d`);
  return Number([...r][0]?.n ?? 0);
}

/** Test hook: forget every window for a bucket prefix (or all). */
export async function _resetRateLimitsFor(bucketPrefix?: string) {
  if (bucketPrefix) await db.execute(sql`delete from rate_limits where key like ${bucketPrefix + ":%"}`);
  else await db.execute(sql`delete from rate_limits`);
}

export function tooManyRequests(r: RateLimitResult, extra: Record<string, unknown> = {}) {
  return Response.json({ error: "rate_limited", retryAfterSec: r.retryAfterSec, ...extra }, { status: 429, headers: { "retry-after": String(r.retryAfterSec) } });
}

/** Client IP for limiter keys. On Vercel `x-forwarded-for` is set by the platform; behind another proxy configure it to overwrite the header. */
export function requestIp(req: { headers: Headers } | Request | undefined | null): string {
  const h = req?.headers;
  if (!h || typeof h.get !== "function") return "0.0.0.0";
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "0.0.0.0";
}
