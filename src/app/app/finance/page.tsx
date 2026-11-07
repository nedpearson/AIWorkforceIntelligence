import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { computeOrgFinancials, ensureDefaultFinancialModel } from "@/engine/finance";
import { workflowCosts, realizedVsProjected, type OpportunityOption } from "./lib";
import { FinanceClient } from "./finance-client";

export const metadata = { title: "Financial Model" };
export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const ctx = await requireCtx("finance:read");
  const model = await ensureDefaultFinancialModel(ctx.orgId);
  const fin = await computeOrgFinancials(ctx.orgId);
  const [workflows, months] = await Promise.all([workflowCosts(ctx.orgId, fin.assumptions, fin), realizedVsProjected(ctx.orgId, fin.realizableAnnualSavings)]);
  const opportunities: OpportunityOption[] = fin.opportunities.map((o) => ({ id: o.id, title: o.title, type: o.type, status: o.status, departmentName: o.departmentName, realizableAnnual: o.realizableAnnualSavings }));
  return (
    <FinanceClient
      saved={model.assumptions}
      initial={{ fin, workflows, months }}
      opportunities={opportunities}
      canWrite={can(ctx.role, "finance:write")}
      canReports={can(ctx.role, "reports:generate")}
    />
  );
}
