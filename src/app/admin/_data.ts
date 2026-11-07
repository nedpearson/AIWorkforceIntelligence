import "server-only";
/** Per-client roll-ups for the consulting portal. Every read runs inside withTenant(clientId) — callers must have passed requireClient / listClients. */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { computeOrgFinancials } from "@/engine/finance";
import { planMonthly, type PlanKey } from "@/engine/billing";
import { num } from "@/lib/utils";

export type ClientSummary = {
  id: string; name: string; industry: string | null; isDemo: boolean; branding: NonNullable<typeof schema.organizations.$inferSelect["branding"]>;
  plan: PlanKey | null; subStatus: string | null; seats: number; seatsUsed: number; monthly: number; trialEndsAt: string | null;
  employees: number; collectorsActive: number; collectorsOffline: number; collectorsPending: number;
  lastAnalysisAt: string | null; lastAnalysisStatus: string | null;
  projected: number; verified: number; opportunities: number; agentsDeployed: number; agentsTotal: number;
  campaigns: number; campaignsRunning: number; authorizations: number; measurements: number; reports: number; projects: number;
  nextStep: string; inviteAccepted: boolean; pendingInvites: number;
};

export async function clientSummary(client: typeof schema.organizations.$inferSelect): Promise<ClientSummary> {
  const orgId = client.id;
  const base = await withTenant(orgId, async (tx) => {
    const [sub] = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, orgId)).limit(1);
    const [emp] = await tx.select({ n: sql<string>`count(*)` }).from(schema.employees).where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.isActive, true)));
    const cols = await tx.select({ status: schema.collectors.status, n: sql<string>`count(*)` }).from(schema.collectors).where(eq(schema.collectors.orgId, orgId)).groupBy(schema.collectors.status);
    const [run] = await tx.select({ status: schema.analysisRuns.status, at: schema.analysisRuns.finishedAt, created: schema.analysisRuns.createdAt }).from(schema.analysisRuns).where(eq(schema.analysisRuns.orgId, orgId)).orderBy(desc(schema.analysisRuns.createdAt)).limit(1);
    const [opp] = await tx.select({ n: sql<string>`count(*)` }).from(schema.opportunities).where(and(eq(schema.opportunities.orgId, orgId), sql`${schema.opportunities.status} <> 'rejected'`));
    const ag = await tx.select({ status: schema.agents.status, n: sql<string>`count(*)` }).from(schema.agents).where(eq(schema.agents.orgId, orgId)).groupBy(schema.agents.status);
    const camps = await tx.select({ status: schema.observationCampaigns.status, n: sql<string>`count(*)` }).from(schema.observationCampaigns).where(eq(schema.observationCampaigns.orgId, orgId)).groupBy(schema.observationCampaigns.status);
    const [auth] = await tx.select({ n: sql<string>`count(*)` }).from(schema.authorizations).where(eq(schema.authorizations.orgId, orgId));
    const [meas] = await tx.select({ n: sql<string>`count(*)` }).from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId));
    const [rep] = await tx.select({ n: sql<string>`count(*)` }).from(schema.reports).where(eq(schema.reports.orgId, orgId));
    const [proj] = await tx.select({ n: sql<string>`count(*)` }).from(schema.projects).where(eq(schema.projects.orgId, orgId));
    const [members] = await tx.select({ n: sql<string>`count(*)` }).from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), inArray(schema.memberships.role, ["owner", "admin"])));
    const [inv] = await tx.select({ n: sql<string>`count(*)` }).from(schema.invitations).where(and(eq(schema.invitations.orgId, orgId), sql`${schema.invitations.acceptedAt} is null and ${schema.invitations.expiresAt} > now()`));
    const [seated] = await tx.select({ n: sql<string>`count(distinct ${schema.collectors.employeeId})` }).from(schema.collectors).where(and(eq(schema.collectors.orgId, orgId), inArray(schema.collectors.status, ["pending", "active", "paused", "offline"])));
    return { sub, emp: num(emp?.n), cols, run, opp: num(opp?.n), ag, camps, auth: num(auth?.n), meas: num(meas?.n), rep: num(rep?.n), proj: num(proj?.n), members: num(members?.n), inv: num(inv?.n), seated: num(seated?.n) };
  });
  let projected = 0, verified = 0;
  if (base.opp > 0 || base.meas > 0) {
    try { const fin = await computeOrgFinancials(orgId); projected = fin.realizableAnnualSavings; verified = fin.verifiedAnnualizedSavings; } catch { /* no model yet */ }
  }
  const col = (s: string) => num(base.cols.find((c) => c.status === s)?.n);
  const agentsDeployed = num(base.ag.find((a) => a.status === "deployed")?.n);
  const agentsTotal = base.ag.reduce((a, r) => a + num(r.n), 0);
  const campaigns = base.camps.reduce((a, r) => a + num(r.n), 0);
  const campaignsRunning = num(base.camps.find((c) => c.status === "running")?.n);
  const collectorsActive = col("active"), collectorsOffline = col("offline"), collectorsPending = col("pending");
  const nextStep = base.members === 0 ? "Client admin has not accepted the invitation"
    : base.auth === 0 ? "Record the signed authorization"
    : base.emp === 0 ? "Add employees"
    : collectorsActive + collectorsPending === 0 ? "Enroll collectors"
    : campaigns === 0 ? "Create an observation campaign"
    : !base.run ? "Run analysis"
    : base.opp === 0 ? "Review analysis results"
    : agentsDeployed === 0 ? "Approve opportunities and deploy agents"
    : base.meas === 0 ? "Measure savings"
    : base.rep === 0 ? "Generate the executive report"
    : "Monthly performance report";
  const plan = (base.sub?.plan ?? null) as PlanKey | null;
  return {
    id: client.id, name: client.name, industry: client.industry, isDemo: client.isDemo, branding: client.branding ?? {},
    plan, subStatus: base.sub?.status ?? null, seats: base.sub?.seats ?? 0, seatsUsed: base.seated, monthly: base.sub ? planMonthly(base.sub.plan, base.sub.seats, base.sub.agentSlots).total : 0, trialEndsAt: base.sub?.trialEndsAt?.toISOString() ?? null,
    employees: base.emp, collectorsActive, collectorsOffline, collectorsPending,
    lastAnalysisAt: (base.run?.at ?? base.run?.created)?.toISOString() ?? null, lastAnalysisStatus: base.run?.status ?? null,
    projected, verified, opportunities: base.opp, agentsDeployed, agentsTotal, campaigns, campaignsRunning, authorizations: base.auth, measurements: base.meas, reports: base.rep, projects: base.proj,
    nextStep, inviteAccepted: base.members > 0, pendingInvites: base.inv,
  };
}

