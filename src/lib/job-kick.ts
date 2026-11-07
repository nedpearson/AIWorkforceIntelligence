/**
 * Start a just-enqueued job right after the current response is sent (next/server `after()`), so analysis does not
 * wait for the once-a-day Vercel Hobby cron. The daily cron remains the sweeper for anything a kick missed (function
 * killed, instance recycled): the job row stays 'queued' until a runner claims it with FOR UPDATE SKIP LOCKED, so a
 * kick and the cron can never run the same job twice.
 * JOBS_KICK_ON_ENQUEUE=0 disables kicks (the e2e suite sets it: its 20-event campaign would otherwise re-analyse the
 * shared demo org mid-suite). The page hosting the server action must allow `maxDuration = 60`.
 */
import { after } from "next/server";
import { runPending } from "@/engine/jobs";

export const KICK_BUDGET_MS = 50_000;
export function kickEnabled(env: Record<string, string | undefined> = process.env) { return env.JOBS_KICK_ON_ENQUEUE !== "0"; }

export function startJobSoon(jobId: string): boolean {
  if (!kickEnabled()) return false;
  try {
    after(async () => {
      try { await runPending({ ids: [jobId], limit: 1, budgetMs: KICK_BUDGET_MS }); }
      catch (e) { console.error("[jobs] immediate run failed; the scheduler will retry", jobId, e); }
    });
    return true;
  } catch (e) {
    // Outside a request scope (scripts/tests): leave it to the worker/cron.
    console.warn("[jobs] after() unavailable; job left for the scheduler", jobId, e instanceof Error ? e.message : e);
    return false;
  }
}
