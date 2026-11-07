import { NextRequest } from "next/server";
import { safeEqual } from "@/lib/crypto";
import { runMigrations } from "@/engine/migrate";
import { seedDemo } from "@/engine/seed";
import { audit } from "@/lib/audit";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * One-time production bootstrap. Protected by CRON_SECRET (header x-cron-secret or Bearer).
 *   POST /api/admin/bootstrap?step=migrate   → apply schema + RLS (idempotent)
 *   POST /api/admin/bootstrap?step=seed      → seed synthetic demo orgs (idempotent; analysis enqueued or run inline with &inline=1)
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret) return Response.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  if (!given || !safeEqual(given, secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!process.env.DATABASE_URL) return Response.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  const step = req.nextUrl.searchParams.get("step") ?? "migrate";
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  try {
    if (step === "migrate") { const r = await runMigrations({ log }); await audit({ actorType: "system", action: "bootstrap.migrate", details: r }); return Response.json({ ok: true, ...r, logs }); }
    if (step === "seed") {
      const days = Number(req.nextUrl.searchParams.get("days") ?? 20);
      const inline = req.nextUrl.searchParams.get("inline") === "1";
      const r = await seedDemo({ days, log, runAnalysisNow: inline });
      await audit({ actorType: "system", action: "bootstrap.seed", details: { skipped: r.skipped, events: r.events ?? 0 } });
      return Response.json({ ok: true, ...r, logs });
    }
    return Response.json({ error: "unknown step" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e), logs }, { status: 500 });
  }
}
