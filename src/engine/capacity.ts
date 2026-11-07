/**
 * Capacity engine — Organizational Transformation.
 *
 * Capacity is NOT payroll reduction. This engine only reports time, at department and role (job title) level,
 * and never produces per-person staffing suggestions.
 *
 *  - computeCapacity(orgId)   → per department / per role: observed, repetitive and recoverable hours per week,
 *                               FTE-equivalent capacity released, verified released capacity (from measurements)
 *  - hiringAvoidance(...)     → pure: avoided future hires = min(planned hires, FTE released × utilization), valued at loaded cost
 *
 * Recoverable hours come from the finance engine's opportunity lines distributed to employees by their share of each
 * workflow's hours (exactly as computeOrgFinancials.byEmployee does); anything that cannot be attributed to a person
 * (no workflow / no performer links) is reported as "Unattributed" so totals always reconcile with finance.
 */
import { eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import type { CalcTree } from "@/db/schema";
import { DEFAULTS } from "./costing";
import { analyzeOpportunities } from "./opportunity-score";

const num = (v: unknown) => (v == null ? 0 : typeof v === "number" ? v : Number(v) || 0);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

export const CAPACITY_DISCLAIMER = "Capacity is not payroll reduction. Staffing changes require management review and HR/legal assessment.";
/** Below this headcount a department's average loaded cost is not shown (it could reveal an individual's pay); the org average is used instead. */
export const MIN_COST_GROUP = 3;

export type CapacityRow = {
  key: string; name: string; headcount: number;
  observedHoursPerWeek: number; repetitiveHoursPerWeek: number; recoverableHoursPerWeek: number; fteReleased: number;
  verifiedHoursPerWeek: number; verifiedFte: number; realizableAnnual: number;
  /** Department rows only: loaded annual cost per FTE used to value avoided hires. */
  loadedCostPerFte?: number; costSource?: "department" | "org_average";
};
export type RoleNote = { role: string; headcount: number; hoursPerWeek: number; tasks: { workflowId: string; workflow: string; hoursPerWeek: number; shareOfRole: number; opportunityId: string | null; opportunity: string | null; solution: string | null; type: string | null; recoverableHoursPerWeek: number }[] };
export type CapacityResult = {
  computedAt: string; hoursPerFte: number; weeksPerYear: number;
  totals: { observedHoursPerWeek: number; repetitiveHoursPerWeek: number; recoverableHoursPerWeek: number; fteReleased: number; verifiedHoursPerWeek: number; verifiedFte: number; financeRecoverableHoursPerWeek: number; orgLoadedCostPerFte: number };
  departments: CapacityRow[]; roles: CapacityRow[];
  unattributed: { recoverableHoursPerWeek: number; verifiedHoursPerWeek: number };
  roleNotes: RoleNote[];
  trees: { recoverable: CalcTree; fte: CalcTree; verified: CalcTree };
  disclaimer: string;
};

export async function computeCapacity(orgId: string): Promise<CapacityResult> {
  const analysis = await analyzeOpportunities(orgId);
  const fin = analysis.fin;
  const raw = await withTenant(orgId, async (tx) => ({
    org: (await tx.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1))[0],
    links: await tx.select({ workflowId: schema.workflowEmployees.workflowId, employeeId: schema.workflowEmployees.employeeId, hoursPerWeek: schema.workflowEmployees.hoursPerWeek }).from(schema.workflowEmployees).where(eq(schema.workflowEmployees.orgId, orgId)),
    measurements: await tx.select({ id: schema.savingsMeasurements.id, agentId: schema.savingsMeasurements.agentId, workflowId: schema.savingsMeasurements.workflowId, hoursSaved: schema.savingsMeasurements.hoursSaved }).from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId)),
    agents: await tx.select({ id: schema.agents.id, workflowId: schema.agents.workflowId, opportunityId: schema.agents.opportunityId }).from(schema.agents).where(eq(schema.agents.orgId, orgId)),
    workflows: await tx.select({ id: schema.workflows.id, name: schema.workflows.name }).from(schema.workflows).where(eq(schema.workflows.orgId, orgId)),
  }));
  const hoursPerFte = raw.org?.settings?.workHoursPerWeek ?? DEFAULTS.workHoursPerWeek;
  const weeks = fin.assumptions.workWeeksPerYear || DEFAULTS.workWeeksPerYear;

  // ---- verified hours/week distributed to employees by workflow share (total = finance annualized ÷ weeks) ----
  const wfTotal = new Map<string, number>(); const linksByWf = new Map<string, typeof raw.links>();
  for (const l of raw.links) { wfTotal.set(l.workflowId, (wfTotal.get(l.workflowId) ?? 0) + num(l.hoursPerWeek)); const a = linksByWf.get(l.workflowId) ?? []; a.push(l); linksByWf.set(l.workflowId, a); }
  const agentById = new Map(raw.agents.map((a) => [a.id, a]));
  const oppWf = new Map(analysis.all.map((o) => [o.id, o.workflowId]));
  const verifiedTotalPerWeek = fin.verifiedHoursSavedAnnualized / weeks;
  const rawVerified = sum(raw.measurements.map((m) => num(m.hoursSaved)));
  const empVerified = new Map<string, number>(); let unattributedVerified = 0;
  for (const m of raw.measurements) {
    const perWeek = rawVerified > 0 ? (num(m.hoursSaved) / rawVerified) * verifiedTotalPerWeek : 0;
    const ag = m.agentId ? agentById.get(m.agentId) : undefined;
    const wfId = m.workflowId ?? ag?.workflowId ?? (ag?.opportunityId ? oppWf.get(ag.opportunityId) ?? null : null);
    const tot = wfId ? wfTotal.get(wfId) ?? 0 : 0;
    if (!wfId || tot <= 0) { unattributedVerified += perWeek; continue; }
    for (const l of linksByWf.get(wfId) ?? []) empVerified.set(l.employeeId, (empVerified.get(l.employeeId) ?? 0) + perWeek * (num(l.hoursPerWeek) / tot));
  }

  // ---- aggregate the finance engine's per-employee figures by department and by role ----
  const orgLoadedCostPerFte = fin.employeesAnalyzed > 0 ? fin.totalAnnualLaborAnalyzed / fin.employeesAnalyzed : 0;
  const deptLabor = new Map(fin.byDepartment.map((d) => [d.departmentId ?? "unassigned", d]));
  const agg = (keyOf: (e: (typeof fin.byEmployee)[number]) => { key: string; name: string }) => {
    const m = new Map<string, CapacityRow>();
    for (const e of fin.byEmployee) {
      const k = keyOf(e); let r = m.get(k.key);
      if (!r) { r = { key: k.key, name: k.name, headcount: 0, observedHoursPerWeek: 0, repetitiveHoursPerWeek: 0, recoverableHoursPerWeek: 0, fteReleased: 0, verifiedHoursPerWeek: 0, verifiedFte: 0, realizableAnnual: 0 }; m.set(k.key, r); }
      r.headcount += 1; r.observedHoursPerWeek += e.hoursPerWeek; r.repetitiveHoursPerWeek += e.repetitiveHoursPerWeek; r.recoverableHoursPerWeek += e.recoverableHoursPerWeek; r.realizableAnnual += e.realizableAnnual;
      r.verifiedHoursPerWeek += empVerified.get(e.employeeId) ?? 0;
    }
    return [...m.values()].map((r) => ({ ...r, fteReleased: r.recoverableHoursPerWeek / hoursPerFte, verifiedFte: r.verifiedHoursPerWeek / hoursPerFte })).sort((a, b) => b.recoverableHoursPerWeek - a.recoverableHoursPerWeek);
  };
  const departments = agg((e) => ({ key: e.departmentId ?? "unassigned", name: e.departmentName ?? "Unassigned" })).map((r) => {
    const d = deptLabor.get(r.key); const ok = !!d && d.employees >= MIN_COST_GROUP && d.laborAnnual > 0;
    return { ...r, loadedCostPerFte: ok ? d!.laborAnnual / d!.employees : orgLoadedCostPerFte, costSource: ok ? ("department" as const) : ("org_average" as const) };
  });
  const roles = agg((e) => ({ key: (e.title ?? "").trim() || "Untitled role", name: (e.title ?? "").trim() || "Untitled role" }));

  const attributed = sum(departments.map((d) => d.recoverableHoursPerWeek));
  const unattributedRecoverable = Math.max(0, fin.hoursRecoverablePerWeek - attributed);
  const recoverable = attributed + unattributedRecoverable;
  const verifiedAttributed = sum(departments.map((d) => d.verifiedHoursPerWeek));

  // ---- role redesign notes: which tasks move to agents, per role ----
  const titleOf = new Map(fin.byEmployee.map((e) => [e.employeeId, (e.title ?? "").trim() || "Untitled role"]));
  const wfName = new Map(raw.workflows.map((w) => [w.id, w.name]));
  const oppsByWf = new Map<string, (typeof analysis.all)[number]>();
  for (const o of analysis.all) if (o.workflowId && o.inScope) { const cur = oppsByWf.get(o.workflowId); if (!cur || o.line.realizableAnnualSavings > cur.line.realizableAnnualSavings) oppsByWf.set(o.workflowId, o); }
  const recByWf = new Map<string, number>(); for (const o of analysis.all) if (o.workflowId && o.inScope) recByWf.set(o.workflowId, (recByWf.get(o.workflowId) ?? 0) + o.line.hoursRecoverablePerWeek);
  const roleMap = new Map<string, { heads: Set<string>; wf: Map<string, { hours: number; rec: number }> }>();
  for (const l of raw.links) {
    const role = titleOf.get(l.employeeId); if (!role) continue;
    const r = roleMap.get(role) ?? { heads: new Set(), wf: new Map() }; r.heads.add(l.employeeId);
    const tot = wfTotal.get(l.workflowId) ?? 0; const share = tot > 0 ? num(l.hoursPerWeek) / tot : 0;
    const w = r.wf.get(l.workflowId) ?? { hours: 0, rec: 0 }; w.hours += num(l.hoursPerWeek); w.rec += (recByWf.get(l.workflowId) ?? 0) * share; r.wf.set(l.workflowId, w);
    roleMap.set(role, r);
  }
  const roleNotes: RoleNote[] = [...roleMap.entries()].map(([role, r]) => {
    const hours = sum([...r.wf.values()].map((x) => x.hours));
    return {
      role, headcount: r.heads.size, hoursPerWeek: hours,
      tasks: [...r.wf.entries()].map(([wfId, x]) => { const o = oppsByWf.get(wfId); return { workflowId: wfId, workflow: wfName.get(wfId) ?? "Workflow", hoursPerWeek: x.hours, shareOfRole: hours > 0 ? x.hours / hours : 0, opportunityId: o?.id ?? null, opportunity: o?.title ?? null, solution: o?.answers.recommendedSolution.name ?? null, type: o?.type ?? null, recoverableHoursPerWeek: x.rec }; })
        .sort((a, b) => b.recoverableHoursPerWeek - a.recoverableHoursPerWeek || b.hoursPerWeek - a.hoursPerWeek),
    };
  }).sort((a, b) => sum(b.tasks.map((t) => t.recoverableHoursPerWeek)) - sum(a.tasks.map((t) => t.recoverableHoursPerWeek)));

  const recoverableTree: CalcTree = { label: "Recoverable hours per week (capacity)", value: recoverable, unit: "hours", basis: "estimated", formula: "Σ opportunity recoverable hrs/wk, distributed to people by their share of each workflow's hours", source: "Finance engine opportunity lines (overlap de-duplicated)", children: [
    ...departments.map((d) => ({ label: d.name, value: d.recoverableHoursPerWeek, unit: "hours", basis: "estimated" as const, source: `${d.headcount} people` })),
    ...(unattributedRecoverable > 0.005 ? [{ label: "Unattributed (no performer links)", value: unattributedRecoverable, unit: "hours", basis: "estimated" as const }] : []),
  ] };
  const fteTree: CalcTree = { label: "FTE capacity recoverable", value: recoverable / hoursPerFte, unit: "FTE", basis: "estimated", formula: `recoverable hrs/wk ÷ ${hoursPerFte} hrs per FTE-week`, children: [recoverableTree, { label: "Hours per FTE-week", value: hoursPerFte, unit: "hours", basis: "assumed", source: "Org setting workHoursPerWeek" }] };
  const verifiedTree: CalcTree = { label: "Verified capacity released", value: verifiedTotalPerWeek / hoursPerFte, unit: "FTE", basis: "observed", formula: `verified hours saved per year ÷ ${weeks} weeks ÷ ${hoursPerFte} hrs per FTE-week`, children: [fin.trees.verifiedSavings.children?.length ? { label: "Verified hours saved per year", value: fin.verifiedHoursSavedAnnualized, unit: "hours", basis: "observed", source: `${fin.verifiedMeasurements} measurement(s), annualized by the finance engine` } : { label: "Verified hours saved per year", value: 0, unit: "hours", basis: "observed", source: "No savings measurements recorded yet" }] };

  return {
    computedAt: new Date().toISOString(), hoursPerFte, weeksPerYear: weeks,
    totals: { observedHoursPerWeek: sum(departments.map((d) => d.observedHoursPerWeek)), repetitiveHoursPerWeek: sum(departments.map((d) => d.repetitiveHoursPerWeek)), recoverableHoursPerWeek: recoverable, fteReleased: recoverable / hoursPerFte, verifiedHoursPerWeek: verifiedAttributed + unattributedVerified, verifiedFte: (verifiedAttributed + unattributedVerified) / hoursPerFte, financeRecoverableHoursPerWeek: fin.hoursRecoverablePerWeek, orgLoadedCostPerFte },
    departments, roles, unattributed: { recoverableHoursPerWeek: unattributedRecoverable, verifiedHoursPerWeek: unattributedVerified }, roleNotes,
    trees: { recoverable: recoverableTree, fte: fteTree, verified: verifiedTree }, disclaimer: CAPACITY_DISCLAIMER,
  };
}

// Redeployment planning (pure) lives next to the planner UI so the browser can run the same function; re-exported here.
export { hiringAvoidance, type HiringAvoidanceInput } from "@/app/app/transformation/hiring-avoidance";
