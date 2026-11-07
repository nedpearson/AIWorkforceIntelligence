import { and, desc, eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { num } from "@/lib/utils";
import { AGENT_TEMPLATES, BUSINESS_FUNCTIONS, agentFunction } from "@/engine/agents/templates";
import { TEST_TRIGGER } from "@/engine/agents/runner-constants";
import { describeCron } from "@/engine/agents/cron";
import { AutomationStudio, type GalleryCard, type FlowRow, type TestRunRow } from "./studio";

export const metadata = { title: "Automation Studio" };
export const dynamic = "force-dynamic";

/** Apps that appear in almost every workflow — a match on these alone is not meaningful. */
const GENERIC_APPS = new Set(["excel", "outlook", "chrome", "word", "gmail", "teams", "slack", "powerpoint", "adobe acrobat"]);

export default async function AutomationPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("agents:read");
  const sp = await searchParams;
  const d = await withTenant(ctx.orgId, async (tx) => {
    const opps = await tx.select({ id: schema.opportunities.id, title: schema.opportunities.title, category: schema.opportunities.recommendedAgentCategory, workflowId: schema.opportunities.workflowId, realizable: schema.opportunities.realizableAnnualSavings, status: schema.opportunities.status, basis: schema.opportunities.basis }).from(schema.opportunities).where(eq(schema.opportunities.orgId, ctx.orgId));
    const wfs = await tx.select({ id: schema.workflows.id, name: schema.workflows.name, steps: schema.workflows.steps, hoursPerWeek: schema.workflows.hoursPerWeek }).from(schema.workflows).where(eq(schema.workflows.orgId, ctx.orgId));
    const creds = await tx.select({ provider: schema.credentials.provider }).from(schema.credentials).where(eq(schema.credentials.orgId, ctx.orgId));
    const agents = await tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, templateKey: schema.agents.templateKey, category: schema.agents.category, runtime: schema.agents.runtime, definition: schema.agents.definition, updatedAt: schema.agents.updatedAt }).from(schema.agents).where(eq(schema.agents.orgId, ctx.orgId)).orderBy(desc(schema.agents.updatedAt));
    const tests = await tx.select({ id: schema.agentRuns.id, agentId: schema.agentRuns.agentId, status: schema.agentRuns.status, createdAt: schema.agentRuns.createdAt, error: schema.agentRuns.error, logs: schema.agentRuns.logs }).from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, ctx.orgId), eq(schema.agentRuns.trigger, TEST_TRIGGER))).orderBy(desc(schema.agentRuns.createdAt)).limit(200);
    return { opps, wfs, creds, agents, tests };
  });
  const haveProviders = new Set(d.creds.map((c) => c.provider));
  const wfApps = d.wfs.map((w) => ({ id: w.id, name: w.name, hours: num(w.hoursPerWeek), apps: new Set((w.steps ?? []).map((s) => s.app.toLowerCase())) }));
  const wfName = new Map(d.wfs.map((w) => [w.id, w.name]));

  const cards: GalleryCard[] = AGENT_TEMPLATES.map((t) => {
    const tApps = t.apps.map((a) => a.toLowerCase());
    const matchedWorkflows = wfApps.map((w) => { const hit = tApps.filter((a) => w.apps.has(a)); const specific = hit.filter((a) => !GENERIC_APPS.has(a)); return { w, hit, ok: specific.length >= 1 || hit.length >= 2 }; })
      .filter((x) => x.ok).sort((a, b) => b.hit.length - a.hit.length || b.w.hours - a.w.hours).map((x) => ({ id: x.w.id, name: x.w.name, apps: x.hit, hoursPerWeek: x.w.hours }));
    const matchedOpps = d.opps.filter((o) => o.category === t.category && o.status !== "rejected").map((o) => ({ id: o.id, title: o.title, realizable: num(o.realizable), workflow: o.workflowId ? wfName.get(o.workflowId) ?? null : null, basis: o.basis }));
    const gates = t.definition.nodes.filter((n) => n.type === "approval").map((n) => String(n.config.action ?? n.label));
    const writes = t.definition.nodes.filter((n) => n.type === "action");
    return {
      key: t.key, name: t.name, description: t.description, fn: t.fn, useCase: t.useCase, category: t.category, runtime: t.runtime, nodeCount: t.definition.nodes.length,
      schedule: t.definition.schedule ? describeCron(t.definition.schedule) : null, baselineMinutesPerRun: t.baselineMinutesPerRun, expectedMinutesSavedPerRun: t.expectedMinutesSavedPerRun, monthlyCost: t.monthlyCost,
      connections: t.requiredCredentials.map((c) => ({ provider: c.provider, label: c.label, have: haveProviders.has(c.provider) })),
      gates, writes: writes.length, undoable: writes.filter((w) => w.compensate).length, llm: t.definition.nodes.some((n) => n.type === "llm"),
      matchedWorkflows: matchedWorkflows.slice(0, 5), matchedWorkflowCount: matchedWorkflows.length, matchedOpps, apps: t.apps,
    };
  });
  const lastTestBy = new Map<string, (typeof d.tests)[number]>();
  for (const r of d.tests) if (!lastTestBy.has(r.agentId)) lastTestBy.set(r.agentId, r);
  const agentName = new Map(d.agents.map((a) => [a.id, a.name]));
  const flows: FlowRow[] = d.agents.map((a) => {
    const lt = lastTestBy.get(a.id);
    return { id: a.id, name: a.name, status: a.status, runtime: a.runtime, fn: agentFunction(a), templateKey: a.templateKey, nodes: a.definition.nodes.length, edges: a.definition.edges.length, gates: a.definition.nodes.filter((n) => n.type === "approval").length, schedule: a.definition.schedule ? describeCron(a.definition.schedule) : null, updatedAt: a.updatedAt.toISOString(), lastTest: lt ? { id: lt.id, status: lt.status, at: lt.createdAt.toISOString() } : null };
  });
  const tests: TestRunRow[] = d.tests.slice(0, 12).map((r) => ({ id: r.id, agentId: r.agentId, agentName: agentName.get(r.agentId) ?? "Agent", status: r.status, at: r.createdAt.toISOString(), error: r.error, steps: (r.logs ?? []).length, requests: (r.logs ?? []).filter((l) => /^Dry run: would send/.test(l.msg)).length }));

  const fn = sp.category && BUSINESS_FUNCTIONS.some((f) => f.key === sp.category) ? sp.category : "";
  const match = sp.match === "matched" || sp.match === "ready" ? sp.match : "";
  const filteredCards = cards.filter((c) => (!fn || c.fn === fn) && (!match || (match === "matched" ? c.matchedOpps.length + c.matchedWorkflowCount > 0 : c.connections.every((x) => x.have))));
  const filterDefs = [
    { key: "category", label: "Business function", all: "All functions", options: BUSINESS_FUNCTIONS.map((f) => ({ value: f.key, label: f.label })) },
    { key: "match", label: "Fit", all: "All templates", options: [{ value: "matched", label: "Matches my workflows / opportunities" }, { value: "ready", label: "All connections in the vault" }] },
  ];
  return <AutomationStudio cards={filteredCards} totalTemplates={cards.length} flows={flows} tests={tests} filterDefs={filterDefs}
    stats={{ matched: cards.filter((c) => c.matchedOpps.length + c.matchedWorkflowCount > 0).length, ready: cards.filter((c) => c.connections.every((x) => x.have)).length, opportunities: d.opps.length, workflows: d.wfs.length }}
    canWrite={can(ctx.role, "agents:write")} />;
}
