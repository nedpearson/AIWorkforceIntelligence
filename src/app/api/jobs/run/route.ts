/**
 * Scheduler tick: runs due jobs. Protect with CRON_SECRET.
 *   POST/GET /api/jobs/run  with header  x-cron-secret: <CRON_SECRET>  (or Authorization: Bearer <CRON_SECRET>, which Vercel Cron sends)
 * Also enqueues the housekeeping jobs (retention sweep, offline check) if none is queued/running.
 */
import { and, inArray, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { safeEqual } from "@/lib/crypto";
import { runPending, requeueStale, enqueue } from "@/engine/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = req.headers.get("x-cron-secret") ?? /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  return !!h && safeEqual(h, secret);
}

async function ensureHousekeeping() {
  for (const kind of ["retention_sweep", "collector_offline_check"]) {
    const [open] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.kind, kind), inArray(schema.jobs.status, ["queued", "running"]))).limit(1);
    if (!open) await enqueue(kind, {}, null, new Date());
  }
}

async function tick(req: Request) {
  if (!process.env.CRON_SECRET) return Response.json({ error: "not_configured", hint: "Set CRON_SECRET in the environment to enable the scheduler endpoint." }, { status: 503 });
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 10)));
  const stale = await requeueStale();
  if (url.searchParams.get("housekeeping") !== "0") await ensureHousekeeping();
  const summary = await runPending({ limit });
  return Response.json({ ok: true, requeuedStale: stale, ...summary });
}
export async function POST(req: Request) { return tick(req); }
export async function GET(req: Request) { return tick(req); }
