# Collector, ingestion pipeline and jobs

## Architecture

```
employee computer                        BridgeBox server (Next.js)                      Postgres
┌───────────────────────────┐            ┌──────────────────────────────────────┐        ┌──────────────────┐
│ collector/ (Node 20, TS)  │  Bearer    │ /api/collect/enroll   (code → token) │        │ collectors       │
│  sampler.ts  active-win   │ ────────▶  │ /api/collect/consent  (ack notice)   │ ─────▶ │ consent_records  │
│  normalize.ts title→cat   │  JSON      │ /api/collect/events   (batch ingest) │        │ activity_events  │
│  queue.ts    disk JSONL   │            │ /api/collect/heartbeat / config      │        │ audit_log        │
│  tray.ts     pause/resume │            │ /api/collect/pause    (employee)     │        │ jobs             │
└───────────────────────────┘            │ src/app/api/collect/_lib.ts (auth,   │        └──────────────────┘
                                         │   rate limit, consent, campaigns)    │              ▲
                                         └──────────────────────────────────────┘              │
                              scheduler  ┌──────────────────────────────────────┐              │
                              (cron or   │ /api/jobs/run  (x-cron-secret)       │ ─────────────┘
                              worker)    │ src/engine/jobs.ts: retention_sweep, │
                                         │   collector_offline_check, analysis  │
                                         └──────────────────────────────────────┘
```

**Wire protocol**: `src/collector-protocol/schema.ts` (zod; shared verbatim by the collector through a relative import). `schedule.ts` next to it is the timezone-aware window check used by both sides.

**Three gates, all enforced server-side** (the collector also filters, but is never trusted):
1. *Authorization* — an owner/officer record in `authorizations` is required before a campaign can be started (`setCampaignStatus`).
2. *Notice & consent* — events are dropped unless the employee's latest `consent_records` row for the current notice version has `acknowledged_at` and no `withdrawn_at`.
3. *Campaign window* — each event's timestamp must fall inside a `running` campaign that includes the employee (by id, department, or org-wide) **and** inside that campaign's daily schedule in the org's timezone.

Then: blocked apps dropped (defaults + collector config + campaign config), `titleMode` applied (`hash` keeps category+hash, `category` drops the hash, `none` drops both), one multi-row insert inside `withTenant(orgId)`, collector counters updated. Response: `{ accepted, dropped, reasons }`.

**Auth**: `Authorization: Bearer <token>`, looked up by `sha256(token)` in `collectors.token_hash` through the admin db handle (the one sanctioned use), then everything is scoped to that collector's `orgId`. The body's `collectorId` must equal the authenticated collector (403 otherwise) — a token from org A can never write into org B (tested). In-memory rate limit 60 req/min per collector (20/min per IP for enroll). 401 bad token, 403 revoked/mismatch, 413 >5000 events or >2 MB, 429 rate limit.

**Jobs** (`src/engine/jobs.ts`): claims with `SELECT … FOR UPDATE SKIP LOCKED`, exponential backoff (30 s · 2^n, cap 1 h), `max_attempts` default 3, stale `running` rows re-queued after 30 min. Built-ins: `retention_sweep` (deletes `activity_events` older than `organizations.retention_days`, audits the count per org), `collector_offline_check` (active → offline when `last_seen_at` > 15 min; a heartbeat flips it back), `analysis` (lazy-imports `src/engine/analysis.ts` and calls `runAnalysis({orgId, campaignId})`; fails cleanly if the module is absent). Tick it with `POST /api/jobs/run` + header `x-cron-secret: $CRON_SECRET` (Vercel Cron's `Authorization: Bearer` is also accepted; each tick also enqueues housekeeping if none is pending), or run `npm run worker` for self-hosted.

Suggested `vercel.json`: `{ "crons": [{ "path": "/api/jobs/run", "schedule": "*/5 * * * *" }] }` with `CRON_SECRET` set in the project env.

## Privacy guarantees

| Guarantee | Where it is enforced |
|---|---|
| No keystrokes, clipboard, screenshots, URLs, titles, file names, message content | Collector has no input hooks and ignores `active-win`'s `url`; `normalize.ts` is the only place a raw title exists and it emits only `{titleCategory, titleHash}`; `MetaSchema` rejects any meta key containing `key`, `text`, `title`, `url`, `content`, `clipboard`, `password`, `screenshot`, `body`, `message`, `subject`, `filename`, `path` (except the count `keysCount`); values are limited to numbers / 64-char strings / booleans. |
| Blocked apps are never sampled | Collector: `isBlocked()` before normalisation. Server: dropped again with reason `blocked_app`. Defaults in `DEFAULT_BLOCKED_APPS`. |
| Nothing outside a campaign's schedule | Collector sleeps outside the window; server drops `outside_campaign_window` / `no_active_campaign`. |
| Employee control | `pause` command / signals / Trust page → `collectors.paused_until` or status `paused` (server drops `collector_paused`); *Withdraw consent* on the Trust page writes `consent_records.withdrawn_at` and pauses the employee's collectors (`consent-lib.ts`). All audited. |
| Retention | `retention_sweep` job honours `organizations.retention_days`; the Trust page shows the number. |
| Hashes are not reversible | `titleHash = HMAC-SHA256(normalised title, per-machine random salt)[:24]`; the salt never leaves the machine. Hostname stored as `hmacHash(hostname)`. |
| Tenancy | Inserts and page reads run inside `withTenant`; RLS on `activity_events` et al.; token lookup is the only admin-handle use in the ingest path. |

## Admin & employee UI

- `/app/collection` (`collectors:manage` / `campaigns:manage`): tabs Authorization, Notice & consent, Collectors (health tiles, enrollment-code modal with install commands, pause/resume/revoke), Campaigns (create/edit modal with dates, departments/people, schedule, title mode, extra blocked apps; start/pause/complete; *Run analysis now* enqueues the `analysis` job and shows the latest `analysis_runs` / job state). All server actions in `actions.ts` are zod-validated, permission-checked, tenant-scoped and audited.
- `/app/trust` (any role): what is collected / never collected, role visibility matrix generated from `PERMISSIONS`, retention days, the current notice, the signed-in employee's own consent record and collectors with **Withdraw consent & pause**, **Pause 1 hour / until I resume**, **Resume**, and re-acknowledge.

## Testing status — be honest

Tested on Linux (`tests/unit/collect-api.test.ts`, 25 tests against a real Postgres `bridgebox_c`): enroll (+ code reuse rejected, audit), 401 bad token, 413 oversize, 400 content-bearing meta, consent gate, consent ack + outdated version 409, config, event ingest with blocked/out-of-window/future drops and collector counters, heartbeat, employee pause/resume + audit, consent withdrawn, revoked 403, Trust-page withdraw path, titleMode `none` and `category`, cross-org isolation, retention sweep (+ audit), offline check + heartbeat recovery, job retry/backoff/failure, cron endpoint auth. Also verified manually: `collector --simulate` enrolls, records consent, samples the synthetic day (blocked apps absent from output), batches, honours `pause`/`resume`/`status` commands, shuts down gracefully; `/api/jobs/run` tick in the real Next runtime; both pages render for a signed-in owner.

**Not tested here (no Windows/macOS desktop in CI):**
- `active-win` foreground sampling on real Windows/macOS, including the macOS Screen Recording permission flow and the Windows helper binary. The code path is `RealForeground` in `collector/src/sampler.ts`; it is loaded lazily and fails with an explicit message if the module is missing. Treat the app-name map (`normalize.ts`) as a starting point that needs tuning against real process names.
- `desktop-idle` (optional) — never installed here; the fallback heuristic is what ran.
- `@yao-pkg/pkg` single-binary packaging (documented, not installed).
- The Intune / Jamf / GPO scripts in `collector/README.md` are samples, not validated against a tenant.
- The `analysis` job end-to-end (engine owned elsewhere); only enqueueing is tested.
- The in-memory rate limiter is per process; multi-instance deployments need an edge limiter.
