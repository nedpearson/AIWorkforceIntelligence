import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { detectIntent, navigationFor, validateAssistantAction, isAllowedHref, answerUniversal, saveExchange, latestConversation } from "@/engine/brain/universal";
import { loadDemoKnowledge } from "@/engine/brain/demo-content";
import { SUGGESTED_QUESTIONS } from "@/engine/brain/assistant-suggestions";

describe("assistant intent routing", () => {
  it("routes each suggested question to its intent", () => {
    expect(SUGGESTED_QUESTIONS.map(detectIntent)).toEqual(["capabilities", "opportunities", "activate_first", "demo", "savings_actual", "agents_working"]);
  });
  it("navigation intents and knowledge fallthrough", () => {
    expect(detectIntent("Open the AI Brain")).toBe("navigate");
    expect(navigationFor("take me to the org chart")).toEqual({ href: "/app/workforce/org-chart", label: "AI Org Chart" });
    expect(detectIntent("Who approves invoices over $5,000?")).toBe("knowledge");
  });
});

describe("assistant action allow-list", () => {
  it("navigate only to allow-listed in-app routes", () => {
    expect(validateAssistantAction({ kind: "navigate", href: "/app/agents?status=deployed" }, "viewer")).toMatchObject({ ok: true, href: "/app/agents?status=deployed" });
    for (const bad of ["https://evil.example", "//evil.example", "/api/admin/bootstrap", "/app/../admin", "/app/workforce/../../admin", "/app/workforce/%2e%2e/%2e%2e/admin", "/app/workforce/./x/../../../admin", "javascript:alert(1)", "/admin", "/app/unknown"]) expect(isAllowedHref(bad)).toBe(false);
    expect(validateAssistantAction({ kind: "navigate", href: "https://evil.example" }, "owner")).toMatchObject({ ok: false, status: 400 });
  });
  it("rejects unknown actions and unauthorized provisioning", () => {
    expect(validateAssistantAction({ kind: "delete_org" }, "owner")).toMatchObject({ ok: false, status: 400 });
    expect(validateAssistantAction({ kind: "run_skill", payload: { skill: "pay_invoice" } }, "owner")).toMatchObject({ ok: false, status: 400 });
    expect(validateAssistantAction({ kind: "provision_persona", payload: { personaKey: "charlotte" } }, "viewer")).toMatchObject({ ok: false, status: 403 });
    expect(validateAssistantAction({ kind: "provision_persona", payload: { personaKey: "charlotte" } }, "manager")).toMatchObject({ ok: false, status: 403 });
    expect(validateAssistantAction({ kind: "provision_persona", payload: { personaKey: "nobody" } }, "owner")).toMatchObject({ ok: false, status: 400 });
    expect(validateAssistantAction({ kind: "provision_persona", payload: { personaKey: "charlotte" } }, "owner")).toMatchObject({ ok: true, personaKey: "charlotte", href: "/app/workforce?persona=charlotte" });
    expect(validateAssistantAction({ kind: "open_demo", payload: { personaKey: "charlotte" } }, "viewer")).toMatchObject({ ok: true, href: "/app/experience?persona=charlotte#demo" });
  });
});

let org = ""; let user = "";
beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const [o] = await db.insert(schema.organizations).values({ name: "Universal Demo", slug: `universal-${Date.now()}`, isDemo: true }).returning(); org = o.id;
  const [u] = await db.insert(schema.users).values({ email: `universal-${Date.now()}@t.test` }).returning(); user = u.id;
  await loadDemoKnowledge(org, user);
});
afterAll(async () => { await db.delete(schema.organizations).where(eq(schema.organizations.id, org)); await db.delete(schema.users).where(eq(schema.users.id, user)); });

describe("answerUniversal", () => {
  it("knowledge questions are answered from the Brain with citations, and persisted", async () => {
    const a = await answerUniversal(org, "Who approves invoices over $5,000?", { userId: user, role: "owner" });
    expect(a.intent).toBe("knowledge"); expect(a.knowledgeFallback).toBe(false); expect(a.answer).toMatch(/controller/i); expect(a.citations[0]?.n).toBe(1);
    const id = await saveExchange(org, user, null, "Who approves invoices over $5,000?", a);
    const conv = await latestConversation(org, user);
    expect(conv?.id).toBe(id); expect(conv?.messages.map((m) => m.role)).toEqual(["user", "assistant"]); expect(conv?.messages[1].mode).toBe("retrieval");
    const [c] = await db.select().from(schema.aiConversations).where(and(eq(schema.aiConversations.id, id)));
    expect(c.aiEmployeeId).toBeNull();
  });
  it("routing returns navigation actions; provision is offered only with agents:write", async () => {
    const s = await answerUniversal(org, "Show me which agents are working right now", { userId: user, role: "viewer" });
    expect(s.actions[0]).toMatchObject({ kind: "navigate", href: "/app/agents?status=deployed" });
    const d = await answerUniversal(org, "Show me how invoice automation works", { userId: user, role: "viewer" });
    expect(d.answer).toMatch(/^Charlotte is an AI agent/); expect(d.actions.some((x) => x.kind === "open_demo")).toBe(true); expect(d.actions.some((x) => x.kind === "provision_persona")).toBe(false);
    expect(d.answer).toMatch(/controller/i); // policy pulled from approved Brain content
  });
  it("unknown questions fall back without fabricating", async () => {
    const a = await answerUniversal(org, "What is the airspeed velocity of an unladen swallow?", { userId: user, role: "owner" });
    expect(a.knowledgeFallback).toBe(true); expect(a.citations).toHaveLength(0);
  });
});
