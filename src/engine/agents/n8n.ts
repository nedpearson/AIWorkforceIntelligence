/**
 * n8n adapter — talks to the n8n public REST API (https://docs.n8n.io/api/).
 *   GET  {base}/api/v1/workflows?limit=1                 connection check
 *   POST {base}/api/v1/workflows                         create   { name, nodes, connections, settings }
 *   PUT  {base}/api/v1/workflows/{id}                    update   (same body)
 *   POST {base}/api/v1/workflows/{id}/activate           activate
 *   GET  {base}/api/v1/executions?workflowId=..&limit=.. list executions { data: [...], nextCursor }
 *   POST {base}/webhook/{path}                           trigger a workflow whose first node is a Webhook
 * Auth header: X-N8N-API-KEY.
 *
 * Config: the org's `integrations` row (provider 'n8n', config.baseUrl, credentialId → vault secret { apiKey }),
 * falling back to env N8N_BASE_URL / N8N_API_KEY. No live n8n is available in CI: tests mock fetch and assert
 * the exact request shapes (tests/unit/n8n.test.ts). See docs/INTEGRATIONS.md.
 */
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { decrypt } from "@/lib/crypto";
import type { AgentDefinition } from "@/db/schema";
import { getTemplate, type N8nWorkflowJson } from "./templates";

export const N8N_NOT_CONFIGURED = "n8n not configured — set N8N_BASE_URL and N8N_API_KEY or add it in Settings → Integrations";
type Agent = typeof schema.agents.$inferSelect;
export type N8nConfig = { baseUrl: string; apiKey: string; source: "integration" | "env" };
export type N8nResult<T> = { ok: true } & T | { ok: false; reason: string; status?: number };
export type N8nExecution = { id: string; finished?: boolean; mode?: string; status?: string; startedAt?: string; stoppedAt?: string; workflowId?: string };

export async function resolveConfig(orgId: string): Promise<N8nConfig | null> {
  const row = await withTenant(orgId, async (tx) => (await tx.select().from(schema.integrations).where(and(eq(schema.integrations.orgId, orgId), eq(schema.integrations.provider, "n8n"))).limit(1))[0]);
  const baseUrl = String((row?.config as Record<string, unknown> | null)?.baseUrl ?? "").replace(/\/+$/, "");
  if (row && baseUrl && row.credentialId) {
    const cred = await withTenant(orgId, async (tx) => (await tx.select().from(schema.credentials).where(and(eq(schema.credentials.id, row.credentialId!), eq(schema.credentials.orgId, orgId))).limit(1))[0]);
    if (cred) {
      let apiKey = "";
      try { const s = JSON.parse(decrypt(cred.secretEnc)); apiKey = String(s.apiKey ?? s.token ?? s.value ?? ""); } catch { apiKey = decrypt(cred.secretEnc); }
      if (apiKey) return { baseUrl, apiKey, source: "integration" };
    }
  }
  if (process.env.N8N_BASE_URL && process.env.N8N_API_KEY) return { baseUrl: process.env.N8N_BASE_URL.replace(/\/+$/, ""), apiKey: process.env.N8N_API_KEY, source: "env" };
  return null;
}

async function api<T>(cfg: N8nConfig, method: string, path: string, body?: unknown): Promise<N8nResult<{ data: T }>> {
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method, headers: { "X-N8N-API-KEY": cfg.apiKey, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data: unknown = text; try { data = text ? JSON.parse(text) : null; } catch { /* text */ }
    if (!res.ok) return { ok: false, reason: `n8n ${method} ${path} → HTTP ${res.status}: ${typeof data === "object" && data && "message" in data ? String((data as { message: unknown }).message) : text.slice(0, 200)}`, status: res.status };
    return { ok: true, data: data as T };
  } catch (e) { return { ok: false, reason: `n8n unreachable: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** Live check; updates integrations.status (connected | error | not_configured). */
export async function checkConnection(orgId: string): Promise<N8nResult<{ baseUrl: string; source: string; workflowCount?: number }>> {
  const cfg = await resolveConfig(orgId);
  if (!cfg) { await setStatus(orgId, "not_configured", N8N_NOT_CONFIGURED); return { ok: false, reason: N8N_NOT_CONFIGURED }; }
  const r = await api<{ data?: unknown[] }>(cfg, "GET", "/api/v1/workflows?limit=1");
  if (!r.ok) { await setStatus(orgId, "error", r.reason); return r; }
  await setStatus(orgId, "connected", null, cfg);
  return { ok: true, baseUrl: cfg.baseUrl, source: cfg.source, workflowCount: Array.isArray(r.data?.data) ? r.data.data.length : undefined };
}

async function setStatus(orgId: string, status: "connected" | "error" | "not_configured", lastError: string | null, cfg?: N8nConfig) {
  await withTenant(orgId, async (tx) => {
    const [row] = await tx.select({ id: schema.integrations.id, config: schema.integrations.config }).from(schema.integrations).where(and(eq(schema.integrations.orgId, orgId), eq(schema.integrations.provider, "n8n"))).limit(1);
    const config = { ...((row?.config as Record<string, unknown>) ?? {}), ...(cfg?.source === "env" ? { baseUrl: cfg.baseUrl, source: "env" } : {}) };
    if (row) await tx.update(schema.integrations).set({ status, lastError, lastCheckedAt: new Date(), config, updatedAt: new Date() }).where(eq(schema.integrations.id, row.id));
    else await tx.insert(schema.integrations).values({ orgId, provider: "n8n", status, lastError, lastCheckedAt: new Date(), config });
  });
}

/** Build the n8n workflow body for an agent: template export if present, else a conversion of its definition. */
export function buildWorkflowBody(agent: Pick<Agent, "name" | "templateKey" | "definition" | "id">): N8nWorkflowJson {
  const t = getTemplate(agent.templateKey);
  if (t?.n8nWorkflowJson) return { ...t.n8nWorkflowJson, name: `BridgeBox — ${agent.name}` };
  return convertDefinition(agent.name, agent.id, agent.definition);
}
/** Generic conversion of an AgentDefinition into n8n nodes. LLM/approval nodes become NoOp placeholders the n8n user fills in. */
export function convertDefinition(name: string, agentId: string, def: AgentDefinition): N8nWorkflowJson {
  const nodes = def.nodes.map((n, i) => {
    const pos: [number, number] = [i * 220, 0];
    switch (n.type) {
      case "trigger": return n.config.source === "schedule" && def.schedule
        ? { parameters: { rule: { interval: [{ field: "cronExpression", expression: def.schedule }] } }, id: n.id, name: n.label, type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: pos }
        : { parameters: { httpMethod: "POST", path: `bridgebox/${agentId}`, responseMode: "onReceived", options: {} }, id: n.id, name: n.label, type: "n8n-nodes-base.webhook", typeVersion: 2, position: pos, webhookId: `bridgebox-${agentId}` };
      case "http": case "action":
        return { parameters: { method: String(n.config.method ?? "GET"), url: String(n.config.url ?? ""), sendBody: n.config.body != null, specifyBody: "json", jsonBody: n.config.body != null ? JSON.stringify(n.config.body) : undefined, options: { timeout: 15000 } }, id: n.id, name: n.label, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos };
      case "condition":
        return { parameters: { conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose" }, conditions: [{ id: `c-${n.id}`, leftValue: `={{ $json.${String(n.config.left ?? "").replace(/^(input|nodes\.[^.]+)\./, "")} }}`, rightValue: n.config.right ?? "", operator: { type: typeof n.config.right === "number" ? "number" : "string", operation: String(n.config.op ?? "exists") } }], combinator: "and" }, options: {} }, id: n.id, name: n.label, type: "n8n-nodes-base.if", typeVersion: 2, position: pos };
      case "transform":
        return { parameters: { assignments: { assignments: Object.entries((n.config.mapping ?? {}) as Record<string, string>).map(([k, v], j) => ({ id: `a${j}`, name: k, value: `={{ $json.${String(v).replace(/^(input|nodes\.[^.]+)\./, "")} }}`, type: "string" })) }, options: {} }, id: n.id, name: n.label, type: "n8n-nodes-base.set", typeVersion: 3.4, position: pos };
      default:
        return { parameters: {}, id: n.id, name: n.label, type: "n8n-nodes-base.noOp", typeVersion: 1, position: pos, notes: `BridgeBox ${n.type} node — configure in n8n (${JSON.stringify(n.config).slice(0, 200)})` };
    }
  });
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const connections: Record<string, { main: { node: string; type: string; index: number }[][] }> = {};
  for (const e of def.edges) {
    const from = byId.get(e.from), to = byId.get(e.to); if (!from || !to) continue;
    const idx = e.when === "false" || e.when === "rejected" ? 1 : 0;
    connections[from.label] ??= { main: [] };
    while (connections[from.label].main.length <= idx) connections[from.label].main.push([]);
    connections[from.label].main[idx].push({ node: to.label, type: "main", index: 0 });
  }
  return { name: `BridgeBox — ${name}`, nodes, connections, settings: { executionOrder: "v1" } };
}

/** Create or update (by agent.externalId) the n8n workflow, then activate it. Stores externalId on the agent. */
export async function pushWorkflow(orgId: string, agent: Agent): Promise<N8nResult<{ externalId: string; created: boolean; active: boolean }>> {
  const cfg = await resolveConfig(orgId);
  if (!cfg) return { ok: false, reason: N8N_NOT_CONFIGURED };
  const body = buildWorkflowBody(agent);
  const payload = { name: body.name, nodes: body.nodes, connections: body.connections, settings: body.settings ?? { executionOrder: "v1" } };
  let externalId = agent.externalId ?? null; let created = false;
  if (externalId) {
    const r = await api<{ id: string }>(cfg, "PUT", `/api/v1/workflows/${encodeURIComponent(externalId)}`, payload);
    if (!r.ok && r.status === 404) externalId = null; else if (!r.ok) return r;
  }
  if (!externalId) {
    const r = await api<{ id: string }>(cfg, "POST", "/api/v1/workflows", payload);
    if (!r.ok) return r;
    externalId = String(r.data.id); created = true;
  }
  const act = await api<{ active: boolean }>(cfg, "POST", `/api/v1/workflows/${encodeURIComponent(externalId)}/activate`);
  await withTenant(orgId, (tx) => tx.update(schema.agents).set({ externalId, updatedAt: new Date() }).where(and(eq(schema.agents.id, agent.id), eq(schema.agents.orgId, orgId))));
  if (!act.ok) return { ok: false, reason: `workflow saved as ${externalId} but activation failed: ${act.reason}`, status: act.status };
  return { ok: true, externalId, created, active: !!act.data?.active };
}

export function webhookPath(agent: Pick<Agent, "templateKey" | "id">): string {
  const t = getTemplate(agent.templateKey);
  const wh = t?.n8nWorkflowJson?.nodes.find((n) => n.type === "n8n-nodes-base.webhook") as { parameters?: { path?: string } } | undefined;
  return wh?.parameters?.path ?? `bridgebox/${agent.id}`;
}
/** POST the payload to the workflow's production webhook URL. Works only after pushWorkflow has activated it. */
export async function triggerViaWebhook(orgId: string, agent: Agent, payload: Record<string, unknown>): Promise<N8nResult<{ status: number; body: unknown }>> {
  const cfg = await resolveConfig(orgId);
  if (!cfg) return { ok: false, reason: N8N_NOT_CONFIGURED };
  if (!agent.externalId) return { ok: false, reason: "push the workflow to n8n first (no externalId on this agent)" };
  try {
    const res = await fetch(`${cfg.baseUrl}/webhook/${webhookPath(agent)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
    const text = await res.text(); let body: unknown = text; try { body = text ? JSON.parse(text) : null; } catch { /* text */ }
    if (!res.ok) return { ok: false, reason: `webhook HTTP ${res.status}: ${text.slice(0, 200)}`, status: res.status };
    return { ok: true, status: res.status, body };
  } catch (e) { return { ok: false, reason: `webhook unreachable: ${e instanceof Error ? e.message : String(e)}` }; }
}

export async function listExecutions(orgId: string, agent: Agent, limit = 50): Promise<N8nResult<{ executions: N8nExecution[] }>> {
  const cfg = await resolveConfig(orgId);
  if (!cfg) return { ok: false, reason: N8N_NOT_CONFIGURED };
  if (!agent.externalId) return { ok: false, reason: "push the workflow to n8n first (no externalId on this agent)" };
  const r = await api<{ data?: N8nExecution[] }>(cfg, "GET", `/api/v1/executions?workflowId=${encodeURIComponent(agent.externalId)}&limit=${limit}&includeData=false`);
  if (!r.ok) return r;
  return { ok: true, executions: r.data?.data ?? [] };
}

const STATUS_MAP: Record<string, typeof schema.agentRuns.$inferInsert["status"]> = { success: "succeeded", error: "failed", crashed: "failed", canceled: "cancelled", waiting: "awaiting_approval", running: "running", new: "queued", unknown: "failed" };
/** Pull n8n executions into agent_runs (idempotent on execution id). minutesSaved = agent expectation on success. */
export async function pullExecutionsIntoRunLedger(orgId: string, agentId: string): Promise<N8nResult<{ imported: number; updated: number; total: number }>> {
  const agent = await withTenant(orgId, async (tx) => (await tx.select().from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId))).limit(1))[0]);
  if (!agent) return { ok: false, reason: "agent not found" };
  const r = await listExecutions(orgId, agent, 100);
  if (!r.ok) return r;
  const existing = await withTenant(orgId, (tx) => tx.select({ id: schema.agentRuns.id, output: schema.agentRuns.output, status: schema.agentRuns.status }).from(schema.agentRuns).where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.agentId, agentId), eq(schema.agentRuns.trigger, "n8n"))).orderBy(desc(schema.agentRuns.createdAt)).limit(500));
  const byExec = new Map(existing.map((e) => [String((e.output as Record<string, unknown> | null)?.n8nExecutionId ?? ""), e]));
  let imported = 0, updated = 0;
  for (const ex of r.executions) {
    const status = STATUS_MAP[String(ex.status ?? (ex.finished ? "success" : "running"))] ?? "failed";
    const minutesSaved = status === "succeeded" ? String(agent.expectedMinutesSavedPerRun ?? "0") : null;
    const startedAt = ex.startedAt ? new Date(ex.startedAt) : null; const finishedAt = ex.stoppedAt ? new Date(ex.stoppedAt) : null;
    const log = { t: new Date().toISOString(), level: "info" as const, msg: `Imported from n8n execution ${ex.id} (mode ${ex.mode ?? "?"}, status ${ex.status ?? "?"})` };
    const prev = byExec.get(String(ex.id));
    await withTenant(orgId, async (tx) => {
      if (prev) { if (prev.status !== status) { await tx.update(schema.agentRuns).set({ status, minutesSaved, finishedAt, logs: [log] }).where(eq(schema.agentRuns.id, prev.id)); updated++; } return; }
      await tx.insert(schema.agentRuns).values({ orgId, agentId, status, trigger: "n8n", input: {}, output: { n8nExecutionId: String(ex.id), mode: ex.mode, n8nStatus: ex.status }, logs: [log], minutesSaved, humanMinutes: "0", startedAt, finishedAt, createdAt: startedAt ?? new Date() });
      imported++;
    });
  }
  if (r.executions.length) await withTenant(orgId, (tx) => tx.update(schema.agents).set({ lastRunAt: new Date() }).where(eq(schema.agents.id, agentId)));
  return { ok: true, imported, updated, total: r.executions.length };
}
