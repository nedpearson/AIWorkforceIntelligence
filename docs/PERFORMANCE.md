# Performance baseline

Measured 2026-11-07 with `tests/perf/perf.ts` (not part of the default unit / e2e runs). Raw output:
`tests/perf/results-2000x10.json`, `tests/perf/results-2000x20.json`.

## Hardware caveat — read first

- **Sandbox, not production:** 2 vCPU (Intel Xeon @ 2.10 GHz), 7.8 GB RAM (~6 GB usable), Linux 6.18, Node 22.23.
- **Everything on one box:** `next start` (production build, `--max-old-space-size=2048`), PostgreSQL 16.15 (local, default
  configuration, no tuning), the load generator and Chromium (for login) all share the same 2 vCPUs.
- Single run per configuration; no warm-up beyond what is listed. Treat the numbers as an order-of-magnitude baseline and
  a regression reference, not as capacity guarantees.
- **100,000-employee scale is NOT validated.** The largest org tested is 2,000 employees × 20 workdays (2.32 M events).
  The render-latency trend below shows the current request-time aggregation would not hold at that scale.

## Method

1. A synthetic org (`is_demo`, slug `perf-<ts>`) with N employees cycled from the demo templates in
   `src/engine/synthetic.ts`, consent records, one active collector per employee and an org-wide running campaign.
2. Events are generated per employee with `generateEvents()` and sent through the real collector endpoint
   `POST /api/collect/events` in batches of ≤ 5,000 (protocol maximum), 4 concurrent senders. Each batch is validated,
   consent/campaign checked and inserted exactly as for a desktop collector.
3. `runAnalysis({ orgId, campaignId })` is timed in-process.
4. A perf owner logs in through the real login form; then each page is fetched (full server render, HTML body read):
   1 first request, 20 sequential, then 5 concurrent.
5. The org, its events, audit rows, jobs and the perf user are deleted (verified: 0 events left).

Re-run: `PERF_EMPLOYEES=2000 PERF_DAYS=10 npx tsx tests/perf/perf.ts` (server must be running on `PERF_BASE_URL`,
default `http://localhost:3000`, against the same `DATABASE_URL`). `PERF_KEEP=1` keeps the org.

## Results

| Size | Events | Ingest (HTTP) | Batch latency p50 / p95 | `runAnalysis` | Analysis RSS Δ / peak | Total wall time |
| --- | ---: | --- | --- | ---: | --- | ---: |
| 200 emp × 10 days | 116,562 | 8.9 s → **13,100 ev/s** | 156 / 343 ms | 3.2 s | 76 / 328 MB | ~1.3 min |
| 2,000 emp × 10 days | 1,160,003 | 84.9 s → **13,700 ev/s** | 159 / 314 ms | 9.0 s | 453 / 815 MB | 3.4 min |
| 2,000 emp × 20 days | 2,324,070 | 158.7 s → **14,600 ev/s** | 299 / 590 ms | 15.0 s | 1,054 / 1,382 MB | 6.0 min |

No events were dropped in any run. Ingestion throughput is flat with volume (bounded by CPU on this box).

### Server-render latency (ms)

| Route | 200×10: seq p50 / p95 | 2,000×10: seq p50 / p95 · 5-concurrent max | 2,000×20: seq p50 / p95 · 5-concurrent max |
| --- | --- | --- | --- |
| `/app` | 205 / 263 | 1,117 / 1,227 · 5,370 | 1,991 / 2,303 · 9,452 |
| `/app/opportunities` | 189 / 209 | 989 / 1,081 · 2,996 | 1,831 / 1,940 · 4,830 |
| `/app/process-mining` | 248 / 13,516 ¹ | 998 / 1,115 · 3,169 | 1,546 / 1,721 · 4,847 |
| `/app/savings` | 137 / 148 | 988 / 1,102 · 2,437 | 1,864 / 1,923 · 5,116 |

¹ See finding 2.

## Findings

1. **Page renders scale linearly with raw event volume.** p50 grows ~0.8 ms per 1,000 stored events (≈ 1 s at 1.2 M,
   ≈ 2 s at 2.3 M) on every analysed page, and 5 concurrent `/app` renders take ~9.5 s at 2.3 M. Latency tracking raw event volume (rather than the 10 workflows / 8 opportunities the analysis
   persisted) indicates request-time aggregation over activity data. Extrapolating, a 100k-employee org would
   take on the order of minutes per render. Before any large-tenant rollout: serve these pages from the analysis run's
   persisted aggregates (or a materialized/cached per-run summary) and add an org/ts index review for `activity_events`.
2. **Intermittent ~13–17 s first render of `/app/process-mining` on the small (200-employee) org**, reproduced twice; the
   same request then runs in < 1 s, and calling `computeOrgProcessMining()` directly on the kept org took 0.8 s. The
   spikes coincided with Postgres autovacuum / autoanalyze of `activity_events` after the bulk insert/delete of the
   previous run (`pg_stat_user_tables.last_autoanalyze` within the same minute). Likely a stale-statistics plan or
   vacuum contention on a 2-vCPU box; **not confirmed** — re-measure on production-class Postgres before acting.
3. `runAnalysis` holds the window's events in memory: ~1 GB RSS growth at 2.3 M events. Workers analysing much larger
   windows need streaming / chunked aggregation or more memory.
4. The collector endpoint is not the bottleneck at this scale: ~14k events/s on 2 shared vCPUs, i.e. 2,000 collectors
   sending a batch every 5 minutes (~100 events each) would use < 1% of it.
