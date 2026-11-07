/**
 * Transformation Roadmap engine.
 *
 *  - roadmapPriority / prioritizeCandidates   → pure auto-prioritization of candidate projects (unit tested)
 *  - projectActualSavings                     → pure: a project's actual savings = Savings Intelligence lineage filtered to
 *                                               the project's opportunities / agents (never a separate number source)
 *  - attentionItems                           → pure: overdue milestones, blocked dependencies, unmitigated high risks
 *  - loadRoadmap(orgId)                       → DB orchestration for /app/roadmap
 *  - create/update/delete helpers             → tenant-scoped, audited CRUD (caller enforces RBAC)
 */
import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { computeSavingsIntelligence, type LineageItem, type SavingsIntelligence } from "./savings";
import { analyzeOpportunities, type OpportunityAnalysis } from "./opportunity-score";

const num = (v: unknown) => (v == null ? 0 : typeof v === "number" ? v : Number(v) || 0);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const r1 = (n: number) => Math.round(n * 10) / 10;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

// ---------------------------------------------------------------------------------------------
// Auto-prioritization (pure)
// ---------------------------------------------------------------------------------------------

export type PriorityKey = "financial" | "complexity" | "risk" | "timeSavings" | "integrations" | "dataReadiness" | "payback";
export const PRIORITY_WEIGHTS: Record<PriorityKey, number> = { financial: 25, complexity: 15, risk: 15, timeSavings: 15, integrations: 10, dataReadiness: 10, payback: 10 };
export const PRIORITY_LABEL: Record<PriorityKey, string> = { financial: "Financial impact", complexity: "Low complexity", risk: "Low risk", timeSavings: "Time savings", integrations: "Few integrations", dataReadiness: "Data readiness", payback: "Fast payback" };

export type CandidateInput = {
  opportunityId: string; title: string; realizableAnnual: number; maxRealizable: number; complexity: number; risk: number;
  hoursRecoverablePerWeek: number; maxHours: number; integrationCount: number; dataReadiness: number; paybackMonths: number | null;
};
export type PriorityPart = { key: PriorityKey; label: string; value: number; weight: number; contribution: number };
export type Candidate = CandidateInput & { priorityScore: number; parts: PriorityPart[] };

export function roadmapPriority(c: CandidateInput): { score: number; parts: PriorityPart[] } {
  const v: Record<PriorityKey, number> = {
    financial: c.maxRealizable > 0 ? clamp01(c.realizableAnnual / c.maxRealizable) : 0,
    complexity: 1 - clamp01(c.complexity),
    risk: 1 - clamp01(c.risk / 100),
    timeSavings: c.maxHours > 0 ? clamp01(c.hoursRecoverablePerWeek / c.maxHours) : 0,
    integrations: clamp01(1 - Math.max(0, c.integrationCount - 1) / 5),
    dataReadiness: clamp01(c.dataReadiness / 100),
    payback: c.paybackMonths == null ? 0 : clamp01(1 - c.paybackMonths / 36),
  };
  const parts = (Object.keys(PRIORITY_WEIGHTS) as PriorityKey[]).map((k) => ({ key: k, label: PRIORITY_LABEL[k], value: r1(v[k] * 100), weight: PRIORITY_WEIGHTS[k], contribution: r1(v[k] * PRIORITY_WEIGHTS[k]) }));
  return { score: r1(sum(parts.map((p) => v[p.key] * p.weight))), parts };
}

/** Sorted highest priority first; ties broken by realizable $ then opportunity id (deterministic). */
export function prioritizeCandidates(cands: CandidateInput[]): Candidate[] {
  return cands.map((c) => { const p = roadmapPriority(c); return { ...c, priorityScore: p.score, parts: p.parts }; })
    .sort((a, b) => b.priorityScore - a.priorityScore || b.realizableAnnual - a.realizableAnnual || a.opportunityId.localeCompare(b.opportunityId));
}

export function candidatesFromAnalyses(all: OpportunityAnalysis[]): CandidateInput[] {
  const pool = all.filter((a) => a.inScope);
  const maxRealizable = Math.max(0, ...pool.map((a) => a.line.realizableAnnualSavings));
  const maxHours = Math.max(0, ...pool.map((a) => a.line.hoursRecoverablePerWeek));
  return pool.map((a) => ({
    opportunityId: a.id, title: a.title, realizableAnnual: a.line.realizableAnnualSavings, maxRealizable, complexity: a.complexity, risk: a.line.risk,
    hoursRecoverablePerWeek: a.line.hoursRecoverablePerWeek, maxHours, integrationCount: a.answers.integrations.length,
    dataReadiness: a.score.factors.find((f) => f.key === "dataReadiness")?.value ?? 0, paybackMonths: a.line.paybackMonths,
  }));
}

// ---------------------------------------------------------------------------------------------
// Actual savings per project (pure, from Savings Intelligence lineage)
// ---------------------------------------------------------------------------------------------

export type SavingsLinks = {
  /** measurement id → agent id */
  measurementAgent: Map<string, string | null>;
  /** ledger id → linked records */
  ledger: Map<string, { opportunityId: string | null; projectId: string | null; agentId: string | null }>;
  /** agent id → opportunity id */
  agentOpportunity: Map<string, string | null>;
};
export type ProjectSavingsBucket = { amount: number; hours: number; items: LineageItem[] };
export type ProjectSavings = { verifiedTime: ProjectSavingsBucket; approved: ProjectSavingsBucket; costAvoidance: ProjectSavingsBucket; realizedHard: ProjectSavingsBucket; realizedAnnual: number; agentIds: string[]; measurementCount: number };

export function projectAgentIds(p: { opportunityIds: string[]; agentIds: string[] }, links: Pick<SavingsLinks, "agentOpportunity">): string[] {
  const opps = new Set(p.opportunityIds);
  const ids = new Set(p.agentIds);
  for (const [agentId, oppId] of links.agentOpportunity) if (oppId && opps.has(oppId)) ids.add(agentId);
  return [...ids].sort();
}

export function projectActualSavings(p: { id: string; opportunityIds: string[]; agentIds: string[] }, si: Pick<SavingsIntelligence, "tiers">, links: SavingsLinks): ProjectSavings {
  const agents = new Set(projectAgentIds(p, links)); const opps = new Set(p.opportunityIds);
  const bucket = (items: LineageItem[]): ProjectSavingsBucket => ({ amount: sum(items.map((i) => i.amount)), hours: sum(items.map((i) => i.hours ?? 0)), items });
  const ledgerMatch = (i: LineageItem) => { const l = links.ledger.get(i.id); return !!l && (l.projectId === p.id || (!!l.opportunityId && opps.has(l.opportunityId)) || (!!l.agentId && agents.has(l.agentId))); };
  const verified = si.tiers.verifiedTime.lineage.filter((i) => i.type === "measurement" && agents.has(links.measurementAgent.get(i.id) ?? ""));
  const costAvoidance = bucket(si.tiers.costAvoidance.lineage.filter(ledgerMatch));
  const realizedHard = bucket(si.tiers.realizedHard.lineage.filter(ledgerMatch));
  return {
    verifiedTime: bucket(verified), approved: bucket(si.tiers.approved.lineage.filter(ledgerMatch)), costAvoidance, realizedHard,
    realizedAnnual: costAvoidance.amount + realizedHard.amount, agentIds: [...agents], measurementCount: verified.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Attention list (pure)
// ---------------------------------------------------------------------------------------------

export type MilestoneLite = { id: string; projectId: string; name: string; status: string; startDate: string | null; dueDate: string | null; dependsOnMilestoneId: string | null };
export type RiskLite = { id: string; projectId: string; title: string; severity: number; likelihood: number; mitigation: string | null; status: string };
export type AttentionItem = { kind: "overdue" | "blocked_dependency" | "high_risk"; projectId: string; refId: string; title: string; detail: string };
export const HIGH_RISK_EXPOSURE = 15; // severity × likelihood on a 5 × 5 matrix

export function attentionItems(milestones: MilestoneLite[], risks: RiskLite[], now: Date = new Date()): AttentionItem[] {
  const byId = new Map(milestones.map((m) => [m.id, m]));
  const out: AttentionItem[] = [];
  for (const m of milestones) {
    if (m.status !== "done" && m.dueDate && new Date(m.dueDate) < now) out.push({ kind: "overdue", projectId: m.projectId, refId: m.id, title: m.name, detail: `Due ${m.dueDate.slice(0, 10)} and still ${m.status.replace(/_/g, " ")}` });
    const dep = m.dependsOnMilestoneId ? byId.get(m.dependsOnMilestoneId) : undefined;
    if (dep && dep.status !== "done" && m.status !== "done" && (m.status === "in_progress" || m.status === "blocked" || (m.startDate && new Date(m.startDate) <= now)))
      out.push({ kind: "blocked_dependency", projectId: m.projectId, refId: m.id, title: m.name, detail: `Waiting on "${dep.name}" (${dep.status.replace(/_/g, " ")})` });
  }
  for (const r of risks) if (r.status === "open" && r.severity * r.likelihood >= HIGH_RISK_EXPOSURE && !(r.mitigation ?? "").trim())
    out.push({ kind: "high_risk", projectId: r.projectId, refId: r.id, title: r.title, detail: `Exposure ${r.severity * r.likelihood}/25 with no mitigation plan` });
  return out;
}

/** True if setting `id.dependsOn = dependsOn` would create a cycle. */
export function createsCycle(milestones: { id: string; dependsOnMilestoneId: string | null }[], id: string, dependsOn: string | null): boolean {
  if (!dependsOn) return false; if (dependsOn === id) return true;
  const next = new Map(milestones.map((m) => [m.id, m.dependsOnMilestoneId])); next.set(id, dependsOn);
  let cur: string | null | undefined = dependsOn; const seen = new Set<string>();
  while (cur) { if (cur === id) return true; if (seen.has(cur)) return true; seen.add(cur); cur = next.get(cur) ?? null; }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

export type RoadmapProject = {
  id: string; name: string; status: string; notes: string | null; opportunityIds: string[]; agentIds: string[];
  budget: number; spent: number; startDate: string | null; targetDate: string | null; ownerUserId: string | null; ownerEmail: string | null;
  targetAnnualSavings: number; priorityScore: number | null; verifiedAt: string | null; verifiedByEmail: string | null; createdAt: string;
  milestones: (MilestoneLite & { sort: number; completedAt: string | null })[]; risks: RiskLite[];
  opportunities: { id: string; title: string; status: string; realizableAnnual: number }[];
  agents: { id: string; name: string; status: string; measurements: number }[];
  savings: ProjectSavings;
};
export type RoadmapData = {
  projects: RoadmapProject[]; candidates: Candidate[]; attention: AttentionItem[];
  members: { id: string; email: string }[]; opportunities: { id: string; title: string; realizableAnnual: number; status: string }[]; agents: { id: string; name: string; status: string }[];
  si: Pick<SavingsIntelligence, "tiers" | "computedAt">;
};

export async function loadSavingsLinks(orgId: string): Promise<SavingsLinks> {
  const r = await withTenant(orgId, async (tx) => ({
    meas: await tx.select({ id: schema.savingsMeasurements.id, agentId: schema.savingsMeasurements.agentId }).from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId)),
    ledger: await tx.select({ id: schema.savingsLedger.id, opportunityId: schema.savingsLedger.opportunityId, projectId: schema.savingsLedger.projectId, agentId: schema.savingsLedger.agentId }).from(schema.savingsLedger).where(eq(schema.savingsLedger.orgId, orgId)),
    agents: await tx.select({ id: schema.agents.id, opportunityId: schema.agents.opportunityId }).from(schema.agents).where(eq(schema.agents.orgId, orgId)),
  }));
  return {
    measurementAgent: new Map(r.meas.map((m) => [m.id, m.agentId])),
    ledger: new Map(r.ledger.map((l) => [l.id, { opportunityId: l.opportunityId, projectId: l.projectId, agentId: l.agentId }])),
    agentOpportunity: new Map(r.agents.map((a) => [a.id, a.opportunityId])),
  };
}

export async function loadRoadmap(orgId: string): Promise<RoadmapData> {
  const [analysis, si, links] = await Promise.all([analyzeOpportunities(orgId), computeSavingsIntelligence(orgId), loadSavingsLinks(orgId)]);
  const raw = await withTenant(orgId, async (tx) => {
    const projects = await tx.select().from(schema.projects).where(eq(schema.projects.orgId, orgId));
    const ids = projects.map((p) => p.id);
    const [milestones, risks, agents, members, meas] = await Promise.all([
      ids.length ? tx.select().from(schema.projectMilestones).where(and(eq(schema.projectMilestones.orgId, orgId), inArray(schema.projectMilestones.projectId, ids))) : Promise.resolve([]),
      ids.length ? tx.select().from(schema.projectRisks).where(and(eq(schema.projectRisks.orgId, orgId), inArray(schema.projectRisks.projectId, ids))) : Promise.resolve([]),
      tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.orgId, orgId)),
      tx.select({ id: schema.users.id, email: schema.users.email }).from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(eq(schema.memberships.orgId, orgId)),
      tx.select({ agentId: schema.savingsMeasurements.agentId }).from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId)),
    ]);
    return { projects, milestones, risks, agents, members, meas };
  });
  const email = new Map(raw.members.map((m) => [m.id, m.email]));
  const oppById = new Map(analysis.all.map((a) => [a.id, a]));
  const measByAgent = new Map<string, number>(); for (const m of raw.meas) if (m.agentId) measByAgent.set(m.agentId, (measByAgent.get(m.agentId) ?? 0) + 1);
  const agentById = new Map(raw.agents.map((a) => [a.id, a]));
  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  const milestones = raw.milestones.map((m) => ({ id: m.id, projectId: m.projectId, name: m.name, status: m.status, startDate: iso(m.startDate), dueDate: iso(m.dueDate), dependsOnMilestoneId: m.dependsOnMilestoneId, sort: m.sort, completedAt: iso(m.completedAt) }));
  const risks: RiskLite[] = raw.risks.map((r) => ({ id: r.id, projectId: r.projectId, title: r.title, severity: r.severity, likelihood: r.likelihood, mitigation: r.mitigation, status: r.status }));

  const projects: RoadmapProject[] = raw.projects.map((p) => {
    const opportunityIds = p.opportunityIds ?? []; const agentIds = p.agentIds ?? [];
    const savings = projectActualSavings({ id: p.id, opportunityIds, agentIds }, si, links);
    return {
      id: p.id, name: p.name, status: p.status, notes: p.notes, opportunityIds, agentIds, budget: num(p.budget), spent: num(p.spent),
      startDate: iso(p.startDate), targetDate: iso(p.targetDate), ownerUserId: p.ownerUserId, ownerEmail: p.ownerUserId ? (email.get(p.ownerUserId) ?? null) : null,
      targetAnnualSavings: num(p.targetAnnualSavings), priorityScore: p.priorityScore == null ? null : num(p.priorityScore), verifiedAt: iso(p.verifiedAt), verifiedByEmail: p.verifiedBy ? (email.get(p.verifiedBy) ?? null) : null, createdAt: p.createdAt.toISOString(),
      milestones: milestones.filter((m) => m.projectId === p.id).sort((a, b) => a.sort - b.sort || (a.startDate ?? "").localeCompare(b.startDate ?? "")),
      risks: risks.filter((r) => r.projectId === p.id).sort((a, b) => b.severity * b.likelihood - a.severity * a.likelihood),
      opportunities: opportunityIds.map((id) => oppById.get(id)).filter((x): x is OpportunityAnalysis => !!x).map((o) => ({ id: o.id, title: o.title, status: o.status, realizableAnnual: o.line.realizableAnnualSavings })),
      agents: savings.agentIds.map((id) => agentById.get(id)).filter((x): x is { id: string; name: string; status: "draft" | "configured" | "deployed" | "paused" | "retired" | "error" } => !!x).map((a) => ({ id: a.id, name: a.name, status: a.status, measurements: measByAgent.get(a.id) ?? 0 })),
      savings,
    };
  }).sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0) || a.createdAt.localeCompare(b.createdAt));

  const taken = new Set(projects.flatMap((p) => p.opportunityIds));
  const candidates = prioritizeCandidates(candidatesFromAnalyses(analysis.all).filter((c) => !taken.has(c.opportunityId) && oppById.get(c.opportunityId)?.status !== "rejected"));
  return {
    projects, candidates, attention: attentionItems(milestones, risks),
    members: raw.members.map((m) => ({ id: m.id, email: m.email })).sort((a, b) => a.email.localeCompare(b.email)),
    opportunities: analysis.all.map((a) => ({ id: a.id, title: a.title, realizableAnnual: a.line.realizableAnnualSavings, status: a.status })),
    agents: raw.agents.map((a) => ({ id: a.id, name: a.name, status: a.status })),
    si: { tiers: si.tiers, computedAt: si.computedAt },
  };
}

// ---------------------------------------------------------------------------------------------
// CRUD (callers enforce RBAC: opportunities:write)
// ---------------------------------------------------------------------------------------------

export const PROJECT_STATUSES = ["proposed", "approved", "in_progress", "live", "measuring", "closed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const MILESTONE_STATUSES = ["not_started", "in_progress", "blocked", "done"] as const;

export type ProjectInput = { name: string; opportunityIds?: string[]; agentIds?: string[]; budget?: number | null; spent?: number | null; startDate?: Date | null; targetDate?: Date | null; ownerUserId?: string | null; notes?: string | null; targetAnnualSavings?: number | null; priorityScore?: number | null; status?: ProjectStatus };

async function assertLinks(orgId: string, i: { opportunityIds?: string[]; agentIds?: string[]; ownerUserId?: string | null }) {
  await withTenant(orgId, async (tx) => {
    if (i.opportunityIds?.length) { const r = await tx.select({ id: schema.opportunities.id }).from(schema.opportunities).where(and(eq(schema.opportunities.orgId, orgId), inArray(schema.opportunities.id, i.opportunityIds))); if (r.length !== new Set(i.opportunityIds).size) throw new Error("one or more opportunities are not in this organization"); }
    if (i.agentIds?.length) { const r = await tx.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.orgId, orgId), inArray(schema.agents.id, i.agentIds))); if (r.length !== new Set(i.agentIds).size) throw new Error("one or more agents are not in this organization"); }
    if (i.ownerUserId) { const r = await tx.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, i.ownerUserId))).limit(1); if (!r.length) throw new Error("owner is not a member of this organization"); }
  });
}
const money = (v: number | null | undefined) => (v == null ? null : v.toFixed(2));

export async function createProject(orgId: string, userId: string, i: ProjectInput) {
  await assertLinks(orgId, i);
  const [row] = await withTenant(orgId, (tx) => tx.insert(schema.projects).values({
    orgId, name: i.name.trim(), status: i.status ?? "proposed", opportunityIds: [...new Set(i.opportunityIds ?? [])], agentIds: [...new Set(i.agentIds ?? [])], budget: money(i.budget), spent: money(i.spent) ?? "0",
    startDate: i.startDate ?? null, targetDate: i.targetDate ?? null, ownerUserId: i.ownerUserId ?? userId, notes: i.notes ?? null, targetAnnualSavings: money(i.targetAnnualSavings), priorityScore: i.priorityScore == null ? null : i.priorityScore.toFixed(2),
  }).returning());
  await audit({ orgId, actorUserId: userId, action: "project.created", entityType: "project", entityId: row.id, details: { name: row.name, opportunityIds: row.opportunityIds } });
  return row;
}

export async function updateProject(orgId: string, userId: string, id: string, i: Partial<ProjectInput>) {
  await assertLinks(orgId, i);
  const set: Partial<typeof schema.projects.$inferInsert> = { updatedAt: new Date() };
  if (i.name !== undefined) set.name = i.name.trim();
  if (i.opportunityIds !== undefined) set.opportunityIds = [...new Set(i.opportunityIds)];
  if (i.agentIds !== undefined) set.agentIds = [...new Set(i.agentIds)];
  if (i.budget !== undefined) set.budget = money(i.budget);
  if (i.spent !== undefined) set.spent = money(i.spent) ?? "0";
  if (i.startDate !== undefined) set.startDate = i.startDate;
  if (i.targetDate !== undefined) set.targetDate = i.targetDate;
  if (i.ownerUserId !== undefined) set.ownerUserId = i.ownerUserId;
  if (i.notes !== undefined) set.notes = i.notes;
  if (i.targetAnnualSavings !== undefined) set.targetAnnualSavings = money(i.targetAnnualSavings);
  if (i.status !== undefined) set.status = i.status;
  const [row] = await withTenant(orgId, (tx) => tx.update(schema.projects).set(set).where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, orgId))).returning());
  if (!row) throw new Error("project not found in this organization");
  await audit({ orgId, actorUserId: userId, action: i.status !== undefined && Object.keys(i).length === 1 ? "project.status_changed" : "project.updated", entityType: "project", entityId: id, details: { fields: Object.keys(i), status: i.status } });
  return row;
}

export async function deleteProject(orgId: string, userId: string, id: string) {
  const [row] = await withTenant(orgId, (tx) => tx.delete(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, orgId))).returning({ id: schema.projects.id, name: schema.projects.name }));
  if (!row) throw new Error("project not found in this organization");
  await audit({ orgId, actorUserId: userId, action: "project.deleted", entityType: "project", entityId: id, details: { name: row.name } });
}

/** Completion verification is allowed only when at least one linked agent has ≥ 1 savings measurement. Returns why it is blocked otherwise (null = allowed). */
export function verificationBlocker(p: Pick<RoadmapProject, "agents" | "verifiedAt">): string | null {
  if (p.verifiedAt) return "Already verified";
  if (!p.agents.length) return "No agents are linked to this project yet. Link or deploy the agent that delivers it, then record a savings measurement.";
  if (!p.agents.some((a) => a.measurements > 0)) return "None of the linked agents has a savings measurement yet. Record one from the agent's Results tab (run ledger or before/after observation).";
  return null;
}

export async function verifyProject(orgId: string, userId: string, id: string) {
  const links = await loadSavingsLinks(orgId);
  const row = await withTenant(orgId, async (tx) => {
    const [p] = await tx.select().from(schema.projects).where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, orgId))).limit(1);
    if (!p) throw new Error("project not found in this organization");
    if (p.verifiedAt) throw new Error("project is already verified");
    const agentIds = projectAgentIds({ opportunityIds: p.opportunityIds ?? [], agentIds: p.agentIds ?? [] }, links);
    const measured = new Set([...links.measurementAgent.values()].filter((x): x is string => !!x));
    if (!agentIds.some((a) => measured.has(a))) throw new Error("cannot verify: no linked agent has a savings measurement yet");
    const [u] = await tx.update(schema.projects).set({ verifiedAt: new Date(), verifiedBy: userId, updatedAt: new Date() }).where(eq(schema.projects.id, id)).returning();
    return u;
  });
  await audit({ orgId, actorUserId: userId, action: "project.verified", entityType: "project", entityId: id, details: { name: row.name } });
  return row;
}

export type MilestoneInput = { name: string; status?: (typeof MILESTONE_STATUSES)[number]; startDate?: Date | null; dueDate?: Date | null; dependsOnMilestoneId?: string | null; ownerUserId?: string | null; sort?: number };

export async function upsertMilestone(orgId: string, userId: string, projectId: string, i: MilestoneInput, id?: string) {
  if (i.startDate && i.dueDate && i.dueDate < i.startDate) throw new Error("due date must be on or after the start date");
  const row = await withTenant(orgId, async (tx) => {
    const [p] = await tx.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, orgId))).limit(1);
    if (!p) throw new Error("project not found in this organization");
    const siblings = await tx.select({ id: schema.projectMilestones.id, dependsOnMilestoneId: schema.projectMilestones.dependsOnMilestoneId }).from(schema.projectMilestones).where(and(eq(schema.projectMilestones.orgId, orgId), eq(schema.projectMilestones.projectId, projectId)));
    if (i.dependsOnMilestoneId && !siblings.some((s) => s.id === i.dependsOnMilestoneId)) throw new Error("a milestone can only depend on another milestone in the same project");
    if (id && createsCycle(siblings, id, i.dependsOnMilestoneId ?? null)) throw new Error("that dependency would create a cycle");
    const values = { name: i.name.trim(), status: i.status ?? "not_started", startDate: i.startDate ?? null, dueDate: i.dueDate ?? null, dependsOnMilestoneId: i.dependsOnMilestoneId ?? null, ownerUserId: i.ownerUserId ?? null, completedAt: i.status === "done" ? new Date() : null };
    if (id) {
      const [u] = await tx.update(schema.projectMilestones).set(values).where(and(eq(schema.projectMilestones.id, id), eq(schema.projectMilestones.orgId, orgId), eq(schema.projectMilestones.projectId, projectId))).returning();
      if (!u) throw new Error("milestone not found"); return u;
    }
    const [c] = await tx.insert(schema.projectMilestones).values({ orgId, projectId, sort: i.sort ?? siblings.length, ...values }).returning();
    return c;
  });
  await audit({ orgId, actorUserId: userId, action: id ? "milestone.updated" : "milestone.created", entityType: "project_milestone", entityId: row.id, details: { projectId, status: row.status } });
  return row;
}

export async function deleteMilestone(orgId: string, userId: string, id: string) {
  const row = await withTenant(orgId, async (tx) => {
    await tx.update(schema.projectMilestones).set({ dependsOnMilestoneId: null }).where(and(eq(schema.projectMilestones.orgId, orgId), eq(schema.projectMilestones.dependsOnMilestoneId, id)));
    const [d] = await tx.delete(schema.projectMilestones).where(and(eq(schema.projectMilestones.id, id), eq(schema.projectMilestones.orgId, orgId))).returning({ id: schema.projectMilestones.id, projectId: schema.projectMilestones.projectId });
    if (!d) throw new Error("milestone not found"); return d;
  });
  await audit({ orgId, actorUserId: userId, action: "milestone.deleted", entityType: "project_milestone", entityId: id, details: { projectId: row.projectId } });
}

export type RiskInput = { title: string; severity: number; likelihood: number; mitigation?: string | null; status?: "open" | "mitigated" | "closed" };
export async function upsertRisk(orgId: string, userId: string, projectId: string, i: RiskInput, id?: string) {
  const row = await withTenant(orgId, async (tx) => {
    const [p] = await tx.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, orgId))).limit(1);
    if (!p) throw new Error("project not found in this organization");
    const values = { title: i.title.trim(), severity: i.severity, likelihood: i.likelihood, mitigation: i.mitigation ?? null, status: i.status ?? "open" };
    if (id) { const [u] = await tx.update(schema.projectRisks).set(values).where(and(eq(schema.projectRisks.id, id), eq(schema.projectRisks.orgId, orgId), eq(schema.projectRisks.projectId, projectId))).returning(); if (!u) throw new Error("risk not found"); return u; }
    const [c] = await tx.insert(schema.projectRisks).values({ orgId, projectId, ...values }).returning(); return c;
  });
  await audit({ orgId, actorUserId: userId, action: id ? "risk.updated" : "risk.created", entityType: "project_risk", entityId: row.id, details: { projectId, exposure: row.severity * row.likelihood } });
  return row;
}
export async function deleteRisk(orgId: string, userId: string, id: string) {
  const [d] = await withTenant(orgId, (tx) => tx.delete(schema.projectRisks).where(and(eq(schema.projectRisks.id, id), eq(schema.projectRisks.orgId, orgId))).returning({ id: schema.projectRisks.id, projectId: schema.projectRisks.projectId }));
  if (!d) throw new Error("risk not found");
  await audit({ orgId, actorUserId: userId, action: "risk.deleted", entityType: "project_risk", entityId: id, details: { projectId: d.projectId } });
}
