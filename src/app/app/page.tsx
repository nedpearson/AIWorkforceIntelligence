import { and, desc, eq } from "drizzle-orm";
import { ShieldCheck } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { Button, Empty } from "@/components/ui";
import { computeExecutiveModel, computePortfolio, resolveDepartmentFilter, sanitizeOverrides } from "@/engine/exports";
import { CommandCenter } from "@/components/command/command-center";
import { PortfolioCommandCenter } from "@/components/command/portfolio";

export const metadata = { title: "Executive Command Center" };
export const dynamic = "force-dynamic";

type SP = { scenario?: string; period?: string; from?: string; to?: string; bu?: string; dept?: string; loc?: string; view?: string };
const DAY = 86_400_000;

export default async function CommandCenterPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireCtx();
  if (!can(ctx.role, "finance:read")) {
    return <Empty title="Your workspace" body="The executive command center shows organization-wide financial figures, which your role does not include. You can review exactly what is collected about your own work on the Trust & Privacy page." action={<Button href="/app/trust" data-testid="cmd-trust"><ShieldCheck size={15} />Trust & Privacy</Button>} />;
  }
  if (ctx.orgKind === "consultancy") {
    const portfolio = await computePortfolio(ctx.orgId, 25);
    return <PortfolioCommandCenter portfolio={portfolio} orgName={ctx.orgName} />;
  }

  const sp = await searchParams;
  const period = sp.period === "30" || sp.period === "90" ? sp.period : "365";
  const to = sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? new Date(sp.to + "T23:59:59Z") : new Date();
  const from = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? new Date(sp.from + "T00:00:00Z") : new Date(to.getTime() - Number(period) * DAY);
  const overrides = sanitizeOverrides({ scenario: sp.scenario, periodStart: from < to ? from : new Date(to.getTime() - Number(period) * DAY), periodEnd: to });

  const [model, rows] = await Promise.all([
    computeExecutiveModel(ctx.orgId, overrides),
    withTenant(ctx.orgId, (tx) => tx.select().from(schema.dashboardViews).where(and(eq(schema.dashboardViews.orgId, ctx.orgId), eq(schema.dashboardViews.userId, ctx.userId), eq(schema.dashboardViews.page, "command"))).orderBy(desc(schema.dashboardViews.createdAt))),
  ]);
  const def = rows.find((r) => r.isDefault);
  const active = sp.view ? rows.find((r) => r.id === sp.view && !r.isDefault) : undefined;
  const layoutSrc = active?.layout?.order?.length ? active.layout : def?.layout;
  const layout = { hidden: layoutSrc?.hidden ?? [], order: layoutSrc?.order ?? [] };
  const deptFilter = resolveDepartmentFilter(model, { bu: sp.bu, dept: sp.dept, loc: sp.loc });

  return (
    <CommandCenter model={model} deptFilter={deptFilter ? [...deptFilter] : null} period={period} layout={layout}
      views={rows.filter((r) => !r.isDefault).map((r) => ({ id: r.id, name: r.name, filters: r.filters }))} activeViewId={active?.id ?? null}
      perms={{ canPdf: can(ctx.role, "reports:generate"), canWriteAgents: can(ctx.role, "agents:write") }} />
  );
}
