# Production audit — module inventory

Derived on 2026-11-07 (branch `fix/security-readiness`) by reading each page's code (`src/app/app/**/page.tsx`,
`actions.ts`, `src/app/admin/**`), the engine modules they call, and the existing tests. Not guessed: where a column
says "no", no test or code was found. "Verified workflow" means a behavioural e2e spec drives the module's main
mutation through the UI and asserts the persisted result; it passed in the run recorded in
`docs/LAUNCH_CERTIFICATION.md` §2 — **on synthetic demo data, locally (local-ci-equivalent), never in production**.
Every nav page is additionally covered by render-only suites (`nav.spec.ts`, `crawl.spec.ts`, `a11y.spec.ts`,
`hydration.spec.ts`, `security.spec.ts` CSP sweep); those alone do not make a module VERIFIED.

Legend — **VERIFIED**: UI + working function + persisted + permission-checked + unit and behavioural e2e coverage.
**PARTIAL**: exists and works in parts; behavioural coverage missing or the main value depends on something not
configured. **BLOCKED**: needs a licence, account, device or credential we do not have. **NOT IMPLEMENTED**: no code.

## Client app (`/app`, sidebar `src/components/app-shell` / `tests/e2e/nav-map.ts`)

| Module | Interface | Functionality | Persisted | Permission (page) | Tests | Verified workflow | Status |
|---|---|---|---|---|---|---|---|
| AI Brain `/app/brain` | yes | upload/paste, review, facts, ask (retrieval) | `knowledge_*`, `brain_facts` | `workflows:read`; ingest needs `employees:write`/`org:manage` | unit `brain*.test.ts` (5 files), `upload-security.test.ts`; e2e tenant-isolation (no doc leak) | no e2e upload → approve → ask | PARTIAL |
| AI Workforce `/app/workforce` | yes | personas, profiles, lifecycle, permission levels, skills | `ai_employees`, `skill_runs`, … | `agents:read` (+ `agents:write`, approve thresholds) | unit `workforce`, `skills*`; e2e `acceptance-ai-workforce.spec.ts`, tenant-isolation | yes (Charlotte: sandbox → pilot → act_with_approval → approval → succeeded) | VERIFIED |
| Experience `/app/experience` | yes | guided "meet your AI workforce" | tour/progress rows | `agents:read` | e2e acceptance (Meet Charlotte) | yes (entry step) | VERIFIED |
| Org chart `/app/workforce/org-chart` | yes | people + AI agents chart | read-only | `employees:read` | render suites only | no | PARTIAL |
| Executive `/app` | yes | KPIs with CalcTrees, charts, next actions | read (financial model) | session | unit `finance`, `costing`; e2e `executive.spec.ts`, `reconciliation.spec.ts` | yes | VERIFIED |
| Business Intelligence `/app/business` | yes | BI roll-ups | read-only | `workflows:read` | unit `business-intel.test.ts` (5) | no | PARTIAL |
| Evaluation `/app/evaluation` | yes | transformation score | `evaluations` | `workflows:read` | unit `evaluation.test.ts` | no | PARTIAL |
| People `/app/employees` | yes | list, costs hidden by role | `employees` | `employees:read`; cost `employees:cost:read` | e2e `auth.spec.ts` (cost hidden for manager), `onboarding-client.spec.ts` (CSV import) | yes (import + role view) | VERIFIED |
| Departments `/app/departments` | yes | department roll-up | read | `workflows:read` | render only | no | PARTIAL |
| Process Mining `/app/process-mining` | yes | org process mining | read (computed) | `workflows:read` | unit `process-mining*.test.ts`; perf baseline | no | PARTIAL |
| Workflows `/app/workflows` | yes | discovered workflows, map, evidence, export | `workflows` | `workflows:read` | unit `mining`, `analysis`, `scoring`; e2e `analysis-workflows.spec.ts` | yes | VERIFIED |
| Benchmarking `/app/benchmarking` | yes | comparisons, datasets | `benchmark_datasets` | `workflows:read` | unit `benchmark.test.ts` | no | PARTIAL |
| Opportunities `/app/opportunities` | yes | ranked list, CalcTree, approve/reopen | `opportunities`, `opportunity_decisions` | `opportunities:read/write` | unit `opportunity-score`, `costing`; e2e `opportunities.spec.ts` | yes | VERIFIED |
| AI Agents `/app/agents` | yes | templates, credentials, deploy, runs, approvals, measurement | `agents`, `agent_runs`, `approvals`, `credentials` | `agents:*`, `credentials:manage` | unit `agents-runner`, `agent-versions`, `n8n`; e2e `agents.spec.ts` | yes, internal runtime vs local mock; n8n not live | VERIFIED (internal runtime) |
| Automation Studio `/app/automation` | yes | automation overview | read | `agents:read` | render only | no | PARTIAL |
| Financial Model `/app/finance` | yes | assumptions, scenarios, slider | `financial_models` | `finance:read/write` | unit `finance`, `costing`; e2e `finance-reports.spec.ts`, `reconciliation.spec.ts` | yes | VERIFIED |
| Savings `/app/savings` | yes | projected vs verified, ledger | `savings_measurements`, `savings_ledger` | `finance:read` | unit `savings.test.ts`; e2e reconciliation, agents, acceptance | yes | VERIFIED |
| Reports `/app/reports` | yes | Executive ROI / proposal PDF | `reports` (PDF base64) | `finance:read`, `reports:generate` | unit `finance` (`generateExecutiveReport`), `exports`; e2e `finance-reports.spec.ts` | yes (incl. cross-org 404) | VERIFIED |
| Roadmap `/app/roadmap` | yes | roadmap | `projects`/milestones | `opportunities:read` | unit `roadmap.test.ts` | no | PARTIAL |
| Transformation `/app/transformation` | yes | org transformation | read | `finance:read` | render only | no | PARTIAL |
| Risk `/app/risk` | yes | risk register | `project_risks`, audit reads | `workflows:read` | unit `risk.test.ts` | no | PARTIAL |
| Assistant `/app/assistant` | yes | evidence-pack answers with citations | `ai_conversations` | `workflows:read`, 30/min | unit `assistant`, `brain-assistant`; e2e `assistant-search.spec.ts` | yes in deterministic retrieval mode; LLM mode BLOCKED (no key) | VERIFIED (retrieval) |
| Structure `/app/settings/structure` | yes | business units, locations | `business_units`, `locations` | `org:manage` | render only | no | PARTIAL |
| Members `/app/settings/members` | yes | invite, role change, remove (+ session revoke) | `memberships`, `invitations` | `members:invite` | unit `onboarding` (invitations), `sessions` | invitation accept via portal onboarding e2e; settings-page invite/remove not e2e | PARTIAL |
| Integrations `/app/integrations` | yes | marketplace; HubSpot + n8n connectors | `integrations`, `credentials` | `org:manage` | unit `connectors`, `n8n` (mocked fetch) | no live vendor | PARTIAL (live: BLOCKED) |
| Data Collection `/app/collection` | yes | authorization, notice, campaigns, codes, collectors, run analysis | `authorizations`, campaigns, `collectors`, `jobs` | `collectors:manage`, `analysis:run` | unit `collect-api` (26), `jobs-runner`; e2e `collection.spec.ts` | yes on the protocol (simulated collector) | VERIFIED (protocol) |
| Audit log `/app/settings/audit` | yes | list, filter, verify chain | `audit_log` (+ hash chain) | `audit:read` | unit `audit-chain.test.ts` | no e2e of verify | PARTIAL |
| Billing `/app/billing` | yes | plan, checkout, portal | `subscriptions`, `invoices` | `org:billing` | unit `billing.test.ts` (mocked Stripe); e2e unconfigured path | Stripe never exercised | BLOCKED (Stripe) |
| Settings `/app/settings` | yes | org profile, retention, data export/delete | `organizations` | `org:manage` | e2e `auth.spec.ts` (manager blocked) | no e2e of save | PARTIAL |
| Security `/app/settings/security` (not in nav) | yes | MFA enrol/disable, password, sign out all, MFA policy | `users`, org settings | session (+ `org:manage` unless MFA-required) | unit `security-auth`, `sessions`, `mfa-policy`; e2e `security.spec.ts` (sign out all) | revocation yes; TOTP sign-in not e2e | PARTIAL |
| Trust & Privacy `/app/trust` | yes | employee view, withdraw / re-acknowledge | `consent_records` | `self:read` | unit `collect-api` (withdraw/ack via consent-lib) | no e2e | PARTIAL |

## Consulting portal (`/admin`)

| Module | Interface | Functionality | Persisted | Permission | Tests | Verified workflow | Status |
|---|---|---|---|---|---|---|---|
| Portfolio `/admin` | yes | clients with projected/verified $ | read | consultancy owner/admin/consultant | e2e `admin-portal.spec.ts` | yes | VERIFIED |
| Client onboarding `/admin/clients/new` | yes | wizard, CSV, invite, trial | org, employees, invitation, subscription | consultant roles | unit `onboarding` (9); e2e `onboarding-client.spec.ts` | yes (invitee accepts) | VERIFIED |
| Client workspace `/admin/clients/[id]` | yes | 10 tabs, projects | various | `requireClient` parent check | e2e `admin-portal.spec.ts` | yes (tabs + project) | VERIFIED |
| Pipeline, Projects, Reports `/admin/*` | yes | portfolio views | read / projects | consultant roles | render suites; projects via workspace e2e | partial | PARTIAL |
| Billing `/admin/billing` | yes | consolidated billing | read | consultant roles | e2e unconfigured path | Stripe never exercised | BLOCKED (Stripe) |
| Team `/admin/team` | yes | members, invites, remove (+ session revoke) | memberships | owner for removal | e2e lists members | no e2e removal | PARTIAL |
| Readiness `/admin/readiness` (new) | yes | 18 gates, live checks, evidence, findings | `readiness_evidence`, `security_findings` | platform owner / consultancy owner, 404 otherwise | unit `readiness.test.ts`, `mfa-policy.test.ts`; e2e `security.spec.ts` (404 × 3 roles, render, axe) | yes (access + render; status computed, never hard-coded) | VERIFIED |

## Outside the web app

| Module | Status | Why |
|---|---|---|
| Desktop collector (`collector/`) | BLOCKED | only `--simulate` on Linux; no real Windows/macOS device, unsigned binaries |
| OIDC SSO | BLOCKED | never run against an IdP |
| Email delivery (notify node, invitations) | NOT IMPLEMENTED | `notify` records `delivered:false`; invitation links are copied by hand |
| QuickBooks / Salesforce / M365 / Google / ERP connectors | NOT IMPLEMENTED | catalog entries only (`implemented: "none"`) |
| Process-mining live APIs (Power Automate, UiPath, Mimica) | BLOCKED | licence; export mappers only |
| Scheduler on Vercel | PARTIAL | code tested; whether production's daily cron completes is a live readiness check |
