import { describe, it, expect } from "vitest";
import { DEMO_ORG, WORKFLOW_PATTERNS, generateEvents } from "@/engine/synthetic";
import { type MiningEvent, type WorkflowMetrics, mineEmployee, clusterInstances, workflowMetrics, observedWeeksFromDays, dayKey } from "@/engine/mining";
import {
  detectFlags, repetitionScore, automationScore, complexity, findDuplicates, crossDepartmentNote, opportunityType, agentCategory, riskScore, feasibilityScore, automationPct, rankValue, apiFriendliness,
  REPETITION_WEIGHTS, AUTOMATION_WEIGHTS,
} from "@/engine/scoring";

/** Mine every demo pattern once from synthetic data so scoring tests run on realistic metrics. */
function metricsByPattern(): Record<string, WorkflowMetrics> {
  let id = 1;
  const synth = generateEvents({ seed: 42, days: 20 });
  const weeks = observedWeeksFromDays(new Set(synth.map((e) => dayKey(e.ts.getTime()))));
  const inst = DEMO_ORG.employees.flatMap((emp) => mineEmployee(synth.filter((x) => x.employeeKey === emp.key).map((e): MiningEvent => ({ id: id++, employeeId: e.employeeKey, ts: e.ts.getTime(), type: e.type, app: e.app, appCategory: e.appCategory, titleCategory: e.titleCategory, titleHash: e.titleHash, durationMs: Math.round(e.durationMs), meta: e.meta }))));
  const clusters = clusterInstances(inst);
  const out: Record<string, WorkflowMetrics> = {};
  for (const [key, p] of Object.entries(WORKFLOW_PATTERNS)) {
    const sig = p.steps.map(([app, , title, type]) => `${app}:${title}:${type}`).join(">");
    const c = clusters.find((x) => x.signature === sig);
    if (c) out[key] = workflowMetrics(c, weeks);
  }
  return out;
}
const M = metricsByPattern();

describe("flags", () => {
  it("flags bank reconciliation as judgment + SOX and contract review as judgment + Legal", () => {
    const b = detectFlags(M.bank_reconciliation); expect(b.requiresJudgment).toBe(true); expect(b.regulatoryFlag).toBe("SOX");
    const c = detectFlags(M.contract_review); expect(c.requiresJudgment).toBe(true); expect(c.regulatoryFlag).toBe("Legal");
    const o = detectFlags(M.employee_onboarding); expect(o.requiresJudgment).toBe(false); expect(o.regulatoryFlag).toBe("PII");
  });
  it("does not flag clerical approval requests or plain order entry", () => {
    expect(detectFlags(M.ap_invoice)).toMatchObject({ requiresJudgment: false, regulatoryFlag: null });
    expect(detectFlags(M.order_entry)).toMatchObject({ requiresJudgment: false, regulatoryFlag: null });
  });
});

describe("scores", () => {
  it("repetition: high-frequency structured work scores high; rare reading work scores low; weights sum to 100", () => {
    expect(REPETITION_WEIGHTS.frequency + REPETITION_WEIGHTS.consistency + REPETITION_WEIGHTS.structuredShare).toBe(100);
    expect(repetitionScore(M.order_entry).score).toBeGreaterThan(80);
    expect(repetitionScore(M.contract_review).score).toBeLessThan(50);
    const s = repetitionScore({ runsPerWeek: 0, canonicalShare: 0, typeShare: {} }); expect(s.score).toBe(0);
    const t = repetitionScore({ runsPerWeek: 100, canonicalShare: 1, typeShare: { data_entry: 1 } }); expect(t.score).toBe(100);
  });
  it("automation: swivel-chair ERP entry scores high; judgment-heavy reading scores near zero; penalties apply", () => {
    const { structuredEntry, swivelChair, apiFriendliness: a, lowVariance } = AUTOMATION_WEIGHTS; expect(structuredEntry + swivelChair + a + lowVariance).toBe(100);
    const order = automationScore(M.order_entry, detectFlags(M.order_entry)); expect(order.score).toBeGreaterThan(55);
    const contract = automationScore(M.contract_review, detectFlags(M.contract_review)); expect(contract.score).toBeLessThan(15);
    const bank = automationScore(M.bank_reconciliation, detectFlags(M.bank_reconciliation)); expect(bank.parts.pJudgment).toBe(-20); expect(bank.parts.pRegulatory).toBe(-10); expect(bank.score).toBeLessThan(35);
    const ap = automationScore(M.ap_invoice, detectFlags(M.ap_invoice)); expect(ap.parts.pHandoff).toBeCloseTo(-10, 1); expect(ap.score).toBeGreaterThanOrEqual(35);
    expect(apiFriendliness(M.order_entry)).toBeGreaterThan(apiFriendliness(M.contract_review));
  });
  it("complexity grows with apps, handoffs and judgment and stays within 0..1", () => {
    const simple = complexity({ distinctApps: 1, handoffRate: 0 }, { requiresJudgment: false, regulatoryFlag: null, reasons: [] });
    const hard = complexity({ distinctApps: 6, handoffRate: 1 }, { requiresJudgment: true, regulatoryFlag: null, reasons: [] });
    expect(simple).toBe(0); expect(hard).toBe(1);
    expect(complexity(M.ap_invoice, detectFlags(M.ap_invoice))).toBeGreaterThan(complexity(M.appointment_scheduling, detectFlags(M.appointment_scheduling)));
  });
  it("automationPct, feasibility, risk and rank formulas", () => {
    expect(automationPct(100)).toBe(0.8); expect(automationPct(50)).toBeCloseTo(0.425, 6);
    expect(feasibilityScore(50, 1, true)).toBe(60); expect(feasibilityScore(50, 0.5, false)).toBe(50);
    expect(riskScore({ regulatoryFlag: "SOX", requiresJudgment: true, employeeCount: 10, handoffRate: 1 })).toBe(100);
    expect(riskScore({ regulatoryFlag: null, requiresJudgment: false, employeeCount: 2, handoffRate: 0 })).toBe(10);
    expect(rankValue(10000, 50, 0)).toBe(5000); expect(rankValue(10000, 50, 100)).toBe(2500);
  });
});

describe("duplicate work", () => {
  it("marks the smaller of two ≥80%-overlapping workflows as a duplicate and notes cross-department work", () => {
    const a = ["x:1:a", "x:2:b", "x:3:c", "x:4:d", "x:5:e"];
    const pairs = findDuplicates([
      { key: "big", tokens: a, hoursPerWeek: 10, departmentIds: ["d1"] },
      { key: "small", tokens: [...a.slice(0, 4), "y:9:z"], hoursPerWeek: 2, departmentIds: ["d2"] }, // 4/6 = 67% → not a duplicate
      { key: "tiny", tokens: a.slice(0, 5), hoursPerWeek: 1, departmentIds: ["d2"] }, // 100%
      { key: "other", tokens: ["q:1:a", "q:2:b"], hoursPerWeek: 5, departmentIds: ["d1"] },
    ]);
    expect(pairs).toEqual([expect.objectContaining({ smaller: "tiny", larger: "big", overlap: 1 })]);
    expect(crossDepartmentNote(["Operations", "Sales", "Operations"])).toContain("2 departments");
    expect(crossDepartmentNote(["Operations"])).toBeNull();
  });
});

describe("recommendations", () => {
  it("picks opportunity types per the documented rules", () => {
    const f = (k: string) => detectFlags(M[k]);
    expect(opportunityType(M.order_entry, 66, f("order_entry"), false)).toBe("rpa");
    expect(opportunityType(M.ap_invoice, 48, f("ap_invoice"), false)).toBe("rpa");
    expect(opportunityType(M.inventory_count, 56, f("inventory_count"), false)).toBe("rpa");
    expect(opportunityType(M.marketing_campaign_ops, 53, f("marketing_campaign_ops"), false)).toBe("conventional_automation");
    expect(opportunityType(M.appointment_scheduling, 40, f("appointment_scheduling"), false)).toBe("ai_agent");
    expect(opportunityType({ ...M.support_ticket, reworkRate: 0.1 }, 49, f("support_ticket"), false)).toBe("ai_agent");
    expect(opportunityType({ ...M.support_ticket, reworkRate: 0.2 }, 49, f("support_ticket"), false)).toBe("process_change");
    expect(opportunityType(M.order_entry, 66, f("order_entry"), true)).toBe("role_consolidation");
  });
  it("recommends agent categories from the dominant title", () => {
    expect(agentCategory(M.ap_invoice)).toBe("invoice");
    expect(agentCategory(M.bank_reconciliation)).toBe("ap_ar");
    expect(agentCategory(M.support_ticket)).toBe("customer_service");
    expect(agentCategory(M.appointment_scheduling)).toBe("scheduling");
    expect(agentCategory(M.employee_onboarding)).toBe("onboarding");
    expect(agentCategory(M.inventory_count)).toBe("inventory");
    expect(agentCategory(M.marketing_campaign_ops)).toBe("marketing");
    expect(agentCategory(M.order_entry)).toBe("sales_crm");
    expect(agentCategory(M.contract_review)).toBe("document");
  });
});
