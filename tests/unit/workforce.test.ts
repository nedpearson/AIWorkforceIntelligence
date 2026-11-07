import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, schema } from "@/db/client";
import {
  provisionTeam, createCustomEmployee, updateEmployee, setStatus, setPermissionLevel, checkStatusTransition, checkPermissionChange, getEmployee, WorkforceError,
  employeeFinancials, recommendations, orgChart, composeRetrievalAnswer, converse, validateUpload, saveMedia, readMedia, sniffImage, MAX_MEDIA_BYTES, ensureAiIntro, savingsAtAdoption,
} from "@/engine/workforce";
import { computeSavingsIntelligence } from "@/engine/savings";
import { ingestDocument, reviewDocument } from "@/engine/brain";

delete process.env.ANTHROPIC_API_KEY;
let org = ""; let other = ""; let owner = ""; let manager = ""; let dept = ""; let wf = ""; let opp = ""; let agent = "";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const stamp = Date.now();

beforeAll(async () => {
  const [o] = await db.insert(schema.organizations).values({ name: "WF Test Co", slug: `wf-${stamp}` }).returning(); org = o.id;
  const [o2] = await db.insert(schema.organizations).values({ name: "WF Other", slug: `wf-o-${stamp}` }).returning(); other = o2.id;
  const [u1] = await db.insert(schema.users).values({ email: `wf-owner-${stamp}@t.test`, name: "Owner" }).returning(); owner = u1.id;
  const [u2] = await db.insert(schema.users).values({ email: `wf-mgr-${stamp}@t.test`, name: "Manager" }).returning(); manager = u2.id;
  await db.insert(schema.memberships).values([{ userId: owner, orgId: org, role: "owner" }, { userId: manager, orgId: org, role: "manager" }]);
  const [d] = await db.insert(schema.departments).values({ orgId: org, name: "Finance" }).returning(); dept = d.id;
  const [boss] = await db.insert(schema.employees).values({ orgId: org, departmentId: dept, displayName: "Dana Controller", title: "Controller", userId: manager, baseAnnualCost: "90000", costBasis: "observed" }).returning();
  const [clerk] = await db.insert(schema.employees).values({ orgId: org, departmentId: dept, managerEmployeeId: boss.id, displayName: "Ari Clerk", title: "AP Clerk", baseAnnualCost: "52000", costBasis: "observed" }).returning();
  const [w] = await db.insert(schema.workflows).values({ orgId: org, departmentId: dept, name: "Bill entry (Outlook → Adobe Acrobat → QuickBooks → Excel)", signature: `sig-${stamp}`, hoursPerWeek: "20", runsPerWeek: "60", avgDurationMin: "20", employeeCount: 1,
    steps: [{ idx: 0, app: "Outlook", action: "open", avgMs: 1000, share: 0.2 }, { idx: 1, app: "Adobe Acrobat", action: "read", avgMs: 1000, share: 0.3 }, { idx: 2, app: "QuickBooks", action: "enter", avgMs: 1000, share: 0.5 }] }).returning(); wf = w.id;
  await db.insert(schema.workflowEmployees).values({ orgId: org, workflowId: wf, employeeId: clerk.id, hoursPerWeek: "20", runsPerWeek: "60", avgDurationMin: "20" });
  const [op] = await db.insert(schema.opportunities).values({ orgId: org, workflowId: wf, departmentId: dept, title: "RPA bot: Bill entry", summary: "Automate vendor invoice entry", type: "rpa", status: "identified", feasibility: "80", risk: "20", automationPct: "0.6",
    hoursRecoverablePerWeek: "12", grossAnnualSavings: "20000", realizableAnnualSavings: "12000", implementationCost: "5000", annualOperatingCost: "1200", recommendedAgentCategory: "invoice", calculation: { label: "x", value: 12000, basis: "estimated" }, evidence: { eventIds: [], sampleSize: 10, observedFrom: "", observedTo: "" } }).returning(); opp = op.id;
  const [ag] = await db.insert(schema.agents).values({ orgId: org, opportunityId: opp, workflowId: wf, name: "AP agent", category: "invoice", templateKey: "invoice", definition: { nodes: [], edges: [] }, monthlyCost: "100" }).returning(); agent = ag.id;
});
afterAll(async () => {
  await db.delete(schema.organizations).where(eq(schema.organizations.id, org)); await db.delete(schema.organizations).where(eq(schema.organizations.id, other));
  await db.delete(schema.users).where(eq(schema.users.id, owner)); await db.delete(schema.users).where(eq(schema.users.id, manager));
});

async function charlotte() { const [e] = await db.select().from(schema.aiEmployees).where(and(eq(schema.aiEmployees.orgId, org), eq(schema.aiEmployees.personaKey, "charlotte"))); return e; }
async function addRun(aiEmployeeId: string, mode: "sandbox" | "live", status = "succeeded", base = 20, review = 5, extra: Partial<typeof schema.skillRuns.$inferInsert> = {}) {
  await db.insert(schema.skillRuns).values({ orgId: org, aiEmployeeId, skillKey: "process_invoice", mode, status, manualBaselineMinutes: String(base), humanReviewMinutes: String(review), durationMs: 4000, ...extra });
}

describe("provisioning", () => {
  it("is idempotent on (org, personaKey) and creates draft/read_only rows labelled AI", async () => {
    const a = await provisionTeam(org, owner, ["charlotte", "olivia", "noah"]);
    expect(a.created).toHaveLength(3);
    const b = await provisionTeam(org, owner, ["charlotte", "olivia", "noah"]);
    expect(b.created).toHaveLength(0); expect(b.existing).toHaveLength(3);
    const c = await charlotte();
    expect(c.status).toBe("draft"); expect(c.permissionLevel).toBe("read_only");
    expect(c.portraitUrl).toBe("/portraits/charlotte.png"); expect(c.portraitProvenance).toBe("ai_generated");
    expect(c.departmentId).toBe(dept); expect(c.opportunityId).toBe(opp);
    expect(c.intro.split(/(?<=[.!?])\s/)[0]).toMatch(/AI agent/);
    const olivia = (a.created.find((x) => x.personaKey === "olivia"))!;
    expect(olivia.portraitUrl).toBe("/portraits/olivia.png"); expect(olivia.portraitProvenance).toBe("ai_generated");
  });
  it("custom employees always state AI identity; instruction edits bump version", async () => {
    const e = await createCustomEmployee(org, owner, { firstName: "Rex", title: "AI Freight Auditor", team: "operations", intro: "I audit freight bills." });
    expect(ensureAiIntro("Rex", "x", e.intro)).toBe(e.intro); expect(e.intro).toMatch(/^Hi, I'm Rex — an AI agent/);
    const u = await updateEmployee(org, { userId: owner, role: "owner" }, e.id, { instructions: "Flag carriers over contract rate." });
    expect(u.instructionsVersion).toBe(2);
    const u2 = await updateEmployee(org, { userId: owner, role: "owner" }, e.id, { responsibilities: ["Audit freight"] });
    expect(u2.instructionsVersion).toBe(2);
    const log = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, org), eq(schema.auditLog.entityId, e.id)));
    expect(log.some((l) => l.action === "ai_employee.update")).toBe(true);
  });
});

describe("status gates", () => {
  it("pure gate rules", () => {
    expect(checkStatusTransition("sandbox", "pilot", { role: "owner", sandboxSuccesses: 0, liveSuccesses: 0 }).ok).toBe(false);
    expect(checkStatusTransition("sandbox", "pilot", { role: "manager", sandboxSuccesses: 1, liveSuccesses: 0 }).ok).toBe(true);
    expect(checkStatusTransition("pilot", "active", { role: "manager", sandboxSuccesses: 1, liveSuccesses: 3 }).ok).toBe(false);
    expect(checkStatusTransition("pilot", "active", { role: "admin", sandboxSuccesses: 1, liveSuccesses: 0 }).ok).toBe(false);
    expect(checkStatusTransition("pilot", "active", { role: "admin", sandboxSuccesses: 1, liveSuccesses: 1 }).ok).toBe(true);
    expect(checkStatusTransition("draft", "active", { role: "owner", sandboxSuccesses: 9, liveSuccesses: 9 }).ok).toBe(false);
  });
  it("enforced against real skill_runs (sandbox→pilot needs a sandbox success; pilot→active needs owner + live success)", async () => {
    const c = await charlotte(); const o = { userId: owner, role: "owner" };
    await setStatus(org, o, c.id, "sandbox");
    await expect(setStatus(org, o, c.id, "pilot")).rejects.toBeInstanceOf(WorkforceError);
    await addRun(c.id, "sandbox", "failed");
    await expect(setStatus(org, o, c.id, "pilot")).rejects.toThrow(/sandbox/);
    await addRun(c.id, "sandbox", "succeeded", 30, 0);
    const piloted = await setStatus(org, o, c.id, "pilot");
    expect(piloted.status).toBe("pilot");
    // entering Pilot links a runtime agent (AP template for process_invoice), deployed for the pilot, schedule-free, audited
    expect(piloted.agentId).toBeTruthy();
    expect(piloted.permissionLevel).toBe("read_only");
    const [pa] = await db.select().from(schema.agents).where(eq(schema.agents.id, piloted.agentId!));
    expect(pa).toMatchObject({ orgId: org, status: "deployed", templateKey: "ap_ar_invoice_intake", category: "ap_ar", opportunityId: opp, workflowId: wf, runtime: "internal" });
    expect(pa.definition.schedule).toBeUndefined();
    expect(pa.deployedAt).toBeTruthy();
    const linkAudit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, org), eq(schema.auditLog.action, "ai_employee.agent_linked"), eq(schema.auditLog.entityId, c.id)));
    expect(linkAudit).toHaveLength(1);
    const [oppRow] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, opp));
    expect(oppRow.status, "a pilot never changes the opportunity's status").toBe("identified");
    // pausing and re-entering Pilot reuses the same agent
    await setStatus(org, o, c.id, "paused");
    expect((await setStatus(org, o, c.id, "pilot")).agentId).toBe(piloted.agentId);
    await expect(setStatus(org, o, c.id, "active")).rejects.toThrow(/live/);
    await addRun(c.id, "live", "succeeded", 20, 5, { reviewStatus: "accepted" });
    await expect(setStatus(org, { userId: manager, role: "manager" }, c.id, "active")).rejects.toThrow(/owner or admin/);
    expect((await setStatus(org, o, c.id, "active")).status).toBe("active");
    const denied = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, org), eq(schema.auditLog.action, "ai_employee.status_denied")));
    expect(denied.length).toBeGreaterThanOrEqual(3);
  });
});

describe("permission escalation", () => {
  it("requires owner/admin + confirmation, one level at a time; lowering is free", async () => {
    expect(checkPermissionChange("read_only", "draft_only", { role: "owner" }).ok).toBe(false);
    expect(checkPermissionChange("read_only", "act_with_approval", { role: "owner", confirm: true }).ok).toBe(false);
    expect(checkPermissionChange("draft_only", "read_only", { role: "viewer" }).ok).toBe(true);
    const c = await charlotte();
    await expect(setPermissionLevel(org, { userId: manager, role: "manager" }, c.id, "draft_only", { confirm: true })).rejects.toThrow(/owner or admin/);
    await expect(setPermissionLevel(org, { userId: owner, role: "owner" }, c.id, "draft_only")).rejects.toMatchObject({ code: "confirmation_required" });
    expect((await setPermissionLevel(org, { userId: owner, role: "owner" }, c.id, "draft_only", { confirm: true })).permissionLevel).toBe("draft_only");
    expect((await getEmployee(org, c.id))!.permissionLevel).toBe("draft_only");
    const log = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.orgId, org), eq(schema.auditLog.action, "ai_employee.permission")));
    expect(log[0].details).toMatchObject({ from: "read_only", to: "draft_only", confirmed: true, escalation: true });
  });
});

describe("employeeFinancials", () => {
  it("excludes sandbox runs and reconciles hard savings with the savings engine", async () => {
    const c = await charlotte();
    await db.update(schema.aiEmployees).set({ agentId: agent }).where(eq(schema.aiEmployees.id, c.id));
    await db.insert(schema.savingsLedger).values({ orgId: org, tier: "realized_hard", status: "approved", title: "Temp AP contractor ended", annualAmount: "6000", agentId: agent, opportunityId: opp, dedupeKey: `wf:${wf}`, effectiveFrom: new Date(Date.now() - 30 * 86_400_000), evidence: [{ kind: "invoice", ref: "contractor-termination" }], submittedBy: manager, approvedBy: owner, approvedAt: new Date() });
    await db.insert(schema.savingsLedger).values({ orgId: org, tier: "realized_hard", status: "submitted", title: "Not yet approved", annualAmount: "99999", agentId: agent, dedupeKey: "other", effectiveFrom: new Date(), evidence: [] });
    const now = new Date(); const range = { from: new Date(+now - 40 * 86_400_000), to: new Date(+now + 60_000) };
    const f = await employeeFinancials(org, c.id, range);
    expect(f.totals.sandboxRuns).toBe(2); expect(f.totals.liveRuns).toBe(1); expect(f.totals.tasksCompleted).toBe(1);
    expect(f.totals.verifiedHoursRecovered).toBeCloseTo(15 / 60, 5); // live only: 20 − 5 min; sandbox 30 min ignored
    expect(f.totals.capacityValue).toBeCloseTo(f.totals.verifiedHoursRecovered * f.loadedHourly, 5);
    expect(f.loadedHourly).toBeGreaterThan(0);
    expect(f.totals.accuracy).toBe(1);
    const si = await computeSavingsIntelligence(org);
    expect(f.totals.hardSavingsAnnual).toBeCloseTo(si.tiers.realizedHard.amount + si.tiers.costAvoidance.amount, 2);
    expect(f.totals.hardSavingsAnnual).toBe(6000);
    expect(f.totals.operatingCost).toBeGreaterThan(0); // agent monthlyCost prorated
    expect(f.beforeAfter?.manualHoursPerWeek).toBe(20);
    expect(f.beforeAfter?.observedAfterHoursPerWeek).toBeCloseTo((5 / 60) * 60, 5);
    expect(f.trees.verifiedHours.basis).toBe("observed");
  });
});

describe("recommendations", () => {
  it("maps the invoice workflow to Charlotte with finance-engine numbers and a quote built from real data", async () => {
    const recs = await recommendations(org);
    const r = recs.find((x) => x.opportunityId === opp)!;
    expect(r.persona.key).toBe("charlotte");
    expect(r.observedHoursPerWeek).toBe(20);
    expect(r.realizableAnnualSavings).toBeGreaterThan(0);
    expect(r.quote).toMatch(/^I'm Charlotte, an AI agent\./); expect(r.quote).toMatch(/20 hours\/week on bill entry/);
    expect(r.existing?.firstName).toBe("Charlotte");
    const s = savingsAtAdoption(r, 0.5); expect(s.annualValue).toBeCloseTo(r.realizableAnnualSavings / 2, 5);
  });
});

describe("org chart", () => {
  it("counts humans and AI, links approval owner, adds proposed AI only in proposed mode", async () => {
    const c = await charlotte();
    await updateEmployee(org, { userId: owner, role: "owner" }, c.id, { approvalOwnerUserId: manager });
    const cur = await orgChart(org, {});
    expect(cur.counts.humans).toBe(2); expect(cur.counts.ai).toBe(4); expect(cur.counts.proposedAi).toBe(0);
    const node = cur.ai.find((a) => a.id === c.id)!;
    expect(node.approvalOwnerName).toBe("Dana Controller");
    const fin = cur.departments.find((d) => d.id === dept)!;
    expect(fin.coveragePct).toBe(1);
    expect(cur.humans.every((h) => h.photoUrl === null)).toBe(true); // no consented photos
    const byDept = await orgChart(org, { dept });
    expect(byDept.counts.humans).toBe(2); expect(byDept.ai.every((a) => a.departmentId === dept)).toBe(true);
    const prop = await orgChart(org, { mode: "proposed" });
    expect(prop.counts.proposedAi).toBe(0); // Charlotte already provisioned → nothing new to propose
  });
});

describe("media", () => {
  it("validates provenance, size and type by magic bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(validateUpload({ kind: "ai_portrait", bytes: PNG, provenance: null }).ok).toBe(false);
    expect(validateUpload({ kind: "ai_portrait", bytes: PNG, provenance: "employee_consented" }).ok).toBe(false);
    expect(validateUpload({ kind: "ai_portrait", bytes: PNG, provenance: "licensed" }).ok).toBe(true);
    const big = new Uint8Array(MAX_MEDIA_BYTES + 1); big.set(PNG);
    expect(validateUpload({ kind: "ai_portrait", bytes: big, provenance: "licensed" })).toMatchObject({ ok: false, status: 413 });
    expect(validateUpload({ kind: "ai_portrait", bytes: new TextEncoder().encode("<svg onload=alert(1)>"), provenance: "licensed" })).toMatchObject({ ok: false, status: 415 });
    expect(validateUpload({ kind: "employee_photo", bytes: PNG, provenance: "employee_consented", consent: false }).ok).toBe(false);
  });
  it("stores, links the portrait and is tenant-isolated", async () => {
    const c = await charlotte();
    const r = await saveMedia(org, owner, { kind: "ai_portrait", bytes: PNG, provenance: "ai_generated", aiEmployeeId: c.id });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect((await getEmployee(org, c.id))!.portraitUrl).toBe(`/api/media/${r.id}`);
    expect((await readMedia(org, r.id))?.mimeType).toBe("image/png");
    expect(await readMedia(other, r.id)).toBeNull();
    const cross = await saveMedia(other, owner, { kind: "ai_portrait", bytes: PNG, provenance: "licensed", aiEmployeeId: c.id });
    expect(cross.ok).toBe(false);
  });
});

describe("conversation (retrieval mode)", () => {
  it("pure composer: always states AI identity, cites, offers the demo action", () => {
    const emp = { id: "e1", firstName: "Charlotte", title: "AI Accounts Payable Specialist", intro: "Hi, I'm Charlotte — an AI agent. I process invoices.", responsibilities: ["Extract invoice data"], skills: ["process_invoice"], status: "draft" as const, permissionLevel: "read_only" as const, personaKey: "charlotte", opportunityId: null };
    for (const q of ["What can you do for my company?", "What tasks could you take over?", "How much money could you save us?", "Can you demonstrate invoice processing?", "What is our refund policy?"]) {
      const a = composeRetrievalAnswer({ employee: emp, question: q, recs: [], fin: null, passages: [], evidence: null, skills: null, demoSkill: "process_invoice" });
      expect(a.content.split(/(?<=[.!?])\s/)[0]).toMatch(/AI agent/); expect(a.mode).toBe("retrieval");
    }
    const demo = composeRetrievalAnswer({ employee: emp, question: "Can you demonstrate?", recs: [], fin: null, passages: [], evidence: null, skills: null, demoSkill: "process_invoice" });
    expect(demo.actions[0]).toMatchObject({ kind: "start_demo", payload: { skillKey: "process_invoice" } });
  });
  it("end to end: persists messages, answers from approved Brain knowledge with citations", async () => {
    const c = await charlotte();
    const doc = await ingestDocument(org, owner, { title: "AP approval policy", content: "# Approval thresholds\nVendor invoices over $5,000 require controller approval before payment is released.", category: "policy" });
    await reviewDocument(org, owner, doc.documentId!, "approve");
    const r1 = await converse({ orgId: org, userId: owner, role: "owner", aiEmployeeId: c.id, message: "Which vendor invoices require controller approval?" });
    expect(r1.reply.mode).toBe("retrieval"); expect(r1.reply.content).toMatch(/^I'm Charlotte, an AI agent/);
    expect(r1.reply.citations.some((x) => x.type === "document" && x.id === doc.documentId)).toBe(true); expect(r1.reply.content).toMatch(/5,000/);
    const r2 = await converse({ orgId: org, userId: owner, role: "owner", aiEmployeeId: c.id, conversationId: r1.conversationId, message: "How much money could you save us?" });
    expect(r2.conversationId).toBe(r1.conversationId);
    expect(r2.reply.citations.some((x) => x.type === "opportunity" && x.id === opp)).toBe(true);
    expect(r2.reply.content).toMatch(/capacity/);
    const msgs = await db.select().from(schema.aiMessages).where(eq(schema.aiMessages.conversationId, r1.conversationId));
    expect(msgs).toHaveLength(4);
  });
});

describe("skills engine integration (adapter)", () => {
  it("a real sandbox run through the skills engine unlocks pilot and never counts toward savings", async () => {
    const { runSkillSafe, loadSkills } = await import("@/engine/workforce");
    expect(await loadSkills()).not.toBeNull();
    const [e] = (await provisionTeam(org, owner, ["isabella"])).created;
    const o = { userId: owner, role: "owner" };
    await setStatus(org, o, e.id, "sandbox");
    const r = await runSkillSafe({ orgId: org, aiEmployeeId: e.id, skillKey: e.skills[0], mode: "sandbox", actorUserId: owner, actorRole: "owner" });
    expect(r.ok).toBe(true);
    expect((await setStatus(org, o, e.id, "pilot")).status).toBe("pilot");
    const f = await employeeFinancials(org, e.id, { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) });
    expect(f.totals.sandboxRuns).toBe(1); expect(f.totals.verifiedHoursRecovered).toBe(0); expect(f.totals.tasksCompleted).toBe(0);
  });
});

describe("persona portraits", () => {
  it("every library persona has an AI-generated portrait file on disk", async () => {
    const fs = await import("node:fs"); const path = await import("node:path");
    const { PERSONAS } = await import("@/engine/workforce/personas");
    for (const p of PERSONAS) {
      expect(p.portrait, p.key).toBe(`/portraits/${p.key}.png`);
      expect(fs.existsSync(path.join(process.cwd(), "public", p.portrait!)), `${p.key} portrait file`).toBe(true);
    }
  });
});
