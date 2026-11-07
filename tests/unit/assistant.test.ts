/**
 * Ask BridgeBox — retrieval mode against the seeded demo org (read-only; no fixtures are written).
 * Needs the seeded demo org (`npm run db:reset`, slug `gulf-coast-supply-demo`) reachable through DATABASE_URL.
 * On a scratch/test DB without it the whole file is skipped with a note, so the rest of the suite stays green:
 *   DATABASE_URL=postgresql://bridgebox:bridgebox@localhost:5432/bridgebox npx vitest run tests/unit/assistant.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DEMO_ORG } from "@/engine/synthetic";
import { buildEvidencePack, answerFromEvidence, extractCitations, type EvidencePack } from "@/engine/assistant";
import { fmtUSD } from "@/lib/utils";

const DEMO_SLUG = "gulf-coast-supply-demo";
// Resolve the demo org once, before test collection, so an unseeded DB turns into a skip rather than a failure.
const demoOrgId = (await db.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.slug, DEMO_SLUG)).limit(1))[0]?.id ?? null;
if (!demoOrgId) console.warn(`[assistant.test] seeded demo org '${DEMO_SLUG}' not found in ${process.env.DATABASE_URL?.replace(/\/\/.*@/, "//***@")} — skipping (run \`npm run db:reset\` on the main DB and point DATABASE_URL at it to exercise these tests).`);
const describeSeeded = demoOrgId ? describe : describe.skip;

let orgId = "";
let pack: EvidencePack;

beforeAll(async () => {
  if (!demoOrgId) return;
  delete process.env.ANTHROPIC_API_KEY;
  orgId = demoOrgId;
  pack = await buildEvidencePack(orgId, { role: "owner" });
});

describeSeeded("evidence pack", () => {
  it("contains the demo org's workflows, opportunities and collectors", () => {
    expect(pack.org.id).toBe(orgId);
    // reseeded 24-employee org: ≥ 9 workflows (incl. the weekly report), ≥ 7 opportunities
    expect(pack.employees.length).toBe(DEMO_ORG.employees.length);
    expect(pack.workflows.length).toBeGreaterThanOrEqual(9);
    expect(pack.workflows.some((w) => /weekly report/i.test(w.name))).toBe(true);
    expect(pack.opportunities.length).toBeGreaterThanOrEqual(7);
    expect(pack.collectors.total).toBeGreaterThan(0);
    expect(pack.includesCompensation).toBe(true);
    expect(pack.employees.some((e) => (e.baseAnnualCost ?? 0) > 0)).toBe(true);
    expect(pack.financials.basis).toEqual({ projected: "estimated", verified: "observed", assumptions: "assumed" });
  });
  it("a manager-role pack carries no per-employee compensation", async () => {
    const mgr = await buildEvidencePack(orgId, { role: "manager" });
    expect(mgr.includesCompensation).toBe(false);
    const json = JSON.stringify(mgr);
    expect(json).not.toContain("baseAnnualCost");
    expect(json).not.toContain("loadedHourly");
    expect(json).not.toContain("laborAnnual");
    expect(mgr.employees.length).toBe(pack.employees.length);
    expect(mgr.financials.realizableAnnualSavings).toBeCloseTo(pack.financials.realizableAnnualSavings, 2);
  });
});

describeSeeded("retrieval-mode answers", () => {
  it("which department wastes the most time → the department with the most repetitive hours, cited", () => {
    const top = [...pack.departments].sort((a, b) => b.repetitiveHoursPerWeek - a.repetitiveHoursPerWeek)[0];
    const r = answerFromEvidence(pack, "Which department wastes the most time?");
    expect(r.basis.intent).toBe("department");
    expect(r.answer.startsWith(top.name)).toBe(true);
    expect(r.answer).toContain(`${top.repetitiveHoursPerWeek.toFixed(top.repetitiveHoursPerWeek < 10 ? 1 : 0)} hrs`);
    expect(r.citations[0]).toMatchObject({ type: "department", label: top.name });
    expect(r.citations[0].href).toBe(top.id ? `/app/departments/${top.id}` : "/app/departments");
  });
  it("what would we save → realizable, gross and net from the financial model with scenario range", () => {
    const f = pack.financials;
    const r = answerFromEvidence(pack, "What would we save?");
    expect(r.basis.intent).toBe("savings");
    expect(r.answer).toContain(fmtUSD(f.realizableAnnualSavings));
    expect(r.answer).toContain(fmtUSD(f.grossAnnualSavings));
    expect(r.answer).toContain(fmtUSD(f.netAnnualSavings));
    for (const s of f.scenarios) expect(r.answer).toContain(fmtUSD(s.realizableAnnualSavings));
    expect(r.answer).toContain("estimated");
    expect(r.citations.some((c) => c.type === "financials" && c.href === "/app/finance")).toBe(true);
    expect(r.citations.filter((c) => c.type === "opportunity").length).toBeGreaterThan(0);
    expect(r.citations[1].id).toBe(pack.opportunities[0].id);
  });
  it("how many hours does Dana spend on invoices → her observed hours on the bill-entry workflow", () => {
    const dana = pack.employees.find((e) => e.name.startsWith("Dana"))!;
    const wf = pack.workflows.find((w) => /bill entry/i.test(w.name))!;
    const link = wf.performers.find((p) => p.employeeId === dana.id)!;
    expect(link.hoursPerWeek).toBeGreaterThan(0);
    const r = answerFromEvidence(pack, "How many hours does Dana spend on invoices?");
    expect(r.basis.intent).toBe("employee_workflow");
    expect(r.answer).toContain(dana.name);
    expect(r.answer).toContain(`${link.hoursPerWeek.toFixed(1)} hrs`);
    expect(r.answer).toContain(wf.name);
    expect(r.citations).toEqual(expect.arrayContaining([expect.objectContaining({ type: "employee", id: dana.id, href: `/app/employees/${dana.id}` }), expect.objectContaining({ type: "workflow", id: wf.id, href: `/app/workflows/${wf.id}` })]));
  });
  it("what has been verified → reports measurements honestly (none in the seed) and keeps projected separate", () => {
    const r = answerFromEvidence(pack, "What has been verified?");
    expect(r.basis.intent).toBe("verified");
    if (pack.measurements.length === 0) {
      expect(r.answer).toMatch(/Nothing has been verified yet/);
      expect(r.answer).toContain(fmtUSD(pack.financials.realizableAnnualSavings));
      expect(r.citations.map((c) => c.type)).toEqual(["financials"]);
    } else {
      expect(r.answer).toContain(fmtUSD(pack.financials.verifiedDollarsSaved));
      expect(r.citations.some((c) => c.type === "measurement")).toBe(true);
    }
  });
  it("which workflows need human judgment → exactly the flagged workflows, each cited", () => {
    const flagged = pack.workflows.filter((w) => w.requiresJudgment || w.regulatoryFlag);
    expect(flagged.length).toBeGreaterThan(0);
    const r = answerFromEvidence(pack, "Which workflows need human judgment?");
    expect(r.basis.intent).toBe("judgment");
    expect(r.answer).toContain(`${flagged.length} workflow(s)`);
    for (const w of flagged) { expect(r.answer).toContain(w.name); expect(r.citations).toContainEqual({ type: "workflow", id: w.id, label: w.name, href: `/app/workflows/${w.id}` }); }
    for (const w of pack.workflows.filter((w) => !w.requiresJudgment && !w.regulatoryFlag)) expect(r.citations.some((c) => c.type === "workflow" && c.id === w.id)).toBe(false);
  });
  it("status of the collectors → active/total counts from collector rows", () => {
    const c = pack.collectors;
    const r = answerFromEvidence(pack, "What is the status of the collectors?");
    expect(r.basis.intent).toBe("collectors");
    expect(r.answer).toContain(`${c.active} of ${c.total} collectors are active`);
    expect(r.citations).toEqual([{ type: "collectors", id: "collectors", label: "Collector health", href: "/app/collection" }]);
  });
  it("top opportunity → the highest realizable opportunity with its workflow", () => {
    const o = pack.opportunities[0];
    const r = answerFromEvidence(pack, "What is the top opportunity?");
    expect(r.basis.intent).toBe("top_opportunity");
    expect(r.answer).toContain(o.title);
    expect(r.answer).toContain(fmtUSD(o.realizableAnnualSavings));
    expect(r.answer).toContain(fmtUSD(o.implementationCost));
    expect(r.citations[0]).toEqual({ type: "opportunity", id: o.id, label: o.title, href: `/app/opportunities/${o.id}` });
    if (o.workflowId) expect(r.citations[1]).toMatchObject({ type: "workflow", id: o.workflowId });
  });
  it("payback → implementation, net, ROI and payback from the model", () => {
    const f = pack.financials;
    const r = answerFromEvidence(pack, "What's the payback?");
    expect(r.basis.intent).toBe("payback");
    expect(r.answer).toContain(fmtUSD(f.implementationCost));
    expect(r.answer).toContain(fmtUSD(f.netAnnualSavings));
    expect(r.answer).toContain(f.paybackMonths == null ? "not reached" : `${f.paybackMonths.toFixed(1)} months`);
    expect(r.citations[0].type).toBe("financials");
  });
  it("an unanswerable question says so and cites nothing", () => {
    const r = answerFromEvidence(pack, "What is the weather in Baton Rouge?");
    expect(r.basis.intent).toBe("unknown");
    expect(r.answer).toMatch(/^I don't have evidence for that/);
    expect(r.citations).toEqual([]);
  });
});

describeSeeded("LLM citation extraction", () => {
  it("maps bracket references to real items and drops unknown ids", () => {
    const o = pack.opportunities[0]; const w = pack.workflows[0];
    const { citations, clean } = extractCitations(pack, `Start with ${o.title} [opportunity:${o.id}] which targets [workflow:${w.id}]. See [financials] and [workflow:00000000-0000-0000-0000-000000000000].`);
    expect(citations).toEqual([
      { type: "opportunity", id: o.id, label: o.title, href: `/app/opportunities/${o.id}` },
      { type: "workflow", id: w.id, label: w.name, href: `/app/workflows/${w.id}` },
      { type: "financials", id: "financials", label: "Financial model (projected)", href: "/app/finance" },
    ]);
    expect(clean).not.toContain("[");
    expect(clean).toContain(`Start with ${o.title} which targets. See and.`);
  });
});
