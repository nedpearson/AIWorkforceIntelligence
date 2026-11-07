/**
 * Skills engine — implements SkillsApi (./contract.ts). UI and other engines import ONLY from "@/engine/skills".
 *
 * runSkill enforcement order (all in code, before any skill logic runs):
 *   1. skill exists · 2. AI employee belongs to the org (withTenant + org filter) · 3. caller RBAC (agents:read for sandbox,
 *   agents:write for live) · 4. status (sandbox always; live only `pilot`/`active`) · 5. live: skill assigned to the employee,
 *   synthetic samples refused · 6. live budgets (monthlyRunBudget runs, monthlyCostBudget at SKILL_RUN_UNIT_COST_USD per run)
 *   · 7. zod input validation. A refusal is persisted (status failed, output.blocked = code) and audited, and never counts
 *   toward budgets.
 * Execution: knowledge is read only through the employee's knowledgeScope + caller role; approved memory is injected and shown
 *   as "Applied approved procedure vN" steps; every step is timed and persisted; the runtime appends "Record processing time"
 *   and "Calculate savings". Live succeeded runs of an employee linked to an agent write an agent_runs row (trigger "skill",
 *   minutesSaved = baseline − (automated + review)) so they flow into recordSavingsFromRunLedger. Sandbox runs NEVER do.
 */
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { can, type Role } from "@/lib/rbac";
import { computeOrgFinancials } from "@/engine/finance";
import type { RunLog } from "@/db/schema";
import type { SkillDefinition, SkillResult, SkillStep, SkillsApi } from "./contract";
import { computeSavings, SkillCtx, type BaselineInfo, type EmployeeInfo, type MemoryItem, type PendingAction, type RateInfo, type SkillImpl, type SavingsCalc } from "./runtime";
import { processInvoice } from "./process-invoice";
import { analyzeFinancials, prepareInvoice, reconcileTransactions } from "./finance-skills";
import { draftCustomerEmail, followUpLead, generateMarketing, generateProposal, updateCrm } from "./sales-skills";
import { analyzeOperations, purchasingRecommendation, reviewDocument, scheduleAppointment, summarizeMeeting, weeklyReport } from "./ops-skills";

export type * from "./contract";
export type { PendingAction, SavingsCalc } from "./runtime";
export { INVOICE_SAMPLES, parseInvoiceText, validateInvoice, matchPurchaseOrder, buildAccountingEntry } from "./invoice";
export { extractPdfText } from "./pdf-text";

/** Planning allowance per LIVE run used for monthlyCostBudget: deterministic compute is negligible; a model-polished run at
 *  claude-sonnet-4-5 list prices ($3/M input, $15/M output tokens) with ~3k in / 1k out ≈ $0.024. $0.25 leaves headroom for retries
 *  and long inputs. It is a budget control, not a price charged to anyone. */
export const SKILL_RUN_UNIT_COST_USD = 0.25;
/** Human minutes added when a person decides an approval (assumption, mirrors the agent runner's default reviewMinutes). */
export const APPROVAL_REVIEW_MINUTES = 2;
const LIVE_STATUSES = ["pilot", "active"];

const IMPLS: SkillImpl<unknown>[] = [processInvoice, prepareInvoice, reconcileTransactions, draftCustomerEmail, generateProposal, analyzeFinancials, scheduleAppointment, weeklyReport, summarizeMeeting, reviewDocument, followUpLead, purchasingRecommendation, updateCrm, generateMarketing, analyzeOperations] as unknown as SkillImpl<unknown>[];
export const SKILLS: SkillDefinition[] = IMPLS;
export function getSkill(key: string): SkillDefinition | undefined { return IMPLS.find((s) => s.key === key); }
const impl = (key: string) => IMPLS.find((s) => s.key === key);

/** Plain-JSON catalog for client components (no zod, no functions). */
export type SkillMeta = { key: string; name: string; description: string; category: SkillDefinition["category"]; access: SkillDefinition["access"]; manualBaselineMinutes: number; baselineBasis: string; reviewMinutes: number; outputDescription: string; generative: boolean; alwaysApproveSteps: string[]; requiresProviders: string[]; samples: { key: string; label: string; description?: string; input: unknown }[] };
export function skillCatalog(keys?: string[]): SkillMeta[] {
  return IMPLS.filter((s) => !keys || keys.includes(s.key)).map((s) => ({ key: s.key, name: s.name, description: s.description, category: s.category, access: s.access, manualBaselineMinutes: s.manualBaselineMinutes, baselineBasis: s.baselineBasis, reviewMinutes: s.reviewMinutes, outputDescription: s.outputDescription, generative: !!s.generative, alwaysApproveSteps: s.alwaysApproveSteps ?? [], requiresProviders: s.requiresProviders ?? [], samples: s.samples() }));
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ---------------------------------------------------------------------------------------------- loaders
async function loadEmployee(orgId: string, id: string): Promise<EmployeeInfo | null> {
  if (!isUuid(id) || !isUuid(orgId)) return null;
  const [e] = await withTenant(orgId, (tx) => tx.select().from(schema.aiEmployees).where(and(eq(schema.aiEmployees.id, id), eq(schema.aiEmployees.orgId, orgId))).limit(1));
  if (!e) return null;
  return { id: e.id, firstName: e.firstName, title: e.title, team: e.team, departmentId: e.departmentId, agentId: e.agentId, knowledgeScope: e.knowledgeScope ?? {}, skills: e.skills ?? [], permissionLevel: e.permissionLevel, status: e.status, monthlyRunBudget: e.monthlyRunBudget, monthlyCostBudget: num(e.monthlyCostBudget) } as EmployeeInfo & { monthlyRunBudget: number; monthlyCostBudget: number };
}
async function loadMemory(orgId: string, empId: string): Promise<MemoryItem[]> {
  const rows = await withTenant(orgId, (tx) => tx.select().from(schema.aiEmployeeMemory).where(and(eq(schema.aiEmployeeMemory.orgId, orgId), eq(schema.aiEmployeeMemory.aiEmployeeId, empId), eq(schema.aiEmployeeMemory.status, "approved"))).orderBy(asc(schema.aiEmployeeMemory.approvedAt), asc(schema.aiEmployeeMemory.createdAt)));
  return rows.map((m, i) => ({ id: m.id, kind: m.kind, text: m.text, version: i + 1 })).slice(-5);
}
async function memberRole(orgId: string, userId: string): Promise<Role | null> {
  if (!isUuid(userId)) return null;
  const [m] = await withTenant(orgId, (tx) => tx.select({ role: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId))).limit(1));
  if (m) return m.role as Role;
  // consultancy members acting in a managed client org act as "consultant" (same rule as getCtx)
  const [org] = await withTenant(orgId, (tx) => tx.select({ parent: schema.organizations.parentOrgId }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1));
  if (!org?.parent) return null;
  const [pm] = await db.select({ role: schema.memberships.role }).from(schema.memberships).where(and(eq(schema.memberships.orgId, org.parent), eq(schema.memberships.userId, userId))).limit(1);
  return pm && ["owner", "admin", "consultant"].includes(pm.role) ? "consultant" : null;
}

async function resolveBaseline(orgId: string, emp: EmployeeInfo, skill: SkillImpl<unknown>, mode: string): Promise<BaselineInfo> {
  const assumed: BaselineInfo = { minutes: skill.manualBaselineMinutes, basis: "assumed", source: skill.baselineBasis };
  if (mode !== "live" || !emp.agentId) return assumed;
  const r = await withTenant(orgId, async (tx) => {
    const [a] = await tx.select({ baseline: schema.agents.baselineMinutesPerRun, workflowId: schema.agents.workflowId, name: schema.agents.name }).from(schema.agents).where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, emp.agentId!))).limit(1);
    const [w] = a?.workflowId ? await tx.select({ avg: schema.workflows.avgDurationMin, name: schema.workflows.name }).from(schema.workflows).where(and(eq(schema.workflows.orgId, orgId), eq(schema.workflows.id, a.workflowId))).limit(1) : [];
    return { a, w };
  });
  if (r.w && num(r.w.avg) > 0) return { minutes: Math.round(num(r.w.avg) * 100) / 100, basis: "observed", source: `Observed average duration of workflow “${r.w.name}” (process mining)` };
  if (r.a && num(r.a.baseline) > 0) return { minutes: num(r.a.baseline), basis: "estimated", source: `Baseline minutes per run configured on agent “${r.a.name}”` };
  return assumed;
}
async function resolveRate(orgId: string, emp: EmployeeInfo): Promise<RateInfo> {
  const fin = await computeOrgFinancials(orgId).catch(() => null);
  const costed = (fin?.byEmployee ?? []).filter((e) => e.loadedHourly > 0);
  if (!costed.length) return { hourly: null, basis: "assumed", source: "No costed employees in BridgeBox yet — value shown in minutes only", performers: 0 };
  const byId = new Map(costed.map((e) => [e.employeeId, e]));
  if (emp.agentId) {
    const links = await withTenant(orgId, async (tx) => {
      const [a] = await tx.select({ workflowId: schema.agents.workflowId }).from(schema.agents).where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, emp.agentId!))).limit(1);
      if (!a?.workflowId) return [];
      return tx.select({ employeeId: schema.workflowEmployees.employeeId, hours: schema.workflowEmployees.hoursPerWeek }).from(schema.workflowEmployees).where(and(eq(schema.workflowEmployees.orgId, orgId), eq(schema.workflowEmployees.workflowId, a.workflowId)));
    });
    let w = 0, s = 0, n = 0, observed = true;
    for (const l of links) { const e = byId.get(l.employeeId); if (!e) continue; const h = num(l.hours) || 1; s += e.loadedHourly * h; w += h; n++; if (e.costBasis !== "observed") observed = false; }
    if (w > 0) return { hourly: Math.round((s / w) * 100) / 100, basis: observed ? "observed" : "estimated", source: `Hours-weighted loaded rate of ${n} performer(s) of the linked agent's workflow (finance engine)`, performers: n };
  }
  if (emp.departmentId) {
    const d = costed.filter((e) => e.departmentId === emp.departmentId);
    if (d.length) return { hourly: Math.round((d.reduce((a, e) => a + e.loadedHourly, 0) / d.length) * 100) / 100, basis: d.every((e) => e.costBasis === "observed") ? "observed" : "estimated", source: `Average loaded rate of ${d.length} employee(s) in ${d[0].departmentName ?? "the department"} (finance engine)`, performers: d.length };
  }
  return { hourly: Math.round((costed.reduce((a, e) => a + e.loadedHourly, 0) / costed.length) * 100) / 100, basis: "estimated", source: `Organization average loaded rate across ${costed.length} costed employee(s) (finance engine)`, performers: costed.length };
}

// ---------------------------------------------------------------------------------------------- persistence helpers
type RunRow = typeof schema.skillRuns.$inferSelect;
const toResult = (r: RunRow): SkillResult => ({
  ok: r.status === "succeeded" || r.status === "awaiting_approval", status: (["succeeded", "failed", "awaiting_approval", "rejected"].includes(r.status) ? r.status : "failed") as SkillResult["status"],
  summary: String((r.output as { summary?: string }).summary ?? r.error ?? ""), output: r.output, steps: r.steps as SkillStep[], citations: r.citations as SkillResult["citations"], durationMs: r.durationMs,
  manualBaselineMinutes: num(r.manualBaselineMinutes), humanReviewMinutes: num(r.humanReviewMinutes), synthetic: r.mode === "sandbox", error: r.error ?? undefined, skillRunId: r.id,
});

async function blockedRun(a: { orgId: string; emp: EmployeeInfo; skillKey: string; mode: string; input: unknown; actorUserId: string; actorRole: string }, code: string, message: string, manualBaselineMinutes: number): Promise<SkillResult> {
  const steps: SkillStep[] = [{ key: "policy", label: "Check permissions, status and budget", status: "failed", ms: 0, detail: message }];
  const [row] = await withTenant(a.orgId, (tx) => tx.insert(schema.skillRuns).values({ orgId: a.orgId, aiEmployeeId: a.emp.id, skillKey: a.skillKey, mode: a.mode, status: "failed", input: safeInput(a.input), output: { blocked: code, summary: message }, steps, citations: [], durationMs: 0, manualBaselineMinutes: String(manualBaselineMinutes), humanReviewMinutes: "0", requestedBy: isUuid(a.actorUserId) ? a.actorUserId : null, error: message }).returning());
  await audit({ orgId: a.orgId, actorUserId: isUuid(a.actorUserId) ? a.actorUserId : null, action: "skill.run.blocked", entityType: "skill_run", entityId: row.id, details: { skillKey: a.skillKey, mode: a.mode, code, aiEmployeeId: a.emp.id, actorRole: a.actorRole } });
  return { ...toResult(row), ok: false, status: "failed", error: message, summary: message };
}
function safeInput(input: unknown): Record<string, unknown> {
  if (input == null || typeof input !== "object") return { value: input ?? null };
  const s = JSON.stringify(input); if (s.length <= 400_000) return input as Record<string, unknown>;
  const o = { ...(input as Record<string, unknown>) }; if (o.file && typeof o.file === "object") o.file = { ...(o.file as object), dataBase64: `[${(o.file as { dataBase64?: string }).dataBase64?.length ?? 0} base64 chars omitted]` };
  return o;
}

async function monthlyLiveRuns(orgId: string, empId: string): Promise<number> {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const [r] = await withTenant(orgId, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(schema.skillRuns).where(and(eq(schema.skillRuns.orgId, orgId), eq(schema.skillRuns.aiEmployeeId, empId), eq(schema.skillRuns.mode, "live"), gte(schema.skillRuns.createdAt, start), sql`(${schema.skillRuns.output}->>'blocked') is null`)));
  return r?.n ?? 0;
}

function finalizeSteps(ctx: SkillCtx, p: { durationMs: number; reviewMinutes: number; baseline: BaselineInfo; rate: RateInfo; status: string }): SavingsCalc {
  const s = computeSavings({ baseline: p.baseline, durationMs: p.durationMs, reviewMinutes: p.reviewMinutes, rate: p.rate, mode: ctx.mode, status: p.status, agentLinked: !!ctx.employee.agentId });
  ctx.steps = ctx.steps.filter((x) => x.key !== "record_time" && x.key !== "savings");
  ctx.steps.push({ key: "record_time", label: "Record processing time", status: "done", ms: 0, detail: `Automated processing took ${Math.round(p.durationMs).toLocaleString()} ms; human review allowance ${p.reviewMinutes} min${p.status === "awaiting_approval" ? " (approval time added when decided)" : ""}.`, data: { durationMs: Math.round(p.durationMs), humanReviewMinutes: p.reviewMinutes } });
  const value = s.valueUsd != null ? `, worth $${s.valueUsd.toFixed(2)} at $${s.hourlyRate!.toFixed(2)}/h (${s.hourlyBasis}: ${s.hourlySource})` : " (no costed employees, so no dollar value)";
  ctx.steps.push({ key: "savings", label: "Calculate savings", status: "done", ms: 0, detail: `Manual ${s.baselineMinutes} min (${s.baselineBasis}) vs ${(s.automatedMinutes + s.reviewMinutes).toFixed(2)} min with the AI employee → ${s.minutesSaved} min saved${value}. ${s.countsNote}`, data: { ...s } });
  return s;
}

async function writeAgentRun(orgId: string, agentId: string, run: { id: string; skillKey: string; aiEmployeeId: string; summary: string; steps: SkillStep[]; createdAt: Date }, s: SavingsCalc): Promise<string | null> {
  return withTenant(orgId, async (tx) => {
    const [agent] = await tx.select({ id: schema.agents.id, status: schema.agents.status }).from(schema.agents).where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, agentId))).limit(1);
    if (!agent || agent.status === "retired") return null;
    const logs: RunLog[] = run.steps.map((st) => ({ t: new Date().toISOString(), level: st.status === "failed" ? "error" : "info", nodeId: st.key, msg: `${st.label}: ${st.status}${st.detail ? ` — ${st.detail}` : ""}`.slice(0, 1000) }));
    const [ar] = await tx.insert(schema.agentRuns).values({ orgId, agentId, status: "succeeded", trigger: "skill", input: { skillRunId: run.id, skillKey: run.skillKey, aiEmployeeId: run.aiEmployeeId }, output: { summary: run.summary, skillRunId: run.id }, logs, minutesSaved: s.minutesSaved.toFixed(2), humanMinutes: s.reviewMinutes.toFixed(2), startedAt: run.createdAt, finishedAt: new Date() }).returning({ id: schema.agentRuns.id });
    await tx.update(schema.agents).set({ lastRunAt: new Date() }).where(eq(schema.agents.id, agentId));
    return ar.id;
  });
}

// ---------------------------------------------------------------------------------------------- runSkill
export const runSkill: SkillsApi["runSkill"] = async (args) => {
  const { orgId, aiEmployeeId, skillKey, mode, actorUserId, actorRole } = args;
  const skill = impl(skillKey);
  const bare = (error: string): SkillResult => ({ ok: false, status: "failed", summary: error, output: {}, steps: [], citations: [], durationMs: 0, manualBaselineMinutes: skill?.manualBaselineMinutes ?? 0, humanReviewMinutes: 0, synthetic: mode === "sandbox", error });
  if (!skill) return bare(`Unknown skill “${skillKey}”`);
  if (mode !== "sandbox" && mode !== "live") return bare("mode must be sandbox or live");
  const emp = await loadEmployee(orgId, aiEmployeeId) as (EmployeeInfo & { monthlyRunBudget: number; monthlyCostBudget: number }) | null;
  if (!emp) {
    await audit({ orgId: isUuid(orgId) ? orgId : null, actorUserId: isUuid(actorUserId) ? actorUserId : null, action: "skill.run.denied", entityType: "ai_employee", entityId: isUuid(aiEmployeeId) ? aiEmployeeId : undefined, details: { skillKey, mode, reason: "ai_employee_not_in_org" } });
    return bare("AI employee not found in this organization");
  }
  const base = { orgId, emp, skillKey, mode, input: args.input, actorUserId, actorRole };
  // RBAC
  if (mode === "live" && !can(actorRole as Role, "agents:write")) return blockedRun(base, "rbac", "Your role can watch sandbox demonstrations but cannot run AI employees on live data (needs agents:write).", skill.manualBaselineMinutes);
  if (mode === "sandbox" && !can(actorRole as Role, "agents:read")) return blockedRun(base, "rbac", "Your role cannot run AI employee demonstrations (needs agents:read).", skill.manualBaselineMinutes);
  if (emp.status === "retired") return blockedRun(base, "status", "This AI employee is retired.", skill.manualBaselineMinutes);
  if (mode === "live") {
    if (!LIVE_STATUSES.includes(emp.status)) return blockedRun(base, "status", `Live work requires the AI employee to be in pilot or active status (currently ${emp.status}). Sandbox demonstrations are always available.`, skill.manualBaselineMinutes);
    if (emp.skills.length && !emp.skills.includes(skillKey)) return blockedRun(base, "skill_not_assigned", `${emp.firstName} is not assigned the “${skill.name}” skill.`, skill.manualBaselineMinutes);
    if (args.input == null) return blockedRun(base, "input_required", "Live runs need real input — synthetic samples only run in sandbox.", skill.manualBaselineMinutes);
    if (typeof args.input === "object" && (args.input as { sampleKey?: unknown }).sampleKey) return blockedRun(base, "synthetic_in_live", "Synthetic samples can only run in sandbox mode; provide real data for live runs.", skill.manualBaselineMinutes);
    const used = await monthlyLiveRuns(orgId, emp.id);
    if (used >= emp.monthlyRunBudget) return blockedRun(base, "run_budget", `Monthly run budget reached (${used}/${emp.monthlyRunBudget} live runs). An owner can raise it.`, skill.manualBaselineMinutes);
    if ((used + 1) * SKILL_RUN_UNIT_COST_USD > emp.monthlyCostBudget + 1e-9) return blockedRun(base, "cost_budget", `Monthly cost budget reached ($${(used * SKILL_RUN_UNIT_COST_USD).toFixed(2)} of $${emp.monthlyCostBudget.toFixed(2)} at $${SKILL_RUN_UNIT_COST_USD.toFixed(2)}/run). An owner can raise it.`, skill.manualBaselineMinutes);
  }
  const rawInput = args.input ?? skill.sampleInput();
  const parsed = skill.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const msg = `Invalid input: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
    return blockedRun({ ...base, input: rawInput }, "invalid_input", msg, skill.manualBaselineMinutes);
  }

  const [row] = await withTenant(orgId, (tx) => tx.insert(schema.skillRuns).values({ orgId, aiEmployeeId: emp.id, skillKey, mode, status: "running", input: safeInput(rawInput), output: {}, steps: [], citations: [], durationMs: 0, requestedBy: isUuid(actorUserId) ? actorUserId : null }).returning());
  const persistSteps = async (steps: SkillStep[]) => { await withTenant(orgId, (tx) => tx.update(schema.skillRuns).set({ steps }).where(and(eq(schema.skillRuns.id, row.id), eq(schema.skillRuns.orgId, orgId)))); };
  const memory = await loadMemory(orgId, emp.id);
  const ctx = new SkillCtx(orgId, mode, emp, actorUserId, actorRole, skill, memory, persistSteps);
  for (const m of memory) ctx.steps.push({ key: `memory_v${m.version}`, label: `Applied approved procedure v${m.version}`, status: "done", ms: 0, detail: m.text.slice(0, 280), data: { memoryId: m.id, kind: m.kind } });

  const t0 = now();
  let status: "succeeded" | "failed" | "awaiting_approval" = "succeeded"; let error: string | null = null;
  let exec: Awaited<ReturnType<SkillImpl["execute"]>> | null = null;
  try { exec = await skill.execute(ctx, parsed.data); if (exec.pending) status = "awaiting_approval"; }
  catch (e) { status = "failed"; error = e instanceof Error ? e.message : String(e); }
  const durationMs = Math.round((now() - t0) * 100) / 100;
  const reviewMinutes = exec?.humanReviewMinutes ?? skill.reviewMinutes;
  const [baseline, rate] = await Promise.all([resolveBaseline(orgId, emp, skill, mode), resolveRate(orgId, emp)]);
  const savings = finalizeSteps(ctx, { durationMs, reviewMinutes: status === "failed" ? 0 : reviewMinutes, baseline, rate, status });
  const summary = status === "failed" ? `${skill.name} failed: ${error}` : exec!.summary;
  const output: Record<string, unknown> = { ...(exec?.output ?? {}), summary, savings, synthetic: mode === "sandbox", permissionLevel: emp.permissionLevel, mode: ctx.llmUsed ? "llm" : "deterministic", appliedMemory: memory.map((m) => ({ id: m.id, version: m.version, kind: m.kind })), ...(exec?.pending ? { approval: { ...exec.pending, status: "pending" } } : {}) };
  let agentRunId: string | null = null;
  if (mode === "live" && status === "succeeded" && emp.agentId) agentRunId = await writeAgentRun(orgId, emp.agentId, { id: row.id, skillKey, aiEmployeeId: emp.id, summary, steps: ctx.steps, createdAt: row.createdAt }, savings);
  const [done] = await withTenant(orgId, (tx) => tx.update(schema.skillRuns).set({ status, output, steps: ctx.steps, citations: ctx.citations, durationMs: Math.round(durationMs), manualBaselineMinutes: String(baseline.minutes), humanReviewMinutes: String(status === "failed" ? 0 : reviewMinutes), agentRunId, error }).where(and(eq(schema.skillRuns.id, row.id), eq(schema.skillRuns.orgId, orgId))).returning());
  await audit({ orgId, actorUserId: isUuid(actorUserId) ? actorUserId : null, action: `skill.run.${mode}`, entityType: "skill_run", entityId: row.id, details: { skillKey, aiEmployeeId: emp.id, status, permissionLevel: emp.permissionLevel, durationMs: Math.round(durationMs), citations: ctx.citations.length, agentRunId, actorRole } });
  return { ...toResult(done), durationMs };
};

// ---------------------------------------------------------------------------------------------- decideSkillRun
export const decideSkillRun: SkillsApi["decideSkillRun"] = async ({ orgId, skillRunId, decision, actorUserId, note }) => {
  const fail = (error: string, r?: RunRow): SkillResult => (r ? { ...toResult(r), ok: false, error } : { ok: false, status: "failed", summary: error, output: {}, steps: [], citations: [], durationMs: 0, manualBaselineMinutes: 0, humanReviewMinutes: 0, synthetic: false, error });
  if (!isUuid(skillRunId) || !isUuid(orgId)) return fail("Skill run not found");
  const [run] = await withTenant(orgId, (tx) => tx.select().from(schema.skillRuns).where(and(eq(schema.skillRuns.id, skillRunId), eq(schema.skillRuns.orgId, orgId))).limit(1));
  if (!run) return fail("Skill run not found");
  if (run.mode !== "live" || run.status !== "awaiting_approval") return fail(`This run is not waiting for approval (status ${run.status}).`, run);
  const role = await memberRole(orgId, actorUserId);
  if (!role || !can(role, "agents:approve")) { await audit({ orgId, actorUserId, action: "skill.approval.denied", entityType: "skill_run", entityId: run.id, details: { role } }); return fail("You don't have permission to approve AI employee actions (needs agents:approve).", run); }
  const pending = (run.output as { approval?: PendingAction }).approval;
  if (!pending) return fail("Approval details are missing on this run.", run);
  if (pending.elevated && !["owner", "admin"].includes(role)) return fail(`This action is over the approval threshold and needs an owner or admin (${pending.approverRole}).`, run);
  const skill = impl(run.skillKey); const emp = await loadEmployee(orgId, run.aiEmployeeId);
  if (!skill || !emp) return fail("Skill or AI employee no longer exists.", run);

  const ctx = new SkillCtx(orgId, "live", emp, actorUserId, role, skill, [], undefined);
  ctx.steps = (run.steps as SkillStep[]).map((s) => ({ ...s }));
  ctx.citations = run.citations as SkillResult["citations"];
  const reqIdx = ctx.steps.findIndex((s) => s.status === "awaiting_approval" && s.key !== pending.stepKey);
  const who = `${role}${note ? ` — “${note.slice(0, 200)}”` : ""}`;
  let output: Record<string, unknown> = { ...run.output };
  let status: "succeeded" | "rejected"; let extraMs = 0; let actionDetail = "";
  if (decision === "approve") {
    if (!LIVE_STATUSES.includes(emp.status) || !["act_with_approval", "autonomous"].includes(emp.permissionLevel)) return fail(`Can't execute: the AI employee is now ${emp.status} / ${emp.permissionLevel}. Re-run after restoring its permissions.`, run);
    if (reqIdx >= 0) ctx.steps[reqIdx] = { ...ctx.steps[reqIdx], status: "done", detail: `${ctx.steps[reqIdx].detail ?? ""} Approved by ${who}.`.trim() };
    const t0 = now();
    try {
      const r = await skill.performAction!(ctx, pending, output);
      actionDetail = r.detail;
      extraMs = Math.round((now() - t0) * 100) / 100;
      const i = ctx.steps.findIndex((s) => s.key === pending.stepKey);
      const st: SkillStep = { key: pending.stepKey, label: i >= 0 ? ctx.steps[i].label : pending.label, status: "done", ms: extraMs, detail: r.detail, ...(r.data ? { data: r.data } : {}) };
      if (i >= 0) ctx.steps[i] = st; else ctx.steps.push(st);
      output = { ...output, ...(r.outputPatch ?? {}), disposition: output.disposition === "awaiting_approval" ? "posted_to_bridgebox_queue" : output.disposition };
    } catch (e) { return fail(`Approved action failed: ${e instanceof Error ? e.message : String(e)}`, run); }
    status = "succeeded";
  } else {
    if (reqIdx >= 0) ctx.steps[reqIdx] = { ...ctx.steps[reqIdx], status: "done", detail: `${ctx.steps[reqIdx].detail ?? ""} Rejected by ${who}.`.trim() };
    const i = ctx.steps.findIndex((s) => s.key === pending.stepKey);
    if (i >= 0) ctx.steps[i] = { ...ctx.steps[i], status: "skipped", detail: "Not executed — the approver rejected it." };
    output = { ...output, disposition: "rejected" };
    status = "rejected";
  }
  const reviewMinutes = num(run.humanReviewMinutes) + APPROVAL_REVIEW_MINUTES;
  const durationMs = run.durationMs + extraMs;
  const [baseline, rate] = await Promise.all([resolveBaseline(orgId, emp, skill, "live"), resolveRate(orgId, emp)]);
  const savings = finalizeSteps(ctx, { durationMs, reviewMinutes, baseline, rate, status });
  const baseSummary = String(output.summary ?? "");
  const byRole = `${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}`;
  const summary = status === "succeeded" ? `${baseSummary.replace(/It is waiting for .*? approval before posting\.?/, "").trim()} Approved by ${byRole} and completed.${actionDetail ? ` ${actionDetail}` : ""}`.trim() : `${baseSummary.replace(/It is waiting for .*? approval before posting\.?/, "").trim()} Rejected by ${byRole}; nothing was executed.`.trim();
  output = { ...output, summary, savings, approval: { ...pending, status: decision === "approve" ? "approved" : "rejected", decidedBy: actorUserId, decidedRole: role, decidedAt: new Date().toISOString(), note: note ?? null } };
  let agentRunId = run.agentRunId;
  if (status === "succeeded" && emp.agentId && !agentRunId) agentRunId = await writeAgentRun(orgId, emp.agentId, { id: run.id, skillKey: run.skillKey, aiEmployeeId: emp.id, summary, steps: ctx.steps, createdAt: run.createdAt }, savings);
  const [done] = await withTenant(orgId, (tx) => tx.update(schema.skillRuns).set({ status, output, steps: ctx.steps, durationMs: Math.round(durationMs), humanReviewMinutes: String(reviewMinutes), agentRunId }).where(and(eq(schema.skillRuns.id, run.id), eq(schema.skillRuns.orgId, orgId), eq(schema.skillRuns.status, "awaiting_approval"))).returning());
  if (!done) return fail("This run was decided by someone else just now.", run);
  await audit({ orgId, actorUserId, action: `skill.approval.${decision === "approve" ? "approved" : "rejected"}`, entityType: "skill_run", entityId: run.id, details: { skillKey: run.skillKey, role, note: note ?? null, elevated: pending.elevated, agentRunId } });
  return toResult(done);
};

// ---------------------------------------------------------------------------------------------- feedback & memory
/** Text that tries to change security posture through feedback. Such memory can never be approved. */
export const SECURITY_ALTERING = [/\bpermission(s|\s+level)?\b/i, /\b(autonomous|act[_ ]with[_ ]approval|draft[_ ]only|read[_ ]only)\b/i, /\b(skip|bypass|disable|remove|ignore|turn off|without|no longer (need|require))\b[^.]{0,40}\bapprov/i, /\b(credential|password|api[ -]?key|secret|access token)s?\b/i, /\b(budget|spending limit|run limit)\b/i, /\b(make|grant|give)\b[^.]{0,30}\b(admin|owner|access|rights|role)\b/i];
export const isSecurityAltering = (t: string) => SECURITY_ALTERING.some((re) => re.test(t));

export const reviewSkillRun: SkillsApi["reviewSkillRun"] = async ({ orgId, skillRunId, verdict, note, improvement, actorUserId }) => {
  if (!isUuid(skillRunId) || !isUuid(orgId)) throw new Error("Skill run not found");
  const role = await memberRole(orgId, actorUserId);
  if (!role || !can(role, "agents:approve")) throw new Error("You don't have permission to review AI employee work (needs agents:approve).");
  const [run] = await withTenant(orgId, (tx) => tx.select({ id: schema.skillRuns.id, aiEmployeeId: schema.skillRuns.aiEmployeeId, status: schema.skillRuns.status }).from(schema.skillRuns).where(and(eq(schema.skillRuns.id, skillRunId), eq(schema.skillRuns.orgId, orgId))).limit(1));
  if (!run) throw new Error("Skill run not found");
  const imp = improvement?.trim().slice(0, 2000);
  const memoryId = await withTenant(orgId, async (tx) => {
    await tx.update(schema.skillRuns).set({ reviewStatus: verdict, reviewNote: note?.slice(0, 2000) ?? null, reviewedBy: actorUserId }).where(and(eq(schema.skillRuns.id, run.id), eq(schema.skillRuns.orgId, orgId)));
    if (!imp) return null;
    // Feedback only ever creates PENDING memory. It never touches ai_employees (permissionLevel, budgets, status), approvals or credentials.
    const [m] = await tx.insert(schema.aiEmployeeMemory).values({ orgId, aiEmployeeId: run.aiEmployeeId, kind: verdict === "corrected" ? "correction" : "procedure", text: imp, status: "pending_review", sourceSkillRunId: run.id, createdBy: actorUserId }).returning({ id: schema.aiEmployeeMemory.id });
    return m.id;
  });
  await audit({ orgId, actorUserId, action: "skill.run.reviewed", entityType: "skill_run", entityId: run.id, details: { verdict, memoryId, securityFlag: imp ? isSecurityAltering(imp) : false } });
};

/** Owner/admin decision on a pending memory item. Security-altering text can never be approved. */
export async function decideMemory(args: { orgId: string; memoryId: string; decision: "approve" | "reject"; actorUserId: string }): Promise<{ status: "approved" | "rejected" }> {
  const { orgId, memoryId, decision, actorUserId } = args;
  if (!isUuid(memoryId) || !isUuid(orgId)) throw new Error("Memory item not found");
  const role = await memberRole(orgId, actorUserId);
  if (!role || !can(role, "agents:write")) throw new Error("Only owners, admins or consultants can approve what an AI employee learns (needs agents:write).");
  const [m] = await withTenant(orgId, (tx) => tx.select().from(schema.aiEmployeeMemory).where(and(eq(schema.aiEmployeeMemory.id, memoryId), eq(schema.aiEmployeeMemory.orgId, orgId))).limit(1));
  if (!m) throw new Error("Memory item not found");
  if (m.status !== "pending_review") throw new Error(`Already ${m.status}`);
  if (decision === "approve" && isSecurityAltering(m.text)) {
    await withTenant(orgId, (tx) => tx.update(schema.aiEmployeeMemory).set({ status: "rejected" }).where(and(eq(schema.aiEmployeeMemory.id, m.id), eq(schema.aiEmployeeMemory.orgId, orgId))));
    await audit({ orgId, actorUserId, action: "skill.memory.approval_refused", entityType: "ai_employee_memory", entityId: m.id, details: { reason: "security_altering" } });
    throw new Error("Feedback can't change permissions, approval steps, budgets or credentials. Change those in the AI employee's settings (owner/admin, audited).");
  }
  const status = decision === "approve" ? "approved" : "rejected";
  await withTenant(orgId, (tx) => tx.update(schema.aiEmployeeMemory).set({ status, approvedBy: decision === "approve" ? actorUserId : null, approvedAt: decision === "approve" ? new Date() : null }).where(and(eq(schema.aiEmployeeMemory.id, m.id), eq(schema.aiEmployeeMemory.orgId, orgId))));
  await audit({ orgId, actorUserId, action: `skill.memory.${status}`, entityType: "ai_employee_memory", entityId: m.id, details: { aiEmployeeId: m.aiEmployeeId, kind: m.kind } });
  return { status };
}

// ---------------------------------------------------------------------------------------------- read helpers
export async function getSkillRun(orgId: string, skillRunId: string): Promise<(SkillResult & { skillKey: string; aiEmployeeId: string; mode: string; reviewStatus: string | null; createdAt: string }) | null> {
  if (!isUuid(skillRunId) || !isUuid(orgId)) return null;
  const [r] = await withTenant(orgId, (tx) => tx.select().from(schema.skillRuns).where(and(eq(schema.skillRuns.id, skillRunId), eq(schema.skillRuns.orgId, orgId))).limit(1));
  return r ? { ...toResult(r), skillKey: r.skillKey, aiEmployeeId: r.aiEmployeeId, mode: r.mode, reviewStatus: r.reviewStatus, createdAt: r.createdAt.toISOString() } : null;
}
export async function listSkillRuns(orgId: string, opts: { aiEmployeeId?: string; mode?: "sandbox" | "live"; limit?: number } = {}) {
  const rows = await withTenant(orgId, (tx) => tx.select({ id: schema.skillRuns.id, aiEmployeeId: schema.skillRuns.aiEmployeeId, skillKey: schema.skillRuns.skillKey, mode: schema.skillRuns.mode, status: schema.skillRuns.status, durationMs: schema.skillRuns.durationMs, manualBaselineMinutes: schema.skillRuns.manualBaselineMinutes, humanReviewMinutes: schema.skillRuns.humanReviewMinutes, reviewStatus: schema.skillRuns.reviewStatus, output: schema.skillRuns.output, createdAt: schema.skillRuns.createdAt })
    .from(schema.skillRuns).where(and(eq(schema.skillRuns.orgId, orgId), opts.aiEmployeeId && isUuid(opts.aiEmployeeId) ? eq(schema.skillRuns.aiEmployeeId, opts.aiEmployeeId) : sql`true`, opts.mode ? eq(schema.skillRuns.mode, opts.mode) : sql`true`)).orderBy(desc(schema.skillRuns.createdAt)).limit(Math.min(opts.limit ?? 50, 500)));
  return rows.map((r) => { const o = r.output as { summary?: string; savings?: SavingsCalc; blocked?: string; approval?: PendingAction }; return { id: r.id, aiEmployeeId: r.aiEmployeeId, skillKey: r.skillKey, mode: r.mode, status: r.status, durationMs: r.durationMs, manualBaselineMinutes: num(r.manualBaselineMinutes), humanReviewMinutes: num(r.humanReviewMinutes), reviewStatus: r.reviewStatus, summary: o.summary ?? "", minutesSaved: o.savings?.minutesSaved ?? null, valueUsd: o.savings?.valueUsd ?? null, blocked: o.blocked ?? null, approval: o.approval ?? null, createdAt: r.createdAt.toISOString() }; });
}
export async function listPendingSkillApprovals(orgId: string) {
  return (await listSkillRuns(orgId, { mode: "live", limit: 500 })).filter((r) => r.status === "awaiting_approval");
}
export async function listEmployeeMemory(orgId: string, aiEmployeeId: string) {
  if (!isUuid(aiEmployeeId)) return [];
  return withTenant(orgId, (tx) => tx.select().from(schema.aiEmployeeMemory).where(and(eq(schema.aiEmployeeMemory.orgId, orgId), eq(schema.aiEmployeeMemory.aiEmployeeId, aiEmployeeId))).orderBy(desc(schema.aiEmployeeMemory.createdAt)).limit(200));
}
/** Live-only work-history totals for an AI employee (sandbox excluded) — for P's AI employee financials. */
export async function skillLedger(orgId: string, aiEmployeeId: string) {
  if (!isUuid(aiEmployeeId)) return { runs: 0, succeeded: 0, minutesSaved: 0, valueUsd: 0, awaitingApproval: 0 };
  const rows = await withTenant(orgId, (tx) => tx.select({ status: schema.skillRuns.status, output: schema.skillRuns.output }).from(schema.skillRuns).where(and(eq(schema.skillRuns.orgId, orgId), eq(schema.skillRuns.aiEmployeeId, aiEmployeeId), eq(schema.skillRuns.mode, "live"), inArray(schema.skillRuns.status, ["succeeded", "awaiting_approval", "rejected", "failed"]))));
  const ok = rows.filter((r) => r.status === "succeeded");
  const s = (r: (typeof rows)[number]) => (r.output as { savings?: SavingsCalc }).savings;
  return { runs: rows.filter((r) => !(r.output as { blocked?: string }).blocked).length, succeeded: ok.length, minutesSaved: Math.round(ok.reduce((a, r) => a + (s(r)?.minutesSaved ?? 0), 0) * 100) / 100, valueUsd: Math.round(ok.reduce((a, r) => a + (s(r)?.valueUsd ?? 0), 0) * 100) / 100, awaitingApproval: rows.filter((r) => r.status === "awaiting_approval").length };
}

// compile-time check that this module satisfies the contract
const _api: SkillsApi = { SKILLS, getSkill, runSkill, decideSkillRun, reviewSkillRun };
void _api;
