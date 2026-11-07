"use server";
/**
 * Server actions for the AI Workforce + Experience Center. zod-validated, permission-checked, tenant-scoped, audited
 * (the engine audits every mutation; actions audit denials of skill runs they block).
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import {
  provisionTeam, createCustomEmployee, updateEmployee, setStatus, setPermissionLevel, decideMemory, getEmployee, runCounts, WorkforceError,
  converse, runSkillSafe, loadSkills, personaByKey, PERSONAS, type EmployeePatch,
} from "@/engine/workforce";
import { listConnectorStates } from "@/engine/connectors/service";

type Ok<T = object> = { ok: true } & T;
type Err = { ok: false; error: string; missing?: string[] };
const uuid = z.string().uuid();
/** requireCtx() denies by redirect (NEXT_REDIRECT …/app?denied=<perm>); inside these try/catch blocks that must surface as a
 *  readable refusal, not the framework's internal error text. */
const deniedPerm = (e: unknown) => { const d = (e as { digest?: unknown })?.digest; return typeof d === "string" && d.startsWith("NEXT_REDIRECT") ? (d.match(/denied=([a-z:]+)/)?.[1] ?? "login") : null; };
const fail = (e: unknown): Err => deniedPerm(e) ? { ok: false, error: deniedPerm(e) === "login" ? "Your session has ended — sign in again." : `Your role can't do this (requires ${deniedPerm(e)}).` } : e instanceof WorkforceError ? { ok: false, error: e.message } : e instanceof z.ZodError ? { ok: false, error: e.issues.map((i) => i.message).join("; ") } : { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
function revalidate(id?: string) { revalidatePath("/app/workforce"); revalidatePath("/app/experience"); revalidatePath("/app/workforce/org-chart"); if (id) revalidatePath(`/app/workforce/${id}`); }

export async function provisionAction(raw: unknown): Promise<Ok<{ created: number; existing: number; ids: Record<string, string> }> | Err> {
  try {
    const ctx = await requireCtx("agents:write");
    const i = z.object({ personaKeys: z.array(z.string().max(40)).max(PERSONAS.length).optional() }).parse(raw ?? {});
    const r = await provisionTeam(ctx.orgId, ctx.userId, i.personaKeys);
    revalidate();
    return { ok: true, created: r.created.length, existing: r.existing.length, ids: Object.fromEntries([...r.created, ...r.existing].map((e) => [e.personaKey ?? e.id, e.id])) };
  } catch (e) { return fail(e); }
}

const RunIn = z.object({ aiEmployeeId: uuid, skillKey: z.string().min(1).max(60), mode: z.enum(["sandbox", "live"]), input: z.unknown().optional() });
/** Runs a skill. Sandbox: anyone who can see agents (synthetic data, no side effects). Live: agents:write AND the employee must be pilot/active. */
export async function runSkillAction(raw: unknown) {
  try {
    const ctx = await requireCtx("agents:read");
    const i = RunIn.parse(raw);
    const emp = await getEmployee(ctx.orgId, i.aiEmployeeId); if (!emp) return { ok: false as const, error: "AI employee not found." };
    if (!emp.skills.includes(i.skillKey)) return { ok: false as const, error: `${emp.firstName} does not have the "${i.skillKey}" skill. Add it under Customize responsibilities.` };
    if (i.mode === "live") {
      const why = !can(ctx.role, "agents:write") ? "Your role cannot assign live tasks." : !["pilot", "active"].includes(emp.status) ? `${emp.firstName} is in ${emp.status} status — live tasks need Pilot or Active.` : null;
      if (why) { await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "skill.run_denied", entityType: "ai_employee", entityId: emp.id, details: { skillKey: i.skillKey, reason: why } }); return { ok: false as const, error: why }; }
    }
    if (emp.status === "draft" && i.mode === "sandbox" && can(ctx.role, "agents:write")) await setStatus(ctx.orgId, { userId: ctx.userId, role: ctx.role }, emp.id, "sandbox").catch(() => null);
    const r = await runSkillSafe({ orgId: ctx.orgId, aiEmployeeId: emp.id, skillKey: i.skillKey, mode: i.mode, input: i.input, actorUserId: ctx.userId, actorRole: ctx.role });
    revalidate(emp.id);
    return { ok: true as const, result: JSON.parse(JSON.stringify(r)) as Record<string, unknown> };
  } catch (e) { return fail(e); }
}

export async function decideRunAction(raw: unknown) {
  try {
    const ctx = await requireCtx("agents:approve");
    const i = z.object({ skillRunId: uuid, decision: z.enum(["approve", "reject"]), note: z.string().max(1000).optional(), aiEmployeeId: uuid }).parse(raw);
    const api = await loadSkills(); if (!api) return { ok: false as const, error: "Skills engine unavailable." };
    const r = await api.decideSkillRun({ orgId: ctx.orgId, skillRunId: i.skillRunId, decision: i.decision, actorUserId: ctx.userId, note: i.note });
    revalidate(i.aiEmployeeId); return { ok: true as const, result: JSON.parse(JSON.stringify(r)) as Record<string, unknown> };
  } catch (e) { return fail(e); }
}
export async function reviewRunAction(raw: unknown): Promise<Ok | Err> {
  try {
    const ctx = await requireCtx("agents:approve");
    const i = z.object({ skillRunId: uuid, verdict: z.enum(["accepted", "corrected", "rejected"]), note: z.string().max(1000).optional(), improvement: z.string().max(1000).optional(), aiEmployeeId: uuid }).parse(raw);
    const api = await loadSkills(); if (!api) return { ok: false, error: "Skills engine unavailable." };
    await api.reviewSkillRun({ orgId: ctx.orgId, skillRunId: i.skillRunId, verdict: i.verdict, note: i.note, improvement: i.improvement, actorUserId: ctx.userId });
    revalidate(i.aiEmployeeId); return { ok: true };
  } catch (e) { return fail(e); }
}

export async function chatAction(raw: unknown) {
  try {
    const ctx = await requireCtx("agents:read");
    const i = z.object({ aiEmployeeId: uuid, conversationId: uuid.nullish(), message: z.string().trim().min(1).max(1500) }).parse(raw);
    const r = await converse({ orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, aiEmployeeId: i.aiEmployeeId, conversationId: i.conversationId ?? null, message: i.message });
    return { ok: true as const, ...r };
  } catch (e) { return fail(e); }
}

const Patch = z.object({
  firstName: z.string().trim().min(1).max(40), title: z.string().trim().min(1).max(80), intro: z.string().trim().max(600), departmentId: uuid.nullable(),
  responsibilities: z.array(z.string().trim().min(1).max(200)).max(20), expertise: z.array(z.string().trim().max(60)).max(10), skills: z.array(z.string().max(60)).max(12),
  knowledgeScope: z.object({ departmentIds: z.array(uuid).max(50).optional(), documentIds: z.array(uuid).max(200).optional(), categories: z.array(z.string().max(30)).max(20).optional() }),
  instructions: z.string().max(4000), monthlyRunBudget: z.number().int().min(0).max(100000), monthlyCostBudget: z.number().min(0).max(1_000_000),
  approvalOwnerUserId: uuid.nullable(),
}).partial();
export async function updateEmployeeAction(raw: unknown): Promise<Ok | Err> {
  try {
    const ctx = await requireCtx("agents:write");
    const i = z.object({ id: uuid, patch: Patch }).parse(raw);
    if (i.patch.skills) { const api = await loadSkills(); if (api) { const bad = i.patch.skills.filter((k) => !api.getSkill(k)); if (bad.length) return { ok: false, error: `Unknown skill(s): ${bad.join(", ")}` }; } }
    await updateEmployee(ctx.orgId, { userId: ctx.userId, role: ctx.role }, i.id, i.patch as EmployeePatch);
    revalidate(i.id); return { ok: true };
  } catch (e) { return fail(e); }
}

export async function setStatusAction(raw: unknown): Promise<Ok<{ status: string }> | Err> {
  try {
    const ctx = await requireCtx("agents:write");
    const i = z.object({ id: uuid, status: z.enum(["draft", "sandbox", "pilot", "active", "paused", "retired"]) }).parse(raw);
    const r = await setStatus(ctx.orgId, { userId: ctx.userId, role: ctx.role }, i.id, i.status);
    revalidate(i.id); return { ok: true, status: r.status };
  } catch (e) { return fail(e); }
}
export async function setPermissionAction(raw: unknown): Promise<Ok<{ level: string }> | Err> {
  try {
    const ctx = await requireCtx("agents:write");
    const i = z.object({ id: uuid, level: z.enum(["read_only", "draft_only", "act_with_approval", "autonomous"]), confirm: z.boolean().optional() }).parse(raw);
    const r = await setPermissionLevel(ctx.orgId, { userId: ctx.userId, role: ctx.role }, i.id, i.level, { confirm: i.confirm });
    revalidate(i.id); return { ok: true, level: r.permissionLevel };
  } catch (e) { return fail(e); }
}
export async function decideMemoryAction(raw: unknown): Promise<Ok | Err> {
  try {
    const ctx = await requireCtx("agents:approve");
    const i = z.object({ memoryId: uuid, decision: z.enum(["approve", "reject"]), aiEmployeeId: uuid }).parse(raw);
    await decideMemory(ctx.orgId, { userId: ctx.userId, role: ctx.role }, i.memoryId, i.decision);
    revalidate(i.aiEmployeeId); return { ok: true };
  } catch (e) { return fail(e); }
}

/** Records which of the employee's tools are connected — only providers whose connector is really configured/connected. */
export async function syncConnectionsAction(raw: unknown): Promise<Ok<{ connected: string[] }> | Err> {
  try {
    const ctx = await requireCtx("agents:write");
    const i = z.object({ id: uuid, providers: z.array(z.string().max(40)).max(30) }).parse(raw);
    const states = await listConnectorStates(ctx.orgId);
    const live = new Set(states.filter((s) => s.status === "connected" || s.status === "configured").map((s) => s.key));
    const connected = i.providers.filter((p) => live.has(p));
    await updateEmployee(ctx.orgId, { userId: ctx.userId, role: ctx.role }, i.id, { connectedProviders: connected });
    revalidate(i.id); return { ok: true, connected };
  } catch (e) { return fail(e); }
}

/** Experience "Start pilot": provision if needed; pilot only when a sandbox run already succeeded, else route to the demo. */
export async function startPilotAction(raw: unknown): Promise<Ok<{ id: string; status: string; needsDemo: boolean; message: string }> | Err> {
  try {
    const ctx = await requireCtx("agents:write");
    const i = z.object({ personaKey: z.string().max(40) }).parse(raw);
    if (!personaByKey(i.personaKey)) return { ok: false, error: "Unknown persona." };
    const r = await provisionTeam(ctx.orgId, ctx.userId, [i.personaKey]);
    const emp = r.created[0] ?? r.existing[0];
    const counts = await runCounts(ctx.orgId, emp.id);
    const actor = { userId: ctx.userId, role: ctx.role };
    if (!counts.sandboxSuccesses) { revalidate(emp.id); return { ok: true, id: emp.id, status: emp.status, needsDemo: true, message: `Watch ${emp.firstName}'s sandbox demonstration first — a pilot needs one successful sandbox run.` }; }
    let status = emp.status;
    if (status === "draft") status = (await setStatus(ctx.orgId, actor, emp.id, "sandbox")).status;
    if (status === "sandbox" || status === "paused") status = (await setStatus(ctx.orgId, actor, emp.id, "pilot")).status;
    revalidate(emp.id);
    return { ok: true, id: emp.id, status, needsDemo: false, message: status === "pilot" ? `${emp.firstName} is now in Pilot at ${emp.permissionLevel.replace(/_/g, " ")} permission.` : `${emp.firstName} is already ${status}.` };
  } catch (e) { return fail(e); }
}

const BuilderIn = z.object({
  id: uuid.nullish(), personaKey: z.string().max(40).nullish(), firstName: z.string().trim().min(1).max(40), title: z.string().trim().min(1).max(80), team: z.string().max(30),
  departmentId: uuid.nullable(), intro: z.string().max(600).optional(), responsibilities: z.array(z.string().trim().min(1).max(200)).max(20), skills: z.array(z.string().max(60)).max(12),
  knowledgeScope: Patch.shape.knowledgeScope.unwrap().optional(), monthlyRunBudget: z.number().int().min(0).max(100000).optional(), monthlyCostBudget: z.number().min(0).max(1_000_000).optional(),
  approvalOwnerUserId: uuid.nullable().optional(), connectedProviders: z.array(z.string().max(40)).max(30).optional(), portraitProvenance: z.enum(["ai_generated", "licensed", "none"]).optional(),
});
/** Builder autosave: creates the draft row on first save, then patches it. Never changes status/permission. */
export async function saveBuilderDraftAction(raw: unknown): Promise<Ok<{ id: string }> | Err> {
  try {
    const ctx = await requireCtx("agents:write");
    const i = BuilderIn.parse(raw);
    const actor = { userId: ctx.userId, role: ctx.role };
    let id = i.id ?? null;
    if (!id) {
      const e = await createCustomEmployee(ctx.orgId, ctx.userId, { firstName: i.firstName, title: i.title, team: i.team, departmentId: i.departmentId, intro: i.intro, responsibilities: i.responsibilities, skills: i.skills, personaKey: i.personaKey ?? null });
      id = e.id;
    }
    const states = i.connectedProviders ? await listConnectorStates(ctx.orgId) : [];
    const live = new Set(states.filter((s) => s.status === "connected" || s.status === "configured").map((s) => s.key));
    const existing = await getEmployee(ctx.orgId, id);
    const portraitUpdate = i.portraitProvenance === "none" && existing?.personaKey == null ? { portraitUrl: null, portraitProvenance: "none" as const } : {};
    await updateEmployee(ctx.orgId, actor, id, {
      firstName: i.firstName, title: i.title, departmentId: i.departmentId, responsibilities: i.responsibilities, skills: i.skills, knowledgeScope: i.knowledgeScope,
      monthlyRunBudget: i.monthlyRunBudget, monthlyCostBudget: i.monthlyCostBudget, approvalOwnerUserId: i.approvalOwnerUserId, connectedProviders: i.connectedProviders?.filter((p) => live.has(p)), ...portraitUpdate,
      ...(i.intro ? { intro: i.intro } : {}),
    });
    revalidate(id); return { ok: true, id };
  } catch (e) { return fail(e); }
}

/** Builder final step: sandbox → pilot only when allowed; otherwise leaves it as a draft and reports what's missing. */
export async function activateBuilderAction(raw: unknown): Promise<Ok<{ id: string; status: string; missing: string[] }> | Err> {
  try {
    const ctx = await requireCtx("agents:write");
    const i = z.object({ id: uuid }).parse(raw);
    const actor = { userId: ctx.userId, role: ctx.role };
    const emp = await getEmployee(ctx.orgId, i.id); if (!emp) return { ok: false, error: "AI employee not found." };
    const counts = await runCounts(ctx.orgId, emp.id);
    const missing: string[] = [];
    if (!counts.sandboxSuccesses) missing.push("a successful sandbox test run");
    if (!emp.approvalOwnerUserId) missing.push("an approval owner (Costs & risks step)");
    if (missing.length) return { ok: true, id: emp.id, status: emp.status, missing };
    let status = emp.status;
    if (status === "draft") status = (await setStatus(ctx.orgId, actor, emp.id, "sandbox")).status;
    if (status === "sandbox") status = (await setStatus(ctx.orgId, actor, emp.id, "pilot")).status;
    revalidate(emp.id); return { ok: true, id: emp.id, status, missing: [] };
  } catch (e) { return fail(e); }
}
