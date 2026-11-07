# Implementation plan

Part 1 is the plan as it was actually executed (three commits on 2026-11-06, `git log`), with what each phase
produced. Part 2 is the forward roadmap with rough effort for one senior engineer unless stated. Effort figures are
estimates, not commitments.

## Part 1 — executed

### Phase 0 — Audit and conventions
- Decided the non-negotiables and wrote them down before code: `docs/CONVENTIONS.md` (tenancy through `withTenant`,
  `orgId` never from the request, every number carries a `basis`, every money figure a `CalcTree`, all formulas in
  one file, every mutation audited, every interactive element has a `data-testid`, integrations without a license are
  honest stubs).
- Chose the stack and rejected alternatives (`docs/ARCHITECTURE.md` §10).

### Phase 1 — Foundation (commit `93be3a1`)
- `src/db/schema.ts`: 28 tables, 16 enums, `basis`/`CalcTree` types, tenancy comments.
- `drizzle/rls.sql`: `bridgebox_app` role, `app_current_org()`, `tenant_isolation` on 24 tables, `org_self`,
  `users_in_org`, `audit_org`, `jobs_org`, `FORCE ROW LEVEL SECURITY`. `scripts/migrate.ts` applies it after
  migrations; `scripts/reset.ts`, `scripts/seed.ts`.
- Auth.js v5 Credentials + bcrypt, TOTP MFA (`otplib`) with vault-encrypted secret, optional OIDC provider with JIT
  users; `src/lib/session.ts` (`getCtx`, `requireCtx`, `requireApiCtx`, consultancy → client resolution);
  `src/lib/rbac.ts` (21 permissions × 6 roles); `src/lib/crypto.ts` (AES-256-GCM, sha256, HMAC, timing-safe compare);
  `src/lib/audit.ts`; `src/middleware.ts`; security headers in `next.config.ts`.
- UI shell: Tailwind v4 tokens, primitives in `src/components/ui/index.tsx`, `<CalcTreeView>`, Recharts wrappers,
  mobile-first layout with drawer.
- `src/engine/synthetic.ts`: deterministic synthetic org (Gulf Coast Supply Co., 12 employees, 6 departments, 10
  workflow patterns, seed 42) and `src/engine/costing.ts` with `DEFAULTS`, `IMPLEMENTATION_PROFILES`, `SCENARIOS`.

### Phase 2 — Engines (commit `b412a46`)
- Analysis: `mining.ts` (sessionization, instances, Jaccard + LCS clustering, metrics, process maps, naming),
  `scoring.ts` (repetition/automation scores, flags, duplicates, opportunity type, agent category, feasibility, risk,
  rank), `analysis.ts` (`runAnalysis`, in-flight opportunity preservation, run summary). `docs/ANALYSIS_METHOD.md`.
- Finance: `finance.ts` (`computeOrgFinancials` with org/department/employee roll-ups and scenarios,
  `ensureDefaultFinancialModel`, `recordSavingsFromRunLedger`, `generateExecutiveReport` with pdfkit, demo watermark).
  `docs/FINANCIAL_METHOD.md`.
- Collector + ingest + jobs: `collector/` (sampler with `active-win`, normalize, disk queue, tray/pause, simulate
  mode), `src/collector-protocol/schema.ts` + `schedule.ts`, `/api/collect/*` with three gates, `jobs.ts` with
  `SKIP LOCKED`, backoff, built-in jobs, `/api/jobs/run`, `scripts/worker.ts`. `docs/COLLECTOR.md`.
- Agents: `definition.ts` (zod graph), `templates.ts` (catalog, 4 real n8n JSON), `runner.ts` (internal runtime with
  approvals, retries, compensation, redaction, llm node), `n8n.ts` (REST v1 adapter), `measure.ts`; credentials vault
  UI; `adapters/process-mining.ts` (license-required stubs + mappers). `docs/INTEGRATIONS.md`.
- Pages: Data Collection, Trust & Privacy, Agents (list/new/detail/approvals/credentials).
- 93 unit tests at this point.

### Phase 3 — UI, portal, billing, assistant (commit `ac0775c`)
- Client app: executive summary (three headline KPIs with drill-downs, four charts), workflows list/detail (process
  map SVG, evidence, sample events drawer, Markdown export), opportunities (ranking, filters, CalcTree, status
  workflow), departments, employees (cost gating), finance (sliders, scenarios), reports (generate/download), search,
  assistant (evidence-grounded retrieval; LLM optional), onboarding, settings (org, members/invites, security/MFA,
  integrations/n8n, data & privacy export/delete/retention, audit log).
- Consulting portal: portfolio, new-client wizard (CSV employees, invite link), client workspace (10 tabs), billing
  (plans, Stripe checkout/portal/sync, local plan), team, pipeline, projects, reports. `billing.ts` + webhook +
  seat enforcement; `onboarding.ts`. `docs/BILLING.md`.

### Phase 4 — Tests and documentation (commit `ac0775c` + this doc set)
- Unit: 129 `it()` cases in 12 files (mining, scoring, costing, finance, analysis end-to-end, collect API, agents
  runtime, n8n, billing, onboarding, assistant, process-mining).
- E2E: Playwright, 35 tests (4 setup + 29 desktop + 2 mobile), serial against the production build; `README.md` and
  `FINDINGS.md`. The four findings (Button `href` dropping props, UTC default campaign date, missing favicon, seed
  consent version) were fixed in app code and the `test.fixme` for #2 was promoted to a real test.
- Docs: this set — `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `PRIVACY.md`, `COSTS.md`, `DEPLOYMENT.md`,
  `PRODUCTION_READINESS.md`, `IMPLEMENTATION_PLAN.md`; `Dockerfile`, `docker-compose.yml`, `vercel.json`,
  `.dockerignore`, `.github/workflows/ci.yml`, `LICENSE`.

## Part 2 — forward roadmap

Ordered by what unblocks the first paying client (see `docs/PRODUCTION_READINESS.md` §4). Effort: S ≤ 1 week,
M = 2–4 weeks, L = 1–3 months.

### Phase 5 — First-client readiness

| # | Item | Why | Effort |
|---|---|---|---|
| 5.1 | **Real-desktop collector certification**: run `collector/` on Windows 11 and macOS 14/15 with real `active-win`, tune `normalize.ts` app map against real process names, verify idle detection, Screen Recording permission flow, queue/backoff under network loss | the whole product depends on it; only Linux-simulated so far | M |
| 5.2 | **Collector signing + notarization + MDM packages**: EV code-signing cert (Windows), Apple Developer ID + notarization, MSI/PKG builds, validated Intune and Jamf profiles (PPPC for Screen Recording), auto-update channel | unsigned binaries are blocked by SmartScreen/Gatekeeper; IT will not deploy them | M (plus certificate lead time) |
| 5.3 | **Login/MFA rate limiting + distributed limiter** (Redis/Upstash or platform WAF) replacing the in-memory map; CSP + HSTS headers | `docs/SECURITY.md` §13 top items | S |
| 5.4 | **Live integration certification**: n8n (self-hosted + cloud) end to end with the four shipped templates; Stripe test-mode checkout → webhook → portal; OIDC against Entra ID and Okta; Anthropic llm node and assistant LLM mode with a real key | every integration is built to the API but none has been run live | M |
| 5.5 | **Object storage for PDFs** (S3/R2, signed URLs) and move `reports.pdf_bytes` out of Postgres; backfill script | table bloat, backup size, 4 MB action limit | S |
| 5.6 | **Consent version enforcement** in `consentState()`, per-employee export/erase actions, MFA recovery codes, org-wide `requireMfa` | privacy and security gaps found while writing this doc set | S |
| 5.7 | **Enterprise plan economics**: lower included agent slots or reprice; measure real `perAgentMonthly` from the ledger | negative margin at full utilisation (`docs/COSTS.md`) | S (decision) |
| 5.8 | **Operational baseline**: error tracking (Sentry), uptime check, structured logs, backup restore drill, runbook | no observability today | S |

### Phase 6 — Scale and assurance

| # | Item | Effort |
|---|---|---|
| 6.1 | **Key-rotation tooling** for `VAULT_KEY` (re-encrypt credentials + MFA secrets), `AUTH_SECRET` rotation playbook, Auth.js database sessions or short-lived JWT with revocation list | S–M |
| 6.2 | **SOC 2 Type I controls**: access reviews, change management via CI gates (CodeQL, `npm audit`, gitleaks), immutable audit sink (append-only store/SIEM), vendor inventory, incident response doc; then Type II observation window | L (process-heavy) + auditor fees |
| 6.3 | **Pen test** of the web app, collector protocol and n8n boundary; fix cycle | M (external) |
| 6.4 | **Job host separation**: dedicated worker deployment, per-tenant analysis time budgets, incremental analysis (process only new events), progress UI | M |
| 6.5 | **Event storage**: partition `activity_events` by month, compress/aggregate past retention into daily summaries | M |
| 6.6 | **LLM-backed assistant certification**: evaluation set of questions with expected citations, refusal behaviour when evidence is absent, prompt-injection tests on evidence text, cost caps per org | M |
| 6.7 | **Multi-region / data residency**: region-pinned Postgres per consultancy, EU hosting option, region-aware Anthropic/n8n endpoints | L |
| 6.8 | **Process-mining live adapters** (only when a client brings a license): Power Automate Dataverse OAuth + queries, UiPath Automation Cloud, Mimica API | M each |
| 6.9 | **Product**: campaign comparison (before/after at campaign level), department benchmarks across clients (anonymised), approval inbox notifications (email/Slack via n8n), white-label portal domains | M–L |

### Not planned
- Keystroke, screenshot or URL capture of any kind — it contradicts the privacy contract and the market position.
- A separate API service or microservices; the monolith with a worker is adequate well past the first fifty clients.
