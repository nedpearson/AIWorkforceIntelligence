# Production readiness — verified report

Written 2026-11-06 against commit `ac0775c` plus this doc set. "Verified" means a named automated test exercises the
behaviour end to end and passed in the last recorded run (`test-results/.last-run.json`: `status: passed`, 0 failed,
at 22:01 local on the day of writing; unit suites were run by their authors during Phases 2–3 — this document did not
re-run them). "Partially" means the code exists and part of it is tested. "Not verified" means nobody has seen it work
against the real thing. Test counts are from grep (`test(`/`it(`), not from a runner.

Bottom line: **the product works end to end on synthetic data with simulated collectors. Nothing that touches a real
employee desktop, a real identity provider, a real n8n, Stripe or Anthropic account has been exercised live.** It is a
credible pilot build; it is not ready to invoice a client until §4 is done.

## 1. Acceptance workflows

The ten workflows below are the ones the e2e suite was written to cover (`tests/e2e/README.md`, "ten production
workflows"); the mapping to spec files is this document's.

| # | Workflow | Status | Evidence |
|---|---|---|---|
| 1 | **Sign in, MFA, roles and route protection** — login/logout, bad password, unauthenticated redirects, manager blocked from Settings/Admin, cost columns hidden by role | **Verified** (password + RBAC); **Partially** (MFA: unit-level only via `authorize()` path, no e2e TOTP login; SSO: not verified) | `tests/e2e/auth.spec.ts` (6), `auth.setup.ts` (4 roles) |
| 2 | **Consultancy onboards a client** — wizard with CSV employees, invite link, invitee accepts in a fresh browser and lands in the new org, trial subscription created | **Verified** | `tests/e2e/onboarding-client.spec.ts`; `tests/unit/onboarding.test.ts` (9: CSV parse, org + trial + model + integrations + invitation, tenancy assertion, invitation lookup/accept/expiry) |
| 3 | **Authorize, notify, consent, collect** — authorization record, notice publish, campaign create/start, enrollment code, collector enroll → consent → 20-event batch accepted, forbidden meta rejected, pause/resume enforced server-side, "Run analysis now" enqueues a job; campaign created with default dates accepts events immediately | **Verified** on the protocol; **Not verified** on a real desktop (collector ran only in `--simulate` on Linux; `active-win`, idle detection, Windows/macOS packaging, MDM scripts untested) | `tests/e2e/collection.spec.ts` (2, incl. the former fixme for FINDINGS #2), `tests/unit/collect-api.test.ts` (25: enroll, auth, consent gate, titleMode, cross-org, retention, offline, jobs, cron auth) |
| 4 | **Discover workflows** — ≥ 9 workflows on the demo org with observed metrics, search, detail with process map, evidence sample size, sample-events drawer, Markdown export | **Verified** | `tests/e2e/analysis-workflows.spec.ts` (2); `tests/unit/mining.test.ts` (13), `scoring.test.ts` (9), `analysis.test.ts` (6, end-to-end on 20 synthetic days incl. performer attribution and a performance case) |
| 5 | **Rank and work opportunities** — ranked list, type filter, rank-1 detail with full CalcTree incl. adoption rate, Approve → Reopen persisted across reloads | **Verified** | `tests/e2e/opportunities.spec.ts`; `tests/unit/costing.test.ts` (10) |
| 6 | **Deploy an agent with approval and measure it** — opportunity → recommended template → credential → policy `all` → deploy → run → `awaiting_approval` → approve → `succeeded` with minutes saved → measurement recorded → "Verified so far" > $0 on the executive page | **Verified** on the internal runtime against a local mock API; **Not verified** on n8n or with a real LLM | `tests/e2e/agents.spec.ts`; `tests/unit/agents-runner.test.ts` (13: approvals, reject, retries + compensation → `rolled_back`, llm skipped without key, redaction, cross-tenant credential denial, approval expiry, policy none, measurement) |
| 7 | **Financial model and executive summary** — three headline KPIs are computed dollar values with drill-downs (basis chips, formulas); four charts render; adoption slider and scenario presets move net savings | **Verified** | `tests/e2e/executive.spec.ts` (3), `finance-reports.spec.ts` (slider test); `tests/unit/finance.test.ts` (7), `costing.test.ts` |
| 8 | **Reports** — Executive ROI PDF is `application/pdf` > 10 KB; Investment proposal generated from `/app/reports` and downloaded via `/api/reports/[id]`; another org's owner gets 404 | **Verified** | `tests/e2e/finance-reports.spec.ts` (3); `tests/unit/finance.test.ts` › `generateExecutiveReport` |
| 9 | **Search and assistant** — `/app/search?q=invoice` returns workflow hits that open; assistant answers "What is our top opportunity?" with a citation that resolves | **Verified** in deterministic retrieval mode; **Not verified** in LLM mode | `tests/e2e/assistant-search.spec.ts` (2); `tests/unit/assistant.test.ts` (12, skipped when the demo org is not seeded) |
| 10 | **Consulting portal and billing** — portfolio with both clients and projected/verified $, all 10 client-workspace tabs load, project created, billing honestly reports "Stripe is not configured" with the env var names and checkout refuses, team page lists members | **Verified** (unconfigured path); **Partially** (Stripe: mocked client + `generateTestHeaderString` signatures only) | `tests/e2e/admin-portal.spec.ts` (3); `tests/unit/billing.test.ts` (15) |
| + | **Tenant isolation** (cross-cutting) — other client's owner gets 404 on every Gulf Coast id and the report API, cannot forge org switch, no switcher; consultancy owner switches legitimately | **Verified** | `tests/e2e/tenant-isolation.spec.ts` (3); unit cross-org tests in collect-api, agents-runner, onboarding |
| + | **Navigation and mobile** — every client and portal nav item loads with the right heading and no console errors; hamburger drawer at 390 px without horizontal overflow | **Verified** | `tests/e2e/nav.spec.ts` (2 desktop + 2 `@mobile`) |

### The four e2e findings (`tests/e2e/FINDINGS.md`) — status in code

| # | Finding | Status | Where verified |
|---|---|---|---|
| 1 | `<Button href>` dropped `data-testid` and other props | **Fixed** | `src/components/ui/index.tsx` line 29 spreads `rest` onto `<Link>` after stripping `type`/`disabled`/`onClick` |
| 2 | New-campaign default start date was the UTC date, stored as local midnight | **Fixed** | `src/app/app/collection/collection-client.tsx`: `localDate()` builds from `getFullYear/getMonth/getDate`; the `test.fixme` is now a passing `test()` in `collection.spec.ts` |
| 3 | `/favicon.ico` 404 on every page | **Fixed** | `src/app/icon.svg` exists (Next.js serves it as the icon); `nav.spec.ts` still whitelists the 404 pattern, which is now harmless |
| 4 | Seeded consent `notice_version` did not match the current notice | **Fixed** | `scripts/seed.ts` imports and uses `DEFAULT_NOTICE_VERSION` |

## 2. Integration status

| Integration | Built to | Tested | Live-tested | Status label in UI | What is missing |
|---|---|---|---|---|---|
| **Internal agent runtime** | own design | unit (13) + e2e (agents) against a local HTTP mock | n/a | — | email delivery in `notify` (recorded `delivered:false`) |
| **n8n** | Public REST API v1 (`/api/v1/workflows`, `/activate`, `/executions`, `/webhook/{path}`) | unit (8) with mocked `fetch`: exact method/path/headers/body, 404-recreate, idempotent import | **no** | `not_configured` until a URL + key is saved; `connected`/`error` after a live check | a real n8n instance; the four shipped workflow JSONs have never been imported into one; credentials inside n8n |
| **Anthropic** | Messages API, `claude-sonnet-4-5`, 60 s timeout, retry 429/5xx | only the no-key path (`skipped` / retrieval mode) | **no** | assistant shows mode; llm node logs `skipped` reason | a key; evaluation of answer quality and prompt-injection resistance |
| **Stripe** | Checkout (subscription mode, metadata), Portal, webhook signature, 6 event types, idempotent ledger, seat enforcement | unit (15) with mocked client and `generateTestHeaderString` | **no** (not even test mode) | "Stripe is not configured" + exact env vars | test-mode run of checkout → webhook → portal → sync; Prices created in the dashboard |
| **Power Automate Process Mining** | Dataverse `pm_process` export shape → `workflows` mapper; adapter interface | unit (mapper + `license_required` + `NotConfiguredError`) | **no** | `license_required` with prerequisites | license, Entra app, live Dataverse queries (not implemented) |
| **UiPath Task Mining** | Task Mining export (`tasks[]`) mapper | same | **no** | `license_required` | license; live API not implemented |
| **Mimica** | Mapper export (`processes[]`) mapper | same | **no** | `license_required` | subscription; live API not implemented |
| **OIDC SSO** | generic Auth.js OIDC provider, JIT user creation | **none** | **no** | login page shows the SSO button only when configured | a tenant on Entra ID / Okta; claim mapping may need adjustment (`email` claim) |
| **Collector** | `active-win` sampling, disk queue, backoff, tray/pause, consent prompt, simulate mode | unit (collect API, 25) + e2e protocol run + manual `--simulate` on Linux | **Linux-simulated only** | Collectors tab health | real Windows/macOS sampling, idle detection, `pkg` binaries, code signing/notarization, Intune/Jamf validation |
| **Jobs** (cron / worker) | `/api/jobs/run` + `scripts/worker.ts` | unit (retry/backoff/failure, cron auth); manual tick in the Next runtime | cron on Vercel **not** run | Collection page shows last job state | a Vercel deployment with `CRON_SECRET` |

## 3. Known limitations and blockers

**Security / privacy** (details in `docs/SECURITY.md` §13, `docs/PRIVACY.md` §9)
- No rate limiting on login/MFA; in-memory limiter elsewhere; no CSP/HSTS from the app; no WAF.
- JWT sessions cannot be revoked; no MFA recovery codes; MFA cannot be required org-wide.
- Consent gate ignores notice version (UI shows "outdated", ingest still accepts).
- No per-employee export/erase action; audit log mutable by the admin DB role; `audit()` swallows failures.
- No key-rotation tooling for `VAULT_KEY`.

**Scale / operations**
- PDFs stored base64 in Postgres; 4 MB server-action limit.
- `runAnalysis` runs inside a 60 s Vercel function unless a worker is deployed; no incremental analysis; no
  partitioning of `activity_events`.
- No error tracking, metrics, uptime monitoring or runbook. Backups are the database provider's concern.
- Drizzle has no down migrations; rollback = restore dump.

**Product**
- All demo data is synthetic; no real client workflow has ever been mined, so the scoring heuristics
  (judgment/regulatory keywords, API-friendliness table, `normalize.ts` title categories) are untuned.
- The Enterprise plan is loss-making if a client deploys all 50 included agents (`docs/COSTS.md`).
- `notify` nodes do not send email; the assistant's LLM mode and agent llm nodes are unevaluated.
- Collector app-name map (`normalize.ts`) is a starting point; real process names will differ.

**Process**
- No security review, pen test, dependency audit or SOC 2 controls.
- Unit suites were not re-run as part of writing this report; CI (`.github/workflows/ci.yml`) is new and has not yet
  executed on GitHub.

## 4. What must happen before the first paying client

In order; items 1–5 are blockers, 6–9 are strongly advised.

1. **Run the collector on real Windows and macOS machines** for at least one full campaign week on friendly users;
   tune `normalize.ts`; confirm idle detection and the Screen Recording flow (roadmap 5.1).
2. **Sign and notarize the collector binaries** and validate one Intune and one Jamf rollout (5.2). Without this,
   the client's IT will refuse the install.
3. **Rate-limit login/MFA and move the limiter out of process**; add CSP/HSTS (5.3).
4. **Exercise every integration the client will use, live**: n8n with the shipped templates, Stripe test mode end to
   end, OIDC if the client has SSO, Anthropic if LLM mode is sold (5.4).
5. **Get CI green on GitHub** and run the full unit + e2e suites on the deployment target's Node/Postgres versions.
6. Move PDFs to object storage (5.5) and enforce consent version + per-employee export/erase (5.6).
7. Fix the Enterprise plan allowance (5.7) before quoting it.
8. Error tracking, uptime monitoring, a tested backup restore, and a one-page incident runbook (5.8).
9. Have counsel review the notice/authorization wording for the client's state and the processor agreement
   (`docs/PRIVACY.md` §10).

Until 1–4 are done, sell it as a **paid pilot with a consulting engagement** — the analysis and reporting on
simulated or imported data are solid; the desktop rollout and the live integrations are not yet proven.
