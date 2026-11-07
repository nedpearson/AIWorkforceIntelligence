import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import { num } from "@/lib/utils";
import { computeOrgFinancials } from "@/engine/finance";
import { seatUsage, stripeConfig, planMonthly, PLANS, EXTRA_SEAT_MONTHLY, EXTRA_AGENT_MONTHLY } from "@/engine/billing";
import { requireClient } from "../../_lib";
import { clientSummary } from "../../_data";
import { ClientWorkspace, type TabKey, type TabData, type FinSlice } from "@/components/admin/client-workspace";
/** Server actions on this page may start an analysis job via after() (src/lib/job-kick.ts): Vercel Hobby cap. */
export const maxDuration = 60;

export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return { title: `Client ${id.slice(0, 8)} — Consulting Portal` }; }

const TABS: TabKey[] = ["overview", "checklist", "collectors", "campaigns", "opportunities", "projects", "agents", "billing", "reports", "branding"];

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; checkout?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const { ctx, consultancy, client } = await requireClient(id);
  const tab: TabKey = (TABS as string[]).includes(sp.tab ?? "") ? (sp.tab as TabKey) : "overview";
  const summary = await clientSummary(client);
  const orgId = client.id;
  let data: TabData = { kind: "overview", fin: null };

  if (tab === "overview") {
    let fin: FinSlice | null = null;
    try { const f = await computeOrgFinancials(orgId); fin = { employeesAnalyzed: f.employeesAnalyzed, totalAnnualLaborAnalyzed: f.totalAnnualLaborAnalyzed, hoursObservedPerWeek: f.hoursObservedPerWeek, repetitiveHoursPerWeek: f.repetitiveHoursPerWeek, hoursRecoverablePerWeek: f.hoursRecoverablePerWeek, grossAnnualSavings: f.grossAnnualSavings, realizableAnnualSavings: f.realizableAnnualSavings, verifiedAnnualizedSavings: f.verifiedAnnualizedSavings, verifiedMeasurements: f.verifiedMeasurements, implementationCost: f.implementationCost, annualOperatingCost: f.annualOperatingCost, netAnnualSavings: f.netAnnualSavings, roi1y: f.roi1y, paybackMonths: f.paybackMonths, deployedAgents: f.deployedAgents, opportunityCount: f.opportunityCount, basisSummary: f.basisSummary, byDepartment: f.byDepartment.slice(0, 8).map((d) => ({ name: d.name, employees: d.employees, realizableAnnual: d.realizableAnnual, verifiedAnnual: d.verifiedAnnual })) }; } catch { fin = null; }
    data = { kind: "overview", fin };
  } else if (tab === "checklist") {
    const c = await withTenant(orgId, async (tx) => {
      const [notice] = await tx.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
      const [consent] = await tx.select({ n: sql<string>`count(distinct ${schema.consentRecords.employeeId})` }).from(schema.consentRecords).where(and(eq(schema.consentRecords.orgId, orgId), sql`${schema.consentRecords.acknowledgedAt} is not null and ${schema.consentRecords.withdrawnAt} is null`));
      const [approved] = await tx.select({ n: sql<string>`count(*)` }).from(schema.opportunities).where(and(eq(schema.opportunities.orgId, orgId), inArray(schema.opportunities.status, ["approved", "in_progress", "deployed", "verified"])));
      return { noticeCustomized: !!(notice?.settings as Record<string, unknown> | null)?.noticeText, consented: num(consent?.n), approved: num(approved?.n) };
    });
    data = { kind: "checklist", ...c };
  } else if (tab === "collectors") {
    const rows = await withTenant(orgId, async (tx) => {
      const cols = await tx.select({ id: schema.collectors.id, name: schema.collectors.name, status: schema.collectors.status, platform: schema.collectors.platform, lastSeenAt: schema.collectors.lastSeenAt, eventsReceived: schema.collectors.eventsReceived, employeeId: schema.collectors.employeeId }).from(schema.collectors).where(eq(schema.collectors.orgId, orgId)).orderBy(desc(schema.collectors.updatedAt));
      const emps = await tx.select({ id: schema.employees.id, name: schema.employees.displayName }).from(schema.employees).where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.isActive, true)));
      return { cols, emps };
    });
    const empName = new Map(rows.emps.map((e) => [e.id, e.name]));
    const seated = new Set(rows.cols.filter((c) => c.status !== "revoked").map((c) => c.employeeId));
    data = { kind: "collectors", usage: await seatUsage(orgId), collectors: rows.cols.map((c) => ({ id: c.id, name: c.name, status: c.status, platform: c.platform, lastSeenAt: c.lastSeenAt?.toISOString() ?? null, events: num(c.eventsReceived), employee: c.employeeId ? empName.get(c.employeeId) ?? "—" : "—" })), unenrolled: rows.emps.filter((e) => !seated.has(e.id)).length, employees: rows.emps.length };
  } else if (tab === "campaigns") {
    const c = await withTenant(orgId, async (tx) => {
      const campaigns = await tx.select().from(schema.observationCampaigns).where(eq(schema.observationCampaigns.orgId, orgId)).orderBy(desc(schema.observationCampaigns.createdAt));
      const runs = await tx.select().from(schema.analysisRuns).where(eq(schema.analysisRuns.orgId, orgId)).orderBy(desc(schema.analysisRuns.createdAt)).limit(10);
      const [events] = await tx.select({ n: sql<string>`count(*)` }).from(schema.activityEvents).where(eq(schema.activityEvents.orgId, orgId));
      const pendingJobs = await tx.select({ id: schema.jobs.id, status: schema.jobs.status, createdAt: schema.jobs.createdAt, error: schema.jobs.error }).from(schema.jobs).where(and(eq(schema.jobs.orgId, orgId), eq(schema.jobs.kind, "analysis"), inArray(schema.jobs.status, ["queued", "running"]))).orderBy(desc(schema.jobs.createdAt)).limit(5);
      return { campaigns, runs, events: num(events?.n), pendingJobs };
    });
    data = { kind: "campaigns", events: c.events, pendingJobs: c.pendingJobs.map((j) => ({ id: j.id, status: j.status, createdAt: j.createdAt.toISOString() })), campaigns: c.campaigns.map((x) => ({ id: x.id, name: x.name, status: x.status, startsAt: x.startsAt?.toISOString() ?? null, endsAt: x.endsAt?.toISOString() ?? null, employees: (x.employeeIds ?? []).length, departments: (x.departmentIds ?? []).length })), runs: c.runs.map((r) => ({ id: r.id, status: r.status, campaignId: r.campaignId, eventsAnalyzed: num(r.eventsAnalyzed), workflowsFound: num(r.workflowsFound), opportunitiesFound: num(r.opportunitiesFound), createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, error: r.error })) };
  } else if (tab === "opportunities") {
    const opps = await withTenant(orgId, (tx) => tx.select({ o: schema.opportunities, dept: schema.departments.name }).from(schema.opportunities).leftJoin(schema.departments, eq(schema.departments.id, schema.opportunities.departmentId)).where(eq(schema.opportunities.orgId, orgId)).orderBy(schema.opportunities.rank, desc(schema.opportunities.realizableAnnualSavings)));
    data = { kind: "opportunities", rows: opps.map(({ o, dept }) => ({ id: o.id, rank: o.rank, title: o.title, summary: o.summary, type: o.type, status: o.status, department: dept, feasibility: num(o.feasibility), risk: num(o.risk), hours: num(o.hoursRecoverablePerWeek), gross: num(o.grossAnnualSavings), realizable: num(o.realizableAnnualSavings), impl: num(o.implementationCost), opex: num(o.annualOperatingCost), payback: o.paybackMonths != null ? num(o.paybackMonths) : null, basis: o.basis, agentId: o.agentId })) };
  } else if (tab === "projects") {
    const c = await withTenant(orgId, async (tx) => {
      const projects = await tx.select().from(schema.projects).where(eq(schema.projects.orgId, orgId)).orderBy(desc(schema.projects.updatedAt));
      const opps = await tx.select({ id: schema.opportunities.id, title: schema.opportunities.title, status: schema.opportunities.status }).from(schema.opportunities).where(eq(schema.opportunities.orgId, orgId)).orderBy(schema.opportunities.rank);
      const agents = await tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.orgId, orgId));
      const members = await tx.select({ userId: schema.memberships.userId, role: schema.memberships.role }).from(schema.memberships).where(eq(schema.memberships.orgId, orgId));
      return { projects, opps, agents, members };
    });
    // owners can be client members or consultancy members — users table is not tenant-scoped
    const consultancyMembers = await db.select({ userId: schema.memberships.userId }).from(schema.memberships).where(eq(schema.memberships.orgId, consultancy.id));
    const userIds = [...new Set([...c.members.map((m) => m.userId), ...consultancyMembers.map((m) => m.userId)])];
    const users = userIds.length ? await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
    data = { kind: "projects", projects: c.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, opportunityIds: p.opportunityIds ?? [], agentIds: p.agentIds ?? [], budget: p.budget != null ? num(p.budget) : null, spent: num(p.spent), startDate: p.startDate?.toISOString().slice(0, 10) ?? null, targetDate: p.targetDate?.toISOString().slice(0, 10) ?? null, ownerUserId: p.ownerUserId, notes: p.notes })), opportunities: c.opps, agents: c.agents, owners: users.map((u) => ({ id: u.id, label: u.name ? `${u.name} (${u.email})` : u.email })) };
  } else if (tab === "agents") {
    const c = await withTenant(orgId, async (tx) => {
      const agents = await tx.select().from(schema.agents).where(eq(schema.agents.orgId, orgId)).orderBy(desc(schema.agents.updatedAt));
      const since = new Date(Date.now() - 30 * 86_400_000);
      const stats = await tx.select({ agentId: schema.agentRuns.agentId, runs: sql<string>`count(*)`, ok: sql<string>`count(*) filter (where ${schema.agentRuns.status} = 'succeeded')`, minutes: sql<string>`coalesce(sum(${schema.agentRuns.minutesSaved}) filter (where ${schema.agentRuns.status} = 'succeeded'), 0)` }).from(schema.agentRuns).where(and(eq(schema.agentRuns.orgId, orgId), gte(schema.agentRuns.createdAt, since))).groupBy(schema.agentRuns.agentId);
      const [pending] = await tx.select({ n: sql<string>`count(*)` }).from(schema.approvals).where(and(eq(schema.approvals.orgId, orgId), eq(schema.approvals.status, "pending")));
      const meas = await tx.select({ agentId: schema.savingsMeasurements.agentId, dollars: sql<string>`coalesce(sum(${schema.savingsMeasurements.dollarsSaved}),0)`, hours: sql<string>`coalesce(sum(${schema.savingsMeasurements.hoursSaved}),0)` }).from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId)).groupBy(schema.savingsMeasurements.agentId);
      return { agents, stats, pending: num(pending?.n), meas };
    });
    const st = new Map(c.stats.map((s) => [s.agentId, s])); const ms = new Map(c.meas.map((m) => [m.agentId, m]));
    data = { kind: "agents", usage: await seatUsage(orgId), pending: c.pending, agents: c.agents.map((a) => ({ id: a.id, name: a.name, category: a.category, status: a.status, runtime: a.runtime, runs30: num(st.get(a.id)?.runs), ok30: num(st.get(a.id)?.ok), minutes30: num(st.get(a.id)?.minutes), monthlyCost: num(a.monthlyCost), verifiedDollars: num(ms.get(a.id)?.dollars), verifiedHours: num(ms.get(a.id)?.hours), deployedAt: a.deployedAt?.toISOString() ?? null, lastRunAt: a.lastRunAt?.toISOString() ?? null })) };
  } else if (tab === "billing") {
    const c = await withTenant(orgId, async (tx) => {
      const [sub] = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, orgId)).limit(1);
      const invoices = await tx.select().from(schema.invoices).where(eq(schema.invoices.orgId, orgId)).orderBy(desc(schema.invoices.createdAt)).limit(24);
      return { sub, invoices };
    });
    const cfg = stripeConfig();
    data = { kind: "billing", checkout: sp.checkout ?? null, stripe: cfg.ok ? { configured: true, missing: [] as string[] } : { configured: false, missing: cfg.missing }, canChange: ["owner", "admin"].includes(consultancy.role), usage: await seatUsage(orgId),
      sub: c.sub ? { plan: c.sub.plan, status: c.sub.status, seats: c.sub.seats, agentSlots: c.sub.agentSlots, stripeCustomerId: c.sub.stripeCustomerId, stripeSubscriptionId: c.sub.stripeSubscriptionId, currentPeriodEnd: c.sub.currentPeriodEnd?.toISOString() ?? null, trialEndsAt: c.sub.trialEndsAt?.toISOString() ?? null, monthly: planMonthly(c.sub.plan, c.sub.seats, c.sub.agentSlots) } : null,
      plans: (Object.keys(PLANS) as (keyof typeof PLANS)[]).map((k) => ({ key: k, ...PLANS[k] })), extraSeat: EXTRA_SEAT_MONTHLY, extraAgent: EXTRA_AGENT_MONTHLY,
      invoices: c.invoices.map((i) => ({ id: i.id, stripeInvoiceId: i.stripeInvoiceId, amountCents: i.amountCents, currency: i.currency, status: i.status, periodStart: i.periodStart?.toISOString() ?? null, periodEnd: i.periodEnd?.toISOString() ?? null, pdfUrl: i.pdfUrl, createdAt: i.createdAt.toISOString(), lines: i.lineItems ?? [] })) };
  } else if (tab === "reports") {
    const reports = await withTenant(orgId, (tx) => tx.select({ id: schema.reports.id, kind: schema.reports.kind, title: schema.reports.title, periodStart: schema.reports.periodStart, periodEnd: schema.reports.periodEnd, createdAt: schema.reports.createdAt, hasPdf: sql<boolean>`${schema.reports.pdfBytes} is not null` }).from(schema.reports).where(eq(schema.reports.orgId, orgId)).orderBy(desc(schema.reports.createdAt)).limit(50));
    data = { kind: "reports", whiteLabel: !!client.branding?.reportName, reports: reports.map((r) => ({ id: r.id, kind: r.kind, title: r.title, periodStart: r.periodStart?.toISOString() ?? null, periodEnd: r.periodEnd?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), hasPdf: !!r.hasPdf })) };
  } else if (tab === "branding") {
    data = { kind: "branding", branding: client.branding ?? {}, consultancyBranding: consultancy.branding };
  }

  return <ClientWorkspace client={{ id: client.id, name: client.name, industry: client.industry, isDemo: client.isDemo, timezone: client.timezone, branding: client.branding ?? {} }} summary={summary} tab={tab} data={data} viewer={{ role: consultancy.role, email: ctx.email }} />;
}
