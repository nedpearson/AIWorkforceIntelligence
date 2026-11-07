import "server-only";
/**
 * Loaders for the ROI & Savings Center. All tenant data via withTenant. Numbers shown on the page come from
 * computeSavingsIntelligence (tiers) — this file only shapes ledger rows and the monthly timeline.
 */
import { eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import { num } from "@/lib/utils";
import type { SavingsIntelligence } from "@/engine/savings";

export type LedgerRow = {
  id: string; tier: "approved" | "cost_avoidance" | "realized_hard"; status: "draft" | "submitted" | "approved" | "rejected";
  title: string; annualAmount: number; hoursPerYear: number | null; basis: "observed" | "estimated" | "assumed";
  opportunity: { id: string; label: string } | null; project: { id: string; label: string } | null; agent: { id: string; label: string } | null; workflow: { id: string; label: string } | null;
  departmentId: string | null; departmentName: string | null;
  evidence: { kind: string; ref: string; note?: string }[]; calculation: unknown;
  submittedById: string | null; submittedBy: string | null; approvedById: string | null; approvedBy: string | null;
  approvedAt: string | null; createdAt: string; effectiveFrom: string; effectiveTo: string | null; rejectionReason: string | null;
};
export type LinkOptions = { opportunities: { id: string; label: string; workflowId: string | null; departmentId: string | null; realizable: number }[]; projects: { id: string; label: string }[]; agents: { id: string; label: string; workflowId: string | null }[]; workflows: { id: string; label: string; departmentId: string | null }[]; departments: { id: string; label: string }[] };
export type TimelinePoint = { month: string; label: string; projected: number; verified: number; ledgerHard: number; ledgerApproved: number };

export async function loadLedger(orgId: string): Promise<{ rows: LedgerRow[]; options: LinkOptions }> {
  const d = await withTenant(orgId, async (tx) => {
    const [ledger, opps, projects, agents, workflows, departments] = await Promise.all([
      tx.select().from(schema.savingsLedger).where(eq(schema.savingsLedger.orgId, orgId)),
      tx.select({ id: schema.opportunities.id, title: schema.opportunities.title, workflowId: schema.opportunities.workflowId, departmentId: schema.opportunities.departmentId, status: schema.opportunities.status, realizable: schema.opportunities.realizableAnnualSavings }).from(schema.opportunities).where(eq(schema.opportunities.orgId, orgId)),
      tx.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.orgId, orgId)),
      tx.select({ id: schema.agents.id, name: schema.agents.name, workflowId: schema.agents.workflowId }).from(schema.agents).where(eq(schema.agents.orgId, orgId)),
      tx.select({ id: schema.workflows.id, name: schema.workflows.name, departmentId: schema.workflows.departmentId }).from(schema.workflows).where(eq(schema.workflows.orgId, orgId)),
      tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, orgId)),
    ]);
    return { ledger, opps, projects, agents, workflows, departments };
  });
  // Submitters/approvers may be consultancy staff who are not members of this org (users RLS hides them from the tenant role).
  // Resolve only the user ids referenced by this tenant's own ledger rows, email only.
  const userIds = [...new Set(d.ledger.flatMap((r) => [r.submittedBy, r.approvedBy]).filter((x): x is string => !!x))];
  const users = userIds.length ? await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const email = new Map(users.map((u) => [u.id, u.email]));
  const oppM = new Map(d.opps.map((o) => [o.id, o.title])); const projM = new Map(d.projects.map((p) => [p.id, p.name]));
  const agM = new Map(d.agents.map((a) => [a.id, a.name])); const wfM = new Map(d.workflows.map((w) => [w.id, w])); const deptM = new Map(d.departments.map((x) => [x.id, x.name]));
  const link = (id: string | null, m: Map<string, string>) => (id ? { id, label: m.get(id) ?? "(deleted)" } : null);
  const rows: LedgerRow[] = d.ledger.map((r) => {
    const deptId = r.departmentId ?? (r.workflowId ? (wfM.get(r.workflowId)?.departmentId ?? null) : null);
    return {
      id: r.id, tier: r.tier, status: r.status, title: r.title, annualAmount: num(r.annualAmount), hoursPerYear: r.hoursPerYear == null ? null : num(r.hoursPerYear), basis: r.basis,
      opportunity: link(r.opportunityId, oppM), project: link(r.projectId, projM), agent: link(r.agentId, agM), workflow: r.workflowId ? { id: r.workflowId, label: wfM.get(r.workflowId)?.name ?? "(deleted)" } : null,
      departmentId: deptId, departmentName: deptId ? (deptM.get(deptId) ?? null) : null,
      evidence: r.evidence ?? [], calculation: r.calculation ?? null,
      submittedById: r.submittedBy, submittedBy: r.submittedBy ? (email.get(r.submittedBy) ?? "unknown user") : null,
      approvedById: r.approvedBy, approvedBy: r.approvedBy ? (email.get(r.approvedBy) ?? "unknown user") : null,
      approvedAt: r.approvedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), effectiveFrom: r.effectiveFrom.toISOString(), effectiveTo: r.effectiveTo?.toISOString() ?? null, rejectionReason: r.rejectionReason,
    };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    rows,
    options: {
      opportunities: d.opps.filter((o) => o.status !== "rejected").map((o) => ({ id: o.id, label: o.title, workflowId: o.workflowId, departmentId: o.departmentId, realizable: num(o.realizable) })).sort((a, b) => a.label.localeCompare(b.label)),
      projects: d.projects.map((p) => ({ id: p.id, label: p.name })), agents: d.agents.map((a) => ({ id: a.id, label: a.name, workflowId: a.workflowId })),
      workflows: d.workflows.map((w) => ({ id: w.id, label: w.name, departmentId: w.departmentId })).sort((a, b) => a.label.localeCompare(b.label)),
      departments: d.departments.map((x) => ({ id: x.id, label: x.name })),
    },
  };
}

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * Monthly realized-vs-projected series over the last 12 months:
 *  projected      — current potential run-rate ÷ 12 (estimated; flat because it is today's model, not history)
 *  verified       — savings_measurements dollars prorated by day across the months their period covers (observed)
 *  ledgerHard     — approved realized-hard + cost-avoidance annual amounts ÷ 12 for every month the entry is in effect
 *  ledgerApproved — approved business cases ÷ 12 from their effective date
 */
export async function savingsTimeline(orgId: string, si: SavingsIntelligence, now = new Date()): Promise<TimelinePoint[]> {
  const d = await withTenant(orgId, async (tx) => ({
    meas: await tx.select({ periodStart: schema.savingsMeasurements.periodStart, periodEnd: schema.savingsMeasurements.periodEnd, dollars: schema.savingsMeasurements.dollarsSaved }).from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId)),
    ledger: await tx.select({ tier: schema.savingsLedger.tier, status: schema.savingsLedger.status, amount: schema.savingsLedger.annualAmount, from: schema.savingsLedger.effectiveFrom, to: schema.savingsLedger.effectiveTo, id: schema.savingsLedger.id }).from(schema.savingsLedger).where(eq(schema.savingsLedger.orgId, orgId)),
  }));
  // Only entries that the engine counts (post de-duplication) feed the ledger lines, so the chart never shows superseded claims.
  const counted = new Set([...si.tiers.approved.lineage, ...si.tiers.realizedHard.lineage, ...si.tiers.costAvoidance.lineage].map((l) => l.id));
  const months: { key: string; start: Date; end: Date }[] = [];
  for (let i = 11; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    months.push({ key: monthKey(start), start, end });
  }
  return months.map((m) => {
    let verified = 0;
    for (const x of d.meas) {
      const ps = +x.periodStart, pe = +x.periodEnd; const span = pe - ps; if (span <= 0) continue;
      const overlap = Math.max(0, Math.min(pe, +m.end) - Math.max(ps, +m.start));
      verified += num(x.dollars) * (overlap / span);
    }
    const active = (r: (typeof d.ledger)[number]) => r.status === "approved" && counted.has(r.id) && +r.from < +m.end && (!r.to || +r.to >= +m.start);
    const ledgerHard = d.ledger.filter((r) => r.tier !== "approved" && active(r)).reduce((s, r) => s + num(r.amount) / 12, 0);
    const ledgerApproved = d.ledger.filter((r) => r.tier === "approved" && active(r)).reduce((s, r) => s + num(r.amount) / 12, 0);
    return { month: m.key, label: m.start.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }), projected: si.tiers.potential.amount / 12, verified, ledgerHard, ledgerApproved };
  });
}
