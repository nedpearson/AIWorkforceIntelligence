/**
 * AI Workforce engine — provisioning, editing, lifecycle gates and permission escalation for AI employees.
 *
 *  provisionTeam(orgId, userId, personaKeys?)        → idempotent on (orgId, personaKey); status draft, read_only
 *  createCustomEmployee(orgId, userId, input)        → custom (non-library) AI employee, always labelled AI
 *  updateEmployee(orgId, actor, id, patch)           → instructions edits bump instructionsVersion; audited
 *  setStatus(orgId, actor, id, to)                   → gated lifecycle (see checkStatusTransition)
 *  setPermissionLevel(orgId, actor, id, level, opts) → escalation needs owner/admin + explicit confirmation
 *
 * AI employees are AI: every intro states it. Nothing here grants a permission implicitly; every mutation is audited.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { PERSONAS, personaByKey, personaForOpportunity, type Persona, type Team } from "./personas";
import { ensurePilotAgent } from "./pilot-agent";

export type AiEmployee = typeof schema.aiEmployees.$inferSelect;
export type AiStatus = AiEmployee["status"];
export type PermissionLevel = AiEmployee["permissionLevel"];
export type Actor = { userId: string; role: string };

export class WorkforceError extends Error {
  constructor(public code: "not_found" | "forbidden" | "gate" | "confirmation_required" | "invalid", message: string) { super(message); this.name = "WorkforceError"; }
}

export const PERMISSION_ORDER: PermissionLevel[] = ["read_only", "draft_only", "act_with_approval", "autonomous"];
export const PERMISSION_LABEL: Record<PermissionLevel, { label: string; body: string }> = {
  read_only: { label: "Read only", body: "May read and analyze. Produces nothing outside BridgeBox." },
  draft_only: { label: "Draft only", body: "May prepare drafts stored in BridgeBox for a person to use." },
  act_with_approval: { label: "Act with approval", body: "Consequential actions wait for a named person to approve." },
  autonomous: { label: "Autonomous", body: "Acts without per-task approval (steps flagged always-approve still wait). Never the default." },
};
export const STATUS_LABEL: Record<AiStatus, string> = { draft: "Draft", sandbox: "Sandbox", pilot: "Pilot", active: "Active", paused: "Paused", retired: "Retired" };
const ELEVATED = ["owner", "admin"];

/** Team → department-name matcher used to place library personas in the department they serve. */
const TEAM_DEPT: Record<Team, RegExp | null> = {
  executive: null, finance: /financ|account|ap\b|ar\b/i, sales: /sales|business dev/i, operations: /operat|logistic|warehouse|supply/i,
  marketing: /market/i, hr: /\bhr\b|human|people|talent/i, customer_service: /customer|support|service/i,
};
export function departmentForTeam(team: string, depts: { id: string; name: string }[]): string | null {
  const rx = TEAM_DEPT[team as Team]; if (!rx) return null;
  return depts.find((d) => rx.test(d.name))?.id ?? null;
}

/** App names seen in workflows → connector catalog keys. Apps without an API connector (Chrome, Acrobat) map to nothing. */
export const APP_PROVIDER: Record<string, string> = {
  QuickBooks: "quickbooks", NetSuite: "netsuite", HubSpot: "hubspot", Salesforce: "salesforce", Zendesk: "zendesk", Slack: "slack", Teams: "teams",
  Outlook: "microsoft_365", Excel: "microsoft_365", Word: "microsoft_365", PowerPoint: "microsoft_365", SharePoint: "sharepoint", Workday: "workday", ADP: "adp", SAP: "sap", ServiceNow: "servicenow",
};
export const providersForApps = (apps: string[]) => [...new Set(apps.map((a) => APP_PROVIDER[a]).filter(Boolean))];

/** Ensures a greeting's first sentence says it is an AI agent. */
export function ensureAiIntro(firstName: string, title: string, intro?: string | null): string {
  const t = (intro ?? "").trim();
  if (/\bAI agent\b/i.test(t.split(/(?<=[.!?])\s/)[0] ?? "")) return t;
  const lead = `Hi, I'm ${firstName} — an AI agent working as your ${title}.`;
  return t ? `${lead} ${t}` : lead;
}

// ---------------------------------------------------------------- gates (pure, unit tested)
export type GateInput = { role: string; sandboxSuccesses: number; liveSuccesses: number };
export type GateResult = { ok: true } | { ok: false; reason: string; missing: string[] };
const TRANSITIONS: Record<AiStatus, AiStatus[]> = {
  draft: ["sandbox", "retired"], sandbox: ["pilot", "paused", "draft", "retired"], pilot: ["active", "paused", "sandbox", "retired"],
  active: ["paused", "pilot", "retired"], paused: ["sandbox", "pilot", "active", "retired"], retired: [],
};
export function checkStatusTransition(from: AiStatus, to: AiStatus, g: GateInput): GateResult {
  if (from === to) return { ok: true };
  if (!TRANSITIONS[from].includes(to)) return { ok: false, reason: `Cannot move from ${STATUS_LABEL[from]} to ${STATUS_LABEL[to]}.`, missing: [`allowed next states: ${TRANSITIONS[from].map((s) => STATUS_LABEL[s]).join(", ") || "none"}`] };
  const missing: string[] = [];
  if (to === "pilot" && g.sandboxSuccesses < 1) missing.push("at least one successful sandbox skill run (Watch a demonstration or the builder's Test step)");
  if (to === "active") {
    if (!ELEVATED.includes(g.role)) missing.push("an owner or admin to activate");
    if (g.liveSuccesses < 1) missing.push("at least one successful live skill run during the pilot");
  }
  return missing.length ? { ok: false, reason: `${STATUS_LABEL[to]} requires ${missing.join(" and ")}.`, missing } : { ok: true };
}
export function checkPermissionChange(from: PermissionLevel, to: PermissionLevel, g: { role: string; confirm?: boolean }): GateResult {
  const a = PERMISSION_ORDER.indexOf(from), b = PERMISSION_ORDER.indexOf(to);
  if (b <= a) return { ok: true }; // lowering is always allowed
  const missing: string[] = [];
  if (!ELEVATED.includes(g.role)) missing.push("an owner or admin");
  if (!g.confirm) missing.push("explicit confirmation");
  if (b - a > 1) missing.push(`stepping through ${PERMISSION_LABEL[PERMISSION_ORDER[a + 1]].label} first`);
  return missing.length ? { ok: false, reason: `Raising permission to ${PERMISSION_LABEL[to].label} requires ${missing.join(", ")}.`, missing } : { ok: true };
}

// ---------------------------------------------------------------- reads
export async function getEmployee(orgId: string, id: string): Promise<AiEmployee | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await withTenant(orgId, (tx) => tx.select().from(schema.aiEmployees).where(and(eq(schema.aiEmployees.orgId, orgId), eq(schema.aiEmployees.id, id))).limit(1));
  return r ?? null;
}
export async function listEmployees(orgId: string): Promise<AiEmployee[]> {
  return withTenant(orgId, (tx) => tx.select().from(schema.aiEmployees).where(eq(schema.aiEmployees.orgId, orgId)).orderBy(schema.aiEmployees.createdAt));
}
export async function runCounts(orgId: string, aiEmployeeId: string) {
  const rows = await withTenant(orgId, (tx) => tx.select({ mode: schema.skillRuns.mode, status: schema.skillRuns.status, n: sql<number>`count(*)::int` }).from(schema.skillRuns)
    .where(and(eq(schema.skillRuns.orgId, orgId), eq(schema.skillRuns.aiEmployeeId, aiEmployeeId))).groupBy(schema.skillRuns.mode, schema.skillRuns.status));
  const get = (mode: string, status: string) => rows.filter((r) => r.mode === mode && r.status === status).reduce((s, r) => s + r.n, 0);
  return { sandboxSuccesses: get("sandbox", "succeeded"), liveSuccesses: get("live", "succeeded"), total: rows.reduce((s, r) => s + r.n, 0) };
}

// ---------------------------------------------------------------- provisioning
function rowFromPersona(orgId: string, userId: string | null, p: Persona, departmentId: string | null, opportunityId: string | null) {
  return {
    orgId, personaKey: p.key, firstName: p.firstName, title: p.title, team: p.team, departmentId, intro: ensureAiIntro(p.firstName, p.title, p.intro),
    responsibilities: p.responsibilities, expertise: p.expertise, skills: p.skills, knowledgeScope: departmentId ? { departmentIds: [departmentId] } : {},
    portraitUrl: p.portrait, portraitProvenance: p.portrait ? "ai_generated" : "none", status: "draft" as const, permissionLevel: "read_only" as const,
    opportunityId, createdBy: userId,
  };
}

/** Creates AI employees from library personas. Idempotent on (orgId, personaKey): existing rows are left untouched. */
export async function provisionTeam(orgId: string, userId: string | null, personaKeys?: string[]): Promise<{ created: AiEmployee[]; existing: AiEmployee[] }> {
  const wanted = (personaKeys?.length ? personaKeys : PERSONAS.map((p) => p.key)).map(personaByKey).filter((p): p is Persona => !!p);
  if (!wanted.length) return { created: [], existing: [] };
  const res = await withTenant(orgId, async (tx) => {
    const depts = await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, orgId));
    const opps = await tx.select({ id: schema.opportunities.id, cat: schema.opportunities.recommendedAgentCategory, status: schema.opportunities.status, realizable: schema.opportunities.realizableAnnualSavings, steps: schema.workflows.steps, departmentId: schema.opportunities.departmentId })
      .from(schema.opportunities).leftJoin(schema.workflows, eq(schema.workflows.id, schema.opportunities.workflowId))
      .where(and(eq(schema.opportunities.orgId, orgId), inArray(schema.opportunities.status, ["identified", "reviewing", "approved", "in_progress", "deployed", "verified"])));
    // best opportunity per persona (largest realizable) — links the employee to the work it would take over
    const oppFor = new Map<string, { id: string; departmentId: string | null; v: number }>();
    for (const o of opps) {
      const p = personaForOpportunity({ recommendedAgentCategory: o.cat, apps: [...new Set((o.steps ?? []).map((s) => s.app))] });
      if (!p) continue; const v = Number(o.realizable) || 0; const cur = oppFor.get(p.key);
      if (!cur || v > cur.v) oppFor.set(p.key, { id: o.id, departmentId: o.departmentId, v });
    }
    const existing = await tx.select().from(schema.aiEmployees).where(and(eq(schema.aiEmployees.orgId, orgId), inArray(schema.aiEmployees.personaKey, wanted.map((p) => p.key))));
    const have = new Set(existing.map((e) => e.personaKey));
    const toInsert = wanted.filter((p) => !have.has(p.key)).map((p) => { const o = oppFor.get(p.key); return rowFromPersona(orgId, userId, p, departmentForTeam(p.team, depts) ?? o?.departmentId ?? null, o?.id ?? null); });
    const created = toInsert.length ? await tx.insert(schema.aiEmployees).values(toInsert).onConflictDoNothing({ target: [schema.aiEmployees.orgId, schema.aiEmployees.personaKey] }).returning() : [];
    return { created, existing };
  });
  if (res.created.length) await audit({ orgId, actorUserId: userId, action: "ai_employee.provision", entityType: "ai_employee", details: { created: res.created.map((c) => c.personaKey), existing: res.existing.length } });
  return res;
}

export type CustomInput = { firstName: string; title: string; team: string; departmentId?: string | null; intro?: string; responsibilities?: string[]; expertise?: string[]; skills?: string[]; personaKey?: string | null };
export async function createCustomEmployee(orgId: string, userId: string, i: CustomInput): Promise<AiEmployee> {
  const firstName = i.firstName.trim().slice(0, 40), title = i.title.trim().slice(0, 80);
  if (!firstName || !title) throw new WorkforceError("invalid", "A name and a position title are required.");
  const persona = i.personaKey ? personaByKey(i.personaKey) : null;
  if (persona) {
    const r = await provisionTeam(orgId, userId, [persona.key]);
    const e = r.created[0] ?? r.existing[0];
    return i.departmentId && e.departmentId !== i.departmentId ? (await updateEmployee(orgId, { userId, role: "owner" }, e.id, { departmentId: i.departmentId }, { skipRoleCheck: true })) : e;
  }
  const [row] = await withTenant(orgId, (tx) => tx.insert(schema.aiEmployees).values({
    orgId, personaKey: null, firstName, title, team: i.team || "custom", departmentId: i.departmentId ?? null, intro: ensureAiIntro(firstName, title, i.intro),
    responsibilities: (i.responsibilities ?? []).slice(0, 20), expertise: (i.expertise ?? []).slice(0, 10), skills: (i.skills ?? []).slice(0, 12),
    knowledgeScope: i.departmentId ? { departmentIds: [i.departmentId] } : {}, portraitUrl: null, portraitProvenance: "none", status: "draft", permissionLevel: "read_only", createdBy: userId,
  }).returning());
  await audit({ orgId, actorUserId: userId, action: "ai_employee.create_custom", entityType: "ai_employee", entityId: row.id, details: { title, team: row.team } });
  return row;
}

export type EmployeePatch = Partial<{
  firstName: string; title: string; intro: string; departmentId: string | null; responsibilities: string[]; expertise: string[]; skills: string[];
  knowledgeScope: { departmentIds?: string[]; documentIds?: string[]; categories?: string[] }; instructions: string; monthlyRunBudget: number; monthlyCostBudget: number;
  approvalOwnerUserId: string | null; connectedProviders: string[]; portraitUrl: string | null; portraitProvenance: "ai_generated" | "licensed" | "none"; agentId: string | null; opportunityId: string | null;
}>;
/** Edits configuration. Never changes status or permission level (use setStatus / setPermissionLevel). */
export async function updateEmployee(orgId: string, actor: Actor, id: string, patch: EmployeePatch, opts: { skipRoleCheck?: boolean } = {}): Promise<AiEmployee> {
  void opts;
  const cur = await getEmployee(orgId, id); if (!cur) throw new WorkforceError("not_found", "AI employee not found.");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; set[k] = v; changed.push(k); }
  if (patch.intro !== undefined) set.intro = ensureAiIntro(patch.firstName ?? cur.firstName, patch.title ?? cur.title, patch.intro);
  if (patch.instructions !== undefined && patch.instructions !== cur.instructions) set.instructionsVersion = cur.instructionsVersion + 1;
  else delete set.instructionsVersion;
  if (patch.approvalOwnerUserId) {
    const ok = await withTenant(orgId, (tx) => tx.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, patch.approvalOwnerUserId!))).limit(1));
    if (!ok.length) throw new WorkforceError("invalid", "The approval owner must be a member of this organization.");
  }
  const [row] = await withTenant(orgId, (tx) => tx.update(schema.aiEmployees).set(set).where(and(eq(schema.aiEmployees.orgId, orgId), eq(schema.aiEmployees.id, id))).returning());
  await audit({ orgId, actorUserId: actor.userId, action: "ai_employee.update", entityType: "ai_employee", entityId: id, details: { fields: changed, instructionsVersion: row.instructionsVersion, ...(set.instructionsVersion ? { instructionsVersionFrom: cur.instructionsVersion } : {}) } });
  return row;
}

export async function setStatus(orgId: string, actor: Actor, id: string, to: AiStatus): Promise<AiEmployee> {
  const cur = await getEmployee(orgId, id); if (!cur) throw new WorkforceError("not_found", "AI employee not found.");
  const counts = await runCounts(orgId, id);
  const g = checkStatusTransition(cur.status, to, { role: actor.role, ...counts });
  if (!g.ok) {
    await audit({ orgId, actorUserId: actor.userId, action: "ai_employee.status_denied", entityType: "ai_employee", entityId: id, details: { from: cur.status, to, missing: g.missing } });
    throw new WorkforceError("gate", g.reason);
  }
  const [row] = await withTenant(orgId, (tx) => tx.update(schema.aiEmployees).set({ status: to, updatedAt: new Date() }).where(and(eq(schema.aiEmployees.orgId, orgId), eq(schema.aiEmployees.id, id))).returning());
  await audit({ orgId, actorUserId: actor.userId, action: "ai_employee.status", entityType: "ai_employee", entityId: id, details: { from: cur.status, to, ...counts } });
  // A pilot does live work: link an executable agent so that work reaches the run ledger and can be measured.
  if (to === "pilot" || to === "active") return ensurePilotAgent(orgId, actor.userId, row);
  return row;
}

export async function setPermissionLevel(orgId: string, actor: Actor, id: string, to: PermissionLevel, opts: { confirm?: boolean } = {}): Promise<AiEmployee> {
  const cur = await getEmployee(orgId, id); if (!cur) throw new WorkforceError("not_found", "AI employee not found.");
  const g = checkPermissionChange(cur.permissionLevel, to, { role: actor.role, confirm: opts.confirm });
  if (!g.ok) {
    await audit({ orgId, actorUserId: actor.userId, action: "ai_employee.permission_denied", entityType: "ai_employee", entityId: id, details: { from: cur.permissionLevel, to, missing: g.missing } });
    throw new WorkforceError(g.missing.includes("explicit confirmation") && g.missing.length === 1 ? "confirmation_required" : "forbidden", g.reason);
  }
  const [row] = await withTenant(orgId, (tx) => tx.update(schema.aiEmployees).set({ permissionLevel: to, updatedAt: new Date() }).where(and(eq(schema.aiEmployees.orgId, orgId), eq(schema.aiEmployees.id, id))).returning());
  await audit({ orgId, actorUserId: actor.userId, action: "ai_employee.permission", entityType: "ai_employee", entityId: id, details: { from: cur.permissionLevel, to, confirmed: !!opts.confirm, escalation: PERMISSION_ORDER.indexOf(to) > PERMISSION_ORDER.indexOf(cur.permissionLevel) } });
  return row;
}

/** Manager decision on a pending memory item. Memory never alters permissions/security. */
export async function decideMemory(orgId: string, actor: Actor, memoryId: string, decision: "approve" | "reject") {
  const [row] = await withTenant(orgId, (tx) => tx.update(schema.aiEmployeeMemory).set({ status: decision === "approve" ? "approved" : "rejected", approvedBy: actor.userId, approvedAt: new Date() })
    .where(and(eq(schema.aiEmployeeMemory.orgId, orgId), eq(schema.aiEmployeeMemory.id, memoryId), eq(schema.aiEmployeeMemory.status, "pending_review"))).returning());
  if (!row) throw new WorkforceError("not_found", "Memory item not found or already decided.");
  await audit({ orgId, actorUserId: actor.userId, action: `ai_employee.memory_${decision}`, entityType: "ai_employee_memory", entityId: memoryId, details: { aiEmployeeId: row.aiEmployeeId, kind: row.kind } });
  return row;
}
