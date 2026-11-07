import { notFound } from "next/navigation";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { num } from "@/lib/utils";
import { analyzeOpportunities, sampleEvidenceEvents } from "@/engine/opportunity-score";
import { getTemplate } from "@/engine/agents/templates";
import { OpportunityReport, type ReportData } from "./opportunity-report";

export const metadata = { title: "Opportunity report" };
export const dynamic = "force-dynamic";

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("opportunities:read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const a = await analyzeOpportunities(ctx.orgId);
  const o = a.all.find((x) => x.id === id);
  if (!o) notFound();
  const [raw, events] = await Promise.all([
    withTenant(ctx.orgId, async (tx) => {
      const [opp] = await tx.select({ calculation: schema.opportunities.calculation, realizable: schema.opportunities.realizableAnnualSavings, createdAt: schema.opportunities.createdAt, updatedAt: schema.opportunities.updatedAt }).from(schema.opportunities).where(and(eq(schema.opportunities.id, id), eq(schema.opportunities.orgId, ctx.orgId))).limit(1);
      const [wf] = o.workflowId ? await tx.select({ id: schema.workflows.id, name: schema.workflows.name, processMap: schema.workflows.processMap, steps: schema.workflows.steps, runsPerWeek: schema.workflows.runsPerWeek, avgDurationMin: schema.workflows.avgDurationMin, hoursPerWeek: schema.workflows.hoursPerWeek, repetitionScore: schema.workflows.repetitionScore, automationScore: schema.workflows.automationScore, reworkRate: schema.workflows.reworkRate, handoffCount: schema.workflows.handoffCount }).from(schema.workflows).where(and(eq(schema.workflows.id, o.workflowId), eq(schema.workflows.orgId, ctx.orgId))).limit(1) : [];
      const performers = o.workflowId ? await tx.select({ id: schema.employees.id, name: schema.employees.displayName, title: schema.employees.title, hoursPerWeek: schema.workflowEmployees.hoursPerWeek }).from(schema.workflowEmployees).innerJoin(schema.employees, eq(schema.employees.id, schema.workflowEmployees.employeeId)).where(and(eq(schema.workflowEmployees.orgId, ctx.orgId), eq(schema.workflowEmployees.workflowId, o.workflowId))) : [];
      const agents = await tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, deployedAt: schema.agents.deployedAt, templateKey: schema.agents.templateKey }).from(schema.agents).where(and(eq(schema.agents.orgId, ctx.orgId), eq(schema.agents.opportunityId, id)));
      const measurements = agents.length ? await tx.select({ id: schema.savingsMeasurements.id, periodStart: schema.savingsMeasurements.periodStart, periodEnd: schema.savingsMeasurements.periodEnd, hoursSaved: schema.savingsMeasurements.hoursSaved, dollarsSaved: schema.savingsMeasurements.dollarsSaved, method: schema.savingsMeasurements.method, basis: schema.savingsMeasurements.basis }).from(schema.savingsMeasurements).where(and(eq(schema.savingsMeasurements.orgId, ctx.orgId), inArray(schema.savingsMeasurements.agentId, agents.map((x) => x.id)))) : [];
      const decisions = await tx.select({ id: schema.opportunityDecisions.id, decision: schema.opportunityDecisions.decision, note: schema.opportunityDecisions.note, decidedBy: schema.opportunityDecisions.decidedBy, createdAt: schema.opportunityDecisions.createdAt }).from(schema.opportunityDecisions).where(and(eq(schema.opportunityDecisions.orgId, ctx.orgId), eq(schema.opportunityDecisions.opportunityId, id))).orderBy(desc(schema.opportunityDecisions.createdAt)).limit(50);
      const users = decisions.length ? await tx.select({ id: schema.users.id, email: schema.users.email }).from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(eq(schema.memberships.orgId, ctx.orgId)) : [];
      const ledger = await tx.select({ id: schema.savingsLedger.id, status: schema.savingsLedger.status, amount: schema.savingsLedger.annualAmount, createdAt: schema.savingsLedger.createdAt }).from(schema.savingsLedger).where(and(eq(schema.savingsLedger.orgId, ctx.orgId), eq(schema.savingsLedger.tier, "approved"), eq(schema.savingsLedger.opportunityId, id))).orderBy(desc(schema.savingsLedger.createdAt)).limit(5);
      const projects = await tx.select({ id: schema.projects.id, name: schema.projects.name, status: schema.projects.status }).from(schema.projects).where(and(eq(schema.projects.orgId, ctx.orgId), sql`${schema.projects.opportunityIds} @> ${JSON.stringify([id])}::jsonb`));
      return { opp, wf: wf ?? null, performers, agents, measurements, decisions, users, ledger, projects };
    }),
    sampleEvidenceEvents(ctx.orgId, o.evidence.eventIds, 8),
  ]);
  const email = new Map(raw.users.map((u) => [u.id, u.email]));
  const tpl = getTemplate(o.answers.recommendedSolution.key);
  const data: ReportData = {
    a: o, splits: a.splits, totalRanked: a.all.filter((x) => x.inScope).length,
    storedCalculation: raw.opp?.calculation ?? o.line.tree, liveDiffers: o.inScope && Math.abs(o.line.realizableAnnualSavings - num(raw.opp?.realizable)) > 1,
    createdAt: raw.opp?.createdAt.toISOString() ?? "", updatedAt: raw.opp?.updatedAt.toISOString() ?? "",
    workflow: raw.wf ? { id: raw.wf.id, name: raw.wf.name, processMap: raw.wf.processMap ?? null, steps: raw.wf.steps ?? [], runsPerWeek: num(raw.wf.runsPerWeek), avgDurationMin: num(raw.wf.avgDurationMin), hoursPerWeek: num(raw.wf.hoursPerWeek), repetitionScore: num(raw.wf.repetitionScore), automationScore: num(raw.wf.automationScore), reworkRate: num(raw.wf.reworkRate), handoffs: raw.wf.handoffCount ?? 0 } : null,
    performers: raw.performers.map((p) => ({ id: p.id, name: p.name, title: p.title, hoursPerWeek: num(p.hoursPerWeek) })).sort((x, y) => y.hoursPerWeek - x.hoursPerWeek),
    agents: raw.agents.map((x) => ({ id: x.id, name: x.name, status: x.status, deployedAt: x.deployedAt?.toISOString() ?? null, templateKey: x.templateKey })),
    measurements: raw.measurements.map((m) => ({ id: m.id, periodStart: m.periodStart.toISOString(), periodEnd: m.periodEnd.toISOString(), hoursSaved: num(m.hoursSaved), dollarsSaved: num(m.dollarsSaved), method: m.method, basis: m.basis })),
    decisions: raw.decisions.map((d) => ({ id: d.id, decision: d.decision, note: d.note, by: d.decidedBy ? (email.get(d.decidedBy) ?? "former member") : "system", at: d.createdAt.toISOString() })),
    ledger: raw.ledger.map((l) => ({ id: l.id, status: l.status, amount: num(l.amount), at: l.createdAt.toISOString() })),
    projects: raw.projects,
    events: events.map((e) => ({ id: e.id, ts: e.ts.toISOString(), type: e.type, app: e.app, titleCategory: e.titleCategory, durationMs: e.durationMs })),
    approvalMode: tpl?.definition.nodes.some((n) => n.type === "approval") ? "Human approval step built in" : "No approval step in template — add one for sensitive actions",
    canWrite: can(ctx.role, "opportunities:write"), canFinance: can(ctx.role, "finance:write"), canAutomate: can(ctx.role, "agents:write"),
  };
  return <OpportunityReport data={data} />;
}
