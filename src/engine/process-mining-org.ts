/**
 * Organization-wide process mining — merges every discovered workflow into one directly-follows graph.
 *
 *  - mergeProcessMaps(workflows)              → PURE: one graph keyed by step id (`app:title:type` = app + action)
 *  - resolveHandoffTarget(...)                → PURE: maps a handoff event's `meta.to` to a department
 *  - computeOrgProcessMining(orgId, filters)  → OrgProcessMining (graph, variants, bottlenecks, handoff matrix, conformance)
 *
 * Everything is observed from our own collectors (`workflows.process_map`, `workflow_employees`, `activity_events`).
 * Nothing here comes from Power Automate / UiPath / Mimica / Celonis — those connectors are license-gated (see
 * src/engine/adapters/process-mining.ts) and their data, once imported, lands in `workflows` like ours.
 * Weekly frequency: a workflow's node counts cover its whole observation window, so they are scaled by
 * runsPerWeek ÷ observed runs (evidence.sampleSize, or the busiest node count when absent).
 * Never import "server-only" here.
 */
import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import type { CalcTree, ProcessMap, WorkflowStep, Evidence } from "@/db/schema";
import { num } from "@/lib/utils";
import { mineEmployee, type MiningEvent } from "./mining";

export type PmFilters = { bu?: string | null; dept?: string | null; loc?: string | null; wf?: string | null };
export type Basis = "observed" | "estimated" | "assumed";

export type WorkflowInput = { id: string; name: string; departmentId: string | null; processMap: ProcessMap | null; runsPerWeek: number; hoursPerWeek: number; reworkRate: number; evidence?: Pick<Evidence, "sampleSize"> | null };
export type GraphNode = { id: string; label: string; app: string; action: string; type: string; count: number; perWeek: number; avgMs: number; hoursPerWeek: number; workflowIds: string[]; reworkRate: number };
export type GraphEdge = { from: string; to: string; count: number; perWeek: number; workflowIds: string[] };
export type MergedGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** Weekly scale for a workflow's process-map counts. */
export function weeklyScale(w: WorkflowInput): number {
  const maxNode = Math.max(0, ...(w.processMap?.nodes ?? []).map((n) => n.count));
  const runs = num(w.evidence?.sampleSize) || maxNode;
  return runs > 0 ? w.runsPerWeek / runs : 0;
}

function splitId(id: string, label: string): { app: string; action: string; type: string } {
  const parts = id.split(":");
  const app = parts[0] ?? label; const type = parts.length >= 3 ? parts[parts.length - 1] : ""; const title = parts.slice(1, parts.length - 1).join(":");
  return { app, action: title ? `${title} (${type.replace(/_/g, " ")})` : label, type };
}

/** PURE. Merge workflow process maps into one directly-follows graph. Node avg duration is count-weighted. */
export function mergeProcessMaps(workflows: WorkflowInput[]): MergedGraph {
  const nodes = new Map<string, GraphNode & { _msw: number; _rw: number }>();
  const edges = new Map<string, GraphEdge>();
  for (const w of workflows) {
    const pm = w.processMap; if (!pm) continue;
    const scale = weeklyScale(w);
    for (const n of pm.nodes) {
      let g = nodes.get(n.id);
      if (!g) { const s = splitId(n.id, n.label); g = { id: n.id, label: n.label, app: s.app, action: s.action, type: s.type, count: 0, perWeek: 0, avgMs: 0, hoursPerWeek: 0, workflowIds: [], reworkRate: 0, _msw: 0, _rw: 0 }; nodes.set(n.id, g); }
      g.count += n.count; g.perWeek += n.count * scale; g._msw += n.avgMs * n.count; g.hoursPerWeek += (n.count * scale * n.avgMs) / 3_600_000; g._rw += w.reworkRate * n.count;
      if (!g.workflowIds.includes(w.id)) g.workflowIds.push(w.id);
    }
    for (const e of pm.edges) {
      const k = `${e.from}→${e.to}`;
      let g = edges.get(k); if (!g) { g = { from: e.from, to: e.to, count: 0, perWeek: 0, workflowIds: [] }; edges.set(k, g); }
      g.count += e.count; g.perWeek += e.count * scale; if (!g.workflowIds.includes(w.id)) g.workflowIds.push(w.id);
    }
  }
  return {
    nodes: [...nodes.values()].map(({ _msw, _rw, ...n }) => ({ ...n, avgMs: n.count > 0 ? _msw / n.count : 0, reworkRate: n.count > 0 ? _rw / n.count : 0 })).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek),
    edges: [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to)).sort((a, b) => b.count - a.count),
  };
}

/**
 * PURE. A handoff's `meta.to` is a role ("manager") or a team ("finance", "it"). Resolve it to a department when we can:
 * "manager" → the sender's manager's department (else the sender's own department — an in-team approval);
 * a team name → the department whose name matches; anything else stays visible as an unmapped target.
 */
export function resolveHandoffTarget(to: string, fromDeptId: string | null, managerDeptId: string | null, departments: { id: string; name: string }[]): { key: string; name: string; mapped: boolean } {
  const t = (to || "").trim().toLowerCase();
  const byId = (id: string) => departments.find((x) => x.id === id);
  if (t === "manager" || t === "supervisor") {
    const id = managerDeptId ?? fromDeptId; const dep = id ? byId(id) : undefined;
    return dep ? { key: dep.id, name: dep.name, mapped: true } : { key: "role:manager", name: "Manager (unmapped)", mapped: false };
  }
  const dep = departments.find((x) => x.name.toLowerCase() === t) ?? (t.length >= 3 ? departments.find((x) => x.name.toLowerCase().startsWith(t)) : undefined);
  if (dep) return { key: dep.id, name: dep.name, mapped: true };
  const lbl = t.length <= 3 ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1);
  return { key: `ext:${t || "unknown"}`, name: `${lbl || "Unknown"} (outside mapped departments)`, mapped: false };
}

export type Variant = { signature: string; steps: string[]; sampleRuns: number; share: number; canonical: boolean };
export type WorkflowSummary = { id: string; name: string; departmentId: string | null; departmentName: string | null; runsPerWeek: number; hoursPerWeek: number; reworkRate: number; reworkHoursPerWeek: number; steps: number; variants: Variant[]; sampleRuns: number; canonicalShare: number; performers: number; opportunities: number };
export type Bottleneck = { nodeId: string; label: string; app: string; avgMs: number; perWeek: number; hoursPerWeek: number; reworkRate: number; crossDeptHandoffsPerWeek: number; departments: number; score: number };
export type NodeDetail = { performers: { id: string; name: string; department: string | null; hoursPerWeek: number }[]; departments: { id: string | null; name: string }[]; workflows: { id: string; name: string }[]; opportunities: { id: string; title: string; status: string; realizableAnnual: number }[] };
export type OrgProcessMining = {
  computedAt: string;
  filters: { bu: string | null; dept: string | null; loc: string | null; wf: string | null };
  graph: MergedGraph;
  nodeDetails: Record<string, NodeDetail>;
  workflows: WorkflowSummary[];
  bottlenecks: Bottleneck[];
  handoffs: { departments: { key: string; name: string; mapped: boolean }[]; matrix: { from: string; to: string; perWeek: number; count: number }[]; total: number; perWeek: number; crossDeptPerWeek: number; weeks: number };
  conformance: { workflowId: string; name: string; reworkRate: number; reworkHoursPerWeek: number; canonicalShare: number; hint: string }[];
  kpis: { processes: number; steps: number; edges: number; variants: number; handoffsPerWeek: number; reworkHoursPerWeek: number };
  trees: { processes: CalcTree; steps: CalcTree; variants: CalcTree; handoffs: CalcTree; rework: CalcTree };
  options: { businessUnits: { id: string; name: string }[]; locations: { id: string; name: string }[]; departments: { id: string; name: string }[]; workflows: { id: string; name: string }[] };
};

const REWORK_HINT_THRESHOLD = 0.15;
/** Runs re-mined per workflow for the variant explorer. */
export const VARIANT_SAMPLE_RUNS = 80;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export async function computeOrgProcessMining(orgId: string, filters: PmFilters = {}): Promise<OrgProcessMining> {
  const d = await withTenant(orgId, async (tx) => {
    const [workflows, links, employees, departments, bus, locs, opps] = await Promise.all([
      tx.select({ id: schema.workflows.id, name: schema.workflows.name, departmentId: schema.workflows.departmentId, processMap: schema.workflows.processMap, steps: schema.workflows.steps, signature: schema.workflows.signature, runsPerWeek: schema.workflows.runsPerWeek, hoursPerWeek: schema.workflows.hoursPerWeek, reworkRate: schema.workflows.reworkRate, evidence: schema.workflows.evidence }).from(schema.workflows).where(eq(schema.workflows.orgId, orgId)),
      tx.select().from(schema.workflowEmployees).where(eq(schema.workflowEmployees.orgId, orgId)),
      tx.select({ id: schema.employees.id, name: schema.employees.displayName, departmentId: schema.employees.departmentId, businessUnitId: schema.employees.businessUnitId, locationId: schema.employees.locationId, managerEmployeeId: schema.employees.managerEmployeeId, isActive: schema.employees.isActive }).from(schema.employees).where(eq(schema.employees.orgId, orgId)),
      tx.select({ id: schema.departments.id, name: schema.departments.name, businessUnitId: schema.departments.businessUnitId, locationId: schema.departments.locationId }).from(schema.departments).where(eq(schema.departments.orgId, orgId)),
      tx.select({ id: schema.businessUnits.id, name: schema.businessUnits.name }).from(schema.businessUnits).where(eq(schema.businessUnits.orgId, orgId)),
      tx.select({ id: schema.locations.id, name: schema.locations.name }).from(schema.locations).where(eq(schema.locations.orgId, orgId)),
      tx.select({ id: schema.opportunities.id, title: schema.opportunities.title, status: schema.opportunities.status, workflowId: schema.opportunities.workflowId, realizable: schema.opportunities.realizableAnnualSavings }).from(schema.opportunities).where(eq(schema.opportunities.orgId, orgId)),
    ]);
    const handoffRows = await tx.execute(sql`select employee_id, (app || ':' || lower(coalesce(title_category, '')) || ':' || type::text) as token, coalesce(meta->>'to', '') as target, count(*)::int as n from activity_events where org_id = ${orgId} and type = 'handoff' group by 1,2,3`) as unknown as { employee_id: string; token: string; target: string; n: number }[];
    const [days] = await tx.execute(sql`select count(distinct date(ts))::int as days from activity_events where org_id = ${orgId} and type not in ('idle_start','idle_end')`) as unknown as { days: number }[];
    // evidence.eventIds holds the FIRST event of each observed run. Re-mine a spread sample of runs: every event of
    // the same employee in the 45 minutes after each anchor, then keep the instance that starts at the anchor.
    const anchors = new Map<number, string>();
    for (const w of workflows) { const ids = (w.evidence?.eventIds ?? []).filter((x) => Number.isFinite(x)); const stepN = Math.max(1, Math.floor(ids.length / VARIANT_SAMPLE_RUNS)); for (let i = 0; i < ids.length && anchors.size < 5000; i += stepN) anchors.set(ids[i], w.id); }
    const sample: (MiningEvent & { anchor: number })[] = [];
    const anchorIds = [...anchors.keys()];
    for (let i = 0; i < anchorIds.length; i += 500) {
      const chunk = anchorIds.slice(i, i + 500);
      const rows = await tx.execute(sql`select a.id as anchor, e.id, e.employee_id, e.ts, e.type::text as type, e.app, coalesce(e.app_category,'') as app_category, coalesce(e.title_category,'') as title_category, e.title_hash, e.duration_ms, e.meta
        from activity_events a join activity_events e on e.org_id = a.org_id and e.employee_id = a.employee_id and e.ts >= a.ts and e.ts < a.ts + interval '45 minutes'
        where a.org_id = ${orgId} and a.id in (${sql.join(chunk.map((x) => sql`${x}`), sql`, `)}) order by a.id, e.ts, e.id`) as unknown as { anchor: number; id: number; employee_id: string; ts: string | Date; type: string; app: string; app_category: string; title_category: string; title_hash: string | null; duration_ms: number; meta: Record<string, number | string | boolean> | null }[];
      for (const r of rows) sample.push({ anchor: Number(r.anchor), id: Number(r.id), employeeId: r.employee_id, ts: new Date(r.ts).getTime(), type: r.type, app: r.app, appCategory: r.app_category, titleCategory: r.title_category, titleHash: r.title_hash, durationMs: Number(r.duration_ms), meta: r.meta });
    }
    return { workflows, links, employees, departments, bus, locs, opps, handoffRows, activeDays: Number(days?.days ?? 0), sample, anchors };
  });

  const deptById = new Map(d.departments.map((x) => [x.id, x]));
  const empById = new Map(d.employees.map((e) => [e.id, e]));
  const empBu = (e: (typeof d.employees)[number]) => e.businessUnitId ?? (e.departmentId ? deptById.get(e.departmentId)?.businessUnitId ?? null : null);
  const empLoc = (e: (typeof d.employees)[number]) => e.locationId ?? (e.departmentId ? deptById.get(e.departmentId)?.locationId ?? null : null);

  // ---------- scope ----------
  const empFiltered = !!(filters.bu || filters.dept || filters.loc);
  const scopedEmp = new Set(d.employees.filter((e) => (!filters.dept || e.departmentId === filters.dept) && (!filters.bu || empBu(e) === filters.bu) && (!filters.loc || empLoc(e) === filters.loc)).map((e) => e.id));
  const linksByWf = new Map<string, typeof d.links>();
  for (const l of d.links) { const a = linksByWf.get(l.workflowId) ?? []; a.push(l); linksByWf.set(l.workflowId, a); }
  const wfInScope = d.workflows.filter((w) => {
    if (filters.wf && w.id !== filters.wf) return false;
    if (!empFiltered) return true;
    const dept = w.departmentId ? deptById.get(w.departmentId) : undefined;
    const deptMatch = !!dept && (!filters.dept || dept.id === filters.dept) && (!filters.bu || dept.businessUnitId === filters.bu) && (!filters.loc || dept.locationId === filters.loc);
    return deptMatch || (linksByWf.get(w.id) ?? []).some((l) => scopedEmp.has(l.employeeId));
  });
  const inputs: WorkflowInput[] = wfInScope.map((w) => ({ id: w.id, name: w.name, departmentId: w.departmentId, processMap: w.processMap ?? null, runsPerWeek: num(w.runsPerWeek), hoursPerWeek: num(w.hoursPerWeek), reworkRate: num(w.reworkRate), evidence: w.evidence }));
  const graph = mergeProcessMaps(inputs);
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  // ---------- handoffs ----------
  const weeks = d.activeDays > 0 ? Math.max(d.activeDays / 5, 0.2) : 0;
  const handoffDepts = new Map<string, { key: string; name: string; mapped: boolean }>();
  const cell = new Map<string, { from: string; to: string; count: number }>();
  const crossByToken = new Map<string, number>();
  let handoffTotal = 0, crossTotal = 0;
  for (const h of d.handoffRows) {
    if (empFiltered && !scopedEmp.has(h.employee_id)) continue;
    if (filters.wf && !nodeIds.has(h.token)) continue;
    const e = empById.get(h.employee_id);
    const fromId = e?.departmentId ?? null;
    const fromKey = fromId ?? "unassigned"; const fromName = fromId ? deptById.get(fromId)?.name ?? "Unknown" : "Unassigned";
    const mgr = e?.managerEmployeeId ? empById.get(e.managerEmployeeId) : undefined;
    const tgt = resolveHandoffTarget(h.target, fromId, mgr?.departmentId ?? null, d.departments);
    handoffDepts.set(fromKey, { key: fromKey, name: fromName, mapped: !!fromId }); handoffDepts.set(tgt.key, tgt);
    const k = `${fromKey}→${tgt.key}`; const c = cell.get(k) ?? { from: fromKey, to: tgt.key, count: 0 }; c.count += h.n; cell.set(k, c);
    handoffTotal += h.n;
    if (tgt.key !== fromKey) { crossTotal += h.n; crossByToken.set(h.token, (crossByToken.get(h.token) ?? 0) + h.n); }
  }
  const perWk = (n: number) => (weeks > 0 ? n / weeks : 0);

  // ---------- node details ----------
  const wfName = new Map(d.workflows.map((w) => [w.id, w.name]));
  const nodeDetails: Record<string, NodeDetail> = {};
  for (const n of graph.nodes) {
    const perf = new Map<string, number>();
    for (const wid of n.workflowIds) for (const l of linksByWf.get(wid) ?? []) if (!empFiltered || scopedEmp.has(l.employeeId)) perf.set(l.employeeId, (perf.get(l.employeeId) ?? 0) + num(l.hoursPerWeek));
    const performers = [...perf.entries()].map(([id, h]) => { const e = empById.get(id); return { id, name: e?.name ?? "Unknown", department: e?.departmentId ? deptById.get(e.departmentId)?.name ?? null : null, hoursPerWeek: h }; }).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek);
    const deps = new Map<string | null, string>();
    for (const wid of n.workflowIds) { const w = wfInScope.find((x) => x.id === wid); if (w?.departmentId) deps.set(w.departmentId, deptById.get(w.departmentId)?.name ?? "Unknown"); }
    for (const p of performers) { const e = empById.get(p.id); if (e?.departmentId) deps.set(e.departmentId, deptById.get(e.departmentId)?.name ?? "Unknown"); }
    nodeDetails[n.id] = {
      performers, departments: [...deps.entries()].map(([id, name]) => ({ id, name })),
      workflows: n.workflowIds.map((id) => ({ id, name: wfName.get(id) ?? "" })),
      opportunities: d.opps.filter((o) => o.workflowId && n.workflowIds.includes(o.workflowId) && o.status !== "rejected").map((o) => ({ id: o.id, title: o.title, status: o.status, realizableAnnual: num(o.realizable) })),
    };
  }

  // ---------- bottlenecks ----------
  const bottlenecks: Bottleneck[] = graph.nodes.map((n) => {
    const cross = perWk(crossByToken.get(n.id) ?? 0);
    const crossShare = n.perWeek > 0 ? Math.min(1, cross / n.perWeek) : 0;
    return { nodeId: n.id, label: n.label, app: n.app, avgMs: n.avgMs, perWeek: n.perWeek, hoursPerWeek: n.hoursPerWeek, reworkRate: n.reworkRate, crossDeptHandoffsPerWeek: cross, departments: nodeDetails[n.id].departments.length, score: n.hoursPerWeek * (1 + n.reworkRate) * (1 + crossShare) };
  }).sort((a, b) => b.score - a.score);

  // ---------- variants (re-mined from each workflow's evidence sample) ----------
  const runsByAnchor = new Map<number, MiningEvent[]>();
  for (const e of d.sample) { const arr = runsByAnchor.get(e.anchor) ?? []; arr.push(e); runsByAnchor.set(e.anchor, arr); }
  const label = (tok: string) => { const p = tok.split(":"); return p.length >= 3 ? `${p[0]}: ${p.slice(1, -1).join(":")} (${p[p.length - 1].replace(/_/g, " ")})` : tok; };
  const workflows: WorkflowSummary[] = wfInScope.map((w) => {
    const counts = new Map<string, { tokens: string[]; n: number }>();
    const wfNodes = new Set((w.processMap?.nodes ?? []).map((n) => n.id));
    let sampled = 0;
    for (const [anchor, wid] of d.anchors) {
      if (wid !== w.id) continue;
      const inst = mineEmployee(runsByAnchor.get(anchor) ?? []).find((x) => x.eventIds[0] === anchor) ?? null;
      if (!inst) continue;
      const toks = inst.tokens.filter((t) => wfNodes.size === 0 || wfNodes.has(t)); if (toks.length < 2) continue;
      sampled++;
      const sig = toks.join(">"); const c = counts.get(sig) ?? { tokens: toks, n: 0 }; c.n += 1; counts.set(sig, c);
    }
    const totalRuns = sum([...counts.values()].map((c) => c.n));
    let variants: Variant[] = [...counts.entries()].map(([sig, c]) => ({ signature: sig, steps: c.tokens.map(label), sampleRuns: c.n, share: totalRuns > 0 ? c.n / totalRuns : 0, canonical: sig === w.signature })).sort((a, b) => b.sampleRuns - a.sampleRuns);
    if (!variants.some((v) => v.canonical) && w.signature) variants = [{ signature: w.signature, steps: w.signature.split(">").map(label), sampleRuns: 0, share: 0, canonical: true }, ...variants];
    const rr = num(w.reworkRate);
    return {
      id: w.id, name: w.name, departmentId: w.departmentId, departmentName: w.departmentId ? deptById.get(w.departmentId)?.name ?? null : null,
      runsPerWeek: num(w.runsPerWeek), hoursPerWeek: num(w.hoursPerWeek), reworkRate: rr, reworkHoursPerWeek: num(w.hoursPerWeek) * rr,
      steps: (w.steps as WorkflowStep[] | null)?.length ?? 0, variants: variants.slice(0, 12), sampleRuns: sampled, canonicalShare: variants.find((v) => v.canonical)?.share ?? 0,
      performers: (linksByWf.get(w.id) ?? []).length, opportunities: d.opps.filter((o) => o.workflowId === w.id && o.status !== "rejected").length,
    };
  }).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek);

  // ---------- conformance ----------
  const conformance = workflows.filter((w) => w.reworkRate > REWORK_HINT_THRESHOLD).map((w) => {
    const pm = wfInScope.find((x) => x.id === w.id)?.processMap;
    const back = (pm?.edges ?? []).map((e) => ({ e, fi: pm!.nodes.findIndex((n) => n.id === e.from), ti: pm!.nodes.findIndex((n) => n.id === e.to) })).filter((x) => x.ti >= 0 && x.fi > x.ti).sort((a, b) => b.e.count - a.e.count)[0];
    const loop = back ? ` Most frequent loop-back: ${label(back.e.from)} → ${label(back.e.to)} (${back.e.count} times observed).` : "";
    return { workflowId: w.id, name: w.name, reworkRate: w.reworkRate, reworkHoursPerWeek: w.reworkHoursPerWeek, canonicalShare: w.canonicalShare, hint: `${(w.reworkRate * 100).toFixed(0)}% of runs repeat an earlier step (threshold ${REWORK_HINT_THRESHOLD * 100}%).${loop} Review input quality and validation at the repeated step before automating.` };
  }).sort((a, b) => b.reworkHoursPerWeek - a.reworkHoursPerWeek);

  // ---------- KPIs + trees ----------
  const variantsTotal = sum(workflows.map((w) => w.variants.filter((v) => v.sampleRuns > 0 || v.canonical).length));
  const reworkHours = sum(workflows.map((w) => w.reworkHoursPerWeek));
  const kpis = { processes: workflows.length, steps: graph.nodes.length, edges: graph.edges.length, variants: variantsTotal, handoffsPerWeek: perWk(handoffTotal), reworkHoursPerWeek: reworkHours };
  const trees: OrgProcessMining["trees"] = {
    processes: { label: "Processes discovered", value: workflows.length, basis: "observed", formula: "count of mined workflows in scope", source: "workflows (our collectors' activity_events → mining engine)", children: workflows.map((w) => ({ label: w.name, value: w.hoursPerWeek, unit: "hours", basis: "observed" as Basis, source: `${w.runsPerWeek.toFixed(1)} runs/wk` })) },
    steps: { label: "Distinct steps in the merged graph", value: graph.nodes.length, basis: "observed", formula: "distinct (app + action) step ids across all workflow process maps", source: `${graph.edges.length} directly-follows edges`, children: graph.nodes.slice(0, 25).map((n) => ({ label: n.label, value: n.hoursPerWeek, unit: "hours", basis: "observed" as Basis, formula: `${n.perWeek.toFixed(1)} × ${(n.avgMs / 1000).toFixed(0)}s per week`, source: `${n.workflowIds.length} workflow(s)` })) },
    variants: { label: "Process variants", value: variantsTotal, basis: "observed", formula: `distinct step sequences re-mined from up to ${VARIANT_SAMPLE_RUNS} observed runs per workflow`, source: "Sample-based: rare variants outside the sample are not counted", children: workflows.map((w) => ({ label: w.name, value: w.variants.length, basis: "observed" as Basis, source: `${w.sampleRuns} sampled runs, canonical share ${(w.canonicalShare * 100).toFixed(0)}%` })) },
    handoffs: { label: "Hand-offs per week", value: kpis.handoffsPerWeek, basis: "observed", formula: `handoff events ÷ (${d.activeDays} active days ÷ 5)`, source: `${handoffTotal} handoff events, ${crossTotal} crossing departments`, children: [{ label: "Cross-department hand-offs per week", value: perWk(crossTotal), basis: "observed" }, { label: "Observed weeks", value: weeks, unit: "weeks", basis: "observed" }] },
    rework: { label: "Rework hours per week", value: reworkHours, unit: "hours", basis: "observed", formula: "Σ workflow hrs/wk × rework rate", children: workflows.filter((w) => w.reworkRate > 0).map((w) => ({ label: w.name, value: w.reworkHoursPerWeek, unit: "hours", basis: "observed" as Basis, formula: `${w.hoursPerWeek.toFixed(1)} × ${(w.reworkRate * 100).toFixed(1)}%` })) },
  };

  const matrix = [...cell.values()].map((c) => ({ ...c, perWeek: perWk(c.count) }));
  return {
    computedAt: new Date().toISOString(),
    filters: { bu: filters.bu ?? null, dept: filters.dept ?? null, loc: filters.loc ?? null, wf: filters.wf ?? null },
    graph, nodeDetails, workflows, bottlenecks, conformance, kpis, trees,
    handoffs: { departments: [...handoffDepts.values()].sort((a, b) => Number(b.mapped) - Number(a.mapped) || a.name.localeCompare(b.name)), matrix, total: handoffTotal, perWeek: perWk(handoffTotal), crossDeptPerWeek: perWk(crossTotal), weeks },
    options: {
      businessUnits: d.bus.map((b) => ({ id: b.id, name: b.name })), locations: d.locs.map((l) => ({ id: l.id, name: l.name })),
      departments: d.departments.map((x) => ({ id: x.id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name)),
      workflows: d.workflows.map((w) => ({ id: w.id, name: w.name })).sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}
