/**
 * Business Benchmarking engine — INTERNAL comparisons only, computed from tenant data.
 *
 * Entities: departments, locations, business units, (consultancy) client orgs in the portfolio, and evaluation
 * snapshots over time. Every metric is normalized to the median of the compared entities and placed in a quartile.
 * External benchmarks are never bundled or invented: they come only from `benchmark_datasets` rows that cite a source.
 */
import { eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { computeOrgFinancials } from "./finance";
import type { OrgFinancials } from "./finance.types";

const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const DAYS_PER_YEAR = 365.25;

import { METRICS, type MetricKey } from "./benchmark.types";
export { METRICS, type MetricKey, type MetricDef } from "./benchmark.types";
export type EntityType = "department" | "location" | "business_unit" | "client";
export type BenchEntity = { id: string; name: string; type: EntityType; employees: number; values: Record<MetricKey, number | null> };
export type MetricStats = { median: number | null; normalized: Record<string, number | null>; quartile: Record<string, 1 | 2 | 3 | 4 | null> };
export type BenchmarkSet = { type: EntityType; entities: BenchEntity[]; stats: Record<MetricKey, MetricStats> };
export type SnapshotPoint = { id: string; name: string; status: string; at: string; score: number | null; potential: number; verified: number; net: number; recoverablePerWeek: number };
export type Benchmarks = { orgId: string; computedAt: string; sets: Partial<Record<EntityType, BenchmarkSet>>; snapshots: SnapshotPoint[]; orgValues: Record<MetricKey, number | null> };

export function median(xs: number[]): number | null {
  if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Quartile by value: 1 = top 25% (highest values), 4 = bottom 25%. Ties share the better quartile. */
export function quartileOf(value: number, all: number[]): 1 | 2 | 3 | 4 {
  const above = all.filter((x) => x > value).length; const p = all.length > 1 ? above / all.length : 0;
  return p < 0.25 ? 1 : p < 0.5 ? 2 : p < 0.75 ? 3 : 4;
}
export function statsFor(entities: BenchEntity[]): Record<MetricKey, MetricStats> {
  return Object.fromEntries(METRICS.map((m) => {
    const vals = entities.map((e) => e.values[m.key]).filter((v): v is number => v != null && Number.isFinite(v));
    const med = median(vals);
    const normalized: Record<string, number | null> = {}; const quartile: Record<string, 1 | 2 | 3 | 4 | null> = {};
    for (const e of entities) { const v = e.values[m.key]; normalized[e.id] = v == null || med == null || med === 0 ? null : v / med; quartile[e.id] = v == null || vals.length < 2 ? null : quartileOf(v, vals); }
    return [m.key, { median: med, normalized, quartile }];
  })) as Record<MetricKey, MetricStats>;
}

type Acc = { employees: number; labor: number; hours: number; repetitive: number; recoverable: number; realizable: number; verified: number; wfHours: number; auto: number; rework: number; handoffs: number };
const blank = (): Acc => ({ employees: 0, labor: 0, hours: 0, repetitive: 0, recoverable: 0, realizable: 0, verified: 0, wfHours: 0, auto: 0, rework: 0, handoffs: 0 });
function toValues(a: Acc): Record<MetricKey, number | null> {
  const fte = a.employees;
  return {
    laborPerEmployee: fte ? a.labor / fte : null, repetitiveShare: a.hours > 0 ? a.repetitive / a.hours : null, recoverableHrsPerFte: fte ? a.recoverable / fte : null,
    automationScoreAvg: a.wfHours > 0 ? a.auto / a.wfHours : null, reworkRate: a.wfHours > 0 ? a.rework / a.wfHours : null, handoffsPerRun: a.wfHours > 0 ? a.handoffs / a.wfHours : null,
    realizablePerFte: fte ? a.realizable / fte : null, verifiedPerFte: fte ? a.verified / fte : null,
  };
}

async function loadOrg(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const [depts, emps, bus, locs, workflows, links, agents, meas, evals] = await Promise.all([
      tx.select({ id: schema.departments.id, name: schema.departments.name, bu: schema.departments.businessUnitId, loc: schema.departments.locationId }).from(schema.departments).where(eq(schema.departments.orgId, orgId)),
      tx.select({ id: schema.employees.id, dept: schema.employees.departmentId, bu: schema.employees.businessUnitId, loc: schema.employees.locationId }).from(schema.employees).where(eq(schema.employees.orgId, orgId)),
      tx.select({ id: schema.businessUnits.id, name: schema.businessUnits.name }).from(schema.businessUnits).where(eq(schema.businessUnits.orgId, orgId)),
      tx.select({ id: schema.locations.id, name: schema.locations.name, bu: schema.locations.businessUnitId }).from(schema.locations).where(eq(schema.locations.orgId, orgId)),
      tx.select({ id: schema.workflows.id, dept: schema.workflows.departmentId, hours: schema.workflows.hoursPerWeek, auto: schema.workflows.automationScore, rework: schema.workflows.reworkRate, handoffs: schema.workflows.handoffCount }).from(schema.workflows).where(eq(schema.workflows.orgId, orgId)),
      tx.select({ wf: schema.workflowEmployees.workflowId, emp: schema.workflowEmployees.employeeId, hours: schema.workflowEmployees.hoursPerWeek }).from(schema.workflowEmployees).where(eq(schema.workflowEmployees.orgId, orgId)),
      tx.select({ id: schema.agents.id, wf: schema.agents.workflowId }).from(schema.agents).where(eq(schema.agents.orgId, orgId)),
      tx.select({ agent: schema.savingsMeasurements.agentId, wf: schema.savingsMeasurements.workflowId, start: schema.savingsMeasurements.periodStart, end: schema.savingsMeasurements.periodEnd, dollars: schema.savingsMeasurements.dollarsSaved }).from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId)),
      tx.select().from(schema.evaluations).where(eq(schema.evaluations.orgId, orgId)),
    ]);
    return { depts, emps, bus, locs, workflows, links, agents, meas, evals };
  });
}

/** Org-level metric values (used for the client portfolio and as the "whole org" reference). */
export function orgLevelValues(fin: OrgFinancials, workflows: { hours: unknown; auto: unknown; rework: unknown; handoffs: unknown }[]): Record<MetricKey, number | null> {
  const a = blank(); a.employees = fin.employeesAnalyzed; a.labor = fin.totalAnnualLaborAnalyzed; a.hours = fin.hoursObservedPerWeek; a.repetitive = fin.repetitiveHoursPerWeek;
  a.recoverable = fin.hoursRecoverablePerWeek; a.realizable = fin.realizableAnnualSavings; a.verified = fin.verifiedAnnualizedSavings;
  for (const w of workflows) { const h = num(w.hours); a.wfHours += h; a.auto += num(w.auto) * h; a.rework += num(w.rework) * h; a.handoffs += num(w.handoffs) * h; }
  return toValues(a);
}

export async function computeBenchmarks(orgId: string, opts: { portfolioOrgIds?: { id: string; name: string }[] } = {}): Promise<Benchmarks> {
  const [fin, d] = await Promise.all([computeOrgFinancials(orgId), loadOrg(orgId)]);
  const empFin = new Map(fin.byEmployee.map((e) => [e.employeeId, e]));
  const deptById = new Map(d.depts.map((x) => [x.id, x])); const locById = new Map(d.locs.map((x) => [x.id, x]));

  // Verified $ attributed to employees by their share of the measured workflow's hours (agent → workflow → performers).
  const wfOfAgent = new Map(d.agents.map((a) => [a.id, a.wf]));
  const linksByWf = new Map<string, { emp: string; hours: number }[]>();
  for (const l of d.links) { const arr = linksByWf.get(l.wf) ?? []; arr.push({ emp: l.emp, hours: num(l.hours) }); linksByWf.set(l.wf, arr); }
  const verifiedByEmp = new Map<string, number>();
  for (const m of d.meas) {
    const days = (+m.end - +m.start) / 86_400_000; if (days <= 0) continue;
    const annual = num(m.dollars) * (DAYS_PER_YEAR / days); const wf = m.wf ?? (m.agent ? wfOfAgent.get(m.agent) : null); if (!wf) continue;
    const ls = linksByWf.get(wf) ?? []; const tot = sum(ls.map((l) => l.hours)); if (tot <= 0) continue;
    for (const l of ls) verifiedByEmp.set(l.emp, (verifiedByEmp.get(l.emp) ?? 0) + annual * (l.hours / tot));
  }
  const wfById = new Map(d.workflows.map((w) => [w.id, w]));

  /** Aggregate analyzed employees (and the workflow hours they perform) into entities by a key function. */
  const group = (type: EntityType, keyOf: (e: (typeof d.emps)[number]) => string | null, names: Map<string, string>): BenchmarkSet => {
    const acc = new Map<string, Acc>();
    const empKey = new Map<string, string>();
    for (const e of d.emps) {
      const f = empFin.get(e.id); if (!f) continue; const k = keyOf(e); if (!k) continue; empKey.set(e.id, k);
      const a = acc.get(k) ?? blank(); a.employees += 1; a.labor += f.laborAnnual; a.hours += f.hoursPerWeek; a.repetitive += f.repetitiveHoursPerWeek; a.recoverable += f.recoverableHoursPerWeek; a.realizable += f.realizableAnnual; a.verified += verifiedByEmp.get(e.id) ?? 0; acc.set(k, a);
    }
    for (const l of d.links) { const k = empKey.get(l.emp); const w = wfById.get(l.wf); if (!k || !w) continue; const a = acc.get(k)!; const h = num(l.hours); a.wfHours += h; a.auto += num(w.auto) * h; a.rework += num(w.rework) * h; a.handoffs += num(w.handoffs) * h; }
    const entities = [...acc.entries()].map(([id, a]) => ({ id, name: names.get(id) ?? "Unknown", type, employees: a.employees, values: toValues(a) })).sort((x, y) => x.name.localeCompare(y.name));
    return { type, entities, stats: statsFor(entities) };
  };

  // Departments: dollars & hours straight from the finance engine's department roll-up (single source of truth).
  const deptEntities: BenchEntity[] = fin.byDepartment.filter((r) => r.departmentId).map((r) => {
    const a = blank(); a.employees = r.employees; a.labor = r.laborAnnual; a.hours = r.hoursPerWeek; a.repetitive = r.repetitiveHoursPerWeek; a.recoverable = r.recoverableHoursPerWeek; a.realizable = r.realizableAnnual; a.verified = r.verifiedAnnual;
    for (const w of d.workflows.filter((x) => x.dept === r.departmentId)) { const h = num(w.hours); a.wfHours += h; a.auto += num(w.auto) * h; a.rework += num(w.rework) * h; a.handoffs += num(w.handoffs) * h; }
    return { id: r.departmentId as string, name: r.name, type: "department" as const, employees: r.employees, values: toValues(a) };
  }).filter((e) => e.employees > 0).sort((x, y) => x.name.localeCompare(y.name));

  const sets: Benchmarks["sets"] = { department: { type: "department", entities: deptEntities, stats: statsFor(deptEntities) } };
  if (d.locs.length) sets.location = group("location", (e) => e.loc ?? (e.dept ? (deptById.get(e.dept)?.loc ?? null) : null), new Map(d.locs.map((x) => [x.id, x.name])));
  if (d.bus.length) sets.business_unit = group("business_unit", (e) => e.bu ?? (e.dept ? (deptById.get(e.dept)?.bu ?? null) : null) ?? (e.loc ? (locById.get(e.loc)?.bu ?? null) : null), new Map(d.bus.map((x) => [x.id, x.name])));

  if (opts.portfolioOrgIds?.length) {
    const clients: BenchEntity[] = [];
    for (const c of opts.portfolioOrgIds) {
      const [cf, wfs] = await Promise.all([computeOrgFinancials(c.id), withTenant(c.id, (tx) => tx.select({ hours: schema.workflows.hoursPerWeek, auto: schema.workflows.automationScore, rework: schema.workflows.reworkRate, handoffs: schema.workflows.handoffCount }).from(schema.workflows).where(eq(schema.workflows.orgId, c.id)))]);
      if (cf.employeesAnalyzed === 0 && wfs.length === 0) { clients.push({ id: c.id, name: c.name, type: "client", employees: 0, values: Object.fromEntries(METRICS.map((m) => [m.key, null])) as Record<MetricKey, number | null> }); continue; }
      clients.push({ id: c.id, name: c.name, type: "client", employees: cf.employeesAnalyzed, values: orgLevelValues(cf, wfs) });
    }
    sets.client = { type: "client", entities: clients, stats: statsFor(clients) };
  }

  const snapshots: SnapshotPoint[] = d.evals.filter((e) => e.snapshot).map((e) => {
    const s = e.snapshot as { score?: number | null; savings?: { potential?: number; verified?: number; net?: number }; hours?: { recoverablePerWeek?: number } };
    return { id: e.id, name: e.name, status: e.status, at: e.createdAt.toISOString(), score: s.score ?? null, potential: num(s.savings?.potential), verified: num(s.savings?.verified), net: num(s.savings?.net), recoverablePerWeek: num(s.hours?.recoverablePerWeek) };
  }).sort((a, b) => a.at.localeCompare(b.at));

  return { orgId, computedAt: new Date().toISOString(), sets, snapshots, orgValues: orgLevelValues(fin, d.workflows) };
}
