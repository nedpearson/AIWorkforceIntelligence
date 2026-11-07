/**
 * Agent version history: every save / deploy / policy change writes agent_versions (n+1); rollback restores the
 * definition + approval policy and itself becomes a new version; the structural diff is correct; cron helpers.
 * The real server actions are exercised with `requireCtx` mocked to a fixture admin (no HTTP session needed).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { AgentDefinition } from "@/db/schema";

const ctx = { userId: "", email: "v@test.local", orgId: "", role: "admin" as const, orgKind: "client" as const, orgName: "V", employeeId: null };
vi.mock("@/lib/session", () => ({ requireCtx: async () => ctx, getCtx: async () => ctx }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { createAgent, updateAgentDefinition, setAgentStatus, updateAgentSettings, rollbackAgentVersion, testRunAgent } = await import("@/app/app/agents/actions");
const { diffDefinitions, listVersions } = await import("@/engine/agents/versions");
const { parseCron, nextRun, describeCron, isValidCron } = await import("@/engine/agents/cron");
const { getTemplate } = await import("@/engine/agents/templates");

let orgB = "";
beforeAll(async () => {
  const [o] = await db.insert(schema.organizations).values({ name: "Versions Test", slug: `versions-${Date.now()}`, isDemo: true }).returning();
  const [b] = await db.insert(schema.organizations).values({ name: "Versions Test B", slug: `versions-b-${Date.now()}`, isDemo: true }).returning();
  const [u] = await db.insert(schema.users).values({ email: `versions-${Date.now()}@test.local`, name: "Editor" }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, orgId: o.id, role: "admin" });
  ctx.orgId = o.id; ctx.userId = u.id; orgB = b.id;
});
afterAll(async () => {
  await db.delete(schema.organizations).where(eq(schema.organizations.id, ctx.orgId));
  await db.delete(schema.organizations).where(eq(schema.organizations.id, orgB));
  await db.delete(schema.users).where(eq(schema.users.id, ctx.userId));
});
const versions = (agentId: string) => db.select().from(schema.agentVersions).where(eq(schema.agentVersions.agentId, agentId)).orderBy(asc(schema.agentVersions.version));

describe("version history via server actions", () => {
  it("create → save → policy change → deploy write v1..v4; rollback restores and writes v5; audited", async () => {
    const r = await createAgent({ templateKey: "data_entry_form_to_system", name: "Form agent", approvalPolicy: { mode: "sensitive_only" } });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const id = r.id;
    let v = await versions(id);
    expect(v.map((x) => [x.version, x.note])).toEqual([[1, "created from template data_entry_form_to_system"]]);
    expect(v[0].createdBy).toBe(ctx.userId); expect(v[0].approvalPolicy).toEqual({ mode: "sensitive_only" });

    const t = getTemplate("data_entry_form_to_system")!;
    const edited: AgentDefinition = { ...t.definition, nodes: t.definition.nodes.map((n) => (n.id === "map" ? { ...n, label: "Map form fields", config: { ...n.config, mapping: { ...(n.config.mapping as object), company: "input.company" } } } : n)) };
    const s1 = await updateAgentDefinition({ agentId: id, definition: edited, note: "add company field" });
    expect(s1).toMatchObject({ ok: true, version: 2 });
    const bad = await updateAgentDefinition({ agentId: id, definition: { nodes: [], edges: [] } });
    expect(bad.ok).toBe(false);
    expect((await versions(id)).length).toBe(2); // invalid saves never create a version

    expect((await updateAgentSettings({ agentId: id, approvalPolicy: { mode: "all", approverRole: "admin" } })).ok).toBe(true);
    expect((await updateAgentSettings({ agentId: id, approvalPolicy: { mode: "all", approverRole: "admin" } })).ok).toBe(true); // unchanged → no version
    expect((await setAgentStatus({ agentId: id, status: "deployed" })).ok).toBe(true);
    v = await versions(id);
    expect(v.map((x) => [x.version, x.note])).toEqual([[1, "created from template data_entry_form_to_system"], [2, "add company field"], [3, "approval policy → all"], [4, "deployed"]]);
    expect(v[3].approvalPolicy).toEqual({ mode: "all", approverRole: "admin" });

    const rb = await rollbackAgentVersion({ agentId: id, version: 1 });
    expect(rb).toMatchObject({ ok: true, version: 5 });
    const [ag] = await db.select().from(schema.agents).where(eq(schema.agents.id, id));
    expect(ag.definition).toEqual(t.definition);
    expect(ag.approvalPolicy).toEqual({ mode: "sensitive_only" });
    v = await versions(id);
    expect(v.at(-1)).toMatchObject({ version: 5, note: "rollback to v1", createdBy: ctx.userId });
    expect(v.at(-1)!.definition).toEqual(t.definition);
    const [log] = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, ctx.orgId), eq(schema.auditLog.action, "agent.version.rollback")));
    expect(log.details).toMatchObject({ toVersion: 1, newVersion: 5 });
    expect((await rollbackAgentVersion({ agentId: id, version: 99 })).ok).toBe(false);

    const list = await listVersions(ctx.orgId, id);
    expect(list.map((x) => x.version)).toEqual([5, 4, 3, 2, 1]);
    expect(await listVersions(orgB, id)).toEqual([]); // RLS: another tenant sees nothing
  });

  it("an agent created before versioning gets a baseline v1 on its first save", async () => {
    const t = getTemplate("document_summarizer")!;
    const [ag] = await db.insert(schema.agents).values({ orgId: ctx.orgId, name: "Legacy", category: t.category, templateKey: t.key, definition: t.definition, approvalPolicy: { mode: "none" } }).returning();
    const changed: AgentDefinition = { ...t.definition, schedule: "0 9 * * 1-5" };
    expect(await updateAgentDefinition({ agentId: ag.id, definition: changed })).toMatchObject({ ok: true, version: 2 });
    const v = await versions(ag.id);
    expect(v.map((x) => x.note)).toEqual(["baseline (state before version history was enabled)", "definition saved"]);
    expect(v[0].definition).toEqual(t.definition); expect(v[1].definition.schedule).toBe("0 9 * * 1-5");
  });

  it("test-run action creates a dry run (trigger test) and writes no version", async () => {
    const t = getTemplate("data_entry_form_to_system")!;
    const [ag] = await db.insert(schema.agents).values({ orgId: ctx.orgId, name: "Dry", category: t.category, templateKey: t.key, definition: t.definition, status: "configured" }).returning();
    const r = await testRunAgent({ agentId: ag.id, input: { email: "a@b.c" } });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.run).toMatchObject({ status: "succeeded", dryRun: true, minutesSaved: null });
    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, r.run.runId));
    expect(run.trigger).toBe("test"); expect(run.minutesSaved).toBeNull();
    expect(await versions(ag.id)).toHaveLength(0);
  });
});

describe("diffDefinitions", () => {
  it("reports added / removed / changed nodes, edges and settings", () => {
    const a: AgentDefinition = { nodes: [{ id: "trigger", type: "trigger", label: "t", config: {} }, { id: "x", type: "transform", label: "X", config: { mapping: { a: "input.a" } } }, { id: "old", type: "notify", label: "Old", config: {} }, { id: "end", type: "end", label: "e", config: {} }],
      edges: [{ from: "trigger", to: "x" }, { from: "x", to: "old" }, { from: "old", to: "end" }] };
    const b: AgentDefinition = { schedule: "0 6 * * *", nodes: [{ id: "trigger", type: "trigger", label: "t", config: {} }, { id: "x", type: "transform", label: "X2", config: { mapping: { a: "input.a", b: "input.b" } } }, { id: "new", type: "approval", label: "Gate", config: {}, sensitive: true }, { id: "end", type: "end", label: "e", config: {} }],
      edges: [{ from: "trigger", to: "x" }, { from: "x", to: "new" }, { from: "new", to: "end", when: "approved" }] };
    const d = diffDefinitions(a, b);
    expect(d.identical).toBe(false);
    expect(d.nodes.added.map((n) => n.id)).toEqual(["new"]);
    expect(d.nodes.removed.map((n) => n.id)).toEqual(["old"]);
    expect(d.nodes.changed).toEqual([{ id: "x", label: "X2", changes: [{ path: "config.mapping.b", before: undefined, after: "input.b" }, { path: "label", before: "X", after: "X2" }] }]);
    expect(d.nodes.unchanged).toBe(2);
    expect(d.edges.added.map((e) => `${e.from}>${e.to}:${e.when ?? ""}`)).toEqual(["x>new:", "new>end:approved"]);
    expect(d.edges.removed.map((e) => `${e.from}>${e.to}`)).toEqual(["x>old", "old>end"]);
    expect(d.settings).toEqual([{ path: "schedule", before: null, after: "0 6 * * *" }]);
    expect(diffDefinitions(a, a).identical).toBe(true);
  });
});

describe("cron", () => {
  it("parses and computes next run times", () => {
    expect(isValidCron("0 7 * * 1")).toBe(true); expect(isValidCron("61 * * * *")).toBe(false); expect(isValidCron("* * *")).toBe(false);
    const from = new Date("2026-11-07T12:00:00Z"); // Saturday
    expect(nextRun("0 7 * * 1", from)!.toISOString()).toBe("2026-11-09T07:00:00.000Z");
    expect(nextRun("30 6 * * *", from)!.toISOString()).toBe("2026-11-08T06:30:00.000Z");
    expect(nextRun("*/15 * * * *", from)!.toISOString()).toBe("2026-11-07T12:15:00.000Z");
    expect(nextRun("0 8 * * 1-5", from)!.toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(nextRun("0 7 2 * *", from)!.toISOString()).toBe("2026-12-02T07:00:00.000Z");
    expect(nextRun("0 9 * * 0", from)!.toISOString()).toBe("2026-11-08T09:00:00.000Z");
    expect(nextRun("0 9 * * 7", from)!.toISOString()).toBe("2026-11-08T09:00:00.000Z");
    // time zone: 07:00 America/Chicago on Monday 2026-11-09 (CST, UTC-6) = 13:00Z
    expect(nextRun("0 7 * * 1", from, "America/Chicago")!.toISOString()).toBe("2026-11-09T13:00:00.000Z");
    expect(describeCron("0 7 * * 1")).toBe("Every Mon at 07:00"); expect(describeCron("0 8 * * 1-5")).toBe("Weekdays at 08:00");
    expect(describeCron("30 6 * * *")).toBe("Every day at 06:30"); expect(describeCron("0 7 2 * *")).toBe("Day 2 of each month at 07:00");
    expect(parseCron("0 0 1 jan *").month.has(1)).toBe(true);
  });
});
