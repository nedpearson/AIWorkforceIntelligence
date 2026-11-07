# Security verification

Findings from the security + production-readiness pass on branch `fix/security-readiness` (2026-11-07), ordered by
severity. The machine-readable register is `src/engine/readiness/findings.ts` (synced to table `security_findings`,
shown at `/admin/readiness`). "Remediated" means fixed in this branch's code (and, for SEC-001, in production data);
**production keeps the old behaviour until this branch is deployed**. Nothing below was run against production by
this pass. Test runs that back each claim are listed in §3.

## 1. Findings

### High

**SEC-001 — Published demo password valid on production accounts (remediated).**
- *Repro (before):* any Vercel production build ran `scripts/bootstrap-on-build.ts`, which seeded the demo unless
  `BOOTSTRAP_SEED_DEMO=0`; `src/engine/seed.ts` hashed `Demo!Pass123` (README). Sign in as `owner@bridgebox.demo` →
  owner of the real *BridgeBox Consulting* org, which manages every client tenant.
- *Production data:* 4 `*.demo` accounts accepted the password; the audit log showed 0 logins and 0 failed logins by
  them; no sessions existed. Remediated 2026-11-07 by `scripts/revoke-demo-credentials.ts --apply` (password_hash NULL
  + audit rows), commit `3f3799c` — performed and verified before this pass, not re-run here.
- *Fix (code):* `shouldSeedOnBuild()` seeds only on `BOOTSTRAP_SEED_DEMO=1` (`src/lib/runtime-env.ts`);
  `resolveSeedPassword()` refuses the default and < 16-char passwords in any production runtime and otherwise generates
  a random one it never prints (`src/engine/seed.ts`); `authorizeCredentials()` refuses `.demo` and demo-org-only
  accounts in production unless `ALLOW_DEMO_LOGINS=1` (`src/lib/authorize.ts`); the login page hides the demo hint
  (`src/app/login/page.tsx`); `/api/admin/bootstrap?step=seed` is refused in production (SEC-011); `getCtx()` rejects
  tokens of users with neither password nor SSO subject (`src/lib/sessions.ts`). `upgradeDemo()` still upgrades demo
  org content and never touches credentials.
- *Evidence:* `tests/unit/security-auth.test.ts` (9 tests: seeding policy, password policy, demo detection, production
  refusal + `ALLOW_DEMO_LOGINS`, real/mixed accounts allowed). Live check *Demo accounts with a password = 0* at
  `/admin/readiness`.

**SEC-003 — No login/MFA rate limit; collector limiter per process (remediated).**
- *Repro (before):* unlimited `POST /api/auth/callback/credentials` attempts; unlimited TOTP guesses after a correct
  password; `rateLimitOk()` used an in-memory `Map`.
- *Fix:* `src/lib/rate-limit.ts` (Postgres, `rate_limits`); budgets in `docs/SECURITY.md` §9; wired in
  `src/lib/authorize.ts`, `src/app/app/settings/actions.ts` (MFA confirm/disable), `src/app/api/collect/_lib.ts`,
  `/api/assistant`, Brain ask, `/api/skills/run`, `/api/brain/upload`, `/api/media`.
- *Evidence:* `tests/unit/rate-limit.test.ts` (6, incl. 50 concurrent hits → counts exactly 1..50 and exactly `limit`
  allowed); `tests/unit/security-auth.test.ts` (email lockout, per-IP limit, MFA budget → `MFA_RATE_LIMITED`).

### Medium

**SEC-002 — `/api/health` disclosed configuration publicly (remediated).** *Repro:* `curl https://app.bridgebox.ai/api/health`
returned env-presence flags, `DB_SCHEMA` and the organization count. *Fix:* `src/app/api/health/route.ts` returns
`{ok, version}`; details need `Authorization: Bearer $CRON_SECRET` or a platform-owner session. *Evidence:*
`tests/unit/security-health.test.ts` (3), `tests/e2e/security.spec.ts` › health.

**SEC-004 — JWT sessions not revocable (remediated).** *Fix:* `users.session_version` (migration 0005) in the token,
checked in `getCtx()` / `getValidSession()`; bumped on password change, MFA enable/disable, membership removal,
owner password-hash rotation, "Sign out all my sessions", owner "Sign out everyone". *Evidence:*
`tests/unit/sessions.test.ts` (5); `tests/e2e/security.spec.ts` › a second browser session is refused (`/app` →
`/login`, `/api/assistant` → 401) after "Sign out all my sessions".

**SEC-005 — No Content-Security-Policy (remediated).** *Fix:* nonce CSP per request (`src/middleware.ts`,
`src/lib/csp.ts`), nonce on the inline theme script (`src/app/layout.tsx`), HSTS over HTTPS. *Evidence:*
`tests/unit/csp.test.ts` (4); `tests/e2e/security.spec.ts` (every owner nav page + portal pages: 200, theme applied,
zero `securitypolicyviolation` events / "Refused to …" console messages). Every `<script>` in the served `/login` HTML
carries the nonce (`curl -s :3200/login | grep -o '<script[^>]*>' | grep -vc nonce` → `0`).

**SEC-006 — Consent for an old notice version still allowed collection (remediated).** *Fix:* `consentState(orgId,
employeeId, currentNoticeVersion)`; ingest drops `consent_outdated`; `/api/collect/config` reports `missing` so the
collector re-prompts with the current notice. *Evidence:* `tests/unit/collect-api.test.ts` › consent version (SEC-006).

**SEC-007 — Brain upload hardening (remediated, residual).** *Fix:* see `docs/SECURITY.md` §9 "Upload hardening".
*Residual:* zip sizes are the declared ones; extraction still runs in-process. *Evidence:*
`tests/unit/upload-security.test.ts` (8: filenames, renamed binary rejected, magic bytes, 20 MB-of-zeros docx rejected
by ratio, declared-size / entry-count limits, non-Word zip, quota).

**SEC-009 — Platform owner without MFA (open, operational).** `nedpearson@gmail.com` owns every org and has no MFA
(stated in the task context; not re-queried). This branch routes the `OWNER_EMAIL` account to MFA enrolment on every
page until enrolled (`src/lib/mfa-policy.ts`) without blocking sign-in. *Next:* enrol after deploy; the live check
*Platform owner MFA enabled* turns green.

**SEC-013 — No dependency audit / SAST / secret scanning in CI (open).** *Next:* add `npm audit --omit=dev`, CodeQL,
gitleaks to `.github/workflows/ci.yml`.

### Low / info

- **SEC-008 — Audit tampering undetectable (open, partially mitigated).** Hash chain + verify (`src/lib/audit.ts`,
  Settings → Audit log → *Verify audit chain*, readiness live check). *Evidence:* `tests/unit/audit-chain.test.ts` (6:
  chaining, 25 concurrent writers stay linear, edited row → `hash_mismatch` at that row, deleted row and forged
  insertion → `prev_hash_mismatch`, legacy rows). *Residual:* tail truncation / whole-chain rewrite need an external
  anchor.
- **SEC-010 — Docs claimed `FORCE ROW LEVEL SECURITY` (remediated in docs).** `drizzle/rls.sql` sets `NO FORCE`; the
  admin handle bypasses RLS by design. `docs/SECURITY.md` §5 corrected.
- **SEC-011 — Bootstrap seed endpoint usable in production (remediated).** `src/app/api/admin/bootstrap/route.ts`.
- **SEC-012 — MFA gate does not cover direct server-action calls (open).**
- **SEC-014 — IP limits trust `x-forwarded-for` (accepted).** Correct on Vercel; documented for self-hosting.

## 2. Unauthenticated access audit — every route under `src/app/api`

Read from the code of each `route.ts` (2026-11-07). "Public" = reachable without a session.

| Route | Methods | Unauthenticated? | Guard | Disclosure notes |
|---|---|---|---|---|
| `/api/health` | GET | **public** | — / Bearer `CRON_SECRET` or platform owner for details | public body `{ok, version}` only (SEC-002 fixed) |
| `/api/auth/[...nextauth]` | GET, POST | **public** | Auth.js; credentials → `authorizeCredentials()` (rate-limited) | `/api/auth/providers` lists configured provider ids (standard) |
| `/api/billing/webhook` | POST, GET | **public** | Stripe signature (`verifyWebhook`); 503 unconfigured | GET returns a static descriptor; a signed request's 500 includes the error message (signature holders only) |
| `/api/collect/enroll` | POST | **public** (the one-time code is the credential) | rate limit 20/min/IP; code hashed, 7-day, single use | 401 reason distinguishes invalid vs expired code |
| `/api/collect/{config,consent,events,heartbeat,pause}` | GET/POST | bearer collector token | `authCollector` (sha256 lookup, 60/min, revoked/pending refused) | scoped to the token's org |
| `/api/jobs/run` | GET, POST | secret | `CRON_SECRET` (constant-time) | 503 hint names the env var only |
| `/api/admin/bootstrap` | POST | secret | `CRON_SECRET`; seed refused in production | error messages returned to secret holders |
| `/api/org/switch` | POST | session | `getValidSession()` + `listUserOrgs` | — |
| `/api/assistant` | GET, POST | session | `requireApiCtx("workflows:read")`, 30/min | 500 returns the error message to the signed-in user |
| `/api/assistant/action` | POST | session | `requireApiCtx("workflows:read")` + action allow-list | — |
| `/api/assistant/tours` | GET, POST | session | `requireApiCtx()` | — |
| `/api/brain/upload` | POST | session | `requireApiCtx` + `employees:write`/`org:manage`, 20/10 min, size/quota | — |
| `/api/export/[kind]` | GET | session | `requireApiCtx("finance:read")` | — |
| `/api/media` | POST | session | `requireApiCtx()` + per-kind permission, 20/10 min | — |
| `/api/media/[id]` | GET | session | `requireApiCtx()`, tenant-scoped | — |
| `/api/reports/[id]` | GET | session | `requireApiCtx("finance:read")`, tenant-scoped (404 cross-org, e2e) | — |
| `/api/reports/generate` | POST | session | `requireApiCtx("reports:generate")` | — |
| `/api/admin/reports/[id]` | GET | session | `getConsultant()` + client-of-consultancy check | — |
| `/api/skills/run` | GET, POST | session | `requireApiCtx("agents:read")` + `runSkill` RBAC/permission level, 20/min | — |
| `/api/skills/decide`, `/review` | POST | session | `requireApiCtx("agents:approve")` | — |
| `/api/skills/memory` | POST | session | `requireApiCtx("agents:write")` | — |

Every session route also gets the server-side revocation check and the MFA-enrolment gate via `requireApiCtx`.

## 3. Evidence runs

Recorded in `docs/LAUNCH_CERTIFICATION.md` §2 (commands, commit SHA, timestamps, results).
