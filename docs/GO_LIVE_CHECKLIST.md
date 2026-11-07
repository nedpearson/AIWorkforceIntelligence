# Go-live checklist

Tick only what you did yourself against the deployment you are releasing. Where a step has a readiness gate, record
the evidence with `npm run readiness:record` (from a machine with the production `DATABASE_URL`) so
`/admin/readiness` reflects it.

## Before the deploy
- [ ] CI green on GitHub for the RC commit → `--gate ci_green --environment ci`
- [ ] `npx tsc --noEmit`, `npx vitest run`, `npx playwright test` green on the RC (local or CI) → gates `e2e`,
      `critical_workflows`, `tenant_isolation`, `financial_reconciliation`, `agent_execution`, `accessibility`
- [ ] Vercel Production env: `DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`, `NEXT_PUBLIC_APP_URL`, `VAULT_KEY`,
      `CRON_SECRET` set; **`BOOTSTRAP_SEED_DEMO` unset, `ALLOW_DEMO_LOGINS` unset, `SEED_PASSWORD` unset**
- [ ] Neon: history retention checked; a branch/snapshot taken right before the deploy (docs/ROLLBACK_PLAN.md §4)
- [ ] Previous production deployment URL noted for rollback

## Deploy
- [ ] Merge → Vercel production build; build log shows `[bootstrap] applied 0005_security_readiness.sql` (first time)
      and **no** `[bootstrap] seed:` line
- [ ] `curl -s https://app.bridgebox.ai/api/health` → exactly `{"ok":true,"version":"<sha7>"}`
- [ ] `curl -sI https://app.bridgebox.ai/login` shows `content-security-policy` with `'nonce-` and
      `strict-transport-security`
- [ ] Sign in as the platform owner → redirected to `/app/settings/security?mfa=required` → enrol MFA → sign in again
      with the code (live check *Platform owner MFA enabled* turns green)
- [ ] Try `owner@bridgebox.demo` with the README password → refused
- [ ] `npm run readiness:record -- --sync-findings` against production (fills the findings register)
- [ ] Open `/admin/readiness`: *Production configuration* passes (DB, 6/6 migrations, env vars, CSP)

## First 24 hours
- [ ] Vercel → Cron Jobs: `/api/jobs/run` returned 200 at 09:00 UTC; readiness *Scheduler ran within 26 h* green
- [ ] Settings → Audit log → *Verify audit chain* intact for the consultancy org
- [ ] Browser console on the main pages: no CSP violations
- [ ] Error tracking / uptime alert configured → `--gate monitoring`

## Pilot client onboarding (per client)
- [ ] Owner policy: *Require MFA for owners and admins* switched on in the client org
- [ ] Authorization signed, notice published (collection is refused until employees acknowledge the current version)
- [ ] Collector installed on the pilot devices and seen `active` (gate `desktop_collectors` once a week completes)
- [ ] Counsel sign-off on notice/authorization for the client's state (gate `privacy_review`)
