/**
 * Enterprise Risk & Compliance engine — a register computed live from tenant data. Nothing is self-reported:
 * every item cites the records it was derived from and links to where it is fixed.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";

const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const DAY = 86_400_000;

export type Severity = "critical" | "high" | "medium" | "low" | "ok";
export type RiskItem = {
  key: string; category: "privacy" | "governance" | "security" | "regulatory" | "operations" | "delivery";
  title: string; severity: Severity; likelihood: number; impact: number; open: boolean;
  evidence: string; metric?: { value: number; of?: number; unit?: string }; href: string; fix: string;
};
export type RiskRegister = {
  orgId: string; computedAt: string; score: number; scoreFormula: string; items: RiskItem[];
  heatmap: { likelihood: number; impact: number; count: number; keys: string[] }[];
  audit: { last30d: number; daily: { day: string; n: number }[]; lastAdminActions: { action: string; at: string; actor: string | null }[] };
  privacy: { retentionDays: number; titleModes: Record<string, number>; blockedAppsConfigured: number; consentAcknowledged: number; employeesObserved: number };
};
export const SEVERITY_PENALTY: Record<Severity, number> = { critical: 25, high: 12, medium: 5, low: 2, ok: 0 };
/** Posture score: 100 − Σ penalties of open items (floored at 0). Higher = safer. */
export function riskScore(items: Pick<RiskItem, "severity" | "open">[]): number {
  return Math.max(0, 100 - items.filter((i) => i.open).reduce((s, i) => s + SEVERITY_PENALTY[i.severity], 0));
}
const LI: Record<Severity, [number, number]> = { critical: [5, 5], high: [4, 4], medium: [3, 3], low: [2, 2], ok: [1, 1] };

export async function computeRiskRegister(orgId: string, now = new Date()): Promise<RiskRegister> {
  const d = await withTenant(orgId, async (tx) => {
    const o = <T extends { orgId: unknown }>(t: T) => eq((t as unknown as { orgId: typeof schema.employees.orgId }).orgId, orgId);
    const [org, observed, consents, auths, workflows, agents, opps, creds, oldest, admins, auditCount, auditDaily, lastAdmin, risks, collectors, campaigns] = await Promise.all([
      tx.select({ retentionDays: schema.organizations.retentionDays }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1),
      tx.select({ emp: schema.activityEvents.employeeId }).from(schema.activityEvents).where(eq(schema.activityEvents.orgId, orgId)).groupBy(schema.activityEvents.employeeId),
      tx.select({ emp: schema.consentRecords.employeeId, ack: schema.consentRecords.acknowledgedAt, wd: schema.consentRecords.withdrawnAt }).from(schema.consentRecords).where(o(schema.consentRecords)),
      tx.select({ id: schema.authorizations.id, signedAt: schema.authorizations.signedAt, expiresAt: schema.authorizations.expiresAt, signer: schema.authorizations.signerName }).from(schema.authorizations).where(o(schema.authorizations)),
      tx.select({ id: schema.workflows.id, name: schema.workflows.name, flag: schema.workflows.regulatoryFlag }).from(schema.workflows).where(o(schema.workflows)),
      tx.select({ id: schema.agents.id, name: schema.agents.name, wf: schema.agents.workflowId, status: schema.agents.status, policy: schema.agents.approvalPolicy, def: schema.agents.definition }).from(schema.agents).where(o(schema.agents)),
      tx.select({ id: schema.opportunities.id, wf: schema.opportunities.workflowId, flag: schema.opportunities.regulatoryFlag, judgment: schema.opportunities.requiresHumanJudgment, status: schema.opportunities.status }).from(schema.opportunities).where(o(schema.opportunities)),
      tx.select({ id: schema.credentials.id, name: schema.credentials.name, lastUsedAt: schema.credentials.lastUsedAt, createdAt: schema.credentials.createdAt }).from(schema.credentials).where(o(schema.credentials)),
      tx.select({ ts: sql<string | null>`min(${schema.activityEvents.ts})` }).from(schema.activityEvents).where(eq(schema.activityEvents.orgId, orgId)),
      tx.select({ role: schema.memberships.role, mfa: schema.users.mfaEnabled, email: schema.users.email }).from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(and(o(schema.memberships), sql`${schema.memberships.role} in ('owner','admin')`)),
      tx.select({ n: sql<string>`count(*)` }).from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), gte(schema.auditLog.ts, new Date(+now - 30 * DAY)))),
      tx.select({ day: sql<string>`to_char(date_trunc('day', ${schema.auditLog.ts}), 'YYYY-MM-DD')`, n: sql<string>`count(*)` }).from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), gte(schema.auditLog.ts, new Date(+now - 30 * DAY)))).groupBy(sql`1`),
      tx.select({ action: schema.auditLog.action, ts: schema.auditLog.ts, actor: schema.auditLog.actorUserId }).from(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.actorType, "user"), sql`${schema.auditLog.action} not like 'auth.%'`)).orderBy(desc(schema.auditLog.ts)).limit(8),
      tx.select({ id: schema.projectRisks.id, title: schema.projectRisks.title, sev: schema.projectRisks.severity, lik: schema.projectRisks.likelihood, status: schema.projectRisks.status, project: schema.projectRisks.projectId }).from(schema.projectRisks).where(o(schema.projectRisks)),
      tx.select({ id: schema.collectors.id, status: schema.collectors.status, lastSeenAt: schema.collectors.lastSeenAt }).from(schema.collectors).where(o(schema.collectors)),
      tx.select({ config: schema.observationCampaigns.config }).from(schema.observationCampaigns).where(o(schema.observationCampaigns)),
    ]);
    return { org: org[0], observed, consents, auths, workflows, agents, opps, creds, oldest: oldest[0]?.ts ?? null, admins, auditCount: num(auditCount[0]?.n), auditDaily, lastAdmin, risks, collectors, campaigns };
  });

  const items: RiskItem[] = [];
  const add = (x: Omit<RiskItem, "likelihood" | "impact" | "open"> & { likelihood?: number; impact?: number }) => {
    const [l, i] = LI[x.severity]; items.push({ ...x, likelihood: x.likelihood ?? l, impact: x.impact ?? i, open: x.severity !== "ok" });
  };

  // 1. consent coverage
  const ackEmp = new Set(d.consents.filter((c) => c.ack && !c.wd).map((c) => c.emp));
  const withoutConsent = d.observed.filter((r) => !ackEmp.has(r.emp)).length;
  add({ key: "consent", category: "privacy", title: "Employees observed without acknowledged consent", severity: withoutConsent === 0 ? "ok" : withoutConsent / Math.max(1, d.observed.length) > 0.2 ? "critical" : "high",
    evidence: `${withoutConsent} of ${d.observed.length} employees with activity events have no current (acknowledged, not withdrawn) consent record`, metric: { value: withoutConsent, of: d.observed.length }, href: "/app/collection?tab=consent", fix: "Publish the notice and collect acknowledgements; pause collectors for anyone who has not acknowledged." });

  // 2. authorization on file
  const validAuth = d.auths.filter((a) => !a.expiresAt || +a.expiresAt > +now);
  const soonest = validAuth.map((a) => a.expiresAt).filter((x): x is Date => !!x).sort((a, b) => +a - +b)[0];
  const daysLeft = soonest ? Math.floor((+soonest - +now) / DAY) : null;
  add({ key: "authorization", category: "governance", title: "Monitoring authorization on file", severity: !validAuth.length ? (d.observed.length ? "critical" : "high") : daysLeft != null && daysLeft < 30 ? "medium" : "ok",
    evidence: !d.auths.length ? "No signed authorization" : !validAuth.length ? `All ${d.auths.length} authorization(s) expired` : `${validAuth.length} valid authorization(s)${daysLeft != null ? `; earliest expires in ${daysLeft} days` : "; no expiry set"}`,
    href: "/app/collection?tab=authorization", fix: "An owner or officer signs (or renews) the monitoring authorization." });

  // 3. regulated workflows & approval gates
  const flagged = d.workflows.filter((w) => w.flag);
  const flaggedIds = new Set(flagged.map((w) => w.id));
  const ungatedAgents = d.agents.filter((a) => a.wf && flaggedIds.has(a.wf) && (a.policy?.mode ?? "sensitive_only") === "none" && a.status !== "retired");
  const flaggedOppsNoJudgment = d.opps.filter((o) => o.wf && flaggedIds.has(o.wf) && !o.judgment && o.status !== "rejected");
  add({ key: "regulated_gates", category: "regulatory", title: "Regulated workflows (PII / SOX / HIPAA / Legal) without approval gates",
    severity: ungatedAgents.length ? "high" : flaggedOppsNoJudgment.length ? "medium" : flagged.length ? "ok" : "ok",
    evidence: flagged.length ? `${flagged.length} regulated workflow(s) (${[...new Set(flagged.map((w) => w.flag))].join(", ")}); ${ungatedAgents.length} agent(s) on them with approval policy "none"; ${flaggedOppsNoJudgment.length} open opportunit${flaggedOppsNoJudgment.length === 1 ? "y" : "ies"} not marked as requiring human judgment` : "No regulated workflows discovered",
    metric: { value: ungatedAgents.length + flaggedOppsNoJudgment.length, of: flagged.length }, href: ungatedAgents[0] ? `/app/agents/${ungatedAgents[0].id}` : "/app/opportunities", fix: "Set approval policy to “sensitive only” or “all” for agents on regulated work and require human review on those opportunities." });

  // 4. agents with approval none touching sensitive nodes
  const sensitiveNone = d.agents.filter((a) => (a.policy?.mode ?? "sensitive_only") === "none" && (a.def?.nodes ?? []).some((n) => n.sensitive) && a.status !== "retired");
  add({ key: "sensitive_no_approval", category: "security", title: "Agents with no approval policy touching sensitive steps", severity: sensitiveNone.some((a) => a.status === "deployed") ? "critical" : sensitiveNone.length ? "high" : "ok",
    evidence: sensitiveNone.length ? `${sensitiveNone.length} agent(s): ${sensitiveNone.slice(0, 3).map((a) => a.name).join(", ")}` : `${d.agents.length} agent(s) checked; none bypass approval on sensitive steps`, metric: { value: sensitiveNone.length, of: d.agents.length },
    href: sensitiveNone[0] ? `/app/agents/${sensitiveNone[0].id}` : "/app/agents", fix: "Change the approval policy to “sensitive only” so sensitive steps wait for a human." });

  // 5. credentials unused > 90 days
  const stale = d.creds.filter((c) => (c.lastUsedAt ? +now - +c.lastUsedAt : +now - +c.createdAt) > 90 * DAY);
  add({ key: "stale_credentials", category: "security", title: "Credentials unused for more than 90 days", severity: stale.length ? (stale.length > 3 ? "medium" : "low") : "ok",
    evidence: `${stale.length} of ${d.creds.length} vaulted credential(s) unused > 90 days${stale.length ? `: ${stale.slice(0, 3).map((c) => c.name).join(", ")}` : ""}`, metric: { value: stale.length, of: d.creds.length }, href: "/app/agents/credentials", fix: "Rotate or delete credentials that are no longer used." });

  // 6. retention vs oldest event
  const retention = d.org?.retentionDays ?? 180;
  const oldestDays = d.oldest ? Math.floor((+now - +new Date(d.oldest)) / DAY) : null;
  add({ key: "retention", category: "privacy", title: "Raw activity kept longer than the retention policy", severity: oldestDays != null && oldestDays > retention + 1 ? (oldestDays > retention * 1.5 ? "high" : "medium") : "ok",
    evidence: oldestDays == null ? `No activity events stored · policy ${retention} days` : `Oldest event is ${oldestDays} days old · policy ${retention} days`, metric: oldestDays == null ? undefined : { value: oldestDays, of: retention, unit: "days" }, href: "/app/settings/data", fix: "Run the retention sweep (worker job) or shorten the window." });

  // 7. MFA among owners/admins
  const noMfa = d.admins.filter((a) => !a.mfa);
  add({ key: "mfa", category: "security", title: "Owners and admins without multi-factor authentication", severity: !d.admins.length ? "ok" : noMfa.length === d.admins.length ? "high" : noMfa.length ? "medium" : "ok",
    evidence: `${d.admins.length - noMfa.length} of ${d.admins.length} owner/admin account(s) have MFA enabled`, metric: { value: d.admins.length - noMfa.length, of: d.admins.length }, href: "/app/settings/security", fix: "Each owner and admin enables MFA under Security settings." });

  // 8. audit log activity
  add({ key: "audit_volume", category: "governance", title: "Audit trail activity", severity: d.auditCount === 0 && (d.observed.length > 0 || d.agents.length > 0) ? "low" : "ok",
    evidence: `${d.auditCount.toLocaleString()} audit event(s) in the last 30 days${d.lastAdmin[0] ? `; last admin action “${d.lastAdmin[0].action}” on ${d.lastAdmin[0].ts.toISOString().slice(0, 10)}` : "; no admin actions recorded"}`, metric: { value: d.auditCount, unit: "events/30d" }, href: "/app/settings/audit", fix: "No audit events while the platform is in use usually means actions are bypassing the app — investigate." });

  // 9. open project risks
  const openRisks = d.risks.filter((r) => r.status === "open");
  for (const r of openRisks.slice(0, 12)) {
    const s = num(r.sev) * num(r.lik); const sev: Severity = s >= 20 ? "critical" : s >= 12 ? "high" : s >= 6 ? "medium" : "low";
    items.push({ key: `project_risk_${r.id}`, category: "delivery", title: r.title, severity: sev, likelihood: num(r.lik), impact: num(r.sev), open: true, evidence: `Project risk register · severity ${r.sev}/5 × likelihood ${r.lik}/5`, href: `/app/roadmap?project=${r.project}`, fix: "Agree a mitigation and owner on the roadmap." });
  }
  if (!openRisks.length) add({ key: "project_risks", category: "delivery", title: "Open transformation project risks", severity: "ok", evidence: d.risks.length ? `${d.risks.length} project risk(s), none open` : "No project risks logged (no projects or none raised)", href: "/app/roadmap", fix: "Log delivery risks on each transformation project." });

  // 10. collectors offline
  const offline = d.collectors.filter((c) => c.status === "offline" || (c.status === "active" && c.lastSeenAt && +now - +c.lastSeenAt > DAY));
  add({ key: "collectors_offline", category: "operations", title: "Collectors offline or silent > 24h", severity: offline.length ? (offline.length / Math.max(1, d.collectors.length) > 0.25 ? "medium" : "low") : "ok",
    evidence: `${offline.length} of ${d.collectors.length} collector(s) offline or not seen in 24h`, metric: { value: offline.length, of: d.collectors.length }, href: "/app/collection?tab=collectors", fix: "Check the device is on and the collector token is valid; offline collectors leave gaps in the evidence." });

  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, ok: 4 };
  items.sort((a, b) => order[a.severity] - order[b.severity]);
  const cells = new Map<string, { likelihood: number; impact: number; count: number; keys: string[] }>();
  for (const it of items.filter((x) => x.open)) { const k = `${it.likelihood}:${it.impact}`; const c = cells.get(k) ?? { likelihood: it.likelihood, impact: it.impact, count: 0, keys: [] }; c.count++; c.keys.push(it.key); cells.set(k, c); }
  const dailyMap = new Map(d.auditDaily.map((r) => [r.day, num(r.n)]));
  const daily = Array.from({ length: 30 }, (_, i) => { const day = new Date(+now - (29 - i) * DAY).toISOString().slice(0, 10); return { day, n: dailyMap.get(day) ?? 0 }; });
  const titleModes: Record<string, number> = {}; let blocked = 0;
  for (const c of d.campaigns) { const m = c.config?.titleMode ?? "category"; titleModes[m] = (titleModes[m] ?? 0) + 1; blocked += c.config?.blockedApps?.length ?? 0; }
  return {
    orgId, computedAt: now.toISOString(), score: riskScore(items), scoreFormula: "100 − Σ open-item penalties (critical 25 · high 12 · medium 5 · low 2), floor 0. Higher = safer.",
    items, heatmap: [...cells.values()],
    audit: { last30d: d.auditCount, daily, lastAdminActions: d.lastAdmin.map((a) => ({ action: a.action, at: a.ts.toISOString(), actor: a.actor })) },
    privacy: { retentionDays: retention, titleModes, blockedAppsConfigured: blocked, consentAcknowledged: ackEmp.size, employeesObserved: d.observed.length },
  };
}
