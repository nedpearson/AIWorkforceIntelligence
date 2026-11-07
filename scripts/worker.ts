/**
 * Self-hosted job worker: `npm run worker`. Polls the jobs table, runs handlers, and enqueues the
 * housekeeping jobs (retention sweep hourly, collector offline check every 5 minutes).
 * Safe to run several instances: claims use FOR UPDATE SKIP LOCKED.
 */
import "dotenv/config";
import { runPending, requeueStale, enqueue, staleMinutes } from "../src/engine/jobs";
import { pg } from "../src/db/client";

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 5000);
let stopping = false;
let lastSweep = 0, lastOffline = 0;

async function loop() {
  console.log(`[worker] started, polling every ${POLL_MS}ms`);
  while (!stopping) {
    try {
      const now = Date.now();
      if (now - lastOffline > 5 * 60_000) { await enqueue("collector_offline_check", {}); lastOffline = now; }
      if (now - lastSweep > 60 * 60_000) { await enqueue("retention_sweep", {}); lastSweep = now; }
      await requeueStale(Math.max(staleMinutes(), 30)); // long analyses run here, not under the 60 s function cap
      const s = await runPending({ limit: 10 });
      if (s.claimed) console.log(`[worker] claimed=${s.claimed} done=${s.done.length} retried=${s.retried.length} failed=${s.failed.length}`);
      if (!s.claimed) await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (e) { console.error("[worker] tick failed", e); await new Promise((r) => setTimeout(r, POLL_MS)); }
  }
  await pg.end({ timeout: 5 });
  console.log("[worker] stopped");
}
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
loop().catch((e) => { console.error(e); process.exit(1); });
