/**
 * Savings Intelligence Engine — the single source of truth for every savings number in the product.
 *
 * Seven tiers, never mixed:
 *  1. potential          — realizable estimate from opportunities (finance engine, overlap de-duplicated)          [estimated]
 *  2. approved           — finance-approved business cases (ledger, tier=approved, status=approved)                [assumed → approved]
 *  3. verifiedTime       — measured reduction in work hours, valued at loaded cost (savings_measurements)          [observed]
 *  4. capacityReleased   — verified hours NOT yet converted to hard savings / cost avoidance (available to redeploy) [observed]
 *  5. costAvoidance      — future expense demonstrably avoided (ledger, evidenced, approved)                       [observed]
 *  6. realizedHard       — confirmed reduction in an actual expense line (ledger, evidenced, approved)             [observed]
 *  7. net                — realizedHard + costAvoidance − attributable implementation & operating cost             [observed/assumed]
 *
 * Time saved is never treated as payroll reduction: only tiers 5–6 (evidenced + approved) count as money actually kept.
 * Every tier carries a CalcTree and a lineage list of the exact source records behind it.
 */
import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import type { CalcTree } from "@/db/schema";
import { computeOrgFinancials } from "./finance";
import type { FinancialOverrides, OrgFinancials } from "./finance.types";
import { audit } from "@/lib/audit";
import { MAX_AUTOMATABLE_SHARE } from "./finance";

const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const MS_PER_DAY = 86_400_000;
/** Same annualization as finance.ts (Σ measurement × 365.25 ÷ period days) so lineage rows sum to the tier. */
const annualize = (start: Date, end: Date) => { const days = (end.getTime() - start.getTime()) / MS_PER_DAY; return days > 0 ? 365.25 / days : 0; };

export type LineageItem = { type: "opportunity" | "ledger" | "measurement" | "project" | "agent" | "workflow" | "assumption"; id: string; label: string; href: string; amount: number; hours?: number; basis: "observed" | "estimated" | "assumed"; status?: string };
export type Tier = { key: TierKey; label: string; description: string; amount: number; hours?: number; basis: "observed" | "estimated" | "assumed"; color: "gold" | "indigo" | "cyan" | "purple" | "emerald" | "royal" | "coral"; tree: CalcTree; lineage: LineageItem[] };
export type TierKey = "potential" | "approved" | "verifiedTime" | "capacityReleased" | "costAvoidance" | "realizedHard" | "net";
export type ReconCheck = { key: string; label: string; status: "pass" | "warn" | "fail"; detail: string };
export type SavingsIntelligence = {
  orgId: string; computedAt: string; amortizationYears: number;
  tiers: Record<TierKey, Tier>;
  order: TierKey[];
  attributableCost: { implementationSpent: number; implementationAnnualized: number; agentOperatingAnnual: number; platformAnnual: number; total: number; tree: CalcTree };
  pendingApprovals: { id: string; tier: string; title: string; amount: number; submittedBy: string | null; submittedById: string | null; createdAt: string }[];
  checks: ReconCheck[];
  overlapRemovedAnnual: number;
  fin: Pick<OrgFinancials, "realizableAnnualSavings" | "grossAnnualSavings" | "verifiedAnnualizedSavings" | "verifiedHoursSavedAnnualized" | "totalAnnualLaborAnalyzed">;
};

export const TIER_ORDER: TierKey[] = ["potential", "approved", "verifiedTime", "capacityReleased", "costAvoidance", "realizedHard", "net"];

export async function computeSavingsIntelligence(orgId: string, overrides: FinancialOverrides = {}, opts: { amortizationYears?: number } = {}): Promise<SavingsIntelligence> {
  const amortizationYears = opts.amortizationYears ?? 3;
  const fin = await computeOrgFinancials(orgId, overrides);
  const d = await withTenant(orgId, async (tx) => {
    const [ledger, measurements, projects, agents, workflows, users] = await Promise.all([
      tx.select().from(schema.savingsLedger).where(eq(schema.savingsLedger.orgId, orgId)),
      tx.select().from(schema.savingsMeasurements).where(eq(schema.savingsMeasurements.orgId, orgId)),
      tx.select().from(schema.projects).where(eq(schema.projects.orgId, orgId)),
      tx.select().from(schema.agents).where(eq(schema.agents.orgId, orgId)),
      tx.select({ id: schema.workflows.id, name: schema.workflows.name }).from(schema.workflows).where(eq(schema.workflows.orgId, orgId)),
      tx.select({ id: schema.users.id, email: schema.users.email }).from(schema.users),
    ]);
    return { ledger, measurements, projects, agents, workflows, users };
  });
  const wfName = new Map(d.workflows.map((w) => [w.id, w.name]));
  const email = new Map(d.users.map((u) => [u.id, u.email]));
  const checks: ReconCheck[] = [];

  // ---------- 1. potential ----------
  const potentialLineage: LineageItem[] = fin.opportunities.map((o) => ({ type: "opportunity", id: o.id, label: o.title, href: `/app/opportunities/${o.id}`, amount: o.realizableAnnualSavings, hours: o.hoursRecoverablePerWeek, basis: "estimated", status: o.status }));
  const potential: Tier = {
    key: "potential", label: "Potential savings", color: "gold", basis: "estimated",
    description: "Realistic annual value of the identified automation opportunities, before anything is implemented. Overlapping opportunities on the same workflow are de-duplicated.",
    amount: fin.realizableAnnualSavings, hours: fin.hoursRecoverablePerWeek * (fin.assumptions.workWeeksPerYear ?? 48),
    tree: fin.overlapRemovedAnnual > 0
      ? { label: "Potential savings", value: fin.realizableAnnualSavings, unit: "usd", basis: "estimated", formula: "Σ opportunity realizable savings − overlap removed", children: [fin.trees.realizableSavings, { label: "Overlap removed (shared workflows)", value: fin.overlapRemovedAnnual, unit: "usd", basis: "estimated", source: "Opportunities targeting the same workflow are capped at 90% of its observed hours" }] }
      : fin.trees.realizableSavings,
    lineage: potentialLineage,
  };

  // ---------- ledger tiers (dedupe by tier + dedupeKey: newest approved entry wins) ----------
  // Realized hard savings / cost avoidance only count while in effect (effectiveFrom ≤ now ≤ effectiveTo); a future-dated
  // claim is not yet realized and an expired one is no longer recurring. Approved business cases count regardless of dates.
  const nowMs = Date.now();
  const inEffect = (r: (typeof d.ledger)[number]) => r.tier === "approved" || (+new Date(r.effectiveFrom) <= nowMs && (!r.effectiveTo || +new Date(r.effectiveTo) >= nowMs));
  const notInEffect = d.ledger.filter((r) => r.status === "approved" && !inEffect(r));
  const approvedRows = d.ledger.filter((r) => r.status === "approved" && inEffect(r));
  const deduped = new Map<string, (typeof approvedRows)[number]>();
  const duplicates: (typeof approvedRows)[number][] = [];
  for (const r of approvedRows.sort((a, b) => +new Date(b.approvedAt ?? b.createdAt) - +new Date(a.approvedAt ?? a.createdAt))) {
    const k = `${r.tier}:${r.dedupeKey}`;
    if (deduped.has(k)) duplicates.push(r); else deduped.set(k, r);
  }
  const ledgerTier = (tier: "approved" | "cost_avoidance" | "realized_hard") => [...deduped.values()].filter((r) => r.tier === tier);
  const ledgerLineage = (rows: (typeof approvedRows)): LineageItem[] => rows.map((r) => ({ type: "ledger", id: r.id, label: r.title, href: `/app/savings?entry=${r.id}`, amount: num(r.annualAmount), hours: r.hoursPerYear ? num(r.hoursPerYear) : undefined, basis: r.basis, status: r.status }));
  const ledgerTree = (label: string, rows: (typeof approvedRows), basis: Tier["basis"]): CalcTree => ({
    label, value: sum(rows.map((r) => num(r.annualAmount))), unit: "usd", basis, formula: `Σ ${rows.length} approved ledger entr${rows.length === 1 ? "y" : "ies"} (de-duplicated by workflow)`,
    children: rows.slice(0, 30).map((r) => ({ label: r.title, value: num(r.annualAmount), unit: "usd", basis: r.basis, source: `Approved by ${email.get(r.approvedBy ?? "") ?? "—"} · evidence: ${r.evidence.map((e) => e.kind).join(", ") || "none"}`, children: r.calculation ? [r.calculation] : undefined })),
  });
  const approvedEntries = ledgerTier("approved");
  const approved: Tier = { key: "approved", label: "Approved savings", color: "indigo", basis: "assumed", description: "Annual savings in business cases that finance has formally approved for implementation.", amount: sum(approvedEntries.map((r) => num(r.annualAmount))), tree: ledgerTree("Approved savings", approvedEntries, "assumed"), lineage: ledgerLineage(approvedEntries) };

  // ---------- 3. verified time ----------
  const measLineage: LineageItem[] = d.measurements.map((m) => ({ type: "measurement", id: m.id, label: `${m.method.replace(/_/g, " ")} · ${new Date(m.periodStart).toLocaleDateString("en-US")}–${new Date(m.periodEnd).toLocaleDateString("en-US")}`, href: m.agentId ? `/app/agents/${m.agentId}?tab=results` : "/app/savings", amount: num(m.dollarsSaved) * annualize(m.periodStart, m.periodEnd), hours: num(m.hoursSaved) * annualize(m.periodStart, m.periodEnd), basis: m.basis }));
  const verifiedHoursAnnual = fin.verifiedHoursSavedAnnualized;
  const verifiedTime: Tier = { key: "verifiedTime", label: "Verified time savings", color: "cyan", basis: "observed", description: "Measured reduction in work hours after deployment (run ledger or before/after observation), valued at loaded labor cost. Time, not cash.", amount: fin.verifiedAnnualizedSavings, hours: verifiedHoursAnnual, tree: fin.trees.verifiedSavings, lineage: measLineage };

  // ---------- 5/6. cost avoidance & realized hard ----------
  const caRows = ledgerTier("cost_avoidance"); const rhRows = ledgerTier("realized_hard");
  const costAvoidance: Tier = { key: "costAvoidance", label: "Cost avoidance", color: "purple", basis: "observed", description: "Future expenses demonstrably avoided — e.g. a planned hire not made because capacity was released. Requires evidence and approval.", amount: sum(caRows.map((r) => num(r.annualAmount))), hours: sum(caRows.map((r) => num(r.hoursPerYear))), tree: ledgerTree("Cost avoidance", caRows, "observed"), lineage: ledgerLineage(caRows) };
  const realizedHard: Tier = { key: "realizedHard", label: "Realized hard savings", color: "emerald", basis: "observed", description: "Confirmed reductions in actual expense lines (overtime, contractors, vendor fees, payroll). Requires evidence and approval.", amount: sum(rhRows.map((r) => num(r.annualAmount))), hours: sum(rhRows.map((r) => num(r.hoursPerYear))), tree: ledgerTree("Realized hard savings", rhRows, "observed"), lineage: ledgerLineage(rhRows) };

  // ---------- 4. capacity released ----------
  const convertedHours = (costAvoidance.hours ?? 0) + (realizedHard.hours ?? 0);
  const capHours = Math.max(0, verifiedHoursAnnual - convertedHours);
  const valuePerHour = verifiedHoursAnnual > 0 ? fin.verifiedAnnualizedSavings / verifiedHoursAnnual : 0;
  const capacityReleased: Tier = {
    key: "capacityReleased", label: "Capacity released", color: "royal", basis: "observed", hours: capHours, amount: capHours * valuePerHour,
    description: "Verified hours freed for higher-value work that have not been converted into hard savings or cost avoidance. Value shown at loaded cost — it is capacity, not cash.",
    tree: { label: "Capacity released", value: capHours * valuePerHour, unit: "usd", basis: "observed", formula: "(verified hours/yr − hours converted to hard savings or cost avoidance) × verified $/hour", children: [
      { label: "Verified hours saved per year", value: verifiedHoursAnnual, unit: "hours", basis: "observed", source: "Savings measurements, annualized" },
      { label: "Hours converted (hard savings + cost avoidance)", value: convertedHours, unit: "hours", basis: "observed", source: "Approved ledger entries" },
      { label: "Verified value per hour", value: valuePerHour, unit: "usd", basis: "observed", formula: "verified $ ÷ verified hours" },
    ] },
    lineage: measLineage,
  };

  // ---------- 7. net ----------
  const implementationSpent = sum(d.projects.map((p) => num(p.spent)));
  const implementationAnnualized = implementationSpent / amortizationYears;
  const deployed = d.agents.filter((a) => a.status === "deployed");
  const agentOperatingAnnual = sum(deployed.map((a) => num(a.monthlyCost) * 12));
  const platformAnnual = (fin.assumptions.platformFeeMonthly ?? 0) * 12;
  const attributableTotal = implementationAnnualized + agentOperatingAnnual + platformAnnual;
  const attribTree: CalcTree = { label: "Attributable cost (annual)", value: attributableTotal, unit: "usd", basis: "observed", formula: `implementation spent ÷ ${amortizationYears} yrs + deployed agent operating cost + platform fee`, children: [
    { label: "Implementation spent to date", value: implementationSpent, unit: "usd", basis: "observed", source: `${d.projects.length} transformation project(s) · projects.spent` },
    { label: `Implementation amortized over ${amortizationYears} years`, value: implementationAnnualized, unit: "usd", basis: "assumed" },
    { label: "Deployed agent operating cost", value: agentOperatingAnnual, unit: "usd", basis: "observed", source: `${deployed.length} deployed agent(s) × monthly cost × 12` },
    { label: "Platform fee", value: platformAnnual, unit: "usd", basis: "assumed", source: "Financial model assumption" },
  ] };
  const netAmount = realizedHard.amount + costAvoidance.amount - attributableTotal;
  const net: Tier = {
    key: "net", label: "Net savings", color: netAmount >= 0 ? "emerald" : "coral", basis: "observed", amount: netAmount,
    description: "Realized hard savings plus cost avoidance, minus the implementation and operating cost attributable to achieving them. The only number that represents money actually kept.",
    tree: { label: "Net savings", value: netAmount, unit: "usd", basis: "observed", formula: "realized hard + cost avoidance − attributable cost", children: [realizedHard.tree, costAvoidance.tree, attribTree] },
    lineage: [...realizedHard.lineage, ...costAvoidance.lineage, ...d.projects.filter((p) => num(p.spent) > 0).map((p) => ({ type: "project" as const, id: p.id, label: `Cost · ${p.name}`, href: `/app/roadmap?project=${p.id}`, amount: -num(p.spent) / amortizationYears, basis: "observed" as const, status: p.status })), ...deployed.map((a) => ({ type: "agent" as const, id: a.id, label: `Operating cost · ${a.name}`, href: `/app/agents/${a.id}`, amount: -num(a.monthlyCost) * 12, basis: "observed" as const })), ...(platformAnnual > 0 ? [{ type: "assumption" as const, id: "platform_fee", label: "Platform fee (financial model assumption)", href: "/app/finance", amount: -platformAnnual, basis: "assumed" as const }] : [])],
  };

  // ---------- reconciliation checks ----------
  // byDepartment already contains an "Unassigned" row (departmentId null) — count it once, as "unassigned".
  const deptTotal = sum(fin.byDepartment.filter((x) => x.departmentId != null).map((x) => x.realizableAnnual));
  const unassigned = sum(fin.byDepartment.filter((x) => x.departmentId == null).map((x) => x.realizableAnnual));
  checks.push({ key: "dept_rollup", label: "Department roll-up equals enterprise potential", status: Math.abs(deptTotal + unassigned - fin.realizableAnnualSavings) <= 1 ? "pass" : "fail", detail: `Σ departments $${Math.round(deptTotal).toLocaleString()} + unassigned $${Math.round(unassigned).toLocaleString()} vs enterprise $${Math.round(fin.realizableAnnualSavings).toLocaleString()}` });
  const oppTotal = sum(fin.opportunities.map((o) => o.realizableAnnualSavings));
  checks.push({ key: "opp_rollup", label: "Opportunity lines sum to potential", status: Math.abs(oppTotal - fin.realizableAnnualSavings) <= 1 ? "pass" : "fail", detail: `Σ lines $${Math.round(oppTotal).toLocaleString()} vs total $${Math.round(fin.realizableAnnualSavings).toLocaleString()}` });
  // Verify (not assume) that no workflow is claimed beyond MAX_AUTOMATABLE_SHARE of its observed hours across all its opportunities.
  const claimsByWf = new Map<string, { hours: number; claimed: number; name: string }>();
  for (const o of fin.opportunities) { if (!o.workflowId) continue; const c = claimsByWf.get(o.workflowId) ?? { hours: o.hoursPerWeek, claimed: 0, name: o.workflowName ?? o.title }; c.claimed += o.hoursRecoverablePerWeek; claimsByWf.set(o.workflowId, c); }
  const overClaimed = [...claimsByWf.values()].filter((c) => c.claimed > c.hours * MAX_AUTOMATABLE_SHARE + 0.01);
  const shared = fin.opportunities.filter((o) => o.overlap).length;
  checks.push({ key: "overlap", label: "No double counting across overlapping opportunities", status: overClaimed.length ? "fail" : "pass", detail: overClaimed.length ? `${overClaimed.length} workflow(s) claimed beyond ${(MAX_AUTOMATABLE_SHARE * 100).toFixed(0)}% of observed hours: ${overClaimed.slice(0, 3).map((c) => c.name).join(", ")}` : fin.overlapRemovedAnnual > 0 ? `$${Math.round(fin.overlapRemovedAnnual).toLocaleString()}/yr removed across ${shared} opportunities that shared a workflow; every workflow is within its ${(MAX_AUTOMATABLE_SHARE * 100).toFixed(0)}% cap` : "No overlapping opportunities found; every workflow is within its cap" });
  checks.push({ key: "ledger_dupes", label: "Ledger entries de-duplicated", status: duplicates.length ? "warn" : "pass", detail: duplicates.length ? `${duplicates.length} older approved entr${duplicates.length === 1 ? "y" : "ies"} superseded by a newer entry for the same workflow and tier (excluded)` : "No duplicate claims" });
  checks.push({ key: "capacity_nonnegative", label: "Converted hours do not exceed verified hours", status: convertedHours <= verifiedHoursAnnual + 0.5 ? "pass" : "fail", detail: `${Math.round(convertedHours).toLocaleString()} hrs converted vs ${Math.round(verifiedHoursAnnual).toLocaleString()} hrs verified per year` });
  const noEvidence = [...deduped.values()].filter((r) => r.tier !== "approved" && r.evidence.length === 0);
  checks.push({ key: "evidence", label: "Every hard saving / cost avoidance cites evidence", status: noEvidence.length ? "fail" : "pass", detail: noEvidence.length ? `${noEvidence.length} approved entr${noEvidence.length === 1 ? "y has" : "ies have"} no evidence attached` : "All approved entries cite evidence" });
  const selfApproved = [...deduped.values()].filter((r) => r.approvedBy && r.approvedBy === r.submittedBy);
  checks.push({ key: "sod", label: "Segregation of duties (submitter ≠ approver)", status: selfApproved.length ? "warn" : "pass", detail: selfApproved.length ? `${selfApproved.length} entr${selfApproved.length === 1 ? "y was" : "ies were"} approved by the person who submitted ${selfApproved.length === 1 ? "it" : "them"}` : "All approvals were made by a different person" });
  checks.push({ key: "hard_vs_verified", label: "Hard savings supported by verified results", status: realizedHard.amount + costAvoidance.amount <= verifiedTime.amount * 1.05 || realizedHard.amount + costAvoidance.amount === 0 ? "pass" : "warn", detail: `Hard + avoidance $${Math.round(realizedHard.amount + costAvoidance.amount).toLocaleString()} vs verified time value $${Math.round(verifiedTime.amount).toLocaleString()} — larger claims need non-time evidence (e.g. vendor reduction)` });

  checks.push({ key: "in_effect", label: "Only in-effect hard savings are counted", status: "pass", detail: notInEffect.length ? `${notInEffect.length} approved entr${notInEffect.length === 1 ? "y is" : "ies are"} future-dated or expired and excluded until in effect` : "All approved entries are currently in effect" });

  const pendingApprovals = d.ledger.filter((r) => r.status === "submitted").map((r) => ({ id: r.id, tier: r.tier, title: r.title, amount: num(r.annualAmount), submittedBy: email.get(r.submittedBy ?? "") ?? null, submittedById: r.submittedBy ?? null, createdAt: r.createdAt.toISOString() }));
  void wfName;
  return {
    orgId, computedAt: new Date().toISOString(), amortizationYears,
    tiers: { potential, approved, verifiedTime, capacityReleased, costAvoidance, realizedHard, net }, order: TIER_ORDER,
    attributableCost: { implementationSpent, implementationAnnualized, agentOperatingAnnual, platformAnnual, total: attributableTotal, tree: attribTree },
    pendingApprovals, checks, overlapRemovedAnnual: fin.overlapRemovedAnnual,
    fin: { realizableAnnualSavings: fin.realizableAnnualSavings, grossAnnualSavings: fin.grossAnnualSavings, verifiedAnnualizedSavings: fin.verifiedAnnualizedSavings, verifiedHoursSavedAnnualized: fin.verifiedHoursSavedAnnualized, totalAnnualLaborAnalyzed: fin.totalAnnualLaborAnalyzed },
  };
}

// ---------- ledger workflow (called by server actions; caller enforces RBAC) ----------
export type LedgerInput = { tier: "approved" | "cost_avoidance" | "realized_hard"; title: string; annualAmount: number; hoursPerYear?: number; opportunityId?: string; projectId?: string; agentId?: string; workflowId?: string; departmentId?: string; effectiveFrom: Date; evidence: { kind: string; ref: string; note?: string }[]; calculation?: CalcTree; basis?: "observed" | "estimated" | "assumed" };

export async function submitLedgerEntry(orgId: string, userId: string, i: LedgerInput) {
  if (!(i.annualAmount >= 0)) throw new Error("annualAmount must be ≥ 0");
  if (!i.title.trim()) throw new Error("title is required");
  i = { ...i, evidence: i.evidence.filter((e) => e.kind.trim() && e.ref.trim()) }; // blank evidence rows do not count as evidence
  if (i.tier !== "approved" && i.evidence.length === 0) throw new Error("Hard savings and cost avoidance require at least one evidence item");
  const dedupeKey = i.workflowId ?? i.opportunityId ?? i.projectId ?? `manual:${i.title.toLowerCase().trim()}`;
  const [row] = await withTenant(orgId, (tx) => tx.insert(schema.savingsLedger).values({
    orgId, tier: i.tier, status: "submitted", title: i.title, annualAmount: i.annualAmount.toFixed(2), hoursPerYear: i.hoursPerYear != null ? i.hoursPerYear.toFixed(2) : null,
    opportunityId: i.opportunityId, projectId: i.projectId, agentId: i.agentId, workflowId: i.workflowId, departmentId: i.departmentId, dedupeKey,
    effectiveFrom: i.effectiveFrom, evidence: i.evidence, calculation: i.calculation, basis: i.basis ?? (i.tier === "approved" ? "assumed" : "observed"), submittedBy: userId,
  }).returning());
  await audit({ orgId, actorUserId: userId, action: "savings.submitted", entityType: "savings_ledger", entityId: row.id, details: { tier: i.tier, amount: i.annualAmount } });
  return row;
}

export async function decideLedgerEntry(orgId: string, userId: string, id: string, decision: "approve" | "reject", reason?: string) {
  const row = await withTenant(orgId, async (tx) => {
    const [r] = await tx.select().from(schema.savingsLedger).where(and(eq(schema.savingsLedger.id, id), eq(schema.savingsLedger.orgId, orgId))).limit(1);
    if (!r) throw new Error("not found");
    if (r.status !== "submitted") throw new Error(`entry is already ${r.status}`);
    const [u] = await tx.update(schema.savingsLedger).set(decision === "approve" ? { status: "approved", approvedBy: userId, approvedAt: new Date(), updatedAt: new Date() } : { status: "rejected", approvedBy: userId, approvedAt: new Date(), rejectionReason: reason ?? null, updatedAt: new Date() }).where(eq(schema.savingsLedger.id, id)).returning();
    if (decision === "approve" && r.tier === "approved" && r.opportunityId) await tx.update(schema.opportunities).set({ status: "approved", updatedAt: new Date() }).where(and(eq(schema.opportunities.id, r.opportunityId), inArray(schema.opportunities.status, ["identified", "reviewing"])));
    return u;
  });
  await audit({ orgId, actorUserId: userId, action: `savings.${decision}d`, entityType: "savings_ledger", entityId: id, details: { reason, selfApproval: row.submittedBy === userId } });
  return row;
}
