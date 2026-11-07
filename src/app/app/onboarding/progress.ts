/**
 * Live rollout state for one tenant — drives the Executive "Next actions" card and the /app/onboarding checklist.
 * Loaded inside withTenant; returns plain JSON.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { num } from "@/lib/utils";

export type Progress = {
  authorizationSigned: boolean;
  noticePublished: boolean; // at least one consent record issued
  consentsAcknowledged: number;
  employeesTotal: number;
  collectorsActive: number;
  collectorsTotal: number;
  lastEventAt: string | null;
  events24h: number;
  campaign: { name: string; status: string } | null;
  campaignCompleted: boolean;
  analysisRun: boolean;
  lastAnalysisAt: string | null;
  workflows: number;
  opportunities: number;
  opportunitiesApproved: number; // approved | in_progress | deployed | verified
  agents: number;
  agentsDeployed: number;
  measurements: number;
  reports: number;
};

export async function loadProgress(orgId: string): Promise<Progress> {
  return withTenant(orgId, async (tx) => {
    const o = (col: AnyPgColumn) => eq(col, orgId);
    const count = async (q: Promise<{ n: string | number }[]>) => num((await q)[0]?.n);
    const [authN, consentIssued, consentAck, empN, collectors, lastCollector, ev24, campaign, analysis, wfN, oppN, oppApproved, agentN, agentDeployed, measN, reportN] = await Promise.all([
      count(tx.select({ n: sql<string>`count(*)` }).from(schema.authorizations).where(o(schema.authorizations.orgId))),
      count(tx.select({ n: sql<string>`count(*)` }).from(schema.consentRecords).where(o(schema.consentRecords.orgId))),
      count(tx.select({ n: sql<string>`count(distinct ${schema.consentRecords.employeeId})` }).from(schema.consentRecords).where(and(o(schema.consentRecords.orgId), sql`${schema.consentRecords.acknowledgedAt} is not null`, sql`${schema.consentRecords.withdrawnAt} is null`))),
      count(tx.select({ n: sql<string>`count(*)` }).from(schema.employees).where(and(o(schema.employees.orgId), eq(schema.employees.isActive, true)))),
      tx.select({ status: schema.collectors.status, n: sql<string>`count(*)` }).from(schema.collectors).where(o(schema.collectors.orgId)).groupBy(schema.collectors.status),
      tx.select({ last: sql<string | null>`max(${schema.collectors.lastEventAt})` }).from(schema.collectors).where(o(schema.collectors.orgId)),
      count(tx.select({ n: sql<string>`count(*)` }).from(schema.activityEvents).where(and(eq(schema.activityEvents.orgId, orgId), sql`${schema.activityEvents.receivedAt} > now() - interval '24 hours'`))),
      tx.select({ name: schema.observationCampaigns.name, status: schema.observationCampaigns.status }).from(schema.observationCampaigns).where(o(schema.observationCampaigns.orgId)).orderBy(desc(schema.observationCampaigns.updatedAt)).limit(1),
      tx.select({ finishedAt: schema.analysisRuns.finishedAt }).from(schema.analysisRuns).where(and(o(schema.analysisRuns.orgId), eq(schema.analysisRuns.status, "done"))).orderBy(desc(schema.analysisRuns.createdAt)).limit(1),
      count(tx.select({ n: sql<string>`count(*)` }).from(schema.workflows).where(o(schema.workflows.orgId))),
      count(tx.select({ n: sql<string>`count(*)` }).from(schema.opportunities).where(and(o(schema.opportunities.orgId), sql`${schema.opportunities.status} <> 'rejected'`))),
      count(tx.select({ n: sql<string>`count(*)` }).from(schema.opportunities).where(and(o(schema.opportunities.orgId), inArray(schema.opportunities.status, ["approved", "in_progress", "deployed", "verified"])))),
      count(tx.select({ n: sql<string>`count(*)` }).from(schema.agents).where(o(schema.agents.orgId))),
      count(tx.select({ n: sql<string>`count(*)` }).from(schema.agents).where(and(o(schema.agents.orgId), eq(schema.agents.status, "deployed")))),
      count(tx.select({ n: sql<string>`count(*)` }).from(schema.savingsMeasurements).where(o(schema.savingsMeasurements.orgId))),
      count(tx.select({ n: sql<string>`count(*)` }).from(schema.reports).where(o(schema.reports.orgId))),
    ]);
    const cActive = num(collectors.find((c) => c.status === "active")?.n);
    const cTotal = collectors.reduce((s, c) => s + num(c.n), 0);
    const camp = campaign[0] ?? null;
    return {
      authorizationSigned: authN > 0, noticePublished: consentIssued > 0, consentsAcknowledged: consentAck, employeesTotal: empN,
      collectorsActive: cActive, collectorsTotal: cTotal, lastEventAt: lastCollector[0]?.last ? new Date(lastCollector[0].last).toISOString() : null, events24h: ev24,
      campaign: camp, campaignCompleted: camp?.status === "completed" || camp?.status === "archived",
      analysisRun: analysis.length > 0, lastAnalysisAt: analysis[0]?.finishedAt?.toISOString() ?? null,
      workflows: wfN, opportunities: oppN, opportunitiesApproved: oppApproved, agents: agentN, agentsDeployed: agentDeployed, measurements: measN, reports: reportN,
    };
  });
}

export type Step = { key: string; title: string; body: string; done: boolean; href: string; cta: string; perm?: string };

/** Ordered rollout checklist derived from Progress. Used by both the onboarding page and the next-actions card. */
export function checklist(p: Progress): Step[] {
  return [
    { key: "authorization", title: "Sign the monitoring authorization", body: "An owner or officer confirms the organization has the right to observe work activity (metadata only, never content).", done: p.authorizationSigned, href: "/app/collection?tab=authorization", cta: "Go to Authorization", perm: "collectors:manage" },
    { key: "notice", title: "Publish the employee notice", body: `Every monitored person sees what is collected and acknowledges it. ${p.consentsAcknowledged} of ${p.employeesTotal} acknowledged so far.`, done: p.noticePublished && p.consentsAcknowledged > 0, href: "/app/collection?tab=consent", cta: "Go to Notice & consent", perm: "collectors:manage" },
    { key: "collectors", title: "Enroll collectors", body: `Install the collector on the computers you want to observe. ${p.collectorsActive} of ${p.collectorsTotal} active.`, done: p.collectorsActive > 0, href: "/app/collection?tab=collectors", cta: "Go to Collectors", perm: "collectors:manage" },
    { key: "campaign", title: "Run an observation campaign", body: p.campaign ? `Latest campaign "${p.campaign.name}" is ${p.campaign.status}.` : "Pick the departments and a 2–4 week window.", done: p.campaignCompleted, href: "/app/collection?tab=campaigns", cta: "Go to Campaigns", perm: "campaigns:manage" },
    { key: "analysis", title: "Run the workflow analysis", body: p.analysisRun ? `Last run ${p.lastAnalysisAt ? new Date(p.lastAnalysisAt).toLocaleDateString() : ""}: ${p.workflows} workflows, ${p.opportunities} opportunities.` : "Turns raw activity into workflows, scores and opportunities.", done: p.analysisRun, href: "/app/collection?tab=campaigns", cta: "Run analysis", perm: "analysis:run" },
    { key: "approve", title: "Approve an opportunity", body: `Review the ranked list and approve the ones you want to pursue. ${p.opportunitiesApproved} approved.`, done: p.opportunitiesApproved > 0, href: "/app/opportunities", cta: "Review opportunities", perm: "opportunities:write" },
    { key: "deploy", title: "Deploy an AI agent", body: `Build an agent from an approved opportunity and switch it on. ${p.agentsDeployed} deployed.`, done: p.agentsDeployed > 0, href: p.opportunities > 0 ? "/app/opportunities" : "/app/agents/new", cta: "Build an agent", perm: "agents:write" },
    { key: "measure", title: "Record a savings measurement", body: "After a few weeks of runs, measure actual hours saved from the run ledger. This is what turns 'projected' into 'verified'.", done: p.measurements > 0, href: "/app/agents", cta: "Go to Agents", perm: "agents:write" },
    { key: "report", title: "Generate an executive report", body: "A PDF with the headline numbers, assumptions and evidence for your leadership team.", done: p.reports > 0, href: "/app/reports", cta: "Go to Reports", perm: "reports:generate" },
  ];
}
