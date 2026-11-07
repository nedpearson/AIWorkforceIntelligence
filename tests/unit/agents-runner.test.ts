/**
 * Internal agent runtime tests. DB-backed (DATABASE_URL → bridgebox_d). Fixtures are created with the admin
 * handle and removed by org cascade. A local http server stands in for external systems so the http/action
 * nodes, retries and compensation are exercised for real. No live Anthropic key is used: the llm node is
 * asserted to produce the `skipped` marker.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { encrypt } from "@/lib/crypto";
import { AGENT_TEMPLATES, AGENT_CATEGORIES, BUSINESS_FUNCTIONS, getTemplate, recommendTemplate, agentFunction } from "@/engine/agents/templates";
import { recordSavingsFromRunLedger } from "@/engine/finance";
import { computeAgentPortfolio } from "@/engine/agents/portfolio";
import { validateDefinition } from "@/engine/agents/definition";
import { startRun, resumeRun, compare } from "@/engine/agents/runner";
import { measureAgent, beforeAfterComparison, runLedgerSummary } from "@/engine/agents/measure";
import type { AgentDefinition } from "@/db/schema";

const ids = { orgA: "", orgB: "", user: "", credA: "", credB: "" };
const SECRET_A = "tok-A-s3cr3t-value-xyz";
const SECRET_B = "tok-B-other-secret-123";
let server: Server; let base = "";
const received: { method: string; url: string; auth?: string; body: string }[] = [];
let failNext = 0; // number of upcoming /flaky requests to fail with 500

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      received.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      if (req.url?.startsWith("/flaky") && failNext > 0) { failNext--; res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "boom" })); return; }
      if (req.url?.startsWith("/always-fail")) { res.writeHead(503); res.end("down"); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "rec-42", echo: body ? JSON.parse(body) : null, auth: req.headers.authorization ?? null, slot: "2026-11-10T15:00:00Z" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const [a] = await db.insert(schema.organizations).values({ name: "Agents Test A", slug: `agents-a-${Date.now()}`, isDemo: true }).returning();
  const [b] = await db.insert(schema.organizations).values({ name: "Agents Test B", slug: `agents-b-${Date.now()}`, isDemo: true }).returning();
  ids.orgA = a.id; ids.orgB = b.id;
  const [u] = await db.insert(schema.users).values({ email: `agents-${Date.now()}@test.local`, name: "Approver" }).returning();
  ids.user = u.id;
  await db.insert(schema.memberships).values({ userId: u.id, orgId: a.id, role: "admin" });
  const [ca] = await db.insert(schema.credentials).values({ orgId: a.id, name: "API A", provider: "http_bearer", secretEnc: encrypt(JSON.stringify({ baseUrl: base, token: SECRET_A })), fields: ["baseUrl", "token"] }).returning();
  const [cb] = await db.insert(schema.credentials).values({ orgId: b.id, name: "API B", provider: "http_bearer", secretEnc: encrypt(JSON.stringify({ baseUrl: base, token: SECRET_B })), fields: ["baseUrl", "token"] }).returning();
  ids.credA = ca.id; ids.credB = cb.id;
});
afterAll(async () => {
  await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.orgA));
  await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.orgB));
  await db.delete(schema.users).where(eq(schema.users.id, ids.user));
  await new Promise<void>((r) => server.close(() => r()));
});

async function makeAgent(orgId: string, def: AgentDefinition, extra: Partial<typeof schema.agents.$inferInsert> = {}) {
  const [ag] = await db.insert(schema.agents).values({ orgId, name: "T", category: "data_entry", templateKey: "data_entry_form_to_system", status: "deployed", definition: def, credentialIds: [ids.credA], approvalPolicy: { mode: "sensitive_only", timeoutHours: 1 }, expectedMinutesSavedPerRun: "7.5", baselineMinutesPerRun: "10", ...extra }).returning();
  return ag;
}
const run = (id: string) => db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).then((r) => r[0]);

describe("templates", () => {
  it("ships valid templates covering every category and every business-function use case, with realistic graphs", () => {
    expect(AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(39);
    expect(new Set(AGENT_TEMPLATES.map((t) => t.key)).size).toBe(AGENT_TEMPLATES.length);
    expect(new Set(AGENT_TEMPLATES.map((t) => t.category))).toEqual(new Set(AGENT_CATEGORIES));
    for (const f of BUSINESS_FUNCTIONS) for (const u of f.useCases) expect(AGENT_TEMPLATES.some((t) => t.fn === f.key && t.useCase === u), `${f.label} / ${u}`).toBe(true);
    for (const t of AGENT_TEMPLATES) {
      expect(BUSINESS_FUNCTIONS.find((f) => f.key === t.fn)?.useCases, t.key).toContain(t.useCase);
      expect(t.requiredCredentials.length, `${t.key} declares credentials`).toBeGreaterThan(0);
      expect(t.requiredCredentials.filter((c) => c.provider === "http_bearer").length, `${t.key}: at most one http_bearer`).toBeLessThanOrEqual(1);
      // a gate exists wherever the template is customer-facing or moves money: every approval is sensitive
      for (const ap of t.definition.nodes.filter((x) => x.type === "approval")) expect(ap.sensitive).toBe(true);
      const v = validateDefinition(t.definition);
      expect(v.ok, `${t.key}: ${!v.ok ? v.errors.join("; ") : ""}`).toBe(true);
      expect(t.description.length).toBeGreaterThan(80);
      expect(t.monthlyCost).toBeGreaterThan(0);
      expect(t.expectedMinutesSavedPerRun).toBeLessThanOrEqual(t.baselineMinutesPerRun);
      const actions = t.definition.nodes.filter((n) => n.type === "action");
      // every template that changes an external system declares how to undo it
      if (actions.length) expect(actions.some((a) => a.compensate), `${t.key} has a compensable action`).toBe(true);
      // library templates: EVERY external write declares its undo
      if (!["customer_service_reply_drafting", "scheduling_appointment_coordinator", "sales_crm_lead_enrichment", "email_admin_triage", "ap_ar_invoice_intake", "invoice_generation", "reporting_weekly_digest", "inventory_reorder", "marketing_social_drafts", "onboarding_new_hire", "document_summarizer", "data_entry_form_to_system"].includes(t.key))
        for (const a of actions) expect(a.compensate, `${t.key}.${a.id} compensate`).toBeTruthy();
    }
    // originals stay first, so category → template recommendations are unchanged
    expect(AGENT_TEMPLATES.slice(0, 12).map((t) => t.category)).toEqual(["customer_service", "scheduling", "sales_crm", "email_admin", "ap_ar", "invoice", "reporting", "inventory", "marketing", "onboarding", "document", "data_entry"]);
    expect(agentFunction({ templateKey: "sales_meeting_scheduler", category: "scheduling" })).toBe("sales");
    expect(agentFunction({ templateKey: "unknown", category: "scheduling" })).toBe("operations");
    const n8n = AGENT_TEMPLATES.filter((t) => t.n8nWorkflowJson);
    expect(n8n.map((t) => t.category).sort()).toEqual(["ap_ar", "customer_service", "reporting", "scheduling"]);
    for (const t of n8n) { expect(t.n8nWorkflowJson!.nodes.length).toBeGreaterThan(2); expect(Object.keys(t.n8nWorkflowJson!.connections).length).toBeGreaterThan(1); }
  });
  it("recommendTemplate uses recommendedAgentCategory then apps", () => {
    expect(recommendTemplate({ recommendedAgentCategory: "ap_ar" }, null).key).toBe("ap_ar_invoice_intake");
    expect(recommendTemplate({ recommendedAgentCategory: null, title: "Reply to support tickets" }, { steps: [{ app: "Zendesk" }] }).category).toBe("customer_service");
    expect(recommendTemplate(null, { steps: [{ app: "QuickBooks" }, { app: "Outlook" }] }).category).toBe("ap_ar");
    expect(recommendTemplate(null, null).category).toBe("data_entry");
  });
  it("rejects broken definitions", () => {
    const v = validateDefinition({ nodes: [{ id: "a", type: "trigger", label: "x", config: {} }], edges: [{ from: "a", to: "zzz" }] });
    expect(v.ok).toBe(false); if (!v.ok) expect(v.errors.join(" ")).toMatch(/unknown node|end node/);
  });
  it("compare covers operators", () => {
    expect(compare(1200, "gt", 1000)).toBe(true); expect(compare("Refund please", "contains", "refund")).toBe(true);
    expect(compare(undefined, "exists", undefined)).toBe(false); expect(compare("", "exists", undefined)).toBe(false); expect(compare("a", "eq", "a")).toBe(true);
  });
});

describe("runner", () => {
  it("template → agent → approval gate → approve → succeeded with minutesSaved; credential redacted", async () => {
    const t = getTemplate("data_entry_form_to_system")!;
    // Insert an approval before the action so the gate is exercised.
    const def: AgentDefinition = {
      ...t.definition,
      nodes: [...t.definition.nodes.slice(0, 3), { id: "gate", type: "approval", label: "Approve", config: { action: "Create record for {{nodes.map.email}}", reviewMinutes: 3 }, sensitive: true }, ...t.definition.nodes.slice(3)],
      edges: [{ from: "trigger", to: "map" }, { from: "map", to: "valid" }, { from: "valid", to: "gate", when: "true" }, { from: "valid", to: "end", when: "false" }, { from: "gate", to: "create", when: "approved" }, { from: "gate", to: "end", when: "rejected" }, { from: "create", to: "notify" }, { from: "notify", to: "end" }],
    };
    const ag = await makeAgent(ids.orgA, def);
    const r1 = await startRun({ orgId: ids.orgA, agentId: ag.id, input: { firstName: "Dana", lastName: "Kim", email: "dana@example.com", phone: "1", source: "web", orgId: ids.orgB }, actorUserId: ids.user });
    expect(r1.status).toBe("awaiting_approval");
    const row1 = await run(r1.runId);
    expect(row1.status).toBe("awaiting_approval"); expect(row1.currentNodeId).toBe("gate");
    expect((row1.input as Record<string, unknown>).orgId).toBeUndefined(); // orgId never accepted from input
    const [ap] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, r1.runId));
    expect(ap.status).toBe("pending"); expect(ap.requestedAction).toBe("Create record for dana@example.com"); expect(ap.expiresAt).toBeTruthy();

    const r2 = await resumeRun(r1.runId, ap.id, "approved", ids.user, "looks good", ids.orgA);
    expect(r2.status).toBe("succeeded"); expect(r2.minutesSaved).toBe(7.5);
    const row2 = await run(r1.runId);
    expect(row2.status).toBe("succeeded"); expect(Number(row2.minutesSaved)).toBe(7.5); expect(Number(row2.humanMinutes)).toBe(3);
    expect(row2.finishedAt).toBeTruthy();
    const [ap2] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, ap.id));
    expect(ap2.status).toBe("approved"); expect(ap2.decidedBy).toBe(ids.user); expect(ap2.decisionNote).toBe("looks good");
    // external call happened with the bearer token, and the token never appears in logs/output
    const call = received.find((c) => c.url === "/records");
    expect(call?.auth).toBe(`Bearer ${SECRET_A}`);
    expect(JSON.parse(call!.body)).toMatchObject({ name: "Dana", surname: "Kim", email: "dana@example.com" });
    const dump = JSON.stringify({ logs: row2.logs, output: row2.output });
    expect(dump).not.toContain(SECRET_A);
    expect(dump).toContain("[redacted]"); // the http node echoes the Authorization header back in its response body
    expect((row2.logs as { nodeId?: string }[]).map((l) => l.nodeId)).toContain("create");
    const [agAfter] = await db.select().from(schema.agents).where(eq(schema.agents.id, ag.id));
    expect(agAfter.lastRunAt).toBeTruthy();
    const [cred] = await db.select().from(schema.credentials).where(eq(schema.credentials.id, ids.credA));
    expect(cred.lastUsedAt).toBeTruthy();
  });

  it("rejection → cancelled, 0 minutes saved, human minutes recorded", async () => {
    const def: AgentDefinition = { nodes: [
      { id: "trigger", type: "trigger", label: "t", config: {} },
      { id: "gate", type: "approval", label: "g", config: { action: "do it", reviewMinutes: 4 }, sensitive: true },
      { id: "act", type: "action", label: "a", config: { kind: "log", message: "did it" } },
      { id: "end", type: "end", label: "e", config: {} },
    ], edges: [{ from: "trigger", to: "gate" }, { from: "gate", to: "act", when: "approved" }, { from: "act", to: "end" }] };
    const ag = await makeAgent(ids.orgA, def, { approvalPolicy: { mode: "all" } });
    const r1 = await startRun({ orgId: ids.orgA, agentId: ag.id });
    expect(r1.status).toBe("awaiting_approval");
    const [ap] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, r1.runId));
    const r2 = await resumeRun(r1.runId, ap.id, "rejected", ids.user, "nope", ids.orgA);
    expect(r2.status).toBe("cancelled");
    const row = await run(r1.runId);
    expect(row.status).toBe("cancelled"); expect(row.minutesSaved).toBeNull(); expect(Number(row.humanMinutes)).toBe(4);
    expect((row.output as { nodes: Record<string, unknown> }).nodes.act).toBeUndefined();
    const again = await resumeRun(r1.runId, ap.id, "approved", ids.user, undefined, ids.orgA);
    expect(again.error).toMatch(/not awaiting approval/);
  });

  it("approval policy none skips the gate", async () => {
    const def: AgentDefinition = { nodes: [{ id: "trigger", type: "trigger", label: "t", config: {} }, { id: "gate", type: "approval", label: "g", config: {}, sensitive: true }, { id: "end", type: "end", label: "e", config: {} }], edges: [{ from: "trigger", to: "gate" }, { from: "gate", to: "end", when: "approved" }] };
    const ag = await makeAgent(ids.orgA, def, { approvalPolicy: { mode: "none" } });
    const r = await startRun({ orgId: ids.orgA, agentId: ag.id });
    expect(r.status).toBe("succeeded"); expect(r.minutesSaved).toBe(7.5);
  });

  it("http failure with retries → compensate completed action → rolled_back", async () => {
    const def: AgentDefinition = { retries: { max: 2, backoffMs: 10 }, nodes: [
      { id: "trigger", type: "trigger", label: "t", config: {} },
      { id: "create", type: "action", label: "Create record", config: { kind: "http", method: "POST", url: "{{secret.baseUrl}}/records", auth: "bearer", credentialId: ids.credA, body: { x: 1 } }, compensate: { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/records/{{nodes.create.body.id}}", auth: "bearer", credentialId: ids.credA, note: "delete created record" } },
      { id: "flaky", type: "action", label: "Flaky step", config: { kind: "http", method: "POST", url: "{{secret.baseUrl}}/flaky", auth: "bearer", credentialId: ids.credA, body: {} } },
      { id: "down", type: "http", label: "Down service", config: { method: "GET", url: "{{secret.baseUrl}}/always-fail", auth: "bearer", credentialId: ids.credA } },
      { id: "end", type: "end", label: "e", config: {} },
    ], edges: [{ from: "trigger", to: "create" }, { from: "create", to: "flaky" }, { from: "flaky", to: "down" }, { from: "down", to: "end" }] };
    const ag = await makeAgent(ids.orgA, def);
    received.length = 0; failNext = 2; // flaky fails twice then succeeds (within max=2 retries)
    const r = await startRun({ orgId: ids.orgA, agentId: ag.id });
    expect(r.status).toBe("rolled_back");
    const row = await run(r.runId);
    expect(row.status).toBe("rolled_back"); expect(row.error).toMatch(/Down service: HTTP 503/);
    expect(received.filter((c) => c.url === "/flaky")).toHaveLength(3); // 2 failures + 1 success
    expect(received.filter((c) => c.url === "/always-fail")).toHaveLength(3); // 1 + 2 retries
    const del = received.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("/records/rec-42"); expect(del?.auth).toBe(`Bearer ${SECRET_A}`);
    const logs = row.logs as { level: string; msg: string; nodeId?: string }[];
    expect(logs.some((l) => l.msg.includes("Rolled back \"Create record\"") && l.msg.includes("delete created record"))).toBe(true);
    expect(logs.filter((l) => l.nodeId === "flaky" && l.level === "warn")).toHaveLength(2);
    expect((row.output as { nodes: Record<string, unknown> }).nodes["create:compensated"]).toBeTruthy();
    expect(JSON.stringify(row.logs)).not.toContain(SECRET_A);
    expect(row.minutesSaved).toBeNull();
  });

  it("failure with no completed actions → failed (not rolled_back)", async () => {
    const def: AgentDefinition = { retries: { max: 0, backoffMs: 0 }, nodes: [{ id: "trigger", type: "trigger", label: "t", config: {} }, { id: "down", type: "http", label: "Down", config: { method: "GET", url: "{{secret.baseUrl}}/always-fail", credentialId: ids.credA } }, { id: "end", type: "end", label: "e", config: {} }], edges: [{ from: "trigger", to: "down" }, { from: "down", to: "end" }] };
    const ag = await makeAgent(ids.orgA, def);
    const r = await startRun({ orgId: ids.orgA, agentId: ag.id });
    expect(r.status).toBe("failed");
  });

  it("llm node without ANTHROPIC_API_KEY → skipped marker, run continues; transform/condition work", async () => {
    const def: AgentDefinition = { nodes: [
      { id: "trigger", type: "trigger", label: "t", config: {} },
      { id: "llm", type: "llm", label: "Draft", config: { system: "s", prompt: "Hello {{input.name}}" } },
      { id: "tf", type: "transform", label: "Shape", config: { mapping: { who: "input.name", draft: "nodes.llm.text", fixed: "=const" } } },
      { id: "cond", type: "condition", label: "Has draft?", config: { left: "nodes.tf.draft", op: "exists" } },
      { id: "yes", type: "notify", label: "Yes", config: { message: "draft for {{nodes.tf.who}}" } },
      { id: "no", type: "notify", label: "No", config: { message: "no draft for {{nodes.tf.who}}", email: { to: "x@y.z" } } },
      { id: "end", type: "end", label: "e", config: {} },
    ], edges: [{ from: "trigger", to: "llm" }, { from: "llm", to: "tf" }, { from: "tf", to: "cond" }, { from: "cond", to: "yes", when: "true" }, { from: "cond", to: "no", when: "false" }, { from: "yes", to: "end" }, { from: "no", to: "end" }] };
    const ag = await makeAgent(ids.orgA, def);
    const r = await startRun({ orgId: ids.orgA, agentId: ag.id, input: { name: "Ned" } });
    expect(r.status).toBe("succeeded");
    const row = await run(r.runId);
    const nodes = (row.output as { nodes: Record<string, Record<string, unknown>> }).nodes;
    expect(nodes.llm).toEqual({ skipped: "ANTHROPIC_API_KEY not configured", prompt: "Hello Ned" });
    expect(nodes.tf).toEqual({ who: "Ned", draft: undefined, fixed: "const" });
    expect(nodes.cond.result).toBe(false);
    expect(nodes.no.message).toBe("no draft for Ned");
    expect((nodes.no.email as { delivered: boolean }).delivered).toBe(false);
    expect(nodes.yes).toBeUndefined();
  });

  it("cross-tenant: org A run cannot use org B's credential (RLS + explicit filter)", async () => {
    const def: AgentDefinition = { retries: { max: 0, backoffMs: 0 }, nodes: [{ id: "trigger", type: "trigger", label: "t", config: {} }, { id: "h", type: "http", label: "Call", config: { method: "GET", url: `${base}/records`, auth: "bearer", credentialId: ids.credB } }, { id: "end", type: "end", label: "e", config: {} }], edges: [{ from: "trigger", to: "h" }, { from: "h", to: "end" }] };
    const ag = await makeAgent(ids.orgA, def);
    received.length = 0;
    const r = await startRun({ orgId: ids.orgA, agentId: ag.id });
    expect(r.status).toBe("failed"); expect(r.error).toMatch(/credential .* not found in this organization/);
    expect(received).toHaveLength(0);
    expect(JSON.stringify((await run(r.runId)).logs)).not.toContain(SECRET_B);
    // and an agent id from org B cannot be started under org A
    const agB = await makeAgent(ids.orgB, def, { credentialIds: [ids.credB] });
    await expect(startRun({ orgId: ids.orgA, agentId: agB.id })).rejects.toThrow(/agent not found/);
  });

  it("approval expiry cancels the run on decision", async () => {
    const def: AgentDefinition = { nodes: [{ id: "trigger", type: "trigger", label: "t", config: {} }, { id: "gate", type: "approval", label: "g", config: {}, sensitive: true }, { id: "end", type: "end", label: "e", config: {} }], edges: [{ from: "trigger", to: "gate" }, { from: "gate", to: "end", when: "approved" }] };
    const ag = await makeAgent(ids.orgA, def, { approvalPolicy: { mode: "all", timeoutHours: 1 } });
    const r = await startRun({ orgId: ids.orgA, agentId: ag.id });
    const [ap] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, r.runId));
    await db.update(schema.approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.approvals.id, ap.id));
    const r2 = await resumeRun(r.runId, ap.id, "approved", ids.user, undefined, ids.orgA);
    expect(r2.status).toBe("cancelled"); expect(r2.error).toMatch(/expired/);
    expect((await db.select().from(schema.approvals).where(eq(schema.approvals.id, ap.id)))[0].status).toBe("expired");
  });
});

describe("measurement", () => {
  it("measureAgent delegates to the finance engine and summarizes the ledger; beforeAfter returns a CalcTree", async () => {
    const def: AgentDefinition = { nodes: [{ id: "trigger", type: "trigger", label: "t", config: {} }, { id: "end", type: "end", label: "e", config: {} }], edges: [{ from: "trigger", to: "end" }] };
    const [wf] = await db.insert(schema.workflows).values({ orgId: ids.orgA, name: "WF", signature: "a>b", steps: [{ idx: 0, app: "Excel", action: "edit", avgMs: 1000, share: 1 }], hoursPerWeek: "5", basis: "observed" }).returning();
    const ag = await makeAgent(ids.orgA, def, { workflowId: wf.id, deployedAt: new Date(Date.now() - 7 * 86400_000) });
    await startRun({ orgId: ids.orgA, agentId: ag.id }); await startRun({ orgId: ids.orgA, agentId: ag.id });
    const calls: unknown[] = [];
    const period = { start: new Date(Date.now() - 86400_000), end: new Date(Date.now() + 60_000) };
    const res = await measureAgent(ids.orgA, ag.id, period, { recordSavingsFromRunLedger: async (...a) => { calls.push(a); return { id: "m1" }; } });
    expect(calls).toEqual([[ids.orgA, ag.id, period.start, period.end]]);
    expect(res.summary).toMatchObject({ runs: 2, succeeded: 2, minutesSaved: 15, humanMinutes: 0, hoursSaved: 0.25 });
    expect(await runLedgerSummary(ids.orgA, ag.id, { start: new Date(0), end: new Date(1) })).toMatchObject({ runs: 0 });
    const tree = await beforeAfterComparison(ids.orgA, wf.id, ag.deployedAt!);
    expect(tree.unit).toBe("hours"); expect(tree.children).toHaveLength(3); expect(tree.basis).toBe("assumed"); // no events → honest basis
    await expect(measureAgent(ids.orgA, ag.id, { start: period.end, end: period.start }, { recordSavingsFromRunLedger: async () => null })).rejects.toThrow(/period/);
    await expect(beforeAfterComparison(ids.orgB, wf.id, new Date())).rejects.toThrow(/workflow not found/);
  });
});

describe("dry run (test environment)", () => {
  it("never calls out: http / action / notify webhook / compensation log the redacted request; approvals auto-approve; no minutes", async () => {
    const def: AgentDefinition = { retries: { max: 0, backoffMs: 0 }, nodes: [
      { id: "trigger", type: "trigger", label: "t", config: {} },
      { id: "read", type: "http", label: "Read", config: { method: "GET", url: "{{secret.baseUrl}}/records?q={{input.q}}", auth: "bearer", credentialId: ids.credA } },
      { id: "gate", type: "approval", label: "Gate", config: { action: "Create {{input.q}}", reviewMinutes: 5 }, sensitive: true },
      { id: "create", type: "action", label: "Create", config: { kind: "http", method: "POST", url: "{{secret.baseUrl}}/records", auth: "bearer", credentialId: ids.credA, body: { q: "{{input.q}}", token: "{{secret.token}}" } }, compensate: { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/records/x", auth: "bearer", credentialId: ids.credA } },
      { id: "hook", type: "notify", label: "Hook", config: { message: "done {{input.q}}", webhookUrl: `${base}/hook` } },
      { id: "llm", type: "llm", label: "Draft", config: { prompt: "hi" } },
      { id: "nocred", type: "http", label: "Provider without credential", config: { method: "GET", url: "{{secret.baseUrl}}/x", auth: "bearer", tokenField: "token", credentialProvider: "hubspot" } },
      { id: "end", type: "end", label: "e", config: {} },
    ], edges: [{ from: "trigger", to: "read" }, { from: "read", to: "gate" }, { from: "gate", to: "create", when: "approved" }, { from: "create", to: "hook" }, { from: "hook", to: "llm" }, { from: "llm", to: "nocred" }, { from: "nocred", to: "end" }] };
    const ag = await makeAgent(ids.orgA, def, { approvalPolicy: { mode: "all" }, lastRunAt: null });
    const [credBefore] = await db.select({ lastUsedAt: schema.credentials.lastUsedAt }).from(schema.credentials).where(eq(schema.credentials.id, ids.credA));
    received.length = 0;
    const r = await startRun({ orgId: ids.orgA, agentId: ag.id, input: { q: "abc" }, dryRun: true, trigger: "manual" });
    expect(r).toMatchObject({ status: "succeeded", dryRun: true, minutesSaved: null });
    expect(received).toHaveLength(0); // zero hits on the local server
    const row = await run(r.runId);
    expect(row.trigger).toBe("test"); expect(row.minutesSaved).toBeNull(); expect(row.humanMinutes).toBeNull();
    const nodes = (row.output as { nodes: Record<string, Record<string, unknown>> }).nodes;
    expect(nodes.read).toMatchObject({ dryRun: true, status: null, request: { method: "GET", url: "[redacted]/records?q=abc", headers: { authorization: "Bearer [redacted]" } } }); // every credential value (incl. baseUrl) is redacted
    expect(nodes.create.request).toMatchObject({ method: "POST", body: { q: "abc", token: "[redacted]" } });
    expect(nodes.gate).toMatchObject({ dryRun: true, autoApproved: true, requestedAction: "Create abc" });
    expect(nodes.hook).toMatchObject({ dryRun: true, wouldDeliver: ["webhook"], delivered: [] });
    expect(nodes.llm).toMatchObject({ skipped: "ANTHROPIC_API_KEY not configured" });
    expect(nodes.nocred).toMatchObject({ dryRun: true, request: { url: "[secret.baseUrl]/x" } });
    expect(nodes.end).toEqual({ dryRun: true, minutesSaved: null });
    const logs = row.logs as { msg: string; nodeId?: string; data?: Record<string, unknown> }[];
    expect(logs[0].msg).toMatch(/Dry run \(test environment\)/);
    expect(logs.some((l) => l.nodeId === "create" && l.msg === "Dry run: would send POST [redacted]/records")).toBe(true);
    expect(logs.some((l) => l.nodeId === "gate" && /auto-approved/.test(l.msg))).toBe(true);
    expect(logs.some((l) => /no hubspot credential attached/.test(l.msg))).toBe(true);
    expect(JSON.stringify({ logs: row.logs, output: row.output })).not.toContain(SECRET_A);
    expect(await db.select().from(schema.approvals).where(eq(schema.approvals.runId, r.runId))).toHaveLength(0);
    const [agAfter] = await db.select().from(schema.agents).where(eq(schema.agents.id, ag.id));
    expect(agAfter.lastRunAt).toBeNull(); // test runs are not "last execution"
    const [credAfter] = await db.select({ lastUsedAt: schema.credentials.lastUsedAt }).from(schema.credentials).where(eq(schema.credentials.id, ids.credA));
    expect(credAfter.lastUsedAt?.getTime()).toBe(credBefore.lastUsedAt?.getTime());
  });

  it("a live run cannot be labelled 'test' by its caller", async () => {
    const def: AgentDefinition = { nodes: [{ id: "trigger", type: "trigger", label: "t", config: {} }, { id: "end", type: "end", label: "e", config: {} }], edges: [{ from: "trigger", to: "end" }] };
    const ag = await makeAgent(ids.orgA, def);
    const r = await startRun({ orgId: ids.orgA, agentId: ag.id, trigger: "test" });
    expect((await run(r.runId)).trigger).toBe("manual"); expect(r.minutesSaved).toBe(7.5);
  });

  it("test runs are excluded from run-ledger savings (finance), ledger summary and the agent portfolio; portfolio valuation = finance valuation", async () => {
    const def: AgentDefinition = { nodes: [{ id: "trigger", type: "trigger", label: "t", config: {} }, { id: "end", type: "end", label: "e", config: {} }], edges: [{ from: "trigger", to: "end" }] };
    const [dept] = await db.insert(schema.departments).values({ orgId: ids.orgA, name: "AP" }).returning();
    const [e1] = await db.insert(schema.employees).values({ orgId: ids.orgA, departmentId: dept.id, displayName: "P1", baseAnnualCost: "62400", costBasis: "observed", hoursPerWeek: "40" }).returning();
    const [e2] = await db.insert(schema.employees).values({ orgId: ids.orgA, departmentId: dept.id, displayName: "P2", loadedHourlyCost: "50", costBasis: "estimated" }).returning();
    const [wf] = await db.insert(schema.workflows).values({ orgId: ids.orgA, name: "Valued WF", signature: "v>w", hoursPerWeek: "4", basis: "observed" }).returning();
    await db.insert(schema.workflowEmployees).values([{ orgId: ids.orgA, workflowId: wf.id, employeeId: e1.id, hoursPerWeek: "3" }, { orgId: ids.orgA, workflowId: wf.id, employeeId: e2.id, hoursPerWeek: "1" }]);
    const ag = await makeAgent(ids.orgA, def, { workflowId: wf.id, monthlyCost: "100", expectedMinutesSavedPerRun: "12" });
    await startRun({ orgId: ids.orgA, agentId: ag.id }); await startRun({ orgId: ids.orgA, agentId: ag.id });
    for (let i = 0; i < 3; i++) await startRun({ orgId: ids.orgA, agentId: ag.id, dryRun: true });
    // even a test row that somehow carried minutes must be ignored
    await db.insert(schema.agentRuns).values({ orgId: ids.orgA, agentId: ag.id, status: "succeeded", trigger: "test", minutesSaved: "999", finishedAt: new Date() });
    const period = { start: new Date(Date.now() - 86400_000), end: new Date(Date.now() + 60_000) };
    const m = await recordSavingsFromRunLedger(ids.orgA, ag.id, period.start, period.end);
    expect(m.runs).toBe(2); expect(Number(m.hoursSaved)).toBeCloseTo(24 / 60, 5);
    expect(await runLedgerSummary(ids.orgA, ag.id, period)).toMatchObject({ runs: 2, succeeded: 2, minutesSaved: 24 });
    const pf = await computeAgentPortfolio(ids.orgA);
    const a = pf.agents.find((x) => x.id === ag.id)!;
    expect(a).toMatchObject({ runs: 2, succeeded: 2, tasksCompleted: 2, minutesSaved: 24, failed: 0 });
    expect(a.lastTest?.status).toBe("succeeded");
    // same loaded hourly + same dollars as the finance engine: (62400×1.3/(40×48)) weighted 3:1 with $50
    const expectedHourly = ((62400 * 1.3) / (40 * 48) * 3 + 50 * 1) / 4;
    expect(a.hourly).toBeCloseTo(expectedHourly, 6);
    expect(a.benefit).toBeCloseTo(Number(m.dollarsSaved), 2);
    expect(a.benefit).toBeCloseTo((24 / 60) * expectedHourly, 6);
    expect(a.operatingCost).toBeCloseTo(100 * (30 / (365.25 / 12)), 6);
    expect(a.netBenefit).toBeCloseTo(a.benefit - a.operatingCost, 6);
    expect(a.trees.net.children?.[0].value).toBeCloseTo(a.benefit, 6);
    expect(pf.kpis.executions).toBeGreaterThanOrEqual(2);
  });

  it("portfolio: failure alerts with consecutive failures, interventions, connected systems, schedule", async () => {
    const def: AgentDefinition = { schedule: "0 7 * * 1", retries: { max: 0, backoffMs: 0 }, nodes: [{ id: "trigger", type: "trigger", label: "t", config: {} }, { id: "down", type: "http", label: "Down", config: { method: "GET", url: "{{secret.baseUrl}}/always-fail", credentialId: ids.credA } }, { id: "end", type: "end", label: "e", config: {} }], edges: [{ from: "trigger", to: "down" }, { from: "down", to: "end" }] };
    const ag = await makeAgent(ids.orgA, def);
    await startRun({ orgId: ids.orgA, agentId: ag.id }); await startRun({ orgId: ids.orgA, agentId: ag.id });
    const pf = await computeAgentPortfolio(ids.orgA);
    const a = pf.agents.find((x) => x.id === ag.id)!;
    expect(a).toMatchObject({ failed: 2, consecutiveFailures: 2, failures7d: 2, successRate: 0, connectedSystems: ["http_bearer"] });
    expect(a.lastError).toMatch(/HTTP 503/);
    expect(a.schedule).toMatchObject({ cron: "0 7 * * 1", valid: true, description: "Every Mon at 07:00" });
    expect(new Date(a.schedule!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    const alert = pf.alerts.find((x) => x.agentId === ag.id)!;
    expect(alert).toMatchObject({ consecutiveFailures: 2, failures7d: 2 }); expect(alert.lastFailedRunId).toBeTruthy();
    // org B sees none of org A's agents
    expect((await computeAgentPortfolio(ids.orgB)).agents.some((x) => x.id === ag.id)).toBe(false);
  });
});
