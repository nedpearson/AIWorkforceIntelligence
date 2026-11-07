/**
 * "Ask BridgeBox" — evidence-grounded question answering.
 *
 *  buildEvidencePack(orgId, { role })       → every fact the assistant may use, loaded inside withTenant and
 *                                             scoped by the asker's role (no per-employee compensation unless
 *                                             the role has `employees:cost:read`).
 *  answerFromEvidence(pack, question)       → deterministic retrieval mode: intent matching over the pack,
 *                                             plain-English answer + the evidence items used (pure, unit tested).
 *  answerQuestion(orgId, question, opts)    → retrieval mode, or Anthropic Messages API when ANTHROPIC_API_KEY
 *                                             is set (the model may only answer from the evidence JSON).
 *
 * Nothing here invents numbers: every figure comes from computeOrgFinancials (which carries bases and CalcTrees)
 * or from tenant rows, and every answer lists the items it was built from.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { can, type Role } from "@/lib/rbac";
import { num, fmtUSD, fmtPct, fmtHours } from "@/lib/utils";
import { computeOrgFinancials } from "./finance";
import { SCENARIOS, type ScenarioKey } from "./costing";

export type Basis = "observed" | "estimated" | "assumed";
export type CitationType = "financials" | "department" | "workflow" | "employee" | "opportunity" | "agent" | "measurement" | "collectors";
export type Citation = { type: CitationType; id: string; label: string; href: string };

export type EvidencePack = {
  org: { id: string; name: string; currency: string; isDemo: boolean };
  role: Role;
  includesCompensation: boolean;
  financials: {
    scenario: ScenarioKey; computedAt: string;
    employeesAnalyzed: number; totalAnnualLaborAnalyzed: number;
    hoursObservedPerWeek: number; repetitiveHoursPerWeek: number; repetitiveSharePct: number;
    hoursRecoverablePerWeek: number; grossAnnualSavings: number; realizableAnnualSavings: number;
    implementationCost: number; annualOperatingCost: number; platformAnnual: number; netAnnualSavings: number;
    roi1y: number; paybackMonths: number | null; threeYearNet: number; threeYearNpv: number;
    verifiedAnnualizedSavings: number; verifiedHoursSaved: number; verifiedDollarsSaved: number; verifiedMeasurements: number;
    automationCompletionPct: number; deploymentCompletionPct: number; deployedAgents: number; opportunityCount: number;
    assumptions: Record<string, number | undefined>;
    scenarios: { key: ScenarioKey; label: string; realizableAnnualSavings: number; netAnnualSavings: number; paybackMonths: number | null; implementationCost: number }[];
    basis: { projected: "estimated"; verified: "observed"; assumptions: "assumed" };
  };
  departments: { id: string | null; name: string; employees: number; laborAnnual?: number; hoursPerWeek: number; repetitiveHoursPerWeek: number; recoverableHoursPerWeek: number; grossAnnual: number; realizableAnnual: number; verifiedAnnual: number; efficiencyGainPct: number; opportunities: number }[];
  workflows: { id: string; name: string; departmentId: string | null; departmentName: string | null; hoursPerWeek: number; runsPerWeek: number; avgDurationMin: number; employeeCount: number; repetitionScore: number; automationScore: number; requiresJudgment: boolean; regulatoryFlag: string | null; isManual: boolean; basis: Basis; performers: { employeeId: string; name: string; hoursPerWeek: number }[]; observedFrom: string; observedTo: string; sampleSize: number }[];
  employees: { id: string; name: string; title: string | null; departmentName: string | null; hoursPerWeek: number; repetitiveHoursPerWeek: number; recoverableHoursPerWeek: number; workflows: { workflowId: string; name: string; hoursPerWeek: number }[]; baseAnnualCost?: number; loadedHourly?: number; laborAnnual?: number; costBasis?: Basis }[];
  opportunities: { id: string; title: string; type: string; status: string; rank: number; workflowId: string | null; workflowName: string | null; departmentName: string | null; feasibility: number; risk: number; hoursRecoverablePerWeek: number; grossAnnualSavings: number; realizableAnnualSavings: number; implementationCost: number; annualOperatingCost: number; netAnnualSavings: number; paybackMonths: number | null; roi1y: number; requiresHumanJudgment: boolean; regulatoryFlag: string | null; deployed: boolean; basis: Basis; summary: string }[];
  agents: { id: string; name: string; status: string; category: string; runtime: string; runs: { total: number; succeeded: number; failed: number; awaitingApproval: number }; lastRunAt: string | null; deployedAt: string | null }[];
  measurements: { id: string; agentId: string | null; agentName: string | null; workflowId: string | null; workflowName: string | null; periodStart: string; periodEnd: string; method: string; runs: number; hoursSaved: number; dollarsSaved: number; costIncurred: number; basis: Basis }[];
  collectors: { total: number; active: number; offline: number; pending: number; paused: number; revoked: number; lastSeenAt: string | null; items: { id: string; name: string; status: string; platform: string; lastSeenAt: string | null; eventsReceived: number }[] };
};

export type AssistantAnswer = {
  answer: string;
  citations: Citation[];
  mode: "llm" | "retrieval";
  basis: { scenario: ScenarioKey; computedAt: string; intent: string; evidence: Record<string, number>; note: string };
};

// ---------------------------------------------------------------------------------------------
// Evidence pack
// ---------------------------------------------------------------------------------------------

export async function buildEvidencePack(orgId: string, opts: { role: Role }): Promise<EvidencePack> {
  const includesCompensation = can(opts.role, "employees:cost:read");
  const fin = await computeOrgFinancials(orgId);
  const rows = await withTenant(orgId, async (tx) => {
    const [org] = await tx.select({ id: schema.organizations.id, name: schema.organizations.name, currency: schema.organizations.currency, isDemo: schema.organizations.isDemo }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
    if (!org) throw new Error("organization not found");
    const [departments, employees, workflows, links, opps, agents, runStats, measurements, collectors] = await Promise.all([
      tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, orgId)),
      tx.select({ id: schema.employees.id, displayName: schema.employees.displayName, title: schema.employees.title, departmentId: schema.employees.departmentId, baseAnnualCost: schema.employees.baseAnnualCost, costBasis: schema.employees.costBasis }).from(schema.employees).where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.isActive, true))),
      tx.select().from(schema.workflows).where(eq(schema.workflows.orgId, orgId)),
      tx.select().from(schema.workflowEmployees).where(eq(schema.workflowEmployees.orgId, orgId)),
      tx.select({ id: schema.opportunities.id, requiresHumanJudgment: schema.opportunities.requiresHumanJudgment, regulatoryFlag: schema.opportunities.regulatoryFlag, summary: schema.opportunities.summary }).from(schema.opportunities).where(eq(schema.opportunities.orgId, orgId)),
      tx.select().from(schema.agents).where(eq(schema.agents.orgId, orgId)),
      tx.select({ agentId: schema.agentRuns.agentId, status: schema.agentRuns.status, n: sql<number>`count(*)::int` }).from(schema.agentRuns).where(eq(schema.agentRuns.orgId, orgId)).groupBy(schema.agentRuns.agentId, schema.agentRuns.status),
      tx.select().from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId)).orderBy(desc(schema.savingsMeasurements.periodEnd)).limit(100),
      tx.select({ id: schema.collectors.id, name: schema.collectors.name, status: schema.collectors.status, platform: schema.collectors.platform, lastSeenAt: schema.collectors.lastSeenAt, eventsReceived: schema.collectors.eventsReceived }).from(schema.collectors).where(eq(schema.collectors.orgId, orgId)),
    ]);
    return { org, departments, employees, workflows, links, opps, agents, runStats, measurements, collectors };
  });

  const deptName = new Map(rows.departments.map((d) => [d.id, d.name]));
  const empById = new Map(rows.employees.map((e) => [e.id, e]));
  const wfById = new Map(rows.workflows.map((w) => [w.id, w]));
  const agentById = new Map(rows.agents.map((a) => [a.id, a]));
  const oppExtra = new Map(rows.opps.map((o) => [o.id, o]));
  const linksByWf = new Map<string, typeof rows.links>();
  for (const l of rows.links) { const arr = linksByWf.get(l.workflowId) ?? []; arr.push(l); linksByWf.set(l.workflowId, arr); }
  const finEmp = new Map(fin.byEmployee.map((e) => [e.employeeId, e]));

  const workflows: EvidencePack["workflows"] = rows.workflows.map((w) => ({
    id: w.id, name: w.name, departmentId: w.departmentId ?? null, departmentName: w.departmentId ? (deptName.get(w.departmentId) ?? null) : null,
    hoursPerWeek: num(w.hoursPerWeek), runsPerWeek: num(w.runsPerWeek), avgDurationMin: num(w.avgDurationMin), employeeCount: w.employeeCount,
    repetitionScore: num(w.repetitionScore), automationScore: num(w.automationScore), requiresJudgment: w.requiresJudgment, regulatoryFlag: w.regulatoryFlag ?? null, isManual: w.isManual, basis: w.basis,
    performers: (linksByWf.get(w.id) ?? []).map((l) => ({ employeeId: l.employeeId, name: empById.get(l.employeeId)?.displayName ?? "Unknown", hoursPerWeek: num(l.hoursPerWeek) })).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek),
    observedFrom: w.evidence?.observedFrom ?? "", observedTo: w.evidence?.observedTo ?? "", sampleSize: w.evidence?.sampleSize ?? 0,
  })).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek);

  const employees: EvidencePack["employees"] = rows.employees.map((e) => {
    const f = finEmp.get(e.id);
    const base = { id: e.id, name: e.displayName, title: e.title ?? null, departmentName: e.departmentId ? (deptName.get(e.departmentId) ?? null) : null, hoursPerWeek: f?.hoursPerWeek ?? 0, repetitiveHoursPerWeek: f?.repetitiveHoursPerWeek ?? 0, recoverableHoursPerWeek: f?.recoverableHoursPerWeek ?? 0, workflows: (f?.topWorkflows ?? []).map((w) => ({ workflowId: w.workflowId, name: w.name, hoursPerWeek: w.hoursPerWeek })) };
    if (!includesCompensation) return base;
    return { ...base, baseAnnualCost: num(e.baseAnnualCost), loadedHourly: f?.loadedHourly ?? 0, laborAnnual: f?.laborAnnual ?? 0, costBasis: e.costBasis };
  }).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek);

  const opportunities: EvidencePack["opportunities"] = fin.opportunities.map((o) => ({
    id: o.id, title: o.title, type: o.type, status: o.status, rank: o.rank, workflowId: o.workflowId, workflowName: o.workflowName, departmentName: o.departmentName, feasibility: o.feasibility, risk: o.risk,
    hoursRecoverablePerWeek: o.hoursRecoverablePerWeek, grossAnnualSavings: o.grossAnnualSavings, realizableAnnualSavings: o.realizableAnnualSavings, implementationCost: o.implementationCost, annualOperatingCost: o.annualOperatingCost, netAnnualSavings: o.netAnnualSavings, paybackMonths: o.paybackMonths, roi1y: o.roi1y,
    requiresHumanJudgment: oppExtra.get(o.id)?.requiresHumanJudgment ?? false, regulatoryFlag: oppExtra.get(o.id)?.regulatoryFlag ?? null, deployed: o.deployed, basis: o.basis, summary: oppExtra.get(o.id)?.summary ?? "",
  }));

  const runsByAgent = new Map<string, EvidencePack["agents"][number]["runs"]>();
  for (const r of rows.runStats) {
    const s = runsByAgent.get(r.agentId) ?? { total: 0, succeeded: 0, failed: 0, awaitingApproval: 0 };
    s.total += r.n; if (r.status === "succeeded") s.succeeded += r.n; if (r.status === "failed" || r.status === "rolled_back") s.failed += r.n; if (r.status === "awaiting_approval") s.awaitingApproval += r.n;
    runsByAgent.set(r.agentId, s);
  }
  const agents: EvidencePack["agents"] = rows.agents.map((a) => ({ id: a.id, name: a.name, status: a.status, category: a.category, runtime: a.runtime, runs: runsByAgent.get(a.id) ?? { total: 0, succeeded: 0, failed: 0, awaitingApproval: 0 }, lastRunAt: a.lastRunAt?.toISOString() ?? null, deployedAt: a.deployedAt?.toISOString() ?? null }));

  const measurements: EvidencePack["measurements"] = rows.measurements.map((m) => ({
    id: m.id, agentId: m.agentId ?? null, agentName: m.agentId ? (agentById.get(m.agentId)?.name ?? null) : null, workflowId: m.workflowId ?? null, workflowName: m.workflowId ? (wfById.get(m.workflowId)?.name ?? null) : null,
    periodStart: m.periodStart.toISOString().slice(0, 10), periodEnd: m.periodEnd.toISOString().slice(0, 10), method: m.method, runs: m.runs, hoursSaved: num(m.hoursSaved), dollarsSaved: num(m.dollarsSaved), costIncurred: num(m.costIncurred), basis: m.basis,
  }));

  const count = (s: string) => rows.collectors.filter((c) => c.status === s).length;
  const lastSeen = rows.collectors.map((c) => c.lastSeenAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const collectors: EvidencePack["collectors"] = {
    total: rows.collectors.length, active: count("active"), offline: count("offline"), pending: count("pending"), paused: count("paused"), revoked: count("revoked"), lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
    items: rows.collectors.map((c) => ({ id: c.id, name: c.name, status: c.status, platform: c.platform, lastSeenAt: c.lastSeenAt?.toISOString() ?? null, eventsReceived: c.eventsReceived })),
  };

  const departments: EvidencePack["departments"] = fin.byDepartment.map((d) => {
    const { laborAnnual, ...rest } = d;
    return includesCompensation ? { id: d.departmentId, laborAnnual, ...rest } : { id: d.departmentId, ...rest };
  });

  return {
    org: { id: rows.org.id, name: rows.org.name, currency: rows.org.currency, isDemo: rows.org.isDemo },
    role: opts.role, includesCompensation,
    financials: {
      scenario: fin.scenario, computedAt: fin.computedAt, employeesAnalyzed: fin.employeesAnalyzed, totalAnnualLaborAnalyzed: fin.totalAnnualLaborAnalyzed,
      hoursObservedPerWeek: fin.hoursObservedPerWeek, repetitiveHoursPerWeek: fin.repetitiveHoursPerWeek, repetitiveSharePct: fin.repetitiveSharePct,
      hoursRecoverablePerWeek: fin.hoursRecoverablePerWeek, grossAnnualSavings: fin.grossAnnualSavings, realizableAnnualSavings: fin.realizableAnnualSavings,
      implementationCost: fin.implementationCost, annualOperatingCost: fin.annualOperatingCost, platformAnnual: fin.platformAnnual, netAnnualSavings: fin.netAnnualSavings,
      roi1y: fin.roi1y, paybackMonths: fin.paybackMonths, threeYearNet: fin.threeYear.totalNet, threeYearNpv: fin.threeYear.npv,
      verifiedAnnualizedSavings: fin.verifiedAnnualizedSavings, verifiedHoursSaved: fin.verifiedHoursSaved, verifiedDollarsSaved: fin.verifiedDollarsSaved, verifiedMeasurements: fin.verifiedMeasurements,
      automationCompletionPct: fin.automationCompletionPct, deploymentCompletionPct: fin.deploymentCompletionPct, deployedAgents: fin.deployedAgents, opportunityCount: fin.opportunityCount,
      assumptions: { ...fin.assumptions },
      scenarios: (Object.keys(SCENARIOS) as ScenarioKey[]).map((k) => ({ key: k, label: fin.scenarios[k].label, realizableAnnualSavings: fin.scenarios[k].realizableAnnualSavings, netAnnualSavings: fin.scenarios[k].netAnnualSavings, paybackMonths: fin.scenarios[k].paybackMonths, implementationCost: fin.scenarios[k].implementationCost })),
      basis: { projected: "estimated", verified: "observed", assumptions: "assumed" },
    },
    departments, workflows, employees, opportunities, agents, measurements, collectors,
  };
}

// ---------------------------------------------------------------------------------------------
// Retrieval mode (deterministic, pure)
// ---------------------------------------------------------------------------------------------

const cite = {
  fin: (): Citation => ({ type: "financials", id: "financials", label: "Financial model (projected)", href: "/app/finance" }),
  dept: (d: EvidencePack["departments"][number]): Citation => ({ type: "department", id: d.id ?? "unassigned", label: d.name, href: d.id ? `/app/departments/${d.id}` : "/app/departments" }),
  wf: (w: { id: string; name: string }): Citation => ({ type: "workflow", id: w.id, label: w.name, href: `/app/workflows/${w.id}` }),
  emp: (e: { id: string; name: string }): Citation => ({ type: "employee", id: e.id, label: e.name, href: `/app/employees/${e.id}` }),
  opp: (o: { id: string; title: string }): Citation => ({ type: "opportunity", id: o.id, label: o.title, href: `/app/opportunities/${o.id}` }),
  agent: (a: { id: string; name: string }): Citation => ({ type: "agent", id: a.id, label: a.name, href: `/app/agents/${a.id}` }),
  meas: (m: EvidencePack["measurements"][number]): Citation => ({ type: "measurement", id: m.id, label: `${m.method} ${m.periodStart} → ${m.periodEnd}`, href: m.agentId ? `/app/agents/${m.agentId}` : "/app/finance" }),
  collectors: (): Citation => ({ type: "collectors", id: "collectors", label: "Collector health", href: "/app/collection" }),
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const has = (q: string, ...words: string[]) => words.some((w) => q.includes(w));
const months = (m: number | null) => (m == null ? "not reached (net savings are not positive)" : `${m.toFixed(1)} months`);
const hrs = (h: number) => fmtHours(h);

/** Tokens of the question that match a name (employee first name/last name, workflow words). */
function findEmployee(pack: EvidencePack, q: string) {
  const toks = q.split(" ");
  return pack.employees.find((e) => { const parts = norm(e.name).split(" "); return parts.some((p) => p.length > 2 && toks.includes(p)); }) ?? null;
}
const STOP = new Set(["the", "a", "an", "on", "in", "of", "for", "to", "do", "does", "how", "many", "much", "hours", "hour", "spend", "spends", "spent", "per", "week", "what", "is", "are", "which", "who", "time", "and", "with", "about", "it", "we", "our", "that", "this", "can", "you", "me", "tell", "show", "list"]);
/** Business synonyms → words that appear in discovered workflow names. */
const SYNONYMS: Record<string, string[]> = { invoice: ["bill", "invoice"], invoices: ["bill", "invoice"], invoicing: ["bill", "invoice"], bills: ["bill"], payables: ["bill"], tickets: ["ticket"], support: ["ticket"], orders: ["order"], scheduling: ["schedul"], appointments: ["schedul"], reports: ["report"], reporting: ["report"], contracts: ["contract"], onboarding: ["hr"], hiring: ["hr"], reconciliation: ["reconcile"], inventory: ["inventory"], campaigns: ["campaign"] };
function findWorkflow(pack: EvidencePack, q: string, exclude: string[] = []) {
  const toks = q.split(" ").filter((t) => t.length > 2 && !STOP.has(t) && !exclude.includes(t)).flatMap((t) => SYNONYMS[t] ?? [t]);
  let best: { w: EvidencePack["workflows"][number]; score: number } | null = null;
  for (const w of pack.workflows) {
    const words = norm(w.name).split(" ").filter((x) => x.length > 2);
    const score = toks.filter((t) => words.some((x) => x.startsWith(t) || t.startsWith(x))).length;
    if (score > 0 && (!best || score > best.score)) best = { w, score };
  }
  return best?.w ?? null;
}

export function answerFromEvidence(pack: EvidencePack, question: string): Omit<AssistantAnswer, "mode"> {
  const q = norm(question);
  const f = pack.financials;
  const base = (intent: string, answer: string, citations: Citation[], note = "Answered from stored evidence; projected figures are estimates, verified figures are measured.") => ({
    answer, citations: dedupe(citations), basis: { scenario: f.scenario, computedAt: f.computedAt, intent, evidence: { departments: pack.departments.length, workflows: pack.workflows.length, opportunities: pack.opportunities.length, agents: pack.agents.length, measurements: pack.measurements.length, collectors: pack.collectors.total }, note },
  });
  const empty = pack.workflows.length === 0 && pack.opportunities.length === 0;

  // 1. Specific person × workflow ("how many hours does Dana spend on invoices")
  const person = findEmployee(pack, q);
  if (person && has(q, "hour", "spend", "time", "work on", "does")) {
    const nameToks = norm(person.name).split(" ");
    const wf = findWorkflow(pack, q, nameToks);
    if (wf) {
      const link = wf.performers.find((p) => p.employeeId === person.id);
      if (!link) return base("employee_workflow", `I don't have evidence of ${person.name} performing "${wf.name}". The observed performers are ${wf.performers.map((p) => `${p.name} (${hrs(p.hoursPerWeek)}/wk)`).join(", ") || "none"}.`, [cite.emp(person), cite.wf(wf)]);
      return base("employee_workflow", `${person.name} spends about ${hrs(link.hoursPerWeek)} per week on "${wf.name}" (observed from collector activity, ${wf.sampleSize} sampled events${wf.observedFrom ? ` between ${wf.observedFrom.slice(0, 10)} and ${wf.observedTo.slice(0, 10)}` : ""}). The workflow takes ${hrs(wf.hoursPerWeek)}/wk across ${wf.performers.length} people in total.`, [cite.emp(person), cite.wf(wf)]);
    }
    const top = person.workflows.slice(0, 5);
    return base("employee_summary", `${person.name}${person.title ? ` (${person.title})` : ""} spends ${hrs(person.hoursPerWeek)} per week on discovered workflows, ${hrs(person.repetitiveHoursPerWeek)} of it repetitive (observed). ${top.length ? `Largest: ${top.map((w) => `${w.name} — ${hrs(w.hoursPerWeek)}/wk`).join("; ")}.` : "No workflow links were observed."} About ${hrs(person.recoverableHoursPerWeek)}/wk could be recovered by the modelled opportunities (estimated).`, [cite.emp(person), ...top.map((w) => cite.wf({ id: w.workflowId, name: w.name }))]);
  }

  // 2. Verified / measured
  if (has(q, "verified", "verify", "measured", "actually saved", "proven", "realized so far", "so far")) {
    if (!pack.measurements.length) return base("verified", `Nothing has been verified yet: there are no post-deployment savings measurements for ${pack.org.name}. Verified savings only appear after an agent is deployed and its run ledger or a before/after observation is recorded. The projected figure is ${fmtUSD(f.realizableAnnualSavings)} realizable per year (estimated), which stays separate from verified numbers.`, [cite.fin()]);
    const list = pack.measurements.slice(0, 5);
    return base("verified", `${f.verifiedMeasurements} measurement(s) have verified ${fmtUSD(f.verifiedDollarsSaved)} and ${hrs(f.verifiedHoursSaved)} saved (observed), which is ${fmtUSD(f.verifiedAnnualizedSavings)} annualized — ${fmtPct(f.automationCompletionPct)} of the ${fmtUSD(f.realizableAnnualSavings)} realizable projection. Latest: ${list.map((m) => `${m.agentName ?? m.workflowName ?? m.method} ${m.periodStart}→${m.periodEnd}: ${fmtUSD(m.dollarsSaved)} / ${hrs(m.hoursSaved)} (${m.method})`).join("; ")}.`, [cite.fin(), ...list.map(cite.meas)]);
  }

  // 3. Collector / data collection status
  if (has(q, "collector", "collection", "agents installed", "workstation", "data coming in", "health")) {
    const c = pack.collectors;
    if (!c.total) return base("collectors", "No collectors are enrolled yet. Enroll workstations under Data Collection to start observing workflows.", [cite.collectors()]);
    const stale = c.items.filter((i) => i.status === "active" && (!i.lastSeenAt || Date.now() - new Date(i.lastSeenAt).getTime() > 86_400_000));
    return base("collectors", `${c.active} of ${c.total} collectors are active${c.offline ? `, ${c.offline} offline` : ""}${c.pending ? `, ${c.pending} pending enrollment` : ""}${c.paused ? `, ${c.paused} paused` : ""}${c.revoked ? `, ${c.revoked} revoked` : ""}. Last heartbeat ${c.lastSeenAt ? new Date(c.lastSeenAt).toLocaleString("en-US") : "never"}.${stale.length ? ` ${stale.length} active collector(s) have not reported in 24h: ${stale.map((s) => s.name).join(", ")}.` : ""} Total events received: ${c.items.reduce((s, i) => s + i.eventsReceived, 0).toLocaleString("en-US")} (observed).`, [cite.collectors()]);
  }

  // 4. Human judgment / regulatory
  if (has(q, "judgment", "judgement", "human", "regulat", "hipaa", "sox", "pii", "risky", "should not automate", "shouldn t automate")) {
    const wfs = pack.workflows.filter((w) => w.requiresJudgment || w.regulatoryFlag);
    const opps = pack.opportunities.filter((o) => o.requiresHumanJudgment || o.regulatoryFlag);
    if (!wfs.length && !opps.length) return base("judgment", "None of the discovered workflows or opportunities are flagged as needing human judgment or carrying a regulatory flag.", [cite.fin()]);
    return base("judgment", `${wfs.length} workflow(s) need human judgment or carry a regulatory flag: ${wfs.map((w) => `${w.name} (${hrs(w.hoursPerWeek)}/wk${w.regulatoryFlag ? `, ${w.regulatoryFlag}` : ""}${w.requiresJudgment ? ", judgment" : ""})`).join("; ")}.${opps.length ? ` Opportunities flagged for a human in the loop: ${opps.map((o) => o.title).join("; ")}.` : ""} These should keep an approval step rather than run fully automatically.`, [...wfs.map(cite.wf), ...opps.map(cite.opp)]);
  }

  // 5. Department ranking
  if (has(q, "department", "team", "which group", "where is the most")) {
    if (!pack.departments.length) return base("department", "No departments have observed activity yet.", [cite.fin()]);
    const byRep = [...pack.departments].sort((a, b) => b.repetitiveHoursPerWeek - a.repetitiveHoursPerWeek);
    const bySave = [...pack.departments].sort((a, b) => b.realizableAnnual - a.realizableAnnual);
    const top = byRep[0]; const topSave = bySave[0];
    const wantsSavings = has(q, "save", "saving", "worth", "money", "dollar");
    const lead = wantsSavings ? topSave : top;
    return base("department", `${lead.name} ${wantsSavings ? `has the largest projected savings: ${fmtUSD(lead.realizableAnnual)} realizable per year (estimated) from ${lead.opportunities} opportunit${lead.opportunities === 1 ? "y" : "ies"}` : `spends the most time on repetitive work: ${hrs(lead.repetitiveHoursPerWeek)} of ${hrs(lead.hoursPerWeek)} observed per week across ${lead.employees} people (observed)`}. Modelled recoverable time is ${hrs(lead.recoverableHoursPerWeek)}/wk (${fmtPct(lead.efficiencyGainPct)} efficiency gain, estimated). Ranking by repetitive hours: ${byRep.slice(0, 5).map((d) => `${d.name} ${hrs(d.repetitiveHoursPerWeek)}`).join(", ")}.`, [cite.dept(lead), ...byRep.slice(0, 5).map(cite.dept)]);
  }

  // 6. Top / best opportunity
  if (has(q, "top opportunit", "best opportunit", "biggest opportunit", "first", "start with", "prioritize", "priority", "quick win", "opportunit")) {
    if (!pack.opportunities.length) return base("top_opportunity", "No opportunities have been identified yet. Run an analysis after an observation campaign completes.", [cite.fin()]);
    const o = pack.opportunities[0];
    const wf = o.workflowId ? pack.workflows.find((w) => w.id === o.workflowId) : null;
    const next = pack.opportunities.slice(1, 4);
    return base("top_opportunity", `The top opportunity is "${o.title}" (${o.type.replace(/_/g, " ")}${o.departmentName ? `, ${o.departmentName}` : ""}): ${hrs(o.hoursRecoverablePerWeek)}/wk recoverable, ${fmtUSD(o.realizableAnnualSavings)} realizable per year (estimated) for ${fmtUSD(o.implementationCost)} one-time and ${fmtUSD(o.annualOperatingCost)}/yr to run, payback ${months(o.paybackMonths)}. Feasibility ${o.feasibility.toFixed(0)}/100, risk ${o.risk.toFixed(0)}/100${o.requiresHumanJudgment ? ", needs a human approval step" : ""}.${wf ? ` It targets "${wf.name}" (${hrs(wf.hoursPerWeek)}/wk observed across ${wf.performers.length} people).` : ""}${next.length ? ` Next: ${next.map((n) => `${n.title} (${fmtUSD(n.realizableAnnualSavings)}/yr)`).join("; ")}.` : ""}`, [cite.opp(o), ...(wf ? [cite.wf(wf)] : []), ...next.map(cite.opp)]);
  }

  // 7. Payback / ROI / cost
  if (has(q, "payback", "pay back", "roi", "return on", "break even", "breakeven", "cost to implement", "implementation cost", "how much will it cost", "investment")) {
    return base("payback", `Under the ${SCENARIOS[f.scenario].label} scenario, implementing all ${f.opportunityCount} opportunities costs ${fmtUSD(f.implementationCost)} one-time plus ${fmtUSD(f.annualOperatingCost)}/yr operating and ${fmtUSD(f.assumptions.platformFeeMonthly ?? 0)}/mo platform fee. Net annual savings are ${fmtUSD(f.netAnnualSavings)}, first-year ROI ${fmtPct(f.roi1y)}, payback ${months(f.paybackMonths)}, three-year net ${fmtUSD(f.threeYearNet)} (NPV ${fmtUSD(f.threeYearNpv)} at ${fmtPct(f.assumptions.discountRate ?? 0)}). All of these are estimates built on assumed adoption (${fmtPct(f.assumptions.adoptionRate ?? 0)}) and realization (${fmtPct(f.assumptions.realizationRate ?? 0)}) rates. Scenarios: ${f.scenarios.map((s) => `${s.label} payback ${months(s.paybackMonths)}`).join(", ")}.`, [cite.fin(), ...pack.opportunities.slice(0, 3).map(cite.opp)]);
  }

  // 8. Agents
  if (has(q, "agent", "automation running", "deployed", "bots")) {
    if (!pack.agents.length) return base("agents", "No AI agents have been created yet. Approve an opportunity and build an agent from its template to start.", [cite.fin()]);
    const list = pack.agents.slice(0, 8);
    return base("agents", `${pack.agents.length} agent(s): ${f.deployedAgents} deployed. ${list.map((a) => `${a.name} — ${a.status}, ${a.runs.succeeded}/${a.runs.total} runs succeeded${a.runs.awaitingApproval ? `, ${a.runs.awaitingApproval} awaiting approval` : ""}`).join("; ")}. Verified savings from their run ledgers total ${fmtUSD(f.verifiedAnnualizedSavings)} annualized (observed).`, list.map(cite.agent));
  }

  // 9. Savings ("what would we save")
  if (has(q, "save", "saving", "worth", "money", "dollar", "recover", "how much", "value", "benefit")) {
    if (empty) return base("savings", "There is no observed workflow data yet, so I can't estimate savings. Enroll collectors and run an analysis first.", [cite.fin()]);
    const top = pack.opportunities.slice(0, 3);
    return base("savings", `Projected (${SCENARIOS[f.scenario].label} scenario): ${f.opportunityCount} opportunities could recover ${hrs(f.hoursRecoverablePerWeek)} per week, worth ${fmtUSD(f.grossAnnualSavings)} gross and ${fmtUSD(f.realizableAnnualSavings)} realizable per year (estimated — time saved is not the same as payroll cut; only ${fmtPct(f.assumptions.realizationRate ?? 0)} is counted as realizable). After ${fmtUSD(f.annualOperatingCost)}/yr operating cost and the platform fee, net annual savings are ${fmtUSD(f.netAnnualSavings)}. Verified so far: ${fmtUSD(f.verifiedAnnualizedSavings)} annualized from ${f.verifiedMeasurements} measurement(s) (observed). Range across scenarios: ${f.scenarios.map((s) => `${s.label} ${fmtUSD(s.realizableAnnualSavings)}`).join(", ")}.${top.length ? ` Largest contributors: ${top.map((o) => `${o.title} (${fmtUSD(o.realizableAnnualSavings)})`).join("; ")}.` : ""}`, [cite.fin(), ...top.map(cite.opp)]);
  }

  // 10. Workflow lookup ("tell me about sales order", "how long does ticket reply take")
  const wf = findWorkflow(pack, q);
  if (wf && has(q, "workflow", "process", "take", "long", "often", "run", "who", "about", "repetitive", "manual", "step")) {
    const opps = pack.opportunities.filter((o) => o.workflowId === wf.id);
    return base("workflow", `"${wf.name}"${wf.departmentName ? ` (${wf.departmentName})` : ""} takes ${hrs(wf.hoursPerWeek)} per week: about ${wf.runsPerWeek.toFixed(0)} runs/wk at ${wf.avgDurationMin.toFixed(1)} min each, performed by ${wf.performers.map((p) => `${p.name} (${hrs(p.hoursPerWeek)})`).join(", ") || `${wf.employeeCount} people`}. Repetition score ${wf.repetitionScore.toFixed(0)}/100, automation score ${wf.automationScore.toFixed(0)}/100 (observed from ${wf.sampleSize} sampled events).${wf.requiresJudgment ? " It needs human judgment." : ""}${wf.regulatoryFlag ? ` Regulatory flag: ${wf.regulatoryFlag}.` : ""}${opps.length ? ` Opportunities: ${opps.map((o) => `${o.title} — ${fmtUSD(o.realizableAnnualSavings)}/yr realizable (estimated)`).join("; ")}.` : " No opportunity has been modelled for it yet."}`, [cite.wf(wf), ...wf.performers.map((p) => cite.emp({ id: p.employeeId, name: p.name })), ...opps.map(cite.opp)]);
  }

  // 11. Repetitive / overview
  if (has(q, "repetitive", "overview", "summary", "summarize", "waste", "wasting", "busywork", "manual")) {
    const topW = pack.workflows.filter((w) => w.repetitionScore >= 50).slice(0, 5);
    return base("overview", `${f.employeesAnalyzed} employees were analyzed. ${hrs(f.repetitiveHoursPerWeek)} of ${hrs(f.hoursObservedPerWeek)} observed per week (${fmtPct(f.repetitiveSharePct)}) go to repetitive workflows (observed). The most repetitive: ${topW.map((w) => `${w.name} — ${hrs(w.hoursPerWeek)}/wk, repetition ${w.repetitionScore.toFixed(0)}/100`).join("; ") || "none yet"}. Modelled opportunities could recover ${hrs(f.hoursRecoverablePerWeek)}/wk, ${fmtUSD(f.realizableAnnualSavings)} realizable per year (estimated).`, [cite.fin(), ...topW.map(cite.wf)]);
  }

  return base("unknown", `I don't have evidence for that. I can answer from ${pack.org.name}'s observed workflows, people, opportunities, agents, verified measurements, collector health and the financial model — for example "Which department wastes the most time?", "What would we save?", "What has been verified?", "Which workflows need human judgment?", "What is the status of the collectors?", "What is the top opportunity?" or "What is the payback?".`, [], "No matching evidence; nothing was inferred.");
}

function dedupe(cs: Citation[]): Citation[] { const seen = new Set<string>(); return cs.filter((c) => { const k = `${c.type}:${c.id}`; if (seen.has(k)) return false; seen.add(k); return true; }); }

// ---------------------------------------------------------------------------------------------
// LLM mode (Anthropic Messages API)
// ---------------------------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are "Ask BridgeBox", an analyst for a workforce-intelligence product. You will receive an EVIDENCE JSON document describing one organization: its financial model, departments, workflows, employees, automation opportunities, agents, verified savings measurements and collector health.
Rules:
1. Answer ONLY from the evidence JSON. If the evidence does not contain what is needed, say exactly "I don't have evidence for that." and suggest what data would be needed. Never invent, extrapolate or estimate numbers that are not in the evidence.
2. Label every number as observed, estimated or assumed, matching the evidence (projected savings are estimated; measurements are observed; assumptions are assumed). Keep projected and verified figures separate; never add them together.
3. Cite the evidence items you used by writing their type and id in square brackets inline or at the end, e.g. [workflow:ID], [opportunity:ID], [department:ID], [employee:ID], [agent:ID], [measurement:ID], [financials], [collectors]. Cite every item whose numbers you quote.
4. Plain English for a business owner, 2-6 sentences, no markdown headings. Time saved is not the same as payroll cut; say so when relevant.
5. The evidence excludes per-employee pay when the asker's role may not see it; never guess compensation.`;

type AnthropicResponse = { content?: { type: string; text?: string }[]; error?: { message?: string } };

async function askAnthropic(pack: EvidencePack, question: string): Promise<{ text: string } | { error: string }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: "ANTHROPIC_API_KEY not configured" };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, system: SYSTEM_PROMPT, messages: [{ role: "user", content: `EVIDENCE JSON:\n${JSON.stringify(pack)}\n\nQUESTION: ${question}` }] }),
    });
    const body = (await res.json().catch(() => ({}))) as AnthropicResponse;
    if (!res.ok) return { error: `Anthropic API HTTP ${res.status}: ${body.error?.message ?? "unknown error"}` };
    const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
    return text ? { text } : { error: "Anthropic API returned no text" };
  } catch (e) { return { error: `Anthropic API unreachable: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** Map [type:id] references in model output to real citations; unknown ids are dropped (never invented). */
export function extractCitations(pack: EvidencePack, text: string): { citations: Citation[]; clean: string } {
  const citations: Citation[] = [];
  const re = /\[(financials|collectors|workflow|opportunity|department|employee|agent|measurement)(?::([^\]\s]+))?\]/gi;
  for (const m of text.matchAll(re)) {
    const type = m[1].toLowerCase(); const id = m[2];
    if (type === "financials") citations.push(cite.fin());
    else if (type === "collectors") citations.push(cite.collectors());
    else if (type === "workflow") { const w = pack.workflows.find((x) => x.id === id); if (w) citations.push(cite.wf(w)); }
    else if (type === "opportunity") { const o = pack.opportunities.find((x) => x.id === id); if (o) citations.push(cite.opp(o)); }
    else if (type === "department") { const d = pack.departments.find((x) => (x.id ?? "unassigned") === id); if (d) citations.push(cite.dept(d)); }
    else if (type === "employee") { const e = pack.employees.find((x) => x.id === id); if (e) citations.push(cite.emp(e)); }
    else if (type === "agent") { const a = pack.agents.find((x) => x.id === id); if (a) citations.push(cite.agent(a)); }
    else if (type === "measurement") { const mm = pack.measurements.find((x) => x.id === id); if (mm) citations.push(cite.meas(mm)); }
  }
  const clean = text.replace(re, "").replace(/[ \t]+([.,;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
  return { citations: dedupe(citations), clean };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export async function answerQuestion(orgId: string, question: string, opts: { userId: string; role: Role }): Promise<AssistantAnswer> {
  const trimmed = question.trim().slice(0, 1000);
  const pack = await buildEvidencePack(orgId, { role: opts.role });
  const retrieval = answerFromEvidence(pack, trimmed);
  let result: AssistantAnswer = { ...retrieval, mode: "retrieval" };
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await askAnthropic(pack, trimmed);
    if ("text" in r) {
      const { citations, clean } = extractCitations(pack, r.text);
      result = { answer: clean, citations, mode: "llm", basis: { ...retrieval.basis, intent: "llm", note: "AI-generated from the evidence pack only; every cited item exists in your data." } };
    } else {
      result = { ...retrieval, mode: "retrieval", basis: { ...retrieval.basis, note: `${retrieval.basis.note} (AI model unavailable: ${r.error})` } };
    }
  }
  // No PII: never log the question text, only its shape.
  await audit({ orgId, actorUserId: opts.userId, action: "assistant.question", entityType: "assistant", details: { mode: result.mode, intent: result.basis.intent, questionLength: trimmed.length, citations: result.citations.length, role: opts.role } });
  return result;
}
