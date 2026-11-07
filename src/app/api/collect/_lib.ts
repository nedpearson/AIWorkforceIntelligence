/**
 * Shared helpers for the collector ingest routes (/api/collect/*).
 * - Bearer-token auth against collectors.token_hash via the ADMIN db handle (the only permitted use
 *   of the admin handle here); every subsequent query is scoped to that collector's orgId.
 * - Per-collector rate limit (60 req/min) in the shared Postgres limiter (src/lib/rate-limit.ts): holds across
 *   instances and restarts.
 */
import { eq, desc, and } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { sha256 } from "@/lib/crypto";
import { hit, _resetRateLimitsFor, requestIp } from "@/lib/rate-limit";
import { DEFAULT_BLOCKED_APPS, DEFAULT_NOTICE_TEXT, DEFAULT_NOTICE_VERSION } from "@/collector-protocol/schema";

export type CollectorRow = typeof schema.collectors.$inferSelect;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const RATE_LIMIT_PER_MIN = 60;

/** Returns true when the caller is within its budget. Keyed by collector id (or ip for enroll). Postgres-backed. */
export async function rateLimitOk(key: string, limit = RATE_LIMIT_PER_MIN): Promise<boolean> {
  return (await hit("collect", key, { limit, windowSec: 60 })).ok;
}
/** Test hook. */
export async function _resetRateLimits() { await _resetRateLimitsFor("collect"); }

export const json = (body: unknown, status = 200) => Response.json(body, { status });
export const err = (status: number, error: string, extra: Record<string, unknown> = {}) => Response.json({ error, ...extra }, { status });

export function clientIp(req: Request): string { return requestIp(req); }

/** Parse + validate a JSON body with size guard. Returns a Response on failure. */
export async function readJson<T>(req: Request, s: z.ZodType<T>): Promise<T | Response> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return err(413, "payload_too_large", { maxBytes: MAX_BODY_BYTES });
  let text: string;
  try { text = await req.text(); } catch { return err(400, "unreadable_body"); }
  if (text.length > MAX_BODY_BYTES) return err(413, "payload_too_large", { maxBytes: MAX_BODY_BYTES });
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return err(400, "invalid_json"); }
  const r = s.safeParse(raw);
  if (!r.success) {
    const tooBig = r.error.issues.some((i) => i.code === "too_big" && i.path[0] === "events");
    return err(tooBig ? 413 : 400, tooBig ? "batch_too_large" : "invalid_request", { issues: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  return r.data;
}

/**
 * Authenticate a collector by bearer token. Returns the collector row (any status) or a Response.
 * Callers decide what to do with paused/revoked collectors so the client gets a precise reason.
 */
export async function authCollector(req: Request, opts: { allowRevoked?: boolean } = {}): Promise<CollectorRow | Response> {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || m[1].length < 16 || m[1].length > 256) return err(401, "missing_or_malformed_token");
  const tokenHash = sha256(m[1].trim());
  const [c] = await db.select().from(schema.collectors).where(eq(schema.collectors.tokenHash, tokenHash)).limit(1);
  if (!c) return err(401, "invalid_token");
  if (!(await rateLimitOk(c.id))) return err(429, "rate_limited", { retryAfterSec: 60 });
  if (c.status === "revoked" && !opts.allowRevoked) return err(403, "collector_revoked");
  if (c.status === "pending") return err(403, "collector_not_enrolled");
  return c;
}

export function isPaused(c: Pick<CollectorRow, "status" | "pausedUntil">): boolean {
  if (c.status === "paused" && (!c.pausedUntil || c.pausedUntil.getTime() > Date.now())) return true;
  return !!c.pausedUntil && c.pausedUntil.getTime() > Date.now();
}

export type OrgNotice = { version: string; text: string };
export type OrgSettingsExt = (typeof schema.organizations.$inferSelect)["settings"] & { noticeText?: string; noticeVersion?: string };
export function noticeFromSettings(settings: unknown): OrgNotice {
  const s = (settings ?? {}) as OrgSettingsExt;
  return { version: s?.noticeVersion || DEFAULT_NOTICE_VERSION, text: s?.noticeText || DEFAULT_NOTICE_TEXT };
}

export function effectiveConfig(c: Pick<CollectorRow, "config">, campaignCfg?: schema.CollectorConfig | null) {
  const base = c.config ?? {};
  const blocked = new Set<string>([...DEFAULT_BLOCKED_APPS, ...(base.blockedApps ?? []), ...(campaignCfg?.blockedApps ?? [])].map((s) => s.toLowerCase()));
  return {
    sampleIntervalMs: campaignCfg?.sampleIntervalMs ?? base.sampleIntervalMs ?? 2000,
    batchIntervalMs: campaignCfg?.batchIntervalMs ?? base.batchIntervalMs ?? 30_000,
    idleThresholdSec: campaignCfg?.idleThresholdSec ?? base.idleThresholdSec ?? 180,
    schedule: campaignCfg?.schedule ?? base.schedule,
    blockedApps: [...blocked],
    titleMode: (campaignCfg?.titleMode ?? base.titleMode ?? "hash") as "hash" | "category" | "none",
  };
}

/**
 * Consent state for an employee, evaluated with the admin handle inside the collector's org.
 * With `currentNoticeVersion`, an acknowledgement of an OLDER notice version is "outdated": ingest refuses it until
 * the employee acknowledges the current notice (docs/SECURITY.md §13, closed in 0005 work).
 */
export async function consentState(orgId: string, employeeId: string | null, currentNoticeVersion?: string): Promise<"acknowledged" | "withdrawn" | "missing" | "outdated"> {
  if (!employeeId) return "missing";
  const rows = await db.select().from(schema.consentRecords)
    .where(and(eq(schema.consentRecords.orgId, orgId), eq(schema.consentRecords.employeeId, employeeId)))
    .orderBy(desc(schema.consentRecords.createdAt)).limit(50);
  const r = rows[0];
  if (!r) return "missing";
  if (r.withdrawnAt) return "withdrawn";
  if (currentNoticeVersion === undefined) return r.acknowledgedAt ? "acknowledged" : "missing";
  if (rows.some((x) => x.noticeVersion === currentNoticeVersion && x.acknowledgedAt && !x.withdrawnAt)) return "acknowledged";
  return rows.some((x) => x.acknowledgedAt && !x.withdrawnAt) ? "outdated" : "missing";
}

/** Campaigns in the org that currently include this employee (running or scheduled with a window). */
export async function campaignsForEmployee(orgId: string, employeeId: string | null) {
  if (!employeeId) return [];
  const [emp] = await db.select({ departmentId: schema.employees.departmentId }).from(schema.employees).where(and(eq(schema.employees.id, employeeId), eq(schema.employees.orgId, orgId))).limit(1);
  const rows = await db.select().from(schema.observationCampaigns).where(eq(schema.observationCampaigns.orgId, orgId));
  return rows.filter((c) => {
    if (!["running", "scheduled"].includes(c.status)) return false;
    const emps = c.employeeIds ?? [], depts = c.departmentIds ?? [];
    if (!emps.length && !depts.length) return true; // org-wide campaign
    return emps.includes(employeeId) || (!!emp?.departmentId && depts.includes(emp.departmentId));
  });
}
