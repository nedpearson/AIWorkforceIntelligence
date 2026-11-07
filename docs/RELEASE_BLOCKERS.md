# Release blockers

What stands between the release candidate and (a) a **supervised pilot** with one friendly client and (b) an
**enterprise** launch. Each item names the readiness gate (`/admin/readiness`) it keeps from passing, an owner and the
next action. The live page is authoritative; this file is the snapshot of 2026-11-07, branch `fix/security-readiness`.

## A. Blocks everything (including a supervised pilot)

| # | Blocker | Gate | Owner | Next action |
|---|---|---|---|---|
| 1 | Security branch not deployed: production still runs the code with SEC-002…SEC-007 and SEC-011 open | security_findings, authn_authz, production_config | Platform owner | Merge `fix/security-readiness`, apply migration 0005 (build bootstrap does it), promote; confirm `/api/health` returns `{ok, version}` only |
| 2 | Platform owner account has no MFA (SEC-009) | authn_authz (live check) | Platform owner | After deploy, sign in → enrol at `/app/settings/security` (the app sends you there) |
| 3 | CI has not been seen green on GitHub for the RC commit | ci_green | Engineering | Push the branch; record the Actions run URL |
| 4 | Backup restore never rehearsed | backup_restore | Platform owner | Neon branch from a timestamp → preview deploy → verify (docs/ROLLBACK_PLAN.md §5) |
| 5 | Rollback never rehearsed | rollback | Platform owner | Promote previous deployment and back in a quiet window |
| 6 | Production scheduler tick never confirmed | monitoring (live check `cron_recent`) | Platform owner | Check Vercel → Cron Jobs → logs for `/api/jobs/run` 200; confirm `CRON_SECRET` is set |

## B. Blocks a paying / enterprise client (pilot may proceed with explicit caveats)

| # | Blocker | Gate | Owner | Next action |
|---|---|---|---|---|
| 7 | Collector never run on real Windows/macOS; binaries unsigned | desktop_collectors | Engineering | Friendly-user pilot week; code signing + notarization |
| 8 | No integration live-tested (Anthropic, n8n, Stripe, OIDC, HubSpot) | live_integrations | Engineering | docs/INTEGRATION_VERIFICATION.md |
| 9 | No real client data: verified savings are synthetic | evidence_savings | Consulting | First pilot client |
| 10 | Performance targets not agreed; dashboards > 1 s at 2,000 employees; 100k untested | performance | Engineering | docs/PERFORMANCE_RESULTS.md |
| 11 | No counsel review of notice/authorization/processor agreement | privacy_review | Legal | docs/PRIVACY.md §10 |
| 12 | No error tracking / uptime monitoring | monitoring | Platform owner | Add Sentry (or Vercel monitoring) + an uptime probe on `/api/health` |
| 13 | No dependency audit / SAST / secret scanning in CI (SEC-013); npm audit shows 3 high + 3 moderate advisories in production deps, rated medium on exploitability (SEC-015); 8 Dependabot alerts untriaged | security (medium) | Engineering | Overrides/upgrades; add audit, CodeQL, gitleaks steps to ci.yml |
| 14 | Email delivery not implemented; QuickBooks/ERP/M365/Google/Salesforce connectors not built | live_integrations | Engineering | Scope per client |
| 15 | Vercel Hobby: cron once a day; functions ≤ 60 s; analysis not chunked | monitoring / performance | Platform owner | Pro plan or external scheduler + worker for large tenants (docs/DEPLOYMENT.md) |

## C. Known residual risks accepted for a pilot (documented, not blocking)

SEC-008 (audit chain has no external anchor), SEC-012 (MFA gate vs direct server-action calls), SEC-014 (IP trust off
Vercel), SEC-007 residual (declared zip sizes), no MFA recovery codes, no WAF.
