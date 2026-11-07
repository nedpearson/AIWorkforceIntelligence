/**
 * Recommendations — which AI employee fits each identified/approved opportunity ("MEET CHARLOTTE" cards).
 * Persona match: personaForOpportunity(recommendedAgentCategory + apps seen in the workflow's steps).
 * Money comes from the finance engine's opportunity line (realizable, estimated); hours from observed workflows.
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import type { CalcTree } from "@/db/schema";
import { computeOrgFinancials } from "@/engine/finance";
import type { OrgFinancials } from "@/engine/finance.types";
import { fmtUSD, fmtNum, num } from "@/lib/utils";
import { personaForOpportunity, type Persona } from "./personas";

export type Recommendation = {
  opportunityId: string; opportunityTitle: string; status: string; type: string;
  workflowId: string | null; workflowName: string | null; workflowLabel: string; departmentId: string | null; departmentName: string | null; apps: string[];
  persona: Pick<Persona, "key" | "firstName" | "title" | "team" | "portrait" | "demoSkill" | "skills">;
  observedHoursPerWeek: number; runsPerWeek: number; avgDurationMin: number; automationPct: number;
  hoursRecoverablePerWeek: number; realizableAnnualSavings: number; grossAnnualSavings: number; annualOperatingCost: number; netAnnualSavings: number; loadedHourly: number;
  basis: "estimated"; tree: CalcTree; quote: string;
  existing: { id: string; status: string; firstName: string } | null;
};

/** "Bill entry (Outlook → Adobe Acrobat → QuickBooks → Excel)" → "bill entry" */
export const workflowLabel = (name: string | null | undefined) => (name ?? "this workflow").replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase() || "this workflow";

export function buildQuote(r: { firstName: string; observedHoursPerWeek: number; workflowLabel: string; hoursRecoverablePerWeek: number; realizableAnnualSavings: number; employees: number }) {
  const team = r.employees > 1 ? `Your team of ${r.employees}` : r.employees === 1 ? "One person on your team" : "Your team";
  return `I'm ${r.firstName}, an AI agent. ${team} spends ~${fmtNum(r.observedHoursPerWeek, 1)} hours/week on ${r.workflowLabel}. I could take over about ${fmtNum(r.hoursRecoverablePerWeek, 1)} hours/week of it — roughly ${fmtUSD(r.realizableAnnualSavings)} a year in recovered capacity (estimated).`;
}

export async function recommendations(orgId: string, deps: { fin?: OrgFinancials } = {}): Promise<Recommendation[]> {
  const fin = deps.fin ?? (await computeOrgFinancials(orgId));
  const d = await withTenant(orgId, async (tx) => {
    const opps = await tx.select({ o: schema.opportunities, w: schema.workflows, dept: schema.departments.name }).from(schema.opportunities)
      .leftJoin(schema.workflows, eq(schema.workflows.id, schema.opportunities.workflowId))
      .leftJoin(schema.departments, eq(schema.departments.id, schema.opportunities.departmentId))
      .where(and(eq(schema.opportunities.orgId, orgId), inArray(schema.opportunities.status, ["identified", "approved"])));
    const emps = await tx.select({ id: schema.aiEmployees.id, personaKey: schema.aiEmployees.personaKey, status: schema.aiEmployees.status, firstName: schema.aiEmployees.firstName }).from(schema.aiEmployees).where(eq(schema.aiEmployees.orgId, orgId));
    return { opps, emps };
  });
  const out: Recommendation[] = [];
  for (const { o, w, dept } of d.opps) {
    const apps = [...new Set((w?.steps ?? []).map((s) => s.app))];
    const p = personaForOpportunity({ recommendedAgentCategory: o.recommendedAgentCategory, apps });
    if (!p) continue;
    const line = fin.opportunities.find((l) => l.id === o.id);
    const realizable = line?.realizableAnnualSavings ?? num(o.realizableAnnualSavings);
    const hoursRec = line?.hoursRecoverablePerWeek ?? num(o.hoursRecoverablePerWeek);
    const perf = w ? fin.byEmployee.filter((e) => e.topWorkflows.some((t) => t.workflowId === w.id)) : [];
    const hw = perf.reduce((s, e) => s + e.hoursPerWeek, 0);
    const loadedHourly = hw > 0 ? perf.reduce((s, e) => s + e.loadedHourly * e.hoursPerWeek, 0) / hw : 0;
    const label = workflowLabel(w?.name ?? o.title);
    const existing = d.emps.find((e) => e.personaKey === p.key);
    const observed = num(w?.hoursPerWeek);
    out.push({
      opportunityId: o.id, opportunityTitle: o.title, status: o.status, type: o.type, workflowId: w?.id ?? null, workflowName: w?.name ?? null, workflowLabel: label,
      departmentId: o.departmentId, departmentName: dept ?? null, apps,
      persona: { key: p.key, firstName: p.firstName, title: p.title, team: p.team, portrait: p.portrait, demoSkill: p.demoSkill, skills: p.skills },
      observedHoursPerWeek: observed, runsPerWeek: num(w?.runsPerWeek), avgDurationMin: num(w?.avgDurationMin), automationPct: line?.automationPct ?? num(o.automationPct),
      hoursRecoverablePerWeek: hoursRec, realizableAnnualSavings: realizable, grossAnnualSavings: line?.grossAnnualSavings ?? num(o.grossAnnualSavings),
      annualOperatingCost: line?.annualOperatingCost ?? num(o.annualOperatingCost), netAnnualSavings: line?.netAnnualSavings ?? realizable - num(o.annualOperatingCost), loadedHourly,
      basis: "estimated", tree: line?.tree ?? o.calculation,
      quote: buildQuote({ firstName: p.firstName, observedHoursPerWeek: observed, workflowLabel: label, hoursRecoverablePerWeek: hoursRec, realizableAnnualSavings: realizable, employees: w?.employeeCount ?? perf.length }),
      existing: existing ? { id: existing.id, status: existing.status, firstName: existing.firstName } : null,
    });
  }
  return out.sort((a, b) => b.realizableAnnualSavings - a.realizableAnnualSavings);
}

/**
 * Savings calculator (pure): manual vs automated hours for a workflow at a given adoption share.
 * annual $ = recoverable hours/week × adoption × weeks/year × loaded hourly. Mirrors the finance engine line at adoption 1.
 */
export function savingsAtAdoption(r: Pick<Recommendation, "observedHoursPerWeek" | "hoursRecoverablePerWeek" | "realizableAnnualSavings">, adoption: number) {
  const a = Math.max(0, Math.min(1, adoption));
  const automatedHoursPerWeek = Math.max(0, r.observedHoursPerWeek - r.hoursRecoverablePerWeek * a);
  return { manualHoursPerWeek: r.observedHoursPerWeek, automatedHoursPerWeek, hoursSavedPerWeek: r.hoursRecoverablePerWeek * a, annualValue: r.realizableAnnualSavings * a };
}
