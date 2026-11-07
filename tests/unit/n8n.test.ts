/**
 * n8n adapter tests. There is no live n8n in CI, so `fetch` is mocked and the exact request shapes
 * (method, path, headers, body) are asserted. DB-backed for the integrations/agents/agent_runs rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { encrypt } from "@/lib/crypto";
import { checkConnection, pushWorkflow, triggerViaWebhook, listExecutions, pullExecutionsIntoRunLedger, resolveConfig, convertDefinition, buildWorkflowBody, N8N_NOT_CONFIGURED } from "@/engine/agents/n8n";
import { getTemplate } from "@/engine/agents/templates";

const ids = { org: "", cred: "", agent: "" };
type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
let calls: Call[] = [];
let responder: (c: Call) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const [org] = await db.insert(schema.organizations).values({ name: "n8n Test", slug: `n8n-${Date.now()}`, isDemo: true }).returning();
  ids.org = org.id;
  const [cred] = await db.insert(schema.credentials).values({ orgId: org.id, name: "n8n key", provider: "n8n", secretEnc: encrypt(JSON.stringify({ apiKey: "n8n-key-123" })), fields: ["apiKey"] }).returning();
  ids.cred = cred.id;
  await db.insert(schema.integrations).values({ orgId: org.id, provider: "n8n", status: "configured", credentialId: cred.id, config: { baseUrl: "https://n8n.example.test/" } });
  const t = getTemplate("ap_ar_invoice_intake")!;
  const [ag] = await db.insert(schema.agents).values({ orgId: org.id, name: "AP intake", category: t.category, templateKey: t.key, status: "configured", runtime: "n8n", definition: t.definition, expectedMinutesSavedPerRun: "11", baselineMinutesPerRun: "14" }).returning();
  ids.agent = ag.id;
});
afterAll(async () => { await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org)); });
beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = responder(c);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });
const agent = async () => (await db.select().from(schema.agents).where(eq(schema.agents.id, ids.agent)))[0];
const integration = async () => (await db.select().from(schema.integrations).where(and(eq(schema.integrations.orgId, ids.org), eq(schema.integrations.provider, "n8n"))))[0];

describe("n8n adapter", () => {
  it("resolves config from the integration row + vault, trimming the trailing slash", async () => {
    expect(await resolveConfig(ids.org)).toEqual({ baseUrl: "https://n8n.example.test", apiKey: "n8n-key-123", source: "integration" });
  });

  it("checkConnection: GET /api/v1/workflows?limit=1 with X-N8N-API-KEY; integration status reflects result", async () => {
    responder = () => ({ status: 200, body: { data: [{ id: "1" }] } });
    const ok = await checkConnection(ids.org);
    expect(ok).toEqual({ ok: true, baseUrl: "https://n8n.example.test", source: "integration", workflowCount: 1 });
    expect(calls).toEqual([{ url: "https://n8n.example.test/api/v1/workflows?limit=1", method: "GET", headers: { "X-N8N-API-KEY": "n8n-key-123", accept: "application/json" }, body: undefined }]);
    expect((await integration()).status).toBe("connected");
    responder = () => ({ status: 401, body: { message: "unauthorized" } });
    const bad = await checkConnection(ids.org);
    expect(bad).toEqual({ ok: false, reason: "n8n GET /api/v1/workflows?limit=1 → HTTP 401: unauthorized", status: 401 });
    const row = await integration();
    expect(row.status).toBe("error"); expect(row.lastError).toMatch(/401/); expect(row.lastCheckedAt).toBeTruthy();
  });

  it("pushWorkflow: POST create then POST activate; second push PUTs by externalId", async () => {
    responder = (c) => c.url.endsWith("/activate") ? { status: 200, body: { id: "wf-9", active: true } } : { status: 200, body: { id: "wf-9", active: false } };
    const r = await pushWorkflow(ids.org, await agent());
    expect(r).toEqual({ ok: true, externalId: "wf-9", created: true, active: true });
    expect(calls.map((c) => [c.method, c.url])).toEqual([["POST", "https://n8n.example.test/api/v1/workflows"], ["POST", "https://n8n.example.test/api/v1/workflows/wf-9/activate"]]);
    const body = calls[0].body as { name: string; nodes: { type: string; name: string }[]; connections: Record<string, unknown>; settings: Record<string, unknown> };
    expect(calls[0].headers).toEqual({ "X-N8N-API-KEY": "n8n-key-123", accept: "application/json", "content-type": "application/json" });
    expect(Object.keys(body).sort()).toEqual(["connections", "name", "nodes", "settings"]); // exactly what the public API accepts
    expect(body.name).toBe("BridgeBox — AP intake");
    expect(body.nodes.map((n) => n.type)).toEqual(["n8n-nodes-base.webhook", "n8n-nodes-base.httpRequest", "n8n-nodes-base.set", "n8n-nodes-base.if", "n8n-nodes-base.emailSend", "n8n-nodes-base.httpRequest"]);
    expect(body.connections["Bill received"]).toEqual({ main: [[{ node: "Extract bill fields", type: "main", index: 0 }]] });
    expect(body.connections["Over threshold?"]).toEqual({ main: [[{ node: "Request approval", type: "main", index: 0 }], [{ node: "Create QuickBooks bill", type: "main", index: 0 }]] });
    expect(body.settings).toMatchObject({ executionOrder: "v1" });
    expect((await agent()).externalId).toBe("wf-9");

    calls = [];
    const r2 = await pushWorkflow(ids.org, await agent());
    expect(r2).toEqual({ ok: true, externalId: "wf-9", created: false, active: true });
    expect(calls.map((c) => [c.method, c.url])).toEqual([["PUT", "https://n8n.example.test/api/v1/workflows/wf-9"], ["POST", "https://n8n.example.test/api/v1/workflows/wf-9/activate"]]);
    expect(calls[0].body).toEqual(body);
  });

  it("pushWorkflow: 404 on PUT recreates; activation failure is reported honestly", async () => {
    responder = (c) => c.method === "PUT" ? { status: 404, body: { message: "not found" } } : c.url.endsWith("/activate") ? { status: 400, body: { message: "Workflow has no trigger" } } : { status: 200, body: { id: "wf-10" } };
    const r = await pushWorkflow(ids.org, await agent());
    expect(r).toEqual({ ok: false, reason: "workflow saved as wf-10 but activation failed: n8n POST /api/v1/workflows/wf-10/activate → HTTP 400: Workflow has no trigger", status: 400 });
    expect(calls.map((c) => c.method)).toEqual(["PUT", "POST", "POST"]);
    expect((await agent()).externalId).toBe("wf-10");
  });

  it("triggerViaWebhook posts to /webhook/{path} from the template's webhook node (no API key)", async () => {
    responder = () => ({ status: 200, body: { received: true } });
    const r = await triggerViaWebhook(ids.org, await agent(), { vendor: "Acme", amount: 12 });
    expect(r).toEqual({ ok: true, status: 200, body: { received: true } });
    expect(calls).toEqual([{ url: "https://n8n.example.test/webhook/bridgebox/ap-bill", method: "POST", headers: { "content-type": "application/json" }, body: { vendor: "Acme", amount: 12 } }]);
  });

  it("listExecutions + pullExecutionsIntoRunLedger: GET /api/v1/executions?workflowId=…; idempotent import with status + minutesSaved", async () => {
    const execs = [
      { id: "101", finished: true, mode: "webhook", status: "success", startedAt: "2026-11-01T10:00:00.000Z", stoppedAt: "2026-11-01T10:00:05.000Z", workflowId: "wf-10" },
      { id: "102", finished: true, mode: "webhook", status: "error", startedAt: "2026-11-02T10:00:00.000Z", stoppedAt: "2026-11-02T10:00:02.000Z", workflowId: "wf-10" },
      { id: "103", finished: false, mode: "manual", status: "running", startedAt: "2026-11-03T10:00:00.000Z", workflowId: "wf-10" },
    ];
    responder = () => ({ status: 200, body: { data: execs, nextCursor: null } });
    const l = await listExecutions(ids.org, await agent());
    expect(l).toEqual({ ok: true, executions: execs });
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://n8n.example.test/api/v1/executions?workflowId=wf-10&limit=50&includeData=false", headers: { "X-N8N-API-KEY": "n8n-key-123" } });

    const p1 = await pullExecutionsIntoRunLedger(ids.org, ids.agent);
    expect(p1).toEqual({ ok: true, imported: 3, updated: 0, total: 3 });
    expect(calls[1].url).toContain("limit=100");
    const runs = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.agentId, ids.agent), eq(schema.agentRuns.trigger, "n8n")));
    const byExec = Object.fromEntries(runs.map((r) => [String((r.output as { n8nExecutionId: string }).n8nExecutionId), r]));
    expect(byExec["101"].status).toBe("succeeded"); expect(Number(byExec["101"].minutesSaved)).toBe(11); expect(byExec["101"].finishedAt?.toISOString()).toBe("2026-11-01T10:00:05.000Z");
    expect(byExec["102"].status).toBe("failed"); expect(byExec["102"].minutesSaved).toBeNull();
    expect(byExec["103"].status).toBe("running");

    execs[2] = { ...execs[2], finished: true, status: "success", stoppedAt: "2026-11-03T10:00:09.000Z" };
    const p2 = await pullExecutionsIntoRunLedger(ids.org, ids.agent);
    expect(p2).toEqual({ ok: true, imported: 0, updated: 1, total: 3 });
    const runs2 = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.agentId, ids.agent), eq(schema.agentRuns.trigger, "n8n")));
    expect(runs2).toHaveLength(3);
    expect(runs2.find((r) => (r.output as { n8nExecutionId: string }).n8nExecutionId === "103")?.status).toBe("succeeded");
  });

  it("unconfigured org: every function returns the exact not-configured reason and integration status not_configured", async () => {
    const [org2] = await db.insert(schema.organizations).values({ name: "n8n none", slug: `n8n-none-${Date.now()}`, isDemo: true }).returning();
    const saved = { url: process.env.N8N_BASE_URL, key: process.env.N8N_API_KEY };
    delete process.env.N8N_BASE_URL; delete process.env.N8N_API_KEY;
    try {
      const a = await agent();
      expect(await checkConnection(org2.id)).toEqual({ ok: false, reason: N8N_NOT_CONFIGURED });
      expect(await pushWorkflow(org2.id, a)).toEqual({ ok: false, reason: N8N_NOT_CONFIGURED });
      expect(await triggerViaWebhook(org2.id, a, {})).toEqual({ ok: false, reason: N8N_NOT_CONFIGURED });
      expect(await listExecutions(org2.id, a)).toEqual({ ok: false, reason: N8N_NOT_CONFIGURED });
      expect(N8N_NOT_CONFIGURED).toBe("n8n not configured — set N8N_BASE_URL and N8N_API_KEY or add it in Settings → Integrations");
      expect(calls).toHaveLength(0);
      const [row] = await db.select().from(schema.integrations).where(eq(schema.integrations.orgId, org2.id));
      expect(row.status).toBe("not_configured");
      // env fallback
      process.env.N8N_BASE_URL = "http://env-n8n:5678/"; process.env.N8N_API_KEY = "env-key";
      expect(await resolveConfig(org2.id)).toEqual({ baseUrl: "http://env-n8n:5678", apiKey: "env-key", source: "env" });
    } finally {
      if (saved.url) process.env.N8N_BASE_URL = saved.url; else delete process.env.N8N_BASE_URL;
      if (saved.key) process.env.N8N_API_KEY = saved.key; else delete process.env.N8N_API_KEY;
      await db.delete(schema.organizations).where(eq(schema.organizations.id, org2.id));
    }
  });

  it("convertDefinition maps a non-template definition to n8n nodes + connections with false/rejected on output 1", () => {
    const t = getTemplate("data_entry_form_to_system")!;
    const wf = convertDefinition("Form entry", "agent-1", t.definition);
    expect(wf.nodes.map((n) => n.type)).toEqual(["n8n-nodes-base.webhook", "n8n-nodes-base.set", "n8n-nodes-base.if", "n8n-nodes-base.httpRequest", "n8n-nodes-base.noOp", "n8n-nodes-base.noOp"]);
    expect(wf.connections["Has email?"]).toEqual({ main: [[{ node: "Create record", type: "main", index: 0 }], [{ node: "Done", type: "main", index: 0 }]] });
    expect(buildWorkflowBody({ id: "x", name: "N", templateKey: "nope", definition: t.definition }).name).toBe("BridgeBox — N");
  });
});
