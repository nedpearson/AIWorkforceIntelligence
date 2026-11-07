/**
 * Production Readiness — the 18 release gates and the pure status computation.
 * A gate's status comes ONLY from (a) live checks computed at request time and (b) evidence rows recorded with
 * `npm run readiness:record` (table readiness_evidence). There is no hard-coded PASS anywhere: a gate that needs
 * evidence and has none is "not_verified", whatever its live checks say.
 */
export type GateStatus = "pass" | "fail" | "blocked" | "not_verified";
export type LiveCheckKey = "db_reachable" | "migrations_applied" | "demo_password_accounts" | "owner_mfa" | "env_vars" | "cron_recent" | "rls_enabled" | "audit_chain" | "csp_header";
export type LiveCheck = { key: LiveCheckKey; label: string; ok: boolean; detail: string };
export type EvidenceRow = { gate: string; status: "pass" | "fail" | "blocked"; commitSha: string; command: string; environment: string; evidence: string; recordedBy: string; recordedAt: Date | string };
export type FindingRow = { id: string; title: string; severity: "critical" | "high" | "medium" | "low" | "info"; status: "open" | "remediated" | "accepted"; owner: string; nextAction: string };

export type GateDef = { key: string; title: string; description: string; critical: boolean; requiresEvidence: boolean; live: LiveCheckKey[]; owner: string; nextAction: string };

export const GATES: GateDef[] = [
  { key: "ci_green", title: "CI green", description: "Typecheck, unit and e2e jobs green on GitHub Actions for the RC commit.", critical: true, requiresEvidence: true, live: [], owner: "Engineering", nextAction: "Push the RC, wait for .github/workflows/ci.yml to pass, record the run URL." },
  { key: "e2e", title: "End-to-end suite", description: "Full Playwright suite (desktop + mobile + crawl) against a production build with the server in UTC.", critical: true, requiresEvidence: true, live: [], owner: "Engineering", nextAction: "npx playwright test against the RC build; record the summary line." },
  { key: "critical_workflows", title: "Critical workflows", description: "The ten acceptance workflows in docs/PRODUCTION_READINESS.md §1 pass on the RC.", critical: false, requiresEvidence: true, live: [], owner: "Engineering", nextAction: "Run the workflow specs; record which passed." },
  { key: "authn_authz", title: "Authentication & authorization", description: "Login, MFA, session revocation, rate limits, RBAC; no demo account can sign in; the platform owner uses MFA.", critical: true, requiresEvidence: true, live: ["demo_password_accounts", "owner_mfa"], owner: "Platform owner", nextAction: "Enable MFA on the platform owner account; keep demo accounts password-less; record auth unit + e2e results." },
  { key: "security_findings", title: "No open critical/high security findings", description: "Computed from the security findings register (table security_findings).", critical: true, requiresEvidence: false, live: [], owner: "Security", nextAction: "Sync the register (npm run readiness:record -- --sync-findings) and close every open critical/high finding." },
  { key: "tenant_isolation", title: "Tenant isolation", description: "RLS enabled with a tenant policy on every tenant table; isolation tests pass.", critical: true, requiresEvidence: true, live: ["rls_enabled"], owner: "Engineering", nextAction: "Run tenant-isolation e2e + unit cross-org tests; record." },
  { key: "live_integrations", title: "Live integrations", description: "Every integration a client will use exercised against the real service (n8n, Stripe test mode, OIDC, Anthropic, …).", critical: false, requiresEvidence: true, live: [], owner: "Engineering", nextAction: "See docs/INTEGRATION_VERIFICATION.md — none is live-tested yet." },
  { key: "desktop_collectors", title: "Desktop collectors on real devices", description: "Collector run for a campaign week on real Windows and macOS machines; signed binaries.", critical: false, requiresEvidence: true, live: [], owner: "Engineering", nextAction: "Pilot on friendly users' Windows + macOS devices; sign/notarize binaries." },
  { key: "financial_reconciliation", title: "Financial reconciliation", description: "KPIs reconcile across /app, /app/finance, /app/savings and the Excel export.", critical: false, requiresEvidence: true, live: [], owner: "Engineering", nextAction: "Run reconciliation.spec.ts + finance/savings unit tests; record." },
  { key: "agent_execution", title: "Agent execution + approvals", description: "Agent runs park on approval, resume on approve, roll back on failure; AI labelling and permission levels hold.", critical: false, requiresEvidence: true, live: [], owner: "Engineering", nextAction: "Run agents-runner/skills unit tests + agents/acceptance e2e; record." },
  { key: "evidence_savings", title: "Evidence-backed savings", description: "Verified savings only from measured, succeeded runs on REAL client data.", critical: false, requiresEvidence: true, live: [], owner: "Consulting", nextAction: "Requires a real pilot client; synthetic data cannot pass this gate." },
  { key: "backup_restore", title: "Backup / restore", description: "A restore of the production database (Neon branch / PITR) tested end to end.", critical: true, requiresEvidence: true, live: [], owner: "Platform owner", nextAction: "Create a Neon branch from a past timestamp, point a preview at it, verify login + data; record." },
  { key: "rollback", title: "Rollback", description: "Vercel instant rollback rehearsed; per-migration rollback SQL reviewed (docs/ROLLBACK_PLAN.md).", critical: true, requiresEvidence: true, live: [], owner: "Platform owner", nextAction: "Promote the previous deployment once in a quiet window and back; record." },
  { key: "performance", title: "Performance targets", description: "Targets in docs/PERFORMANCE_RESULTS.md met at the claimed scale.", critical: false, requiresEvidence: true, live: [], owner: "Engineering", nextAction: "Run tests/perf/perf.ts at target scale; record results." },
  { key: "accessibility", title: "Accessibility", description: "axe-core: zero serious/critical violations on every page, light and dark.", critical: false, requiresEvidence: true, live: [], owner: "Engineering", nextAction: "Run a11y.spec.ts; record." },
  { key: "production_config", title: "Production configuration", description: "Database reachable, all migrations applied, required env vars present, CSP header served.", critical: true, requiresEvidence: false, live: ["db_reachable", "migrations_applied", "env_vars", "csp_header"], owner: "Platform owner", nextAction: "Fix the failing live check(s) shown." },
  { key: "privacy_review", title: "Privacy review", description: "Counsel reviewed notice/authorization wording and the processor agreement for the client's state.", critical: false, requiresEvidence: true, live: [], owner: "Legal", nextAction: "Engage counsel (docs/PRIVACY.md §10); record the sign-off." },
  { key: "monitoring", title: "Monitoring", description: "Scheduler ran within 26 h; audit chains verify; error tracking and uptime alerts configured.", critical: false, requiresEvidence: true, live: ["cron_recent", "audit_chain"], owner: "Platform owner", nextAction: "Configure error tracking + uptime monitoring; record; keep the daily cron running." },
];
export const GATE_KEYS = GATES.map((g) => g.key);

export type GateResult = GateDef & { status: GateStatus; reason: string; liveChecks: LiveCheck[]; evidence: EvidenceRow | null };
export type Overall = "GO" | "CONDITIONAL GO" | "NO-GO";

const t = (d: Date | string) => new Date(d).getTime();

export function computeGate(def: GateDef, live: LiveCheck[], evidence: EvidenceRow[], findings: FindingRow[] | null): GateResult {
  const liveChecks = def.live.map((k) => live.find((c) => c.key === k) ?? { key: k, label: k, ok: false, detail: "check did not run" });
  const latest = evidence.filter((e) => e.gate === def.key).sort((a, b) => t(b.recordedAt) - t(a.recordedAt))[0] ?? null;
  const base = { ...def, liveChecks, evidence: latest };
  const failedLive = liveChecks.filter((c) => !c.ok);
  if (failedLive.length) return { ...base, status: "fail", reason: `Live check failed: ${failedLive.map((c) => c.label).join(", ")}` };
  if (def.key === "security_findings") {
    if (!findings || !findings.length) return { ...base, status: "not_verified", reason: "Findings register is empty or not synced" };
    const open = findings.filter((f) => f.status === "open" && (f.severity === "critical" || f.severity === "high"));
    return open.length ? { ...base, status: "fail", reason: `${open.length} open critical/high finding(s): ${open.map((f) => f.id).join(", ")}` } : { ...base, status: "pass", reason: `${findings.length} findings registered; none open at critical/high` };
  }
  if (latest) {
    if (latest.status === "fail") return { ...base, status: "fail", reason: `Evidence recorded as FAIL (${latest.environment})` };
    if (latest.status === "blocked") return { ...base, status: "blocked", reason: `Evidence recorded as BLOCKED (${latest.environment})` };
    return { ...base, status: "pass", reason: `Evidence: ${latest.environment} @ ${latest.commitSha.slice(0, 7)}` };
  }
  if (def.requiresEvidence) return { ...base, status: "not_verified", reason: liveChecks.length ? "Live checks pass, but no evidence recorded" : "No evidence recorded" };
  if (!liveChecks.length) return { ...base, status: "not_verified", reason: "No live checks and no evidence" };
  return { ...base, status: "pass", reason: "All live checks pass" };
}

export function computeOverall(gates: GateResult[]): { overall: Overall; blockers: GateResult[]; conditions: GateResult[] } {
  const notPass = gates.filter((g) => g.status !== "pass");
  const hardFail = gates.filter((g) => g.status === "fail" || (g.critical && g.status !== "pass"));
  if (hardFail.length) return { overall: "NO-GO", blockers: hardFail, conditions: notPass.filter((g) => !hardFail.includes(g)) };
  if (!notPass.length) return { overall: "GO", blockers: [], conditions: [] };
  return { overall: "CONDITIONAL GO", blockers: [], conditions: notPass };
}

export function computeReadiness(live: LiveCheck[], evidence: EvidenceRow[], findings: FindingRow[] | null) {
  const gates = GATES.map((g) => computeGate(g, live, evidence, findings));
  return { gates, ...computeOverall(gates) };
}
