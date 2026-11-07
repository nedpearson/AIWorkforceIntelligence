import { and, eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { AGENT_TEMPLATES, recommendTemplate } from "@/engine/agents/templates";
import { resolveConfig } from "@/engine/agents/n8n";
import { NewAgent, type TemplateCard } from "./new-agent";

export const metadata = { title: "New agent" };
export const dynamic = "force-dynamic";

export default async function NewAgentPage({ searchParams }: { searchParams: Promise<{ opportunityId?: string; template?: string }> }) {
  const ctx = await requireCtx("agents:write");
  const sp = await searchParams;
  const data = await withTenant(ctx.orgId, async (tx) => {
    const creds = await tx.select({ id: schema.credentials.id, name: schema.credentials.name, provider: schema.credentials.provider }).from(schema.credentials).where(eq(schema.credentials.orgId, ctx.orgId));
    const opps = await tx.select({ id: schema.opportunities.id, title: schema.opportunities.title, workflowId: schema.opportunities.workflowId, recommendedAgentCategory: schema.opportunities.recommendedAgentCategory, status: schema.opportunities.status, realizable: schema.opportunities.realizableAnnualSavings }).from(schema.opportunities).where(eq(schema.opportunities.orgId, ctx.orgId));
    const wfs = await tx.select({ id: schema.workflows.id, name: schema.workflows.name, steps: schema.workflows.steps }).from(schema.workflows).where(eq(schema.workflows.orgId, ctx.orgId));
    const [n8n] = await tx.select({ status: schema.integrations.status, lastError: schema.integrations.lastError }).from(schema.integrations).where(and(eq(schema.integrations.orgId, ctx.orgId), eq(schema.integrations.provider, "n8n"))).limit(1);
    return { creds, opps, wfs, n8n };
  });
  const opp = sp.opportunityId ? data.opps.find((o) => o.id === sp.opportunityId) ?? null : null;
  const wf = opp?.workflowId ? data.wfs.find((w) => w.id === opp.workflowId) ?? null : null;
  const recommended = sp.template ?? (opp ? recommendTemplate(opp, wf).key : null);
  const templates: TemplateCard[] = AGENT_TEMPLATES.map((t) => ({ key: t.key, category: t.category, name: t.name, description: t.description, runtime: t.runtime, monthlyCost: t.monthlyCost, baselineMinutesPerRun: t.baselineMinutesPerRun, expectedMinutesSavedPerRun: t.expectedMinutesSavedPerRun, requiredCredentials: t.requiredCredentials, hasN8n: !!t.n8nWorkflowJson, nodeCount: t.definition.nodes.length, schedule: t.definition.schedule ?? null }));
  const n8nConfigured = !!(await resolveConfig(ctx.orgId));
  return <NewAgent templates={templates} recommendedKey={recommended} credentials={data.creds} opportunities={data.opps.map((o) => ({ id: o.id, title: o.title, workflowId: o.workflowId, realizable: Number(o.realizable) }))} workflows={data.wfs.map((w) => ({ id: w.id, name: w.name }))} initialOpportunityId={opp?.id ?? null} n8n={{ configured: n8nConfigured, status: data.n8n?.status ?? "not_configured", lastError: data.n8n?.lastError ?? null }} canCreds={can(ctx.role, "credentials:manage")} />;
}
