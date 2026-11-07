import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ShieldCheck } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { Button, Empty } from "@/components/ui";
import { computeExecutiveModel, computePortfolio, resolveDepartmentFilter, sanitizeOverrides } from "@/engine/exports";
import { CommandCenter } from "@/components/command/command-center";
import { PortfolioCommandCenter } from "@/components/command/portfolio";
import { HomeBand, type HomeBandData } from "@/components/assistant/home-band";
import { PERSONAS } from "@/engine/workforce/personas";

/** Live counts for the five-entry-point band (Simple mode). Financial values come from the same executive model as the Command Center. */
async function homeBandData(orgId: string, role: Parameters<typeof can>[0], model?: { counts: { workflows: number; opportunities: number }; tracker: { deployedAgents: number }; savings: { tiers: { verifiedTime: { amount: number }; realizedHard: { amount: number } } } }): Promise<HomeBandData> {
  const r = await withTenant(orgId, async (tx) => {
    const [team] = await tx.select({ n: sql<number>`count(*)::int`, working: sql<number>`count(*) filter (where ${schema.aiEmployees.status} in ('pilot','active'))::int` }).from(schema.aiEmployees).where(and(eq(schema.aiEmployees.orgId, orgId), inArray(schema.aiEmployees.status, ["draft", "sandbox", "pilot", "active", "paused"])));
    const [demos] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.skillRuns).where(and(eq(schema.skillRuns.orgId, orgId), eq(schema.skillRuns.mode, "sandbox")));
    const counts = model ? null : (await tx.execute(sql`select (select count(*) from workflows where org_id = ${orgId})::int as wf, (select count(*) from opportunities where org_id = ${orgId})::int as opp, (select count(*) from agents where org_id = ${orgId} and status = 'deployed')::int as dep`) as unknown as { wf: number; opp: number; dep: number }[])[0];
    return { team, demos, counts };
  });
  return {
    workflows: model?.counts.workflows ?? r.counts?.wf ?? 0, opportunities: model?.counts.opportunities ?? r.counts?.opp ?? 0,
    aiTeam: r.team?.n ?? 0, personasAvailable: PERSONAS.length, portraits: PERSONAS.filter((p) => p.portrait).map((p) => ({ key: p.key, name: p.firstName, src: p.portrait! })),
    demoRuns: r.demos?.n ?? 0, demosAvailable: PERSONAS.length,
    working: r.team?.working ?? 0, deployedAgents: model?.tracker.deployedAgents ?? r.counts?.dep ?? 0,
    verifiedAnnual: model ? model.savings.tiers.verifiedTime.amount : null, hardSavings: model ? model.savings.tiers.realizedHard.amount : null,
    canFinance: can(role, "finance:read"), canAgents: can(role, "agents:read"),
  };
}

export const metadata = { title: "Executive Command Center" };
export const dynamic = "force-dynamic";

type SP = { scenario?: string; period?: string; from?: string; to?: string; bu?: string; dept?: string; loc?: string; view?: string };
const DAY = 86_400_000;

export default async function CommandCenterPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireCtx();
  if (!can(ctx.role, "finance:read")) {
    const band = can(ctx.role, "workflows:read") ? await homeBandData(ctx.orgId, ctx.role) : null;
    return <>{band && <HomeBand d={band} />}<Empty title="Your workspace" body="The executive command center shows organization-wide financial figures, which your role does not include. You can review exactly what is collected about your own work on the Trust & Privacy page." action={<Button href="/app/trust" data-testid="cmd-trust"><ShieldCheck size={15} />Trust & Privacy</Button>} /></>;
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
  const band = await homeBandData(ctx.orgId, ctx.role, model);

  return (<>
    <HomeBand d={band} />
    <CommandCenter model={model} deptFilter={deptFilter ? [...deptFilter] : null} period={period} layout={layout}
      views={rows.filter((r) => !r.isDefault).map((r) => ({ id: r.id, name: r.name, filters: r.filters }))} activeViewId={active?.id ?? null}
      perms={{ canPdf: can(ctx.role, "reports:generate"), canWriteAgents: can(ctx.role, "agents:write") }} />
  </>);
}
