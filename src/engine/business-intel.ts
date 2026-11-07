/**
 * Business Intelligence engine — organization performance from the tenant's own data.
 *
 *  - resolveScope(employees, departments, filters)   → PURE: which employees / departments a filter set selects
 *  - computeBusinessIntel(orgId, filters, opts)      → BusinessIntel (labor, overhead, activity, workload, trends + CalcTrees)
 *
 * Sources of truth:
 *  - Labor $ comes ONLY from computeOrgFinancials().byEmployee (finance engine), so the unfiltered total equals
 *    fin.totalAnnualLaborAnalyzed exactly.
 *  - Overhead $ is `departments.annualOverhead` as entered, with its own `overheadBasis`.
 *  - "Entered operating expense" = labor + entered overhead. It is NOT total company opex (no GL / finance import).
 *  - Hours / categories / apps / switches / idle come from `activity_events` (observed). Weeks = distinct active days ÷ 5,
 *    the same convention the finance engine uses.
 * Never import "server-only" here (tests + scripts reach it).
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import type { CalcTree } from "@/db/schema";
import { num } from "@/lib/utils";
import { computeOrgFinancials, type OrgFinancials } from "./finance";

export type Basis = "observed" | "estimated" | "assumed";
export type BizFilters = { bu?: string | null; dept?: string | null; loc?: string | null; from?: Date | null; to?: Date | null };

type EmpLite = { id: string; departmentId: string | null; businessUnitId: string | null; locationId: string | null; isActive?: boolean };
type DeptLite = { id: string; name: string; businessUnitId: string | null; locationId: string | null; annualOverhead: string | null; overheadBasis: Basis };

/** Employee BU / location: own assignment first, then the department's. */
export function employeeBu(e: EmpLite, deptById: Map<string, DeptLite>): string | null { return e.businessUnitId ?? (e.departmentId ? deptById.get(e.departmentId)?.businessUnitId ?? null : null); }
export function employeeLoc(e: EmpLite, deptById: Map<string, DeptLite>): string | null { return e.locationId ?? (e.departmentId ? deptById.get(e.departmentId)?.locationId ?? null : null); }

/** PURE. Resolve bu/dept/loc filters to an employee set and a department set (departments matched on their own BU / location). */
export function resolveScope<E extends EmpLite, D extends DeptLite>(employees: E[], departments: D[], f: BizFilters): { employees: E[]; departments: D[]; filtered: boolean } {
  const deptById = new Map<string, DeptLite>(departments.map((d) => [d.id, d]));
  const emps = employees.filter((e) => (e.isActive ?? true)
    && (!f.dept || e.departmentId === f.dept)
    && (!f.bu || employeeBu(e, deptById) === f.bu)
    && (!f.loc || employeeLoc(e, deptById) === f.loc));
  const depts = departments.filter((d) => (!f.dept || d.id === f.dept) && (!f.bu || d.businessUnitId === f.bu) && (!f.loc || d.locationId === f.loc));
  return { employees: emps, departments: depts, filtered: !!(f.bu || f.dept || f.loc) };
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p; const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export type ExpenseRow = { id: string | null; name: string; labor: number; overhead: number; entered: number; headcount: number; laborBasis: Basis; overheadBasis: Basis };
export type HoursRow = { name: string; hours: number; share: number };
export type BusinessIntel = {
  computedAt: string;
  filters: { bu: string | null; dept: string | null; loc: string | null; from: string | null; to: string | null };
  filtered: boolean;
  headcount: number;
  employeesAnalyzed: number;
  laborAnnual: number;
  overheadAnnual: number;
  enteredOpexAnnual: number;
  departmentsWithOverhead: number;
  departmentsInScope: number;
  byBusinessUnit: ExpenseRow[];
  byLocation: ExpenseRow[];
  byDepartment: ExpenseRow[];
  activity: {
    events: number;
    activeHours: number;
    idleHours: number;
    idleShare: number;
    activeDays: number;
    weeks: number;
    hoursPerWeek: number;
    byCategory: HoursRow[];
    byActivity: HoursRow[];
    topApps: HoursRow[];
    contextSwitches: { count: number; perHour: number; basis: Basis; method: "app_switch_events" | "derived_app_changes" };
  };
  repetitive: { hoursPerWeek: number; sharePct: number; basis: Basis };
  workload: { employees: number; p25: number; p50: number; p75: number; p90: number; max: number; histogram: { bucket: string; from: number; to: number; employees: number }[] };
  weekly: { week: string; hours: number; repetitiveHours: number; repetitiveShare: number }[];
  trees: { labor: CalcTree; overhead: CalcTree; enteredOpex: CalcTree; headcount: CalcTree; hoursPerWeek: CalcTree; repetitive: CalcTree; contextSwitches: CalcTree; idle: CalcTree };
  options: { businessUnits: { id: string; name: string }[]; locations: { id: string; name: string }[]; departments: { id: string; name: string }[] };
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const IDLE_TYPES = ["idle_start", "idle_end"];
const HR = 3_600_000;
const ACTIVITY_LABEL: Record<string, string> = {
  app_focus: "Focused app time", app_switch: "App switching", click_burst: "Clicking / navigating UI", navigation: "Navigation", data_entry: "Data entry", copy_paste: "Copy & paste",
  document_open: "Opening documents", document_save: "Saving documents", form_submit: "Submitting forms", print: "Printing", email_compose: "Writing email", handoff: "Hand-offs",
};

function inList(col: SQL, ids: string[]): SQL { return sql`${col} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`; }

export async function computeBusinessIntel(orgId: string, filters: BizFilters = {}, opts: { fin?: OrgFinancials; showEmployeeCosts?: boolean } = {}): Promise<BusinessIntel> {
  const fin = opts.fin ?? await computeOrgFinancials(orgId);
  const from = filters.from ?? null, to = filters.to ?? null;

  const data = await withTenant(orgId, async (tx) => {
    const [employees, departments, bus, locs, workflows, wfEmps] = await Promise.all([
      tx.select({ id: schema.employees.id, displayName: schema.employees.displayName, departmentId: schema.employees.departmentId, businessUnitId: schema.employees.businessUnitId, locationId: schema.employees.locationId, isActive: schema.employees.isActive }).from(schema.employees).where(eq(schema.employees.orgId, orgId)),
      tx.select({ id: schema.departments.id, name: schema.departments.name, businessUnitId: schema.departments.businessUnitId, locationId: schema.departments.locationId, annualOverhead: schema.departments.annualOverhead, overheadBasis: schema.departments.overheadBasis }).from(schema.departments).where(eq(schema.departments.orgId, orgId)),
      tx.select({ id: schema.businessUnits.id, name: schema.businessUnits.name }).from(schema.businessUnits).where(eq(schema.businessUnits.orgId, orgId)),
      tx.select({ id: schema.locations.id, name: schema.locations.name }).from(schema.locations).where(eq(schema.locations.orgId, orgId)),
      tx.select({ id: schema.workflows.id, name: schema.workflows.name, repetitionScore: schema.workflows.repetitionScore, processMap: schema.workflows.processMap }).from(schema.workflows).where(eq(schema.workflows.orgId, orgId)),
      tx.select().from(schema.workflowEmployees).where(eq(schema.workflowEmployees.orgId, orgId)),
    ]);
    const scope = resolveScope(employees, departments, filters);
    const ids = scope.employees.map((e) => e.id);
    const repTokens = [...new Set(workflows.filter((w) => num(w.repetitionScore) >= 50).flatMap((w) => (w.processMap?.nodes ?? []).map((n) => n.id)))];
    if (!ids.length) return { employees, departments, bus, locs, workflows, wfEmps, scope, agg: [], days: [] as { employee_id: string; days: number }[], totalDays: 0, derivedSwitches: 0, weekly: [] as { wk: string; ms: number; rms: number }[] };
    const conds: SQL[] = [sql`org_id = ${orgId}`, inList(sql`employee_id`, ids)];
    if (from) conds.push(sql`ts >= ${from.toISOString()}`);
    if (to) conds.push(sql`ts < ${to.toISOString()}`);
    const where = sql.join(conds, sql` and `);
    const tokenExpr = sql`(app || ':' || lower(coalesce(title_category, '')) || ':' || type::text)`;
    const repCond = repTokens.length ? sql`${tokenExpr} in (${sql.join(repTokens.map((t) => sql`${t}`), sql`, `)})` : sql`false`;
    const agg = await tx.execute(sql`select employee_id, coalesce(app_category, 'uncategorized') as cat, type::text as type, app, sum(duration_ms)::float8 as ms, count(*)::int as n from activity_events where ${where} group by 1,2,3,4`) as unknown as { employee_id: string; cat: string; type: string; app: string; ms: number; n: number }[];
    const days = await tx.execute(sql`select employee_id, count(distinct date(ts))::int as days from activity_events where ${where} and type not in ('idle_start','idle_end') group by 1`) as unknown as { employee_id: string; days: number }[];
    const [td] = await tx.execute(sql`select count(distinct date(ts))::int as days from activity_events where ${where} and type not in ('idle_start','idle_end')`) as unknown as { days: number }[];
    const [sw] = await tx.execute(sql`select count(*)::int as n from (select app, lag(app) over (partition by employee_id order by ts, id) as prev from activity_events where ${where} and type not in ('idle_start','idle_end','app_switch')) x where prev is not null and prev <> app`) as unknown as { n: number }[];
    const weekly = await tx.execute(sql`select to_char(date_trunc('week', ts), 'YYYY-MM-DD') as wk, coalesce(sum(duration_ms) filter (where type not in ('idle_start','idle_end')), 0)::float8 as ms, coalesce(sum(duration_ms) filter (where type not in ('idle_start','idle_end') and ${repCond}), 0)::float8 as rms from activity_events where ${where} group by 1 order by 1`) as unknown as { wk: string; ms: number; rms: number }[];
    return { employees, departments, bus, locs, workflows, wfEmps, scope, agg, days, totalDays: Number(td?.days ?? 0), derivedSwitches: Number(sw?.n ?? 0), weekly };
  });

  const { scope, departments } = data;
  const deptById = new Map<string, DeptLite>(departments.map((d) => [d.id, d]));
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const buName = new Map(data.bus.map((b) => [b.id, b.name]));
  const locName = new Map(data.locs.map((l) => [l.id, l.name]));
  const empInScope = new Set(scope.employees.map((e) => e.id));
  const finEmp = fin.byEmployee.filter((e) => empInScope.has(e.employeeId));
  const empMeta = new Map(scope.employees.map((e) => [e.id, e]));

  // ---------- labor + overhead ----------
  const laborAnnual = sum(finEmp.map((e) => e.laborAnnual));
  const laborBasis: Basis = finEmp.length > 0 && finEmp.every((e) => e.costBasis === "observed") ? "observed" : "assumed";
  const overheadOf = (d: DeptLite) => num(d.annualOverhead);
  const overheadDepts = scope.departments.filter((d) => overheadOf(d) > 0);
  const overheadAnnual = sum(overheadDepts.map(overheadOf));
  const overheadBasis: Basis = overheadDepts.length === 0 || overheadDepts.some((d) => d.overheadBasis === "assumed") ? "assumed" : overheadDepts.every((d) => d.overheadBasis === "observed") ? "observed" : "estimated";

  const group = (keyOfEmp: (e: EmpLite) => string | null, keyOfDept: (d: DeptLite) => string | null, names: Map<string, string>): ExpenseRow[] => {
    const m = new Map<string | null, ExpenseRow & { _obs: boolean; _ohObs: boolean }>();
    const row = (k: string | null) => { let r = m.get(k); if (!r) { r = { id: k, name: k ? (names.get(k) ?? "Unknown") : "Unassigned", labor: 0, overhead: 0, entered: 0, headcount: 0, laborBasis: "assumed", overheadBasis: "assumed", _obs: true, _ohObs: true }; m.set(k, r); } return r; };
    for (const e of scope.employees) row(keyOfEmp(e)).headcount += 1;
    for (const fe of finEmp) { const e = empMeta.get(fe.employeeId); if (!e) continue; const r = row(keyOfEmp(e)); r.labor += fe.laborAnnual; if (fe.costBasis !== "observed") r._obs = false; }
    for (const d of overheadDepts) { const r = row(keyOfDept(d)); r.overhead += overheadOf(d); if (d.overheadBasis !== "observed") r._ohObs = false; }
    return [...m.values()].map(({ _obs, _ohObs, ...r }) => ({ ...r, entered: r.labor + r.overhead, laborBasis: (r.labor > 0 && _obs ? "observed" : "assumed") as Basis, overheadBasis: (r.overhead > 0 && _ohObs ? "observed" : "assumed") as Basis })).sort((a, b) => b.entered - a.entered);
  };
  const byBusinessUnit = group((e) => employeeBu(e, deptById), (d) => d.businessUnitId, buName);
  const byLocation = group((e) => employeeLoc(e, deptById), (d) => d.locationId, locName);
  const byDepartment = group((e) => e.departmentId, (d) => d.id, deptName);

  // ---------- activity ----------
  const isIdle = (t: string) => IDLE_TYPES.includes(t);
  const active = data.agg.filter((r) => !isIdle(r.type));
  const activeMs = sum(active.map((r) => r.ms));
  const idleMs = sum(data.agg.filter((r) => r.type === "idle_start").map((r) => r.ms));
  const activeHours = activeMs / HR, idleHours = idleMs / HR;
  const weeks = data.totalDays > 0 ? Math.max(data.totalDays / 5, 0.2) : 0;
  const hoursPerWeek = weeks > 0 ? activeHours / weeks : 0;
  const rollup = (key: (r: (typeof active)[number]) => string, label: (k: string) => string = (k) => k): HoursRow[] => {
    const m = new Map<string, number>(); for (const r of active) m.set(key(r), (m.get(key(r)) ?? 0) + r.ms);
    return [...m.entries()].map(([k, ms]) => ({ name: label(k), hours: ms / HR, share: activeMs > 0 ? ms / activeMs : 0 })).filter((r) => r.hours > 0).sort((a, b) => b.hours - a.hours);
  };
  const byCategory = rollup((r) => r.cat, (k) => (["erp", "crm", "hr", "it"].includes(k) ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1)));
  const byActivity = rollup((r) => r.type, (k) => ACTIVITY_LABEL[k] ?? k);
  const topApps = rollup((r) => r.app).slice(0, 12);
  const switchEvents = sum(data.agg.filter((r) => r.type === "app_switch").map((r) => r.n));
  const contextSwitches = switchEvents > 0
    ? { count: switchEvents, perHour: activeHours > 0 ? switchEvents / activeHours : 0, basis: "observed" as Basis, method: "app_switch_events" as const }
    : { count: data.derivedSwitches, perHour: activeHours > 0 ? data.derivedSwitches / activeHours : 0, basis: "estimated" as Basis, method: "derived_app_changes" as const };
  const events = sum(data.agg.map((r) => r.n));

  // ---------- workload (hours/week per employee, each over their own observed weeks) ----------
  const empMs = new Map<string, number>(); for (const r of active) empMs.set(r.employee_id, (empMs.get(r.employee_id) ?? 0) + r.ms);
  const perEmp = data.days.map((d) => { const w = Math.max(d.days / 5, 0.2); return (empMs.get(d.employee_id) ?? 0) / HR / w; }).sort((a, b) => a - b);
  const maxW = perEmp.length ? perEmp[perEmp.length - 1] : 0;
  const step = 5; const top = Math.max(step, Math.ceil(maxW / step) * step);
  const histogram: BusinessIntel["workload"]["histogram"] = [];
  for (let lo = 0; lo < top; lo += step) histogram.push({ bucket: `${lo}–${lo + step}`, from: lo, to: lo + step, employees: perEmp.filter((h) => h >= lo && (h < lo + step || (lo + step === top && h <= top))).length });

  // ---------- repetitive share ----------
  const unfilteredAll = !scope.filtered && !from && !to;
  let repetitive: BusinessIntel["repetitive"]; let repTree: CalcTree;
  if (unfilteredAll) {
    repetitive = { hoursPerWeek: fin.repetitiveHoursPerWeek, sharePct: fin.repetitiveSharePct, basis: "observed" };
    repTree = { label: "Repetitive share of observed time", value: fin.repetitiveSharePct, unit: "pct", basis: "observed", formula: "repetitive workflow hrs/wk ÷ observed hrs/wk", source: "Finance engine (computeOrgFinancials)", children: [fin.trees.repetitiveHours, { label: "Observed hours per week", value: fin.hoursObservedPerWeek, unit: "hours", basis: "observed", formula: "max(non-idle activity hrs/wk, Σ workflow hrs/wk)" }] };
  } else {
    const repIds = new Set(data.workflows.filter((w) => num(w.repetitionScore) >= 50).map((w) => w.id));
    const links = data.wfEmps.filter((l) => empInScope.has(l.employeeId));
    const wfHours = sum(links.map((l) => num(l.hoursPerWeek)));
    const repHours = sum(links.filter((l) => repIds.has(l.workflowId)).map((l) => num(l.hoursPerWeek)));
    const denom = Math.max(hoursPerWeek, wfHours);
    repetitive = { hoursPerWeek: repHours, sharePct: denom > 0 ? repHours / denom : 0, basis: "observed" };
    repTree = { label: "Repetitive share of observed time (filtered)", value: repetitive.sharePct, unit: "pct", basis: "observed", formula: "Σ performer hrs/wk on workflows with repetition ≥ 50 ÷ max(active hrs/wk, Σ performer workflow hrs/wk)", source: "workflow_employees × activity_events for the employees in scope", children: [
      { label: "Repetitive workflow hours per week", value: repHours, unit: "hours", basis: "observed" },
      { label: "Active hours per week (in scope)", value: hoursPerWeek, unit: "hours", basis: "observed" },
      { label: "Workflow hours per week (in scope)", value: wfHours, unit: "hours", basis: "observed" },
    ] };
  }

  const weekly = data.weekly.map((w) => ({ week: w.wk, hours: w.ms / HR, repetitiveHours: w.rms / HR, repetitiveShare: w.ms > 0 ? w.rms / w.ms : 0 }));

  // ---------- trees ----------
  const deptLaborChildren: CalcTree[] = byDepartment.filter((r) => r.labor > 0).map((r) => ({
    label: r.name, value: r.labor, unit: "usd", basis: r.laborBasis, formula: `Σ loaded annual cost of ${finEmp.filter((e) => (empMeta.get(e.employeeId)?.departmentId ?? null) === r.id).length} analyzed employees`, source: "Finance engine byEmployee",
    children: opts.showEmployeeCosts ? finEmp.filter((e) => (empMeta.get(e.employeeId)?.departmentId ?? null) === r.id).map((e) => ({ label: e.name, value: e.laborAnnual, unit: "usd", basis: e.costBasis, source: "Employee record" })) : undefined,
  }));
  const labor: CalcTree = { label: "Annual labor expense (loaded)", value: laborAnnual, unit: "usd", basis: laborBasis, formula: `Σ base annual cost × (1 + ${fin.assumptions.benefitsLoadPct}) over ${finEmp.length} analyzed employees in scope`, source: unfilteredAll || !scope.filtered ? `Equals finance engine total labor analyzed (${fin.employeesAnalyzed} employees)` : "Finance engine byEmployee, filtered to scope", children: deptLaborChildren };
  const overhead: CalcTree = { label: "Department overhead (entered)", value: overheadAnnual, unit: "usd", basis: overheadBasis, formula: "Σ departments.annual_overhead", source: `${overheadDepts.length} of ${scope.departments.length} departments in scope have overhead entered (Settings → Structure)`, children: overheadDepts.map((d) => ({ label: d.name, value: overheadOf(d), unit: "usd", basis: d.overheadBasis, source: "Entered on department" })) };
  const enteredOpex: CalcTree = { label: "Entered operating expense", value: laborAnnual + overheadAnnual, unit: "usd", basis: laborBasis === "observed" && overheadBasis === "observed" ? "observed" : "assumed", formula: "labor expense + entered department overhead", source: "Not total company opex — only labor and the overhead entered per department (no general-ledger import)", children: [labor, overhead] };
  const headcount: CalcTree = { label: "Headcount (active employees in scope)", value: scope.employees.length, basis: "observed", formula: "count of active employee records matching the filters", source: `${finEmp.length} have observed activity or workflow links (analyzed)`, children: byDepartment.filter((r) => r.headcount > 0).map((r) => ({ label: r.name, value: r.headcount, basis: "observed" as Basis })) };
  const hpwTree: CalcTree = { label: "Observed active hours per week", value: hoursPerWeek, unit: "hours", basis: "observed", formula: `Σ non-idle event duration ÷ (distinct active days ÷ 5)`, source: `activity_events: ${events.toLocaleString("en-US")} events${from || to ? " in the selected date range" : ""}`, children: [
    { label: "Active hours observed", value: activeHours, unit: "hours", basis: "observed", children: byCategory.slice(0, 12).map((c) => ({ label: c.name, value: c.hours, unit: "hours", basis: "observed" as Basis })) },
    { label: "Observed weeks", value: weeks, unit: "weeks", basis: "observed", formula: `${data.totalDays} active days ÷ 5` },
  ] };
  const switchTree: CalcTree = { label: "Context switches per active hour", value: contextSwitches.perHour, basis: contextSwitches.basis, formula: contextSwitches.method === "app_switch_events" ? "count(app_switch events) ÷ active hours" : "count(consecutive events where the app changes, per employee) ÷ active hours", source: contextSwitches.method === "app_switch_events" ? "Collector app_switch events" : "Collectors did not emit app_switch events; switches derived from the ordered event stream", children: [
    { label: "Switches", value: contextSwitches.count, basis: contextSwitches.basis },
    { label: "Active hours", value: activeHours, unit: "hours", basis: "observed" },
  ] };
  const idleTree: CalcTree = { label: "Idle share", value: activeHours + idleHours > 0 ? idleHours / (activeHours + idleHours) : 0, unit: "pct", basis: "observed", formula: "idle hours ÷ (active + idle hours)", children: [{ label: "Idle hours", value: idleHours, unit: "hours", basis: "observed" }, { label: "Active hours", value: activeHours, unit: "hours", basis: "observed" }] };

  return {
    computedAt: new Date().toISOString(),
    filters: { bu: filters.bu ?? null, dept: filters.dept ?? null, loc: filters.loc ?? null, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
    filtered: scope.filtered || !!from || !!to,
    headcount: scope.employees.length, employeesAnalyzed: finEmp.length,
    laborAnnual, overheadAnnual, enteredOpexAnnual: laborAnnual + overheadAnnual, departmentsWithOverhead: overheadDepts.length, departmentsInScope: scope.departments.length,
    byBusinessUnit, byLocation, byDepartment,
    activity: { events, activeHours, idleHours, idleShare: idleTree.value, activeDays: data.totalDays, weeks, hoursPerWeek, byCategory, byActivity, topApps, contextSwitches },
    repetitive,
    workload: { employees: perEmp.length, p25: percentile(perEmp, 0.25), p50: percentile(perEmp, 0.5), p75: percentile(perEmp, 0.75), p90: percentile(perEmp, 0.9), max: maxW, histogram },
    weekly,
    trees: { labor, overhead, enteredOpex, headcount, hoursPerWeek: hpwTree, repetitive: repTree, contextSwitches: switchTree, idle: idleTree },
    options: {
      businessUnits: data.bus.map((b) => ({ id: b.id, name: b.name })).sort((a, b) => a.name.localeCompare(b.name)),
      locations: data.locs.map((l) => ({ id: l.id, name: l.name })).sort((a, b) => a.name.localeCompare(b.name)),
      departments: departments.map((d) => ({ id: d.id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}
