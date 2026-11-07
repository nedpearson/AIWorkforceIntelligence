# Launch certification

**Release candidate:** branch `fix/security-readiness`, code commit `24fa22e773fbd9e0931cdb03d3c76ccd9821920f`
(the following commit only adds evidence to docs). **Not deployed.** Production (`bridgebox-aiwi`,
https://app.bridgebox.ai) still runs the previous code; nothing in this pass was run against production.

## 1. Decision

| Audience | Decision | Why |
|---|---|---|
| **Enterprise launch** (paying client, real employees' desktops, live integrations) | **NO-GO** | Collectors never run on real devices, no integration live-tested, no real-data savings, performance not proven beyond 2,000 synthetic employees, no counsel review, no monitoring — `docs/RELEASE_BLOCKERS.md` §B |
| **Supervised pilot** (one friendly client, consultant in the loop, synthetic/imported data first) | **NO-GO today → CONDITIONAL GO once §A of `docs/RELEASE_BLOCKERS.md` is done** | The critical gates `ci_green`, `backup_restore`, `rollback` are not verified, the security fixes are not deployed, and the platform owner has no MFA. These are hours of work, not engineering projects. When every critical gate passes, `/admin/readiness` computes CONDITIONAL GO by itself |

The decision is computed, not asserted: `/admin/readiness` (src/engine/readiness/gates.ts) returns NO-GO while any
gate fails or any critical gate (CI green, e2e, authn/z, no open critical/high findings, tenant isolation, production
config, backup/restore, rollback) is not passing. Snapshot of the local computation in §3.

## 2. Evidence runs (this pass)

All on the sandbox (2 vCPU, Postgres 16 local, database `bridgebox_sec`), environment label
`local-ci-equivalent`: production build (`NEXT_DIST_DIR=.next-sec npm run build`), server `next start -p 3200` with
`TZ=UTC ALLOW_DEMO_LOGINS=1 JOBS_KICK_ON_ENQUEUE=0`, browser in `America/Chicago`. Commit `24fa22e`.

| # | When (UTC) | Command | Result |
|---|---|---|---|
| 1 | 2026-11-07 18:48 | `npx tsc --noEmit` | exit 0 |
| 2 | 18:48:33 | `npx vitest run` (DATABASE_URL → `bridgebox_sec`) | **44 files, 385/385 passed** (baseline before this pass: 34 files, 324/324). New suites: security-auth 9, sessions 5, rate-limit 6, csp 4, security-health 3, mfa-policy 4, jobs-runner 5, upload-security 7, audit-chain 6, readiness 11; collect-api 25 → 26 (consent version) |
| 3 | 18:51 | `AUTH_URL=… NEXT_PUBLIC_APP_URL=http://localhost:3200 NEXT_DIST_DIR=.next-sec NODE_OPTIONS=--max-old-space-size=2048 npm run build` | exit 0; bootstrap applied migrations, did not seed |
| 4 | 19:05:35 → 19:32:52 | `E2E_BASE_URL=http://localhost:3200 npx playwright test` (full suite, 73 tests) | 67 passed, 1 failed, 5 not run. The failure: `crawl › manager · desktop-light` — `Target crashed`; `dmesg`: the sandbox memory cgroup OOM-killed `chrome-headless` at 4.7 GB anon RSS (single renderer, `--renderer-process-limit=1`, after ~10 crawled pages × up to 60 clicks). Serial mode skipped the 5 crawl tests after it |
| 5 | 19:35:38 → 19:52:07 | crawl batch: `--grep "(manager\|consultant) · (desktop\|mobile)-[a-z]+: every nav page"` | manager × 3 passed; consultant desktop-light OOM-killed again after `/app/automation` (60 clicks); 2 not run |
| 6 | 19:54:04 → 20:04:20 | crawl batch: `--grep "consultant · desktop-light: every nav page"` (fresh browser) | passed |
| 7 | 20:08:05 → 20:08:56 | crawl batch: `--grep "consultant · (desktop-dark\|mobile-light): every nav page"` | passed |
| | | **e2e total** | **73/73 passed across runs 4–7**; no application assertion failed; 0 console/page errors in every crawled page line |
| 8 | ≈18:33 (first build of the same source tree, before the commit) | `curl -s :3200/login \| grep -o '<script[^>]*>' \| grep -vc nonce` | `0` (every script nonce'd); `curl -s :3200/api/health` → `{"ok":true,"version":"local"}` |
| 9 | 2026-11-07 | `npm audit --omit=dev --json` | 3 high, 3 moderate (SEC-015) |
| 10 | 19:4x / 20:11 | `npm run readiness:record -- --sync-findings` and `--gate … --environment local-ci-equivalent --commit 24fa22e…` for `critical_workflows`, `tenant_isolation`, `financial_reconciliation`, `agent_execution`, `accessibility`, `authn_authz`, `e2e` | 15 findings synced; 7 evidence rows (local `bridgebox_sec` database only) |

Not recorded (not proven here): `ci_green` (GitHub Actions not run), `live_integrations`, `desktop_collectors`,
`evidence_savings`, `backup_restore`, `rollback`, `performance`, `privacy_review`, `monitoring`. Nothing was recorded
for `environment = production`.

The crawl OOM is a property of this sandbox (cgroup limit, one shared renderer); it is also a signal worth checking
on a real browser — the renderer's memory grows across many client-side navigations (`/app/automation`,
`/app/employees` each drive ~60 navigations). Not investigated further in this pass.

## 3. Readiness snapshot (local database, after recording)

Computed with `runLiveChecks()` + `computeReadiness()` (the page's own code) against `bridgebox_sec` and the running server, 2026-11-07 20:12:37Z:

```
OVERALL NO-GO
LIVE ok   Database reachable — select 1 succeeded
LIVE ok   Migrations applied — 6 applied / 6 migration files
LIVE FAIL Demo accounts with a password = 0 — 4 demo account(s) can sign in with a password
LIVE FAIL Platform owner MFA enabled — OWNER_EMAIL not set; 0/1 consultancy owner(s) have MFA
LIVE FAIL Required environment variables present — missing: CRON_SECRET
LIVE FAIL Scheduler ran within 26 h — no completed housekeeping job (the /api/jobs/run tick has never completed)
LIVE ok   RLS + tenant policy on every tenant table — 45/45 tenant tables
LIVE ok   Audit hash chains verify — 5 chain(s), 161 rows verified
LIVE ok   Content-Security-Policy served — GET /login → 200, nonce-based CSP present
GATE not_verified ci_green                 No evidence recorded
GATE pass         e2e                      Evidence: local-ci-equivalent @ 24fa22e
GATE pass         critical_workflows       Evidence: local-ci-equivalent @ 24fa22e
GATE fail         authn_authz              Live check failed: Demo accounts with a password = 0, Platform owner MFA enabled
GATE pass         security_findings        15 findings registered; none open at critical/high
GATE pass         tenant_isolation         Evidence: local-ci-equivalent @ 24fa22e
GATE not_verified live_integrations        No evidence recorded
GATE not_verified desktop_collectors       No evidence recorded
GATE pass         financial_reconciliation Evidence: local-ci-equivalent @ 24fa22e
GATE pass         agent_execution          Evidence: local-ci-equivalent @ 24fa22e
GATE not_verified evidence_savings         No evidence recorded
GATE not_verified backup_restore           No evidence recorded
GATE not_verified rollback                 No evidence recorded
GATE not_verified performance              No evidence recorded
GATE pass         accessibility            Evidence: local-ci-equivalent @ 24fa22e
GATE fail         production_config        Live check failed: Required environment variables present
GATE not_verified privacy_review           No evidence recorded
GATE fail         monitoring               Live check failed: Scheduler ran within 26 h
```

Interpretation: locally the live checks *Demo accounts with a password = 0* and *Platform owner MFA* fail by design
(the e2e database is the seeded demo); in production after deploy they are expected to pass once the owner enrols MFA (not verified). Gates
recorded here carry `environment = local-ci-equivalent`; none was recorded for production.

## 4. What this certification does not cover

Production configuration values (not read), the Vercel cron in production, Neon backups, any live vendor API, real
Windows/macOS collectors, performance at more than 2,000 employees (100k: untested, no claim), legal review.
