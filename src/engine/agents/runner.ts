/**
 * Internal agent runtime. Executes an AgentDefinition node graph for one agent_runs row.
 *
 * Guarantees:
 *  - Every DB access is inside withTenant(orgId). orgId comes from the caller (server action / job), never from input.
 *  - Secrets are decrypted only here, injected into http requests, and any string equal to a secret value is
 *    redacted from logs and persisted outputs.
 *  - State (node outputs, completed action nodes, human minutes) is persisted after every node so the UI can
 *    poll and so an approval gate can suspend and later resume the run.
 *  - On failure after retries, completed action nodes are compensated in reverse order (rollback).
 *  - Test environment (dry run): a run with trigger "test" (startRun({ dryRun: true })) never calls out. http, action
 *    (kind http), notify webhooks and compensation log the exact request that WOULD be sent (secrets redacted) and
 *    return a synthetic `{ dryRun: true }` marker; approval gates auto-approve with a log line; no minutesSaved or
 *    human minutes are recorded, agents.lastRunAt is not touched, and finance excludes trigger "test" from savings.
 */
import { and, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant, type TenantDb } from "@/db/tenant";
import { decrypt } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import type { AgentDefinition, AgentNode, RunLog } from "@/db/schema";
import { getPath, nextNodeId, template } from "./definition";
import type { JobHandler } from "../jobs";
import { TEST_TRIGGER } from "./runner-constants";

type Agent = typeof schema.agents.$inferSelect;
type Run = typeof schema.agentRuns.$inferSelect;
export type RunState = { nodes: Record<string, unknown>; completedActions: string[]; humanMinutes: number; approvals: string[] };
export type RunResult = { runId: string; status: Run["status"]; error?: string | null; minutesSaved?: number | null; dryRun?: boolean };
export { TEST_TRIGGER };

const HTTP_TIMEOUT_MS = 15_000;
const MAX_STEPS = 500;
export const LLM_MODEL = "claude-sonnet-4-5";

class NodeError extends Error { constructor(msg: string, public readonly retryable = true) { super(msg); } }

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------
export async function startRun(p: { orgId: string; agentId: string; trigger?: string; input?: Record<string, unknown>; actorUserId?: string | null; dryRun?: boolean }): Promise<RunResult> {
  const { orgId, agentId } = p;
  const input = sanitizeInput(p.input ?? {});
  // A dry run is identified by its trigger; a caller cannot create a "test" run that calls out, nor a live run labelled "test".
  const trigger = p.dryRun ? TEST_TRIGGER : (p.trigger && p.trigger !== TEST_TRIGGER ? p.trigger : "manual");
  const runId = await withTenant(orgId, async (tx) => {
    const [agent] = await tx.select({ id: schema.agents.id, status: schema.agents.status }).from(schema.agents).where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId))).limit(1);
    if (!agent) throw new Error("agent not found");
    if (agent.status === "retired") throw new Error("agent is retired");
    const [run] = await tx.insert(schema.agentRuns).values({ orgId, agentId, status: "queued", trigger, input, logs: [], output: {} }).returning({ id: schema.agentRuns.id });
    return run.id;
  });
  await audit({ orgId, actorUserId: p.actorUserId ?? null, actorType: p.actorUserId ? "user" : "system", action: p.dryRun ? "agent.test_run.start" : "agent.run.start", entityType: "agent_run", entityId: runId, details: { agentId, trigger } });
  return executeRun(runId, orgId);
}

/** Execute (or continue) a run. Safe to call from the jobs engine: payload { runId, orgId }. */
export async function executeRun(runId: string, orgId?: string): Promise<RunResult> {
  const loaded = await loadRun(runId, orgId);
  if (!loaded) return { runId, status: "failed", error: "run not found" };
  const { run, agent } = loaded;
  if (!["queued", "running"].includes(run.status)) return { runId, status: run.status, error: run.error, minutesSaved: num(run.minutesSaved) };
  const def = agent.definition;
  const start = def.nodes.find((n) => n.type === "trigger") ?? def.nodes[0];
  const state = readState(run);
  const ex = new Executor(run.orgId, agent, run, state);
  await ex.persist({ status: "running", startedAt: run.startedAt ?? new Date(), currentNodeId: start.id });
  return ex.runFrom(start.id);
}

/** Decide a pending approval and resume (approved) or cancel (rejected) the run. */
export async function resumeRun(runId: string, approvalId: string, decision: "approved" | "rejected", userId: string | null, note?: string, orgId?: string): Promise<RunResult> {
  const loaded = await loadRun(runId, orgId);
  if (!loaded) return { runId, status: "failed", error: "run not found" };
  const { run, agent } = loaded;
  if (run.status !== "awaiting_approval") return { runId, status: run.status, error: "run is not awaiting approval" };
  const approval = await withTenant(run.orgId, async (tx) => (await tx.select().from(schema.approvals).where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.runId, runId), eq(schema.approvals.orgId, run.orgId))).limit(1))[0]);
  if (!approval) return { runId, status: run.status, error: "approval not found" };
  if (approval.status !== "pending") return { runId, status: run.status, error: `approval already ${approval.status}` };
  const state = readState(run);
  const ex = new Executor(run.orgId, agent, run, state);
  const node = agent.definition.nodes.find((n) => n.id === approval.nodeId);
  if (!node) return ex.fail("approval node no longer exists in definition");
  if (approval.expiresAt && approval.expiresAt < new Date()) {
    await withTenant(run.orgId, (tx) => tx.update(schema.approvals).set({ status: "expired", decidedAt: new Date(), decidedBy: userId, decisionNote: note ?? "expired before decision" }).where(eq(schema.approvals.id, approvalId)));
    ex.log("warn", `Approval expired at ${approval.expiresAt.toISOString()} — run cancelled`, node.id);
    await audit({ orgId: run.orgId, actorUserId: userId, action: "agent.approval.expired", entityType: "approval", entityId: approvalId, details: { runId } });
    return ex.finish("cancelled", { error: "approval expired" });
  }
  await withTenant(run.orgId, (tx) => tx.update(schema.approvals).set({ status: decision, decidedAt: new Date(), decidedBy: userId, decisionNote: note ?? null }).where(eq(schema.approvals.id, approvalId)));
  await audit({ orgId: run.orgId, actorUserId: userId, action: `agent.approval.${decision}`, entityType: "approval", entityId: approvalId, details: { runId, nodeId: node.id, note } });
  state.humanMinutes += num(node.config.reviewMinutes ?? 2);
  ex.log("info", `Approval ${decision}${note ? `: ${note}` : ""}`, node.id, { decidedBy: userId, reviewMinutes: num(node.config.reviewMinutes ?? 2) });
  if (decision === "rejected") {
    const next = nextNodeId(agent.definition, node, "rejected");
    // A rejected branch may route to a dedicated node; by default the run is cancelled.
    if (next && agent.definition.nodes.find((n) => n.id === next)?.type !== "end") { await ex.persist({ status: "running", currentNodeId: next }); return ex.runFrom(next, "cancelled"); }
    return ex.finish("cancelled", { error: "rejected by approver" });
  }
  const next = nextNodeId(agent.definition, node, "approved");
  if (!next) return ex.finish("succeeded");
  await ex.persist({ status: "running", currentNodeId: next });
  return ex.runFrom(next);
}

/** Sweep: expire pending approvals past expiresAt and cancel their runs. Returns count. */
export async function expireApprovals(orgId: string): Promise<number> {
  const pend = await withTenant(orgId, (tx) => tx.select().from(schema.approvals).where(and(eq(schema.approvals.orgId, orgId), eq(schema.approvals.status, "pending"))));
  let n = 0;
  for (const a of pend) {
    if (a.expiresAt && a.expiresAt < new Date()) { await resumeRun(a.runId, a.id, "rejected", null, "expired", orgId); n++; }
  }
  return n;
}

/** Jobs-engine hook: maps job kind `agent_run` → executeRun. The jobs engine calls this at startup. */
export function registerAgentJobs(registerJob: (kind: string, handler: JobHandler) => void) {
  try {
    registerJob("agent_run", async (payload) => {
      const runId = String(payload.runId ?? ""); const orgId = payload.orgId ? String(payload.orgId) : undefined;
      if (!runId) throw new Error("agent_run job needs payload.runId");
      const r = await executeRun(runId, orgId);
      return { ...r } as Record<string, unknown>;
    });
  } catch (e) { console.error("registerAgentJobs failed", e); }
}

// Self-register with the jobs engine when it is present (src/engine/jobs.ts exports registerJob).
// Wrapped so the runner still loads in environments without the jobs module.
try {
  import("../jobs").then((m) => { if (typeof m.registerJob === "function" && !m.registeredJobKinds?.().includes("agent_run")) registerAgentJobs(m.registerJob); }).catch(() => { /* jobs engine not available */ });
} catch { /* ignore */ }

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------
class Executor {
  private logs: RunLog[];
  private secrets = new Set<string>();
  private attempt: number;
  readonly dryRun: boolean;
  private curNode: string | undefined;
  constructor(private orgId: string, private agent: Agent, private run: Run, private state: RunState) {
    this.logs = [...(run.logs ?? [])];
    this.attempt = run.attempt ?? 1;
    this.dryRun = run.trigger === TEST_TRIGGER;
    if (this.dryRun && this.logs.length === 0) this.log("info", "Dry run (test environment): no external system will be called; requests are logged instead and approvals auto-approve.");
  }
  get def(): AgentDefinition { return this.agent.definition; }
  private scope(): Record<string, unknown> { return { input: this.run.input ?? {}, nodes: this.state.nodes, run: { id: this.run.id, agentId: this.agent.id } }; }

  log(level: RunLog["level"], msg: string, nodeId?: string, data?: Record<string, unknown>) {
    this.logs.push({ t: new Date().toISOString(), level, nodeId, msg: this.redactStr(msg), ...(data ? { data: this.redact(data) as Record<string, unknown> } : {}) });
  }
  redactStr(s: string): string { let out = s; for (const sec of this.secrets) if (sec.length >= 3) out = out.split(sec).join("[redacted]"); return out; }
  redact(v: unknown): unknown {
    if (typeof v === "string") return this.redactStr(v);
    if (Array.isArray(v)) return v.map((x) => this.redact(x));
    if (v && typeof v === "object") { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = this.redact(x); return o; }
    return v;
  }
  async persist(patch: Partial<typeof schema.agentRuns.$inferInsert>) {
    const output = { nodes: this.redact(this.state.nodes) as Record<string, unknown>, state: { completedActions: this.state.completedActions, humanMinutes: this.state.humanMinutes, approvals: this.state.approvals } };
    await withTenant(this.orgId, (tx) => tx.update(schema.agentRuns).set({ logs: this.logs.slice(-500), output, attempt: this.attempt, ...patch }).where(and(eq(schema.agentRuns.id, this.run.id), eq(schema.agentRuns.orgId, this.orgId))));
  }
  async finish(status: Run["status"], extra: { error?: string | null; minutesSaved?: number | null } = {}): Promise<RunResult> {
    // Test runs never record time saved or human time: they must not feed any savings / benefit number.
    const minutesSaved = this.dryRun ? null : (extra.minutesSaved ?? null);
    const humanMinutes = this.dryRun ? null : String(this.state.humanMinutes);
    await this.persist({ status, error: extra.error ?? null, minutesSaved: minutesSaved == null ? null : String(minutesSaved), humanMinutes, finishedAt: new Date() });
    if (!this.dryRun) await withTenant(this.orgId, (tx) => tx.update(schema.agents).set({ lastRunAt: new Date() }).where(eq(schema.agents.id, this.agent.id)));
    await audit({ orgId: this.orgId, actorType: "agent", action: this.dryRun ? `agent.test_run.${status}` : `agent.run.${status}`, entityType: "agent_run", entityId: this.run.id, details: { agentId: this.agent.id, minutesSaved, error: extra.error ?? undefined, dryRun: this.dryRun || undefined } });
    return { runId: this.run.id, status, error: extra.error ?? null, minutesSaved, ...(this.dryRun ? { dryRun: true } : {}) };
  }
  async fail(error: string): Promise<RunResult> {
    this.log("error", error);
    const rolledBack = await this.rollback();
    return this.finish(rolledBack ? "rolled_back" : "failed", { error });
  }

  /** Main loop. `terminalStatus` lets a rejected-branch continuation end as cancelled. */
  async runFrom(startId: string, terminalStatus: "succeeded" | "cancelled" = "succeeded"): Promise<RunResult> {
    let cur: string | null = startId;
    let steps = 0;
    while (cur) {
      if (++steps > MAX_STEPS) return this.fail(`run exceeded ${MAX_STEPS} steps (cycle?)`);
      const node = this.def.nodes.find((n) => n.id === cur);
      if (!node) return this.fail(`node "${cur}" not found in definition`);
      await this.persist({ currentNodeId: node.id });

      if (node.type === "approval") {
        const gate = this.approvalRequired(node);
        if (gate && this.dryRun) {
          const requestedAction = this.redactStr(template(String(node.config.action ?? node.label), this.scope()));
          this.log("info", `Dry run: approval auto-approved — a live run would pause here and ask a ${this.agent.approvalPolicy?.approverRole ?? "manager"} to approve "${requestedAction}"`, node.id, { dryRun: true });
          this.state.nodes[node.id] = { dryRun: true, autoApproved: true, requestedAction };
          await this.persist({});
          cur = nextNodeId(this.def, node, "approved"); continue;
        }
        if (gate) return this.requestApproval(node);
        this.log("info", `Approval skipped by policy (${this.agent.approvalPolicy?.mode ?? "sensitive_only"})`, node.id);
        this.state.nodes[node.id] = { skipped: "approval policy" };
        cur = nextNodeId(this.def, node, "approved"); continue;
      }
      if (node.type === "end") {
        const override = node.config.minutesSavedPath ? num(getPath(this.scope(), String(node.config.minutesSavedPath))) : null;
        const minutesSaved = terminalStatus === "succeeded" ? (override ?? num(this.agent.expectedMinutesSavedPerRun)) : 0;
        this.state.nodes[node.id] = this.dryRun ? { dryRun: true, minutesSaved: null } : { minutesSaved, humanMinutes: this.state.humanMinutes };
        if (this.dryRun) this.log("info", `Dry run finished — no minutes saved recorded (a live run would record ${minutesSaved} min)`, node.id);
        else this.log("info", `Run finished: ${minutesSaved} min saved (${override != null ? "from output" : "agent expectation"}), ${this.state.humanMinutes} human min`, node.id);
        return this.finish(terminalStatus, { minutesSaved });
      }

      const res = await this.executeWithRetries(node);
      if (!res.ok) return this.fail(`${node.label}: ${res.error}`);
      this.state.nodes[node.id] = res.output;
      if (node.type === "action") this.state.completedActions.push(node.id);
      await this.persist({});
      cur = node.type === "condition" ? nextNodeId(this.def, node, res.branch ? "true" : "false") : nextNodeId(this.def, node);
    }
    // No end node reached (dangling edge): still a success with expected minutes.
    const minutesSaved = terminalStatus === "succeeded" ? num(this.agent.expectedMinutesSavedPerRun) : 0;
    this.log("warn", "Flow ended without an end node");
    return this.finish(terminalStatus, { minutesSaved });
  }

  private approvalRequired(node: AgentNode): boolean {
    const mode = this.agent.approvalPolicy?.mode ?? "sensitive_only";
    if (mode === "none") return false;
    if (mode === "all") return true;
    return node.sensitive !== false; // sensitive_only: approval nodes are sensitive unless explicitly marked otherwise
  }
  private async requestApproval(node: AgentNode): Promise<RunResult> {
    const hours = this.agent.approvalPolicy?.timeoutHours ?? 72;
    const expiresAt = new Date(Date.now() + hours * 3600_000);
    const requestedAction = this.redactStr(template(String(node.config.action ?? node.label), this.scope()));
    const payload = this.redact({ input: this.run.input, nodes: this.state.nodes }) as Record<string, unknown>;
    const id = await withTenant(this.orgId, async (tx) => (await tx.insert(schema.approvals).values({ orgId: this.orgId, runId: this.run.id, agentId: this.agent.id, nodeId: node.id, requestedAction, payload, expiresAt }).returning({ id: schema.approvals.id }))[0].id);
    this.state.approvals.push(id);
    this.log("info", `Waiting for approval: ${requestedAction}`, node.id, { approvalId: id, expiresAt: expiresAt.toISOString(), approverRole: this.agent.approvalPolicy?.approverRole ?? "manager" });
    await this.persist({ status: "awaiting_approval", currentNodeId: node.id });
    await audit({ orgId: this.orgId, actorType: "agent", action: "agent.approval.requested", entityType: "approval", entityId: id, details: { runId: this.run.id, nodeId: node.id } });
    return { runId: this.run.id, status: "awaiting_approval" };
  }

  private async executeWithRetries(node: AgentNode): Promise<{ ok: true; output: unknown; branch?: boolean } | { ok: false; error: string }> {
    const retries = this.def.retries ?? { max: 0, backoffMs: 0 };
    let lastErr = "";
    for (let a = 0; a <= retries.max; a++) {
      const t0 = Date.now();
      this.curNode = node.id;
      try {
        const r = await this.executeNode(node);
        this.log("info", `${node.label} ok (${Date.now() - t0} ms)`, node.id, { attempt: a + 1, output: summarize(r.output) });
        return { ok: true, ...r };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        const retryable = !(e instanceof NodeError) || e.retryable;
        this.log(a < retries.max && retryable ? "warn" : "error", `${node.label} failed (attempt ${a + 1}/${retries.max + 1}): ${lastErr}`, node.id);
        this.attempt = a + 1;
        if (!retryable) break;
        if (a < retries.max && retries.backoffMs > 0) await sleep(retries.backoffMs * Math.pow(2, a));
      }
    }
    return { ok: false, error: lastErr };
  }

  private async executeNode(node: AgentNode): Promise<{ output: unknown; branch?: boolean }> {
    const c = node.config ?? {};
    const scope = this.scope();
    switch (node.type) {
      case "trigger": return { output: { input: this.run.input, trigger: this.run.trigger } };
      case "transform": {
        const mapping = (c.mapping ?? {}) as Record<string, string>;
        const out: Record<string, unknown> = {};
        for (const [k, p] of Object.entries(mapping)) out[k] = typeof p === "string" && p.startsWith("=") ? p.slice(1) : getPath(scope, String(p));
        return { output: out };
      }
      case "condition": {
        const left = getPath(scope, String(c.left ?? ""));
        const right = typeof c.right === "string" && /^(input|nodes)\./.test(c.right) ? getPath(scope, c.right) : c.right;
        const branch = compare(left, String(c.op ?? "truthy"), right);
        return { output: { left: summarize(left), op: c.op, right: summarize(right), result: branch }, branch };
      }
      case "http": return { output: await this.httpCall(c, scope) };
      case "action": {
        const kind = String(c.kind ?? "http");
        if (kind === "http") return { output: await this.httpCall(c, scope) };
        if (kind === "log") return { output: { logged: template(String(c.message ?? node.label), scope) } };
        throw new NodeError(`unknown action kind "${kind}"`, false);
      }
      case "llm": return { output: await this.llmCall(c, scope) };
      case "notify": {
        const message = template(String(c.message ?? node.label), scope);
        const body = c.bodyPath ? getPath(scope, String(c.bodyPath)) : undefined;
        const out: Record<string, unknown> = { message, delivered: [] as string[] };
        this.log("info", `Notify: ${message}`, node.id);
        if (c.webhookUrl) {
          await this.httpCall({ method: "POST", url: String(c.webhookUrl), credentialId: c.credentialId, credentialProvider: c.credentialProvider, auth: c.auth, tokenField: c.tokenField, body: { message, body, runId: this.run.id, agentId: this.agent.id } }, scope);
          if (this.dryRun) { out.dryRun = true; out.wouldDeliver = ["webhook"]; } else (out.delivered as string[]).push("webhook");
        }
        if (c.email) out.email = { to: template(String((c.email as Record<string, unknown>).to ?? ""), scope), delivered: false, reason: "Email delivery is not part of the internal runtime. Use the n8n runtime (SMTP node) or add a webhookUrl to this notify node." };
        return { output: out };
      }
      default: throw new NodeError(`unsupported node type "${node.type}"`, false);
    }
  }

  /** Resolve a credential by explicit id or by provider among the agent's attached credentials. Tenant-scoped. */
  private async credential(c: Record<string, unknown>): Promise<Record<string, string> | null> {
    let id = c.credentialId ? String(c.credentialId) : null;
    if (!id && c.credentialProvider) {
      const ids = this.agent.credentialIds ?? [];
      if (ids.length) {
        const rows = await withTenant(this.orgId, (tx) => tx.select({ id: schema.credentials.id, provider: schema.credentials.provider }).from(schema.credentials).where(eq(schema.credentials.orgId, this.orgId)));
        id = rows.find((r) => ids.includes(r.id) && r.provider === c.credentialProvider)?.id ?? null;
      }
      if (!id) {
        if (this.dryRun) { this.log("warn", `Dry run: no ${c.credentialProvider} credential attached — placeholders are used; a live run would fail here`); return null; }
        throw new NodeError(`no ${c.credentialProvider} credential attached to this agent — add one under Agents → Credentials and attach it`, false);
      }
    }
    if (!id) return null;
    const row = await withTenant(this.orgId, async (tx) => (await tx.select().from(schema.credentials).where(and(eq(schema.credentials.id, id!), eq(schema.credentials.orgId, this.orgId))).limit(1))[0]);
    if (!row) {
      if (this.dryRun) { this.log("warn", `Dry run: credential ${id} not found in this organization — a live run would fail here`); return null; }
      throw new NodeError(`credential ${id} not found in this organization`, false);
    }
    let secret: Record<string, string> = {};
    try { const parsed = JSON.parse(decrypt(row.secretEnc)); secret = typeof parsed === "object" && parsed ? parsed : { value: String(parsed) }; } catch { secret = { value: decrypt(row.secretEnc) }; }
    for (const v of Object.values(secret)) if (typeof v === "string" && v.length >= 3) this.secrets.add(v);
    if (!this.dryRun) await withTenant(this.orgId, (tx) => tx.update(schema.credentials).set({ lastUsedAt: new Date() }).where(eq(schema.credentials.id, row.id)));
    return secret;
  }

  private async httpCall(c: Record<string, unknown>, scope: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resolved = await this.credential(c);
    // Dry run without a usable credential: fill {{secret.x}} with visible placeholders so the request shape can still be shown.
    const secret: Record<string, string> = resolved ?? (this.dryRun ? placeholderSecret(c) : {});
    const s = { ...scope, secret };
    const url = template(String(c.url ?? ""), s);
    const problems: string[] = [];
    const bad = (m: string) => { if (this.dryRun) { problems.push(m); return; } throw new NodeError(m, false); };
    if (!/^https?:\/\//i.test(url) && !(this.dryRun && url.startsWith("[secret."))) bad(`invalid url "${this.redactStr(url)}"`);
    const method = String(c.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { accept: "application/json" };
    for (const [k, v] of Object.entries((c.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = template(String(v), s);
    const auth = c.auth ? String(c.auth) : null;
    if (auth === "bearer") { const tok = secret[String(c.tokenField ?? "token")]; if (!tok) bad(`credential has no "${c.tokenField ?? "token"}" field`); else headers.authorization = `Bearer ${tok}`; }
    if (auth === "basic") { const u = secret[String(c.userField ?? "user")], p = secret[String(c.passField ?? "password")]; if (u == null || p == null) bad("credential lacks basic-auth fields"); else headers.authorization = `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`; }
    if (auth === "header") { const name = String(c.authHeader ?? "x-api-key"); const v = secret[String(c.tokenField ?? "apiKey")]; if (!v) bad(`credential has no "${c.tokenField ?? "apiKey"}" field`); else headers[name.toLowerCase()] = v; }
    let body: string | undefined;
    if (c.body != null && method !== "GET" && method !== "HEAD") {
      body = typeof c.body === "string" ? template(c.body, s) : JSON.stringify(deepTemplate(c.body, s));
      headers["content-type"] ??= "application/json";
    }
    if (this.dryRun) {
      // Basic-auth headers carry base64(user:pass) — redact the encoded form too.
      if (headers.authorization?.startsWith("Basic ")) this.secrets.add(headers.authorization.slice(6));
      let parsedBody: unknown = body;
      try { parsedBody = body ? JSON.parse(body) : undefined; } catch { /* keep text */ }
      const request = this.redact({ method, url, headers, ...(parsedBody !== undefined ? { body: parsedBody } : {}) }) as Record<string, unknown>;
      this.log("info", `Dry run: would send ${method} ${this.redactStr(url)}`, this.curNode, { request, ...(problems.length ? { wouldFail: problems } : {}) });
      return { dryRun: true, request, status: null, ok: null, ...(problems.length ? { wouldFail: problems } : {}) };
    }
    const timeout = Math.min(num(c.timeoutMs) || HTTP_TIMEOUT_MS, 60_000);
    let res: Response;
    try { res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout), redirect: "manual" }); }
    catch (e) { throw new NodeError(`request failed: ${e instanceof Error ? e.message : String(e)}`); }
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    const out = { status: res.status, ok: res.ok, url: this.redactStr(url), method, body: this.redact(parsed) };
    if (!res.ok) throw new NodeError(`HTTP ${res.status} ${method} ${this.redactStr(url)}: ${this.redactStr(text).slice(0, 300)}`, res.status >= 500 || res.status === 429 || res.status === 408);
    return out;
  }

  private async llmCall(c: Record<string, unknown>, scope: Record<string, unknown>): Promise<Record<string, unknown>> {
    const key = process.env.ANTHROPIC_API_KEY;
    const prompt = template(String(c.prompt ?? "{{input}}"), scope);
    if (!key) return { skipped: "ANTHROPIC_API_KEY not configured", prompt: prompt.slice(0, 2000) };
    this.secrets.add(key);
    const body = { model: String(c.model ?? LLM_MODEL), max_tokens: Math.min(num(c.maxTokens) || 1024, 4096), system: String(c.system ?? ""), messages: [{ role: "user", content: prompt }] };
    let res: Response;
    try { res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }); }
    catch (e) { throw new NodeError(`Anthropic request failed: ${e instanceof Error ? e.message : String(e)}`); }
    const json = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; model?: string; usage?: unknown; stop_reason?: string; error?: { message?: string } };
    if (!res.ok) throw new NodeError(`Anthropic HTTP ${res.status}: ${json.error?.message ?? ""}`, res.status >= 500 || res.status === 429);
    const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return { text, model: json.model, usage: json.usage, stopReason: json.stop_reason };
  }

  /** Compensate completed action nodes in reverse order. Returns true if any compensation ran. */
  private async rollback(): Promise<boolean> {
    const done = [...this.state.completedActions].reverse();
    let any = false;
    for (const id of done) {
      const node = this.def.nodes.find((n) => n.id === id);
      if (!node?.compensate) continue;
      const comp = node.compensate;
      const kind = String(comp.kind ?? "log");
      this.curNode = node.id;
      try {
        if (kind === "http") { const out = await this.httpCall(comp, this.scope()); this.log("info", `Rolled back "${node.label}"${comp.note ? ` (${comp.note})` : ""}`, node.id, { compensation: summarize(out) }); }
        else this.log("info", `Rollback note for "${node.label}": ${template(String(comp.message ?? comp.note ?? "manual compensation required"), this.scope())}`, node.id);
        any = true;
        this.state.nodes[`${node.id}:compensated`] = { kind, at: new Date().toISOString() };
      } catch (e) {
        this.log("error", `Rollback of "${node.label}" failed: ${e instanceof Error ? e.message : String(e)} — manual compensation required`, node.id);
      }
      await this.persist({});
    }
    return any;
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
async function loadRun(runId: string, orgIdHint?: string): Promise<{ run: Run; agent: Agent } | null> {
  // The jobs engine may only know runId. We resolve the org via the admin handle strictly by run id, then do
  // everything else inside withTenant(orgId). Server actions always pass orgId from ctx.
  let orgId = orgIdHint;
  if (!orgId) {
    const { db } = await import("@/db/client");
    const [r] = await db.select({ orgId: schema.agentRuns.orgId }).from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)).limit(1);
    if (!r) return null;
    orgId = r.orgId;
  }
  return withTenant(orgId, async (tx: TenantDb) => {
    const [run] = await tx.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.orgId, orgId!))).limit(1);
    if (!run) return null;
    const [agent] = await tx.select().from(schema.agents).where(and(eq(schema.agents.id, run.agentId), eq(schema.agents.orgId, orgId!))).limit(1);
    if (!agent) return null;
    return { run, agent };
  });
}
/** For dry runs without a credential: `{{secret.baseUrl}}` → "[secret.baseUrl]" so the logged request stays readable. */
function placeholderSecret(c: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of JSON.stringify(c).matchAll(/secret\.([a-zA-Z0-9_]+)/g)) out[m[1]] = `[secret.${m[1]}]`;
  for (const k of [c.tokenField, c.userField, c.passField].filter(Boolean)) out[String(k)] ??= `[secret.${String(k)}]`;
  if (c.auth === "bearer") out.token ??= "[secret.token]";
  if (c.auth === "basic") { out.user ??= "[secret.user]"; out.password ??= "[secret.password]"; }
  return out;
}
function readState(run: Run): RunState {
  const o = (run.output ?? {}) as { nodes?: Record<string, unknown>; state?: Partial<RunState> };
  return { nodes: o.nodes ?? {}, completedActions: o.state?.completedActions ?? [], humanMinutes: num(o.state?.humanMinutes), approvals: o.state?.approvals ?? [] };
}
/** Strip any tenant-identifying keys from caller input: orgId is never trusted from input. */
function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const { orgId: _o, org_id: _o2, ...rest } = input as Record<string, unknown> & { orgId?: unknown; org_id?: unknown };
  return rest;
}
const num = (v: unknown): number => (v == null ? 0 : typeof v === "number" ? v : Number(v) || 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function summarize(v: unknown): unknown { const s = JSON.stringify(v ?? null); return s && s.length > 2000 ? { truncated: s.slice(0, 2000) } : v; }
function deepTemplate(v: unknown, scope: Record<string, unknown>): unknown {
  if (typeof v === "string") {
    const m = v.match(/^\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}$/);
    if (m) { const r = getPath(scope, m[1]); return r === undefined ? "" : r; } // whole-string placeholder keeps its type
    return template(v, scope);
  }
  if (Array.isArray(v)) return v.map((x) => deepTemplate(x, scope));
  if (v && typeof v === "object") { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = deepTemplate(x, scope); return o; }
  return v;
}
export function compare(left: unknown, op: string, right: unknown): boolean {
  const n = (x: unknown) => (typeof x === "number" ? x : Number(x));
  switch (op) {
    case "eq": return left == right; // eslint-disable-line eqeqeq
    case "neq": return left != right; // eslint-disable-line eqeqeq
    case "gt": return n(left) > n(right);
    case "gte": return n(left) >= n(right);
    case "lt": return n(left) < n(right);
    case "lte": return n(left) <= n(right);
    case "contains": return typeof left === "string" ? left.toLowerCase().includes(String(right).toLowerCase()) : Array.isArray(left) ? left.includes(right) : false;
    case "exists": return left !== undefined && left !== null && left !== "";
    case "truthy": default: return !!left;
  }
}
