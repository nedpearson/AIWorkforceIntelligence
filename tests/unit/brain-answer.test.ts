import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ingestDocument, reviewDocument, proposeFact, reviewFact, type Passage } from "@/engine/brain";
import { askBrain, composeRetrievalAnswer, mapCitationMarkers, brainScopeFor, FALLBACK_ANSWER, NO_DEPARTMENT } from "@/engine/brain/answer";
import { loadDemoKnowledge, DEMO_DOCUMENTS } from "@/engine/brain/demo-content";
import { canApproveItem, decideItems, reviewQueue, documentDetail } from "@/engine/brain/review";
import { syncBrainSource, listBrainSources } from "@/engine/brain/sources";

let org = ""; let plain = ""; let user = ""; let deptA = ""; let deptB = "";
beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const s = Date.now();
  const [o] = await db.insert(schema.organizations).values({ name: "Brain Ask Demo", slug: `brain-ask-${s}`, isDemo: true }).returning(); org = o.id;
  const [p] = await db.insert(schema.organizations).values({ name: "Brain Plain", slug: `brain-plain-${s}` }).returning(); plain = p.id;
  const [u] = await db.insert(schema.users).values({ email: `brain-ask-${s}@t.test` }).returning(); user = u.id;
  const [a] = await db.insert(schema.departments).values({ orgId: org, name: "Finance" }).returning(); deptA = a.id;
  const [b] = await db.insert(schema.departments).values({ orgId: org, name: "Sales" }).returning(); deptB = b.id;
  await loadDemoKnowledge(org, user);
});
afterAll(async () => { for (const id of [org, plain]) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)); await db.delete(schema.users).where(eq(schema.users.id, user)); });

describe("askBrain", () => {
  it("demo knowledge loads only into demo orgs, approved", async () => {
    await expect(loadDemoKnowledge(plain, user)).rejects.toThrow(/demo organization/);
    const docs = await db.select().from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.orgId, org));
    expect(docs).toHaveLength(DEMO_DOCUMENTS.length); expect(docs.every((d) => d.status === "approved")).toBe(true);
    expect((await loadDemoKnowledge(org, user)).created).toBe(0); // idempotent (exact duplicates skipped)
  });
  it("answers with inline [n] citations that map to the passages used", async () => {
    const a = await askBrain(org, "Who approves invoices over $5,000?", { role: "manager", departmentIds: null });
    expect(a.mode).toBe("retrieval"); expect(a.fallback).toBe(false);
    expect(a.answer).toMatch(/controller approval/i); expect(a.answer).toContain("[1]");
    expect(a.citations[0]).toMatchObject({ n: 1, type: "document" }); expect(a.citations[0].href).toMatch(/^\/app\/brain\?doc=/);
    expect(a.passages.length).toBe(a.citations.length); expect(a.passages[0].approvedAt).toBeTruthy();
    const markers = [...a.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    expect(Math.max(...markers)).toBeLessThanOrEqual(a.citations.length);
  });
  it("falls back honestly when nothing approved covers the question", async () => {
    const a = await askBrain(org, "What is the capital of France?", { role: "owner" });
    expect(a.fallback).toBe(true); expect(a.answer).toBe(FALLBACK_ANSWER); expect(a.citations).toHaveLength(0);
    const empty = await askBrain(plain, "Who approves invoices?", { role: "owner" });
    expect(empty.fallback).toBe(true);
  });
  it("filters by role and department before answering", async () => {
    const r1 = await ingestDocument(org, user, { title: "Finance close calendar", content: "The monthly close calendar locks the general ledger on business day three for the finance team.", category: "procedure", departmentId: deptA });
    await reviewDocument(org, user, r1.documentId!, "approve");
    const r2 = await ingestDocument(org, user, { title: "Board bonus pool", content: "The executive bonus pool is set by the board compensation committee each February.", category: "policy", allowedRoles: ["owner"] });
    await reviewDocument(org, user, r2.documentId!, "approve");
    const q1 = "When does the close calendar lock the general ledger?";
    expect((await askBrain(org, q1, { role: "manager", departmentIds: [deptA] })).fallback).toBe(false);
    expect((await askBrain(org, q1, { role: "manager", departmentIds: [deptB] })).fallback).toBe(true);
    expect((await askBrain(org, q1, { role: "viewer", departmentIds: [NO_DEPARTMENT] })).fallback).toBe(true);
    const q2 = "Who sets the executive bonus pool?";
    expect((await askBrain(org, q2, { role: "manager", departmentIds: null })).fallback).toBe(true);
    expect((await askBrain(org, q2, { role: "owner", departmentIds: null })).answer).toMatch(/compensation committee/);
  });
  it("facts are cited too", async () => {
    const f = await proposeFact(org, user, { category: "company", subject: "Forklift certification", statement: "Forklift certification renews every three years for warehouse staff." });
    expect((await askBrain(org, "How often does forklift certification renew?", { role: "manager" })).fallback).toBe(true); // pending ≠ known
    await reviewFact(org, user, f.id, "approve");
    const a = await askBrain(org, "How often does forklift certification renew?", { role: "manager" });
    expect(a.fallback).toBe(false); expect(a.citations.some((c) => c.type === "fact")).toBe(true);
  });
  it("scope: admins see all departments; others get their department or org-wide only", async () => {
    expect((await brainScopeFor(org, { userId: user, role: "owner" })).departmentIds).toBeNull();
    expect((await brainScopeFor(org, { userId: user, role: "viewer" })).departmentIds).toEqual([NO_DEPARTMENT]);
  });
});

describe("pure answer helpers", () => {
  const P = (id: string, title: string, text: string): Passage => ({ kind: "chunk", id, documentId: id, title, text, category: "policy", score: 1, citation: { type: "document", id, label: title } });
  it("composeRetrievalAnswer requires keyword coverage", () => {
    const ps = [P("1", "AP Policy", "Invoices over $5,000 require controller approval. Payment runs are Tuesdays."), P("2", "Capital plan", "Capital projects are reviewed annually.")];
    const r = composeRetrievalAnswer("Which invoices require controller approval?", ps);
    expect(r.fallback).toBe(false); expect(r.used.map((p) => p.id)).toEqual(["1"]); expect(r.answer).toContain("[1]");
    expect(composeRetrievalAnswer("What is the capital of France?", ps).fallback).toBe(true);
  });
  it("mapCitationMarkers renumbers and drops unknown indices", () => {
    const ps = [P("a", "A", "x"), P("b", "B", "y")];
    const m = mapCitationMarkers("Second [2]. Bogus [9]. First [1].", ps);
    expect(m.text).toBe("Second [1]. Bogus. First [2]."); expect(m.used.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("review scope & sources", () => {
  it("managers approve only their own department's items", async () => {
    expect(canApproveItem("owner", null, deptA)).toBe(true);
    expect(canApproveItem("manager", deptA, deptA)).toBe(true);
    expect(canApproveItem("manager", deptA, null)).toBe(false);
    expect(canApproveItem("manager", deptA, deptB)).toBe(false);
    expect(canApproveItem("viewer", deptA, deptA)).toBe(false);
    const fa = await proposeFact(org, user, { category: "procedure", subject: "Finance thing", statement: "Finance reconciles bank accounts daily.", departmentId: deptA });
    const fb = await proposeFact(org, user, { category: "procedure", subject: "Sales thing", statement: "Sales reviews pipeline every Monday.", departmentId: deptB });
    const q = await reviewQueue(org, { role: "manager", departmentId: deptA });
    expect(q.find((i) => i.id === fa.id)?.canApprove).toBe(true); expect(q.find((i) => i.id === fb.id)?.canApprove).toBe(false);
    const r = await decideItems(org, user, { role: "manager", departmentId: deptA }, [{ kind: "fact", id: fa.id }, { kind: "fact", id: fb.id }], "approve");
    expect(r.done).toEqual([fa.id]); expect(r.denied).toEqual([fb.id]);
  });
  it("document detail exposes chunks and version chain", async () => {
    const [d] = await db.select().from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.orgId, org)).limit(1);
    const v2 = await ingestDocument(org, user, { title: d.title, content: d.content + "\n\nAdded clause: reviewed quarterly.", category: "policy", supersedesId: d.id });
    const det = await documentDetail(org, v2.documentId!);
    expect(det!.versions.map((v) => v.version)).toEqual([2, 1]); expect(det!.chunks.length).toBeGreaterThan(0);
  });
  it("sources: BridgeBox sync proposes facts; HubSpot not connected is reported honestly", async () => {
    const bb = await syncBrainSource(org, user, "bridgebox"); expect(bb.ok).toBe(true);
    const hs = await syncBrainSource(org, user, "hubspot", { hubspotSync: async () => ({ ok: false as const, error: "HubSpot is not configured" }) });
    expect(hs.ok).toBe(false);
    expect((await syncBrainSource(org, user, "sharepoint")).ok).toBe(false);
    const list = await listBrainSources(org);
    expect(list.find((s) => s.key === "bridgebox")?.lastSyncedAt).toBeTruthy(); expect(list.find((s) => s.key === "hubspot")?.status).toBe("not_connected");
  });
});
