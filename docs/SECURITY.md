# Security

What protects what, where it is implemented, which test proves it, and what is still missing. Nothing in this file
is aspirational: if a control is listed, it is in the code at the path given; if it is a gap, it is in §13.

## 1. Threat model

| Asset | Threat | Primary control |
|---|---|---|
| Employee activity metadata (`activity_events`) | cross-tenant read; de-anonymization; collection outside authorization | RLS + `withTenant`; metadata-only protocol with forbidden-key rejection; salted on-device title hashes; three ingest gates |
| Employee compensation (`employees.base_annual_cost`, `loaded_hourly_cost`) | exposure to managers/viewers | `employees:cost:read` permission; cost columns hidden for `manager`/`viewer` (e2e `auth.spec.ts`) |
| Credentials for client systems (`credentials.*_enc`) | theft from DB dump or logs | AES-256-GCM with env-only `VAULT_KEY`; values never returned after save; redaction of every secret string in run logs/outputs |
| Collector bearer tokens | replay from another org; forged events | token stored as `sha256`; body `collectorId` must equal the token's collector (403); everything scoped to the token's org |
| Session / account | credential stuffing, MFA bypass, session theft | bcrypt (cost 10), TOTP enforced inside `authorize()`, Postgres-backed login/MFA rate limits (§9), httpOnly cookies, 12 h JWT revocable via `session_version` (§3), demo accounts refused in production (SEC-001), audit of failures |
| Scheduler and webhooks | unauthenticated job execution; forged Stripe events | `CRON_SECRET` with constant-time compare; Stripe signature verification; idempotent event ledger |
| Agent actions on client systems | runaway or malicious automation | approval gates with expiry, policy modes, compensation/rollback, per-org credential lookup, no `eval` templating |
| Consultancy staff | acting in a client org they do not manage | `listUserOrgs` / `assertClientOfConsultancy` parent check before any cross-org read; org switch validated server-side |

Out of scope for this build: endpoint security of employee machines, the client's own IdP, Postgres host hardening,
DDoS.

## 2. Authentication (`src/lib/auth.ts`, `src/lib/mfa.ts`)

- **Password:** Auth.js Credentials provider → `authorizeCredentials()` in `src/lib/authorize.ts`; `bcryptjs.compare`
  against `users.password_hash` (seed uses cost 10). Failed attempts audit `auth.login_failed` with the email; success
  audits `auth.login` and sets `last_login_at`. Before bcrypt: per-IP budget (every attempt) and per-email failure
  budget (`RATE_LIMITED`, audited `auth.login_rate_limited`).
- **Demo accounts (SEC-001):** under a production runtime (`VERCEL_ENV=production` or `NODE_ENV=production`) an account
  whose email ends in `.demo`, or whose memberships are all in `is_demo` orgs, is refused exactly like a wrong password
  (audited `auth.login_blocked_demo`) unless `ALLOW_DEMO_LOGINS=1` (CI/e2e only). The build seeds the demo only with
  `BOOTSTRAP_SEED_DEMO=1`, and production seeding refuses the README password (`resolveSeedPassword()`). The login page
  hides the demo hint whenever demo logins are refused. Tests: `tests/unit/security-auth.test.ts`.
- **MFA:** TOTP via `otplib`. The secret is stored vault-encrypted (`mfa_secret_enc`) and verified inside `authorize()`,
  so a password alone never yields a session when `mfa_enabled` is true (`MFA_REQUIRED` / `MFA_INVALID` errors; failures
  audit `auth.mfa_failed`). Wrong codes count against a per-user budget (5 / 15 min) at sign-in and in
  `mfaConfirm`/`mfaDisable`; once exhausted even a correct code is refused (`MFA_RATE_LIMITED`). Enrollment/disable live
  in `/app/settings/security` (`mfaStart`, `mfaConfirm`, `mfaDisable`, audited `mfa.*`). No recovery codes exist (§13).
- **MFA policy:** an owner can require MFA for owners/admins (and consultants acting in the org):
  `organizations.settings.requireMfaForAdmins`, audited `mfa.policy_updated`. The platform owner (`OWNER_EMAIL`) is
  always required. An affected user without MFA is redirected from every `/app` and `/admin` page to
  `/app/settings/security?mfa=required` (banner) and API routes answer 403 `mfa_enrollment_required`; sign-in and the
  enrolment page itself are never blocked (`src/lib/mfa-policy.ts`, `tests/unit/mfa-policy.test.ts`). Direct
  server-action calls are not gated (SEC-012).
- **SSO:** a generic OIDC provider is registered only when `OIDC_ISSUER` and `OIDC_CLIENT_ID` are set. On first login
  a user row is created just-in-time from `sub`/`email` (audit `auth.sso_jit_user_created`); the user still needs a
  membership (invitation) to reach any org. SSO users have no password hash. Untested against a real IdP (§13).
- **Invitations:** `src/engine/onboarding.ts` — token-based invite links (`/invite/[token]`), expiry, one-time accept,
  audits `invitation.*` and `auth.user_created_via_invite`.

## 3. Sessions

JWT strategy, `maxAge` 12 h, cookie set by Auth.js (`httpOnly`, `sameSite=lax`, `secure` in production, `trustHost`).
The active organization is a second cookie `bb_org` (httpOnly, lax, secure in production) written only by
`POST /api/org/switch` after `listUserOrgs()` confirms membership or consultancy parentage (403 otherwise; e2e
`tenant-isolation.spec.ts` forges it and expects rejection). `src/middleware.ts` only redirects cookie-less requests to
`/login`; authorization is re-derived on every server request by `getCtx()`.

**Revocation (migration 0005, `src/lib/sessions.ts`).** Every token carries `sv` = `users.session_version` at sign-in.
`getCtx()` reads the version in the same query that loads memberships and returns no context (→ `/login`, API 401) when
the token's `sv` differs, or when the user has neither a password hash nor an SSO subject (e.g. SEC-001's revoked
accounts). `getValidSession()` applies the same check where no org is needed (org switch, invitations). The version is
bumped (audited `auth.sessions_revoked` with the reason) on password change, MFA enable/disable, membership removal
(client settings and consulting team), a changed `OWNER_PASSWORD_HASH`, "Sign out all my sessions", and the owner's
"Sign out everyone in <org>". After a bump of their own version the browser is signed out and must sign in again.
Tokens issued before 0005 have no `sv` and count as version 0. Tests: `tests/unit/sessions.test.ts`,
`tests/e2e/security.spec.ts` › session revocation.

## 4. RBAC (`src/lib/rbac.ts`)

Roles: `owner`, `admin`, `manager`, `employee`, `consultant` (a consultancy member acting inside a client), `viewer`.
Checked with `requireCtx(perm)` (pages/actions → redirect `/app?denied=<perm>`) or `requireApiCtx(perm)` (routes →
401/403). The matrix below is `PERMISSIONS` verbatim.

| Permission | owner | admin | manager | employee | consultant | viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `org:manage` | ✓ | ✓ | | | ✓ | |
| `org:billing` | ✓ | | | | ✓ | |
| `members:invite` | ✓ | ✓ | | | ✓ | |
| `employees:read` | ✓ | ✓ | ✓ | | ✓ | ✓ |
| `employees:cost:read` | ✓ | ✓ | | | ✓ | |
| `employees:write` | ✓ | ✓ | | | ✓ | |
| `collectors:manage` | ✓ | ✓ | | | ✓ | |
| `campaigns:manage` | ✓ | ✓ | | | ✓ | |
| `analysis:run` | ✓ | ✓ | | | ✓ | |
| `workflows:read` | ✓ | ✓ | ✓ | | ✓ | ✓ |
| `opportunities:read` | ✓ | ✓ | ✓ | | ✓ | ✓ |
| `opportunities:write` | ✓ | ✓ | | | ✓ | |
| `agents:read` | ✓ | ✓ | ✓ | | ✓ | ✓ |
| `agents:write` | ✓ | ✓ | | | ✓ | |
| `agents:approve` | ✓ | ✓ | ✓ | | | |
| `credentials:manage` | ✓ | ✓ | | | | |
| `finance:read` | ✓ | ✓ | ✓ | | ✓ | ✓ |
| `finance:write` | ✓ | ✓ | | | ✓ | |
| `reports:generate` | ✓ | ✓ | | | ✓ | |
| `self:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `audit:read` | ✓ | ✓ | | | ✓ | |

Two deliberate asymmetries: a `consultant` cannot approve agent actions or manage client credentials (those stay
with the client's own owner/admin), and `employee` can only see their own Trust page.

## 5. Tenant isolation

### Database (`drizzle/rls.sql`, applied by `scripts/migrate.ts`)

| Policy | Table(s) | Rule |
|---|---|---|
| `tenant_isolation` | `memberships`, `invitations`, `departments`, `employees`, `consent_records`, `authorizations`, `collectors`, `observation_campaigns`, `activity_events`, `workflows`, `workflow_employees`, `analysis_runs`, `opportunities`, `credentials`, `agents`, `agent_runs`, `approvals`, `savings_measurements`, `financial_models`, `projects`, `reports`, `subscriptions`, `invoices`, `integrations` | `USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())` |
| `org_self` | `organizations` | `id = app_current_org() OR parent_org_id = app_current_org()` (a consultancy sees its children) |
| `users_in_org` | `users` | row visible only if a membership in the current org exists |
| `audit_org` | `audit_log` | own org, `WITH CHECK` on insert |
| `jobs_org` | `jobs` | own org |

All tables have `ENABLE ROW LEVEL SECURITY` and **`NO FORCE`** (`drizzle/rls.sql`): the table owner — the
`DATABASE_URL` role used by the admin handle — bypasses RLS by design (an earlier version of this document said
`FORCE`; corrected, SEC-010). `rate_limits`, `readiness_evidence` and `security_findings` have RLS enabled with no
policy, so the app role sees no rows. The non-login role `bridgebox_app` holds DML grants and is
what `withTenant` switches to with `set_config('role', 'bridgebox_app', true)`; `app_current_org()` reads
`app.current_org`. A statement outside `withTenant` runs as the connecting role, which must therefore be treated as an
admin credential (§12).

### Application
`withTenant(orgId, fn)` rejects non-UUID ids, opens a transaction, sets the org and role, and runs `fn`. Code also
filters by `orgId` explicitly (defence in depth, `docs/CONVENTIONS.md`). The consultancy access rule: a user whose
membership in a `consultancy` org has role owner/admin/consultant may act as `consultant` inside any org whose
`parent_org_id` is that consultancy — resolved in `getCtx()` and `listUserOrgs()`, enforced again by
`assertClientOfConsultancy` in portal actions.

### Tests that prove it

| Test | What it shows |
|---|---|
| `tests/unit/collect-api.test.ts` › "a token from org A can never write into org B" | collector bearer token scoping + `collectorId` mismatch → 403 |
| `tests/unit/agents-runner.test.ts` › "cross-tenant: org A run cannot use org B's credential (RLS + explicit filter)" | credential lookup inside `withTenant` cannot see another org's row |
| `tests/unit/onboarding.test.ts` › `describe("tenancy")` | `assertClientOfConsultancy` rejects a client that is not a child of the consultancy |
| `tests/e2e/tenant-isolation.spec.ts` (3 tests) | Bayou Dental's owner sees only their org, gets 404 for Gulf Coast workflow/opportunity/employee/agent ids and for `/api/reports/[id]`, has no org switcher, and a forged `POST /api/org/switch` is refused; Gulf Coast's owner reaches the same ids; the consultancy owner switches in legitimately |
| `tests/e2e/finance-reports.spec.ts` › "another org's owner gets 404 for that id" | report download is tenant-scoped |
| `tests/e2e/auth.spec.ts` › manager tests | `manager` blocked from `/app/settings` and `/admin`; cost columns hidden |

## 6. Secrets and the credential vault (`src/lib/crypto.ts`)

- `VAULT_KEY`: 32 bytes base64, environment only, never in the database. AES-256-GCM with a random 12-byte IV per
  value; output `base64(iv).base64(tag).base64(ct)`. Used for `credentials` secrets and `users.mfa_secret_enc`.
- Credentials UI (`/app/agents/credentials`, `credentials:manage`): presets smtp / http_bearer / quickbooks / hubspot /
  n8n / zendesk; secret values are never echoed back; `last_used_at` maintained by the runner; delete is blocked while an
  active agent references the credential (`credential.created` / `credential.deleted` audited).
- Collector tokens: `randomToken(32)` base64url; only `sha256(token)` is stored. Enrollment codes likewise
  (`enrollment_code_hash`).
- `hmacHash(s)` (HMAC-SHA256 keyed with `AUTH_SECRET`, 32 hex chars) hashes IPs in audit rows and collector hostnames.
- `safeEqual` (timing-safe) for `CRON_SECRET`.
- `.env` is git-ignored and docker-ignored; `.env.example` lists every variable with no values.

## 7. Audit logging (`src/lib/audit.ts`, `audit_log`)

Every mutation writes `{ orgId, actorUserId, actorType (user|collector|system|agent), action, entityType, entityId,
details, ipHash }`. Insert failures are logged to stderr and never block the request. Readable at
`/app/settings/audit` (`audit:read`). Action names present in the code (grep `action: "`):

`agent.approval.expired` `agent.approval.requested` `agent.created` `agent.definition.updated` `agent.measured`
`agent.run.retry` `agent.run.start` `agent.settings.updated` `analysis.enqueued` `analysis.requested`
`assistant.question` `auth.login` `auth.login_blocked_demo` `auth.login_failed` `auth.login_rate_limited`
`auth.mfa_failed` `auth.mfa_rate_limited` `auth.org_sessions_revoked` `auth.sessions_revoked` `auth.sso_jit_user_created`
`auth.user_created_via_invite` `authorization.recorded` `billing.checkout_started` `billing.plan_set_locally`
`billing.portal_opened` `billing.sync_all` `billing.synced` `billing.webhook` `branding.updated` `client.created`
`collector.config_updated` `collector.enroll_failed` `collector.enrolled` `collector.enrollment_code_created`
`collector.offline` `collector.paused` `collector.resumed` `consent.acknowledged` `consent.requested`
`consent.withdrawn` `credential.created` `credential.deleted` `demo_data.generated` `financial_model.updated`
`integration.configured` `integration.disconnected` `integration.tested` `invitation.accepted` `invitation.created`
`invitation.revoked` `membership.removed` `membership.role_changed` `mfa.confirm_failed` `mfa.disable_failed`
`mfa.disabled` `mfa.enabled` `mfa.enrollment_started` `mfa.policy_updated` `notice.updated` `org.created_by_consultancy` `org.updated`
`password.change_failed` `password.changed` `privacy.activity_events_deleted` `privacy.export`
`privacy.retention_sweep` `project.deleted` `report.downloaded` `report.generated` `retention.sweep`

Templated families: `agent.<status>`, `agent.approval.<approved|rejected>`, `agent.run.<status>`,
`campaign.<status>`, `collector.<pause|resume|revoke>d`, `opportunity.<action|status>`.

**Hash chain (migration 0005).** Each row stores `prev_hash` and `hash = sha256(canonical([prev_hash, org_id,
actor_user_id, actor_type, action, entity_type, entity_id, details, ip_hash, ts]))`, chained per org (NULL org = global
chain); inserts for one org are serialised with `pg_advisory_xact_lock`. `verifyAuditChain(orgId)` walks the chain and
reports the first edited row (`hash_mismatch`) or the row after a deleted/inserted one (`prev_hash_mismatch`); owners
and admins run it from **Settings → Audit log → Verify audit chain**, and `/admin/readiness` verifies every chain live.
Rows written before 0005 are reported as `legacy`. Limit: deleting the newest rows is only detectable against an
external copy of the head hash; the admin role can still rewrite a whole chain. Tests: `tests/unit/audit-chain.test.ts`.

## 8. HTTP headers (`next.config.ts`)

Applied to every route (`next.config.ts`): `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(self), geolocation=()`.
Every page (`src/middleware.ts`, `src/lib/csp.ts`) also gets a per-request nonce CSP:
`default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self'
data: blob: https:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob: data:; worker-src 'self' blob:;
frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` (+
`upgrade-insecure-requests` over HTTPS). Next.js stamps the nonce on its scripts; the root layout passes it to the
inline theme script. Styles keep `'unsafe-inline'` (React style attributes); `img-src https:` keeps client logo URLs
working. `Strict-Transport-Security: max-age=63072000; includeSubDomains` is sent when the request arrived over HTTPS.
API routes carry the static headers only. Server actions accept bodies up to 4 MB. Tests: `tests/unit/csp.test.ts`,
`tests/e2e/security.spec.ts` (zero CSP violations on every owner nav page and the portal).

## 9. Rate limiting and payload limits

All limits use one Postgres fixed-window limiter (`src/lib/rate-limit.ts`, table `rate_limits`, migration 0005): one
atomic `INSERT … ON CONFLICT DO UPDATE` per hit, window start from the database clock, keys HMAC-hashed (no emails or
IPs in clear). Shared by every instance and survives restarts. If the limiter itself errors (e.g. before migration 0005)
the request is allowed and the error logged. Expired windows are swept by the scheduler tick.

| Where | Limit | Key |
|---|---|---|
| Sign-in, every attempt | 100 / 15 min | client IP (`x-forwarded-for`, set by Vercel) |
| Sign-in, failures | 10 / 15 min, checked before bcrypt (the right password is refused once exhausted) | email |
| MFA code failures (sign-in, enrol, disable) | 5 / 15 min | user |
| `/api/collect/*` (authenticated) | 60 / min | collector |
| `/api/collect/enroll` | 20 / min | IP |
| `/api/assistant` POST, Brain "Ask" | 30 / min | user |
| `/api/skills/run` POST | 20 / min | org + user |
| `/api/brain/upload`, `/api/media` POST | 20 / 10 min | user |
| Event batch | ≤ 5000 events, ≤ 2 MB body (413) | `MAX_EVENTS_PER_BATCH`, `MAX_BODY_BYTES` |
| Brain upload request | ≤ 25 MB (content-length, before parsing), ≤ 20 files, ≤ 10 MB each | `MAX_UPLOAD_REQUEST_BYTES` |
| `/api/jobs/run` | `limit` capped at 50 per tick, 45 s claim budget | route |
| Report generation, other server actions | **none** | — |

Tests: `tests/unit/rate-limit.test.ts` (incl. 50 concurrent hits → counts 1..50, exactly `limit` allowed),
`tests/unit/security-auth.test.ts`.

### Upload hardening (AI Brain, `src/engine/brain/extract.ts`, `quota.ts`)
Filenames are sanitised (directories, control/bidi characters, reserved characters, leading dots stripped; ≤ 150
chars). Binary formats must match magic bytes (`%PDF`, `PK\3\4`); text formats (txt, md, csv, json) must be
valid UTF-8 without NUL bytes. `.docx` central directories are inspected before mammoth runs: ≤ 2000 entries, ≤ 50 MB
declared uncompressed, ≤ 100× ratio for entries over 1 MB, no ZIP64, no encryption, must contain `word/document.xml`.
Declared sizes can be forged; actual inflation is bounded only by the 10 MB compressed cap (SEC-007 residual). Each org
may store 50 MB of document text (`BRAIN_ORG_QUOTA_BYTES`). Tests: `tests/unit/upload-security.test.ts`. CSV and
JSON stay accepted as text-sniffed formats; HTML/HTM uploads are rejected (owner decision 2026-11-07 — save web pages as PDF).

## 10. Collector token lifecycle

1. Admin creates an enrollment code (`collectors:manage`; 7-day, single use; stored hashed; audited
   `collector.enrollment_code_created`). Seat limits may refuse (`assertSeatAvailable`).
2. Collector `POST /api/collect/enroll` with the code, platform, hostname, version (IP-limited; bad/used code → 401 and
   `collector.enroll_failed` with hashed IP). Response carries the bearer token once; the server keeps `sha256`.
3. Every later call is `Authorization: Bearer <token>`; lookup by hash via the admin handle (the one sanctioned use),
   then everything runs inside `withTenant(collector.orgId)`. Body `collectorId` ≠ token's collector → 403.
4. Status transitions: `pending → active` on enrol; `paused` by employee/admin (`paused_until`); `offline` when no
   heartbeat for 15 min (job), back to `active` on heartbeat; `revoked` by admin → every call 403 and the collector
   exits.
5. There is no token rotation; revoke and re-enrol. Tokens live in `collector.json` with mode 600 on the employee
   machine.

## 11. Agent execution safety (`src/engine/agents/runner.ts`)

- **Approval gates:** `approval` nodes create `approvals` rows and park the run as `awaiting_approval`; policy modes
  `all` / `sensitive_only` (default) / `none`; `approverRole` default `manager`; `timeoutHours` default 72 after which
  `expireApprovals` marks them expired and the run is cancelled (audited). Only `agents:approve` roles can decide.
- **Credential scoping:** the runner resolves `credentialProvider` only among the agent's attached `credentialIds`,
  inside `withTenant` (tested cross-tenant).
- **Redaction:** every string equal to a decrypted secret is replaced with `[redacted]` in step logs, persisted outputs
  and approval payloads.
- **Templating without eval:** `{{secret.x}}`, `{{input.x}}`, `{{nodes.<id>.body.x}}` resolved by `getPath`; no code
  execution.
- **Retries and compensation:** per-node retries with backoff; after exhaustion, completed `action` nodes with a
  `compensate` block are reversed in order and the run ends `rolled_back`.
- **LLM node:** skipped with an explicit reason when `ANTHROPIC_API_KEY` is absent; 60 s timeout; retry on 429/5xx.
- **Measurement honesty:** `minutesSaved` is the agent's declared expectation per successful run; verified dollars are
  computed only from `succeeded` runs and labelled by method.
- **n8n path:** credentials for external systems live inside n8n; BridgeBox stores only the n8n API key (vault).

## 12. Operational rules

- The `DATABASE_URL` role is an admin credential: it bypasses RLS whenever code uses `db` directly. Do not share it
  with reporting tools; give them a role that cannot `SET ROLE` past `bridgebox_app`.
- Rotate `AUTH_SECRET` to invalidate every session; rotating `VAULT_KEY` requires re-encrypting
  `credentials` and `users.mfa_secret_enc` (no tooling exists yet).
- Keep `CRON_SECRET` out of URLs; it is sent as a header.
- Back up Postgres with the audit log; see `docs/DEPLOYMENT.md` §E.

## 13. Known gaps (ordered by how much they matter before a paying client)

The findings register with severities and status is `src/engine/readiness/findings.ts` (rendered at `/admin/readiness`,
details in `docs/SECURITY_VERIFICATION.md`).

| Gap | Impact | Direction |
|---|---|---|
| Rate limits are application-level only | a distributed attack still reaches the function and the database | Vercel Firewall rule in front of `/api/auth/*` and `/api/collect/enroll` |
| No WAF / bot protection | abuse of public endpoints (`/api/collect/enroll`, `/invite/[token]`) | Vercel Firewall or Cloudflare in front |
| PDF bytes stored base64 in `reports.pdf_bytes` | table bloat, slow backups, 4 MB action limit | object storage (S3/R2) with signed URLs |
| No key-rotation tooling for `VAULT_KEY` | rotation is a manual re-encrypt script that does not exist | `scripts/rotate-vault-key.ts` |
| No MFA recovery codes | a lost phone needs an operator to clear `mfa_enabled` in the database | recovery codes |
| MFA enrolment gate does not cover direct server-action calls (SEC-012) | an un-enrolled admin can still call an action by id | check `ctx.mfaRequired` in `requireCtx(perm)` |
| OIDC never exercised against a provider | SSO may fail on first real tenant | certify against Entra ID and Okta |
| Collector binaries unsigned, untested on real Windows/macOS | SmartScreen/Gatekeeper blocks, unknown `active-win` behaviour | code signing + notarization + MDM packages |
| Audit chain has no external anchor (SEC-008) | truncating the newest rows or rewriting a whole chain is undetectable | ship head hashes to an append-only store / SIEM |
| No secrets scanning, dependency audit or SAST in CI | supply-chain and regression risk | `npm audit`, CodeQL, gitleaks steps |
| `audit()` swallows insert failures | a DB outage silently drops audit rows | alert on the stderr pattern; consider failing the mutation |
| No SOC 2 / pen test | procurement blocker for larger clients | see `docs/IMPLEMENTATION_PLAN.md` phase 5+ |
