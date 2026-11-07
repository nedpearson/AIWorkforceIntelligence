# Integration verification

Status of every external integration as of branch `fix/security-readiness` (2026-11-07). Sources: the connector
catalog (`src/engine/connectors/catalog.ts`, field `implemented`), `docs/INTEGRATIONS.md`, the code paths named below
and the unit tests that exist. "Credentials configured" refers to **production** (Vercel project `bridgebox-aiwi`)
and is stated only where it is known; this branch did not read production environment values.

**Bottom line: no external integration has been tested against the live vendor service.** The only integration
exercised end to end is BridgeBox's own agent runtime, against a local HTTP mock (unit + e2e).

| Integration | Implemented | Licensing / account needed | Credentials configured (prod) | Tested | Live-tested |
|---|---|---|---|---|---|
| Internal agent runtime (`src/engine/agents/runner.ts`) | Yes | — (`VAULT_KEY`) | n/a | `tests/unit/agents-runner.test.ts`; `tests/e2e/agents.spec.ts`, `acceptance-ai-workforce.spec.ts` against `tests/e2e/mock-api.ts` | n/a (internal); never against a client's real system |
| Anthropic (assistant LLM mode, agent `llm` node) | Yes — env (`ANTHROPIC_API_KEY`), Messages API shape | Anthropic API account | Unknown | Only the no-key path (`skipped` / retrieval mode) | **No** |
| n8n | Yes — full (`src/engine/agents/n8n.ts`, marketplace) | n8n Cloud or self-hosted | Unknown (per-org config or `N8N_*`) | `tests/unit/n8n.test.ts` with mocked `fetch` (exact request shapes) | **No** |
| Microsoft 365 (Entra ID, Graph) | **No connector** (`implemented: "none"`); OIDC sign-in via generic provider only | Entra tenant + app registration | — | — | **No** |
| Google Workspace | **No connector** (`none`); OIDC sign-in possible via generic provider | Workspace tenant | — | — | **No** |
| Salesforce | **No connector** (`none`) | Salesforce org + connected app | — | — | **No** |
| HubSpot | Yes — full (`src/engine/connectors/hubspot.ts`: private-app token, test connection, sync summary) | HubSpot private app token | Unknown | `tests/unit/connectors.test.ts` with mocked `fetch` | **No** (catalog note: "not yet tested with a live HubSpot account") |
| QuickBooks | **No connector** (`none`); a `quickbooks` credential preset exists for agent HTTP steps; Skills Lab says QuickBooks/NetSuite "not built" | Intuit developer app (OAuth 2.0) | — | Agent HTTP path only, against the mock | **No** |
| ERP (SAP, Oracle, NetSuite, Workday, ADP, ServiceNow) | **No connectors** (`none`) | Vendor licences / partner programmes | — | — | **No** |
| Power Automate Process Mining | Adapter: export mapper only; live API **not implemented**, reports `license_required` | Power Automate Premium + Process Mining, Entra app | No (licence not held) | `tests/unit/process-mining.test.ts` (mapper) | **No** |
| UiPath Task Mining | Adapter: export mapper only; reports `license_required` | Automation Cloud Enterprise + Task Mining | No | same | **No** |
| Mimica | Adapter: export mapper only; reports `license_required` | Mimica subscription (API not self-serve) | No | same | **No** |
| Stripe (billing) | Yes — env: Checkout, Portal, webhook signature, 6 event types, idempotent ledger | Stripe account, Prices | Unknown (the app reports "Stripe is not configured" whenever `STRIPE_SECRET_KEY` is absent) | `tests/unit/billing.test.ts` (mocked client, `generateTestHeaderString`); e2e covers the *unconfigured* path | **No** (not even test mode) |
| OIDC SSO (Entra ID / Okta / Google) | Yes — generic Auth.js OIDC provider + JIT user | IdP tenant | Unknown | **None** | **No** |
| Email (agent `notify`, invitations) | **Not implemented**: `notify` records `delivered:false`; invitation links are shown to copy, not emailed | SMTP / email provider | — | runner test asserts `delivered:false` | **No** |
| Cron / scheduler (`/api/jobs/run`, `vercel.json` `0 9 * * *`) | Yes; daily on Hobby + `after()` kicks (`src/lib/job-kick.ts`) | Vercel (Hobby: once a day) | `CRON_SECRET` presence unknown from here | `tests/unit/collect-api.test.ts` (cron auth, retry/backoff), `tests/unit/jobs-runner.test.ts` (claims, concurrency, stale recovery, budget) | **Unknown** — whether the production cron has completed a tick is shown live by the readiness check *Scheduler ran within 26 h* |
| Desktop collector | Yes (`collector/`) | Code-signing certificates, MDM | n/a | `tests/unit/collect-api.test.ts`; e2e protocol run; `--simulate` on Linux | **No** real Windows/macOS device |

## How to move a row to "live-tested"

Exercise the integration against the real service from a deployment built from the RC commit, then record it:

```bash
npm run readiness:record -- --gate live_integrations --status pass --environment production \
  --command "<what you ran, e.g. Stripe test-mode checkout → webhook → portal>" --evidence "<ids / screenshots / log lines>"
```

One evidence row covers the gate; list every integration you verified in `--evidence` and update this table in the
same commit. Until then the `live_integrations` gate at `/admin/readiness` shows **Not verified**.
