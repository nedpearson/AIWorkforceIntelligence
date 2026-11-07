import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { computeSavingsIntelligence } from "@/engine/savings";
import { loadLedger, savingsTimeline } from "./lib";
import { SavingsCenter } from "@/components/savings/savings-center";

export const metadata = { title: "ROI & Savings Center" };
export const dynamic = "force-dynamic";

type SP = { amort?: string; entry?: string; dept?: string; status?: string; savings?: string; wf?: string; agent?: string; from?: string; to?: string };

export default async function SavingsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireCtx("finance:read");
  const sp = await searchParams;
  const amortizationYears = Math.min(5, Math.max(1, Math.round(Number(sp.amort) || 3)));
  const si = await computeSavingsIntelligence(ctx.orgId, {}, { amortizationYears });
  const [{ rows, options }, timeline] = await Promise.all([loadLedger(ctx.orgId), savingsTimeline(ctx.orgId, si)]);

  // Global filters (server-side): apply to the ledger. Tier totals are always enterprise-wide so they reconcile.
  const fromMs = sp.from ? Date.parse(sp.from) : NaN; const toMs = sp.to ? Date.parse(sp.to) : NaN;
  const filtered = rows.filter((r) =>
    (!sp.dept || r.departmentId === sp.dept) && (!sp.status || r.status === sp.status) && (!sp.savings || r.tier === sp.savings) &&
    (!sp.wf || r.workflow?.id === sp.wf) && (!sp.agent || r.agent?.id === sp.agent) &&
    (Number.isNaN(fromMs) || Date.parse(r.effectiveFrom) >= fromMs) && (Number.isNaN(toMs) || Date.parse(r.effectiveFrom) <= toMs));

  const canSubmit = can(ctx.role, "finance:write");
  const canApprove = canSubmit && (ctx.role === "owner" || ctx.role === "admin");
  return (
    <SavingsCenter
      si={si} ledger={filtered} pending={rows.filter((r) => r.status === "submitted")} ledgerTotal={rows.length} options={options} timeline={timeline}
      me={{ userId: ctx.userId, role: ctx.role }} canSubmit={canSubmit} canApprove={canApprove}
      entryId={sp.entry ?? null} amortizationYears={amortizationYears}
    />
  );
}
