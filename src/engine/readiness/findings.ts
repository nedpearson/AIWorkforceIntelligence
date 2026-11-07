/**
 * Security findings register — source of truth for table security_findings (synced by
 * `npm run readiness:record -- --sync-findings`). Details, repro and evidence: docs/SECURITY_VERIFICATION.md.
 * "remediated" means fixed in the code of the commit that carries this file (and, where stated, in production data);
 * a deployment built from an older commit does not have the fix.
 */
export type Finding = { id: string; title: string; severity: "critical" | "high" | "medium" | "low" | "info"; status: "open" | "remediated" | "accepted"; component: string; summary: string; fix: string; evidence: string; owner: string; nextAction: string };

export const FINDINGS: Finding[] = [
  { id: "SEC-001", title: "Published demo password valid on production accounts incl. owner of the real consultancy org", severity: "high", status: "remediated", component: "scripts/bootstrap-on-build.ts, src/engine/seed.ts, src/lib/authorize.ts",
    summary: "Every Vercel production build seeded the demo unless BOOTSTRAP_SEED_DEMO=0, using the README password Demo!Pass123; owner@bridgebox.demo owned the real BridgeBox Consulting org.",
    fix: "Production data: password hashes nulled by scripts/revoke-demo-credentials.ts --apply (2026-11-07, audit log showed 0 logins). Code: build seeds only with BOOTSTRAP_SEED_DEMO=1; production seeding refuses the default password; authorize() refuses demo accounts in production unless ALLOW_DEMO_LOGINS=1; login page hides the demo hint; getCtx() rejects tokens of users with no password and no SSO subject.",
    evidence: "tests/unit/security-auth.test.ts (SEC-001 block); commit 3f3799c (revocation) + this branch", owner: "Platform owner", nextAction: "Deploy this branch; keep BOOTSTRAP_SEED_DEMO and ALLOW_DEMO_LOGINS unset in production." },
  { id: "SEC-002", title: "/api/health disclosed env-variable presence and organization count publicly", severity: "medium", status: "remediated", component: "src/app/api/health/route.ts",
    summary: "Unauthenticated GET returned which secrets were configured, DB_SCHEMA and the number of organizations.",
    fix: "Public response is {ok, version}; details require Authorization: Bearer $CRON_SECRET or a platform-owner session.", evidence: "tests/unit/security-health.test.ts", owner: "Engineering", nextAction: "Deploy." },
  { id: "SEC-003", title: "No rate limit on login or MFA; collector limiter in process memory", severity: "high", status: "remediated", component: "src/lib/authorize.ts, src/lib/rate-limit.ts",
    summary: "Credential stuffing and 6-digit TOTP brute force were limited only by network speed; the collector limiter reset per instance.",
    fix: "Postgres fixed-window limiter (rate_limits): login per IP (100/15 min) and per-email failures (10/15 min), MFA failures (5/15 min per user), collector requests, enroll, assistant/brain ask, skill runs, uploads.", evidence: "tests/unit/rate-limit.test.ts (incl. 50 concurrent hits)", owner: "Engineering", nextAction: "Deploy; consider a Vercel Firewall rule in front of /api/auth as defence in depth." },
  { id: "SEC-004", title: "JWT sessions could not be revoked", severity: "medium", status: "remediated", component: "src/lib/sessions.ts, src/lib/session.ts",
    summary: "A stolen or offboarded session stayed valid for up to 12 h.", fix: "users.session_version embedded in the token and checked by getCtx(); bumped on password change, MFA change, member removal, owner password-hash rotation and 'Sign out all sessions'.",
    evidence: "tests/unit/sessions.test.ts", owner: "Engineering", nextAction: "Deploy (migration 0005)." },
  { id: "SEC-005", title: "No Content-Security-Policy", severity: "medium", status: "remediated", component: "src/middleware.ts, src/lib/csp.ts, src/app/layout.tsx",
    summary: "Any XSS would run with full page privileges.", fix: "Per-request nonce CSP with strict-dynamic; theme script nonce'd; HSTS over HTTPS.", evidence: "tests/unit/csp.test.ts; tests/e2e/security-headers.spec.ts (zero CSP violations on nav pages)", owner: "Engineering", nextAction: "Deploy; watch the browser console after deploy." },
  { id: "SEC-006", title: "Collector ingest accepted consent given for an older notice version", severity: "medium", status: "remediated", component: "src/app/api/collect/_lib.ts consentState()",
    summary: "After the notice changed, employees who acknowledged the old notice kept being collected.", fix: "Ingest requires an acknowledgement of the org's current notice version (drop reason consent_outdated); /config reports 'missing' so collectors re-prompt.", evidence: "tests/unit/collect-api.test.ts › consent version", owner: "Engineering", nextAction: "Deploy." },
  { id: "SEC-007", title: "Brain upload: no zip-bomb guard, binaries accepted as text, unsanitised filenames, no org quota", severity: "medium", status: "remediated", component: "src/engine/brain/extract.ts, src/engine/brain/quota.ts, src/app/api/brain/upload/route.ts",
    summary: "A crafted .docx could exhaust memory; renamed binaries were stored as text.", fix: "Request cap before parsing, filename sanitisation, UTF-8/NUL sniffing for text formats, zip central-directory limits (entries, declared size, ratio, ZIP64, encryption), 50 MB per-org text quota.",
    evidence: "tests/unit/upload-security.test.ts", owner: "Engineering", nextAction: "Residual: declared zip sizes can be forged — move extraction to an isolated worker with a memory cap." },
  { id: "SEC-008", title: "Audit log tampering undetectable", severity: "low", status: "open", component: "src/lib/audit.ts",
    summary: "The admin DB role can edit or delete audit rows.", fix: "Per-org hash chain (prev_hash/hash) + verifyAuditChain() + owner 'Verify audit chain' button. Edits and deletions inside the chain are detected; truncating the newest rows is not without an external anchor.",
    evidence: "tests/unit/audit-chain.test.ts", owner: "Engineering", nextAction: "Ship head hashes to an external append-only store (SIEM / object lock)." },
  { id: "SEC-009", title: "Platform owner account has no MFA", severity: "medium", status: "open", component: "production account nedpearson@gmail.com",
    summary: "The account that owns every client org signs in with a password only.", fix: "Platform owner now always routed to MFA enrolment (src/lib/mfa-policy.ts); enrolment itself is a user action.", evidence: "Readiness live check 'Platform owner MFA'", owner: "Platform owner", nextAction: "Sign in after deploy and enrol MFA at /app/settings/security." },
  { id: "SEC-010", title: "SECURITY.md claimed FORCE ROW LEVEL SECURITY; rls.sql sets NO FORCE", severity: "low", status: "remediated", component: "docs/SECURITY.md, drizzle/rls.sql",
    summary: "Documentation overstated isolation: the table owner (admin handle) bypasses RLS by design.", fix: "Docs corrected; behaviour unchanged (admin handle is an admin credential).", evidence: "drizzle/rls.sql lines 39-40", owner: "Engineering", nextAction: "None." },
  { id: "SEC-011", title: "/api/admin/bootstrap?step=seed could seed demo data in production", severity: "low", status: "remediated", component: "src/app/api/admin/bootstrap/route.ts",
    summary: "CRON_SECRET holders could create demo accounts in production.", fix: "Refused in production unless BOOTSTRAP_SEED_DEMO=1; passwords follow resolveSeedPassword(); maxDuration 60.", evidence: "code review (route)", owner: "Engineering", nextAction: "None." },
  { id: "SEC-012", title: "MFA enrolment gate covers pages and API routes, not direct server-action calls", severity: "low", status: "open", component: "src/lib/session.ts",
    summary: "A user who must enrol MFA cannot open pages or call API routes, but could still invoke a server action by id.", fix: "—", evidence: "code review", owner: "Engineering", nextAction: "Check ctx.mfaRequired in requireCtx(perm) for mutating actions (exempting the security page's own actions)." },
  { id: "SEC-013", title: "No dependency audit / SAST / secret scanning in CI", severity: "medium", status: "open", component: ".github/workflows/ci.yml",
    summary: "Supply-chain and regression risk are not checked automatically.", fix: "—", evidence: "ci.yml has no such step", owner: "Engineering", nextAction: "Add npm audit --omit=dev, CodeQL and gitleaks steps." },
  { id: "SEC-014", title: "IP-based limits trust x-forwarded-for", severity: "info", status: "accepted", component: "src/lib/rate-limit.ts requestIp()",
    summary: "Correct on Vercel (platform sets the header); behind another proxy the header must be overwritten by that proxy.", fix: "Documented in docs/DEPLOYMENT.md.", evidence: "—", owner: "Engineering", nextAction: "Configure the proxy when self-hosting." },
];
