import { and, eq, sql } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { num } from "@/lib/utils";
import { computeAgentPortfolio, portfolioKpis } from "@/engine/agents/portfolio";
import { BUSINESS_FUNCTIONS } from "@/engine/agents/templates";
import { CommandCenter } from "./command-center";

export const metadata = { title: "AI Agent Command Center" };
export const dynamic = "force-dynamic";

const STATUSES = ["draft", "configured", "deployed", "paused", "retired", "error"];

export default async function AgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("agents:read");
  const sp = await searchParams;
  const pf = await computeAgentPortfolio(ctx.orgId, { windowDays: 30 });
  const extra = await withTenant(ctx.orgId, async (tx) => {
    const [pending] = await tx.select({ n: sql<string>`count(*)` }).from(schema.approvals).where(and(eq(schema.approvals.orgId, ctx.orgId), eq(schema.approvals.status, "pending")));
    const [opps] = await tx.select({ n: sql<string>`count(*)` }).from(schema.opportunities).where(eq(schema.opportunities.orgId, ctx.orgId));
    return { pending: num(pending?.n), opportunities: num(opps?.n) };
  });
  // Server-side filtering (URL params are the single source of filter state).
  const category = sp.category && BUSINESS_FUNCTIONS.some((f) => f.key === sp.category) ? sp.category : "";
  const status = sp.status && STATUSES.includes(sp.status) ? sp.status : "";
  const agent = sp.agent && pf.agents.some((a) => a.id === sp.agent) ? sp.agent : "";
  const filtered = pf.agents.filter((a) => (!category || a.fn === category) && (!status || a.status === status) && (!agent || a.id === agent));
  const filterDefs = [
    { key: "category", label: "Business function", all: "All functions", options: BUSINESS_FUNCTIONS.map((f) => ({ value: f.key, label: f.label })) },
    { key: "status", label: "Status", all: "All statuses", options: STATUSES.map((s) => ({ value: s, label: s })) },
    { key: "agent", label: "Agent", all: "All agents", options: pf.agents.map((a) => ({ value: a.id, label: a.name })) },
  ];
  return (
    <CommandCenter portfolio={pf} agents={filtered} kpis={portfolioKpis(filtered, pf.windowDays)} alerts={pf.alerts.filter((x) => filtered.some((a) => a.id === x.agentId))} filterDefs={filterDefs} filtered={!!(category || status || agent)}
      pending={extra.pending} hasOpportunities={extra.opportunities > 0}
      perms={{ write: can(ctx.role, "agents:write"), approve: can(ctx.role, "agents:approve"), creds: can(ctx.role, "credentials:manage") }} />
  );
}
