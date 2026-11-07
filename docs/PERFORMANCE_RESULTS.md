# Performance results

**Source of every number here: `docs/PERFORMANCE.md`** (measured 2026-11-07 with `tests/perf/perf.ts`, raw output in
`tests/perf/results-2000x10.json` and `results-2000x20.json`). This security pass did **not** re-run the performance
harness; the readiness gate `performance` stays *Not verified* until targets are agreed and met.

## What was measured (sandbox: 2 vCPU, ~6 GB usable RAM, app + Postgres + load generator on one box)

| Size | Events | Ingest throughput | `runAnalysis` | `/app` render p50 / p95 (sequential) | `/app` 5-concurrent max |
|---|---:|---:|---:|---|---:|
| 200 employees × 10 days | 116,562 | 13,100 ev/s | 3.2 s | 205 / 263 ms | — |
| 2,000 × 10 days | 1,160,003 | 13,700 ev/s | 9.0 s | 1,117 / 1,227 ms | 5,370 ms |
| 2,000 × 20 days | 2,324,070 | 14,600 ev/s | 15.0 s | 1,991 / 2,303 ms | 9,452 ms |

No events were dropped in any run.

## Targets — honest status

| Target | Status |
|---|---|
| Collector ingest keeps up with a 2,000-employee org | Met in the sandbox (≈ 14k events/s vs. what 2,000 collectors send) |
| Analysis of a 2,000-employee × 20-day campaign inside one Vercel function (≤ 60 s) | Met in the sandbox (15 s), not measured on Vercel |
| Dashboard pages < 1 s p95 at 2,000 employees | **Not met** (1.1–2.3 s p50 at 1.2–2.3 M events; PERFORMANCE.md finding 1: renders scale with raw event volume) |
| 100,000 employees | **Untested. No claim is made.** PERFORMANCE.md extrapolates minutes per render at that scale with the current request-time aggregation |
| Production (Vercel + Neon) latency | **Untested** |

## Effect of this branch on performance (reasoned, not measured)

- `getCtx()` now joins `users` into its existing membership query (one query, same round trip).
- Each `audit()` is a small transaction with an advisory lock + one indexed lookup (`audit_org_id`); high-frequency
  writers to one org's chain serialise. The ingest hot path (`/api/collect/events`) does not audit per batch.
- Every collector request does one rate-limit upsert (`rate_limits` primary key).
- Pages are now always dynamically rendered (per-request CSP nonce); they already were for every authenticated page.

## To pass the gate

Agree numeric targets, run `PERF_EMPLOYEES=… PERF_DAYS=… npx tsx tests/perf/perf.ts` against the RC build (ideally
on Vercel + Neon), and record with `npm run readiness:record -- --gate performance …`.
