# End-to-end acceptance suite (Playwright)

Browser-level acceptance tests for the ten production workflows plus security/tenant isolation. Every spec
drives the real UI against the real Next.js production build and the real Postgres, and asserts outcomes that
are visible in the database through the UI (reloads after mutations, cross-role checks, API round-trips).

## Prerequisites

- Postgres running with the seeded demo database: `postgresql://bridgebox:bridgebox@localhost:5432/bridgebox`
  (`DATABASE_URL` in `.env`). Seed once with `npm run db:reset`.
- `.env` present (the suite reads `DATABASE_URL` and `SEED_PASSWORD`, if set, from it).
- Playwright `@playwright/test@1.65` and its Chromium build are already installed (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`).
  Do not run `playwright install`.
- Port 3000 free, or an already-running `npm run start` on it (the config reuses an existing server).

## Running

The crawl alone takes ~45–60 min on a 2-vCPU box: `npx playwright test --grep-invert "Crawl"` for the fast path. Never run two Playwright processes at once — they share `test-results/` and delete each other's traces.

Performance baseline (not part of the suite): `npx tsx tests/perf/perf.ts` — see `docs/PERFORMANCE.md`.


```bash
npm run db:reset              # once, for a clean seed (optional afterwards — see "Re-runnable")
npm run test:e2e              # = npx playwright test (builds + starts the app if nothing listens on :3000)
npx playwright test --reporter=list
npx playwright test --project=desktop tests/e2e/agents.spec.ts   # one spec
npx playwright test --project=mobile                              # only the @mobile subset
npx playwright show-trace test-results/<test>/trace.zip           # trace of a failed test
```

`playwright.config.ts` starts the app with `npm run build && npm run start` (5-minute timeout) unless port 3000 is
already serving; set `E2E_BASE_URL` to point at another host. The browser runs in `America/Chicago`
(the demo organizations' time zone); override with `E2E_TZ`.

## Layout

| File | Purpose |
| --- | --- |
| `auth.setup.ts` | `setup` project: logs in once per role through the login form and stores cookies in `.auth/<role>.json` (git-ignored). |
| `fixtures.ts` | `test` with `ownerPage`, `managerPage`, `consultantPage`, `bayouPage` (one fresh context per test from the stored state), `loginViaForm`, `watchConsole`, `expandCalcTree`, money regexes, `uniq()`. |
| `db.ts` | Read-only Postgres helper (`postgres` package) used only to look up ids of seeded Gulf Coast rows for the isolation checks. Never writes. |
| `mock-api.ts` | Local HTTP stub that stands in for a client's "target system API" so an agent's post-approval HTTP step makes a real outbound call. |
| `auth.spec.ts` | Login success/failure, logout, unauthenticated redirects (`/app`, `/admin`, API 401), manager blocked from Settings/Admin, cost columns hidden for managers. |
| `nav.spec.ts` | Every client sidebar item (owner) and every consulting-portal item (consultancy owner): URL, `h1`, no console errors / `Application error`. `@mobile`: hamburger drawer, 3 pages, no horizontal overflow. |
| `executive.spec.ts` | Hero KPIs are computed `$` values, each opens the drill-down with basis chips + formulas; 4 charts render; top opportunity links through; next-action links resolve 200. |
| `onboarding-client.spec.ts` | `/admin/clients/new` wizard with a 3-row CSV → invite link → accepted by a new user in a fresh browser context → lands in the new org. |
| `collection.spec.ts` | Authorization, notice publish, campaign create/start, enrollment code, then the collector protocol via `request` (enroll → consent → 20-event batch accepted=20, forbidden meta key rejected), collector active in UI, pause/resume enforced server-side, "Run analysis now" enqueues a job. |
| `analysis-workflows.spec.ts` | ≥ 9 workflows, search; detail: process-map SVG nodes/edges, evidence sample size, sample-events drawer rows, Markdown export containing the workflow name and sample size. |
| `opportunities.spec.ts` | Ranked list, type filter, rank-1 detail with the full CalcTree (incl. "Adoption rate"), Approve → Reopen persisted across reloads. |
| `agents.spec.ts` | Opportunity → "Automate this" → recommended template → inline `http_bearer` credential pointing at the mock API → policy `all` → deploy → Run now (JSON) → `awaiting_approval` → approve in Approvals tab → `succeeded` with minutes saved → measurement recorded → executive "Verified so far" > $0. |
| `finance-reports.spec.ts` | Adoption slider and scenario presets move net savings; Executive ROI PDF (`application/pdf`, > 10 KB, `%PDF-`); generate an Investment proposal from `/app/reports`, download via `/api/reports/[id]`; Bayou Dental's owner gets 404 for that id. |
| `tenant-isolation.spec.ts` | Bayou Dental owner: own org only, empty workflows, 404 for Gulf Coast workflow/opportunity/employee(/agent) ids and report API, no org switcher, cannot forge `/api/org/switch`; Gulf Coast owner reaches the same ids; consultancy owner switches orgs via the switcher. |
| `assistant-search.spec.ts` | `/app/search?q=invoice` returns workflow hits that open; assistant answers "What is our top opportunity?" with an opportunity citation that resolves. |
| `admin-portal.spec.ts` | Portfolio shows both demo clients with projected/verified `$`; all 10 client-workspace tabs load; create a project; billing says "Stripe is not configured" with the env var names and checkout refuses honestly; team page lists members. |
| `nav-map.ts` | Static copy of the sidebar (`NAV_GROUPS`): testid → path → h1 → roles, plus the documented benign console patterns. `nav.spec.ts` and `crawl.spec.ts` assert the rendered sidebar equals it. |
| `crawl.spec.ts` | Owner, manager, consultancy owner × (1440 light, 1440 dark, 390 light): every nav page → 200, h1, no `Application error`, no console/page errors, no horizontal overflow. On 1440 light it clicks every enabled non-destructive control in `<main>` (≤ 60/page; destructive and state-changing controls skipped — see the file header) and writes `test-results/crawl/crawl-report.json`. |
| `a11y.spec.ts` | axe-core (`wcag2a/2aa/21a/21aa/22aa`) on every nav page for the client owner and consultancy owner, light and dark; zero serious/critical is the bar. Report: `test-results/a11y/a11y-report.json`. |
| `reconciliation.spec.ts` | `/app` primary KPIs = `/app/finance` = `/app/savings` to the whole dollar (saved model, Conservative preset, and a temporarily saved custom model); the Excel export from `/app` equals the UI and its sheets add up. |
| `FINDINGS.md` | Application bugs found by the suite, with repro steps. |

## Re-runnable without reseeding

Specs create what they need with unique names (`uniq()`), never delete seeded rows, and tolerate state left by
earlier runs (e.g. the agents spec picks the lowest-ranked opportunity that still has no agent; the opportunities
spec skips approve/reopen when rank 1 is already managed by an agent). Each run leaves behind: one onboarded client
org + 3 employees + 1 user, one campaign (completed), one collector + 20 events, one queued analysis job, one agent
+ run + measurement, one credential, one project, two reports and a notice-text suffix on Gulf Coast. Run
`npm run db:reset` whenever you want a pristine demo again.

Specs run serially (`workers: 1`) because they share one database; the whole suite takes about **1 minute** against
an already-built server (35 tests: 4 setup + 29 desktop + 2 mobile — 34 pass, 1 is a `test.fixme` documenting FINDINGS.md #2),
plus the one-off `next build` (~1–2 min) when the config has to start the server itself.

## Conventions

- Locate by `data-testid` first; by accessible role/name only where the app drops the testid (see FINDINGS.md #1).
- Assert persisted outcomes: reload after a mutation, or read it back as another role / via the API.
- Console errors fail the nav tests, except the `favicon.ico` 404 (FINDINGS.md #3) which is filtered explicitly.
- Failure artifacts (screenshot, trace, DOM snapshot) land in `test-results/`.
