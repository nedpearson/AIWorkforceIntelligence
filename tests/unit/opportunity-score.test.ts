/** Pure tests for the explainable opportunity score (no DB). */
import { describe, it, expect } from "vitest";
import { scoreOpportunity, evidenceConfidence, SCORE_WEIGHTS, FACTOR_ORDER, quadrantOf, riskBucket, type ScoreInputs } from "@/engine/opportunity-score";

const base: ScoreInputs = {
  realizableAnnual: 20_000, orgMaxRealizable: 40_000, feasibility: 70, implementationCost: 6_000, orgMaxImplementationCost: 12_000, complexity: 0.3,
  sampleSize: 150, basis: "observed", performers: 5, performersWithCollector: 5, repetitionScore: 85, reworkRate: 0.06,
  hoursRecoverablePerWeek: 10, orgMaxHoursRecoverable: 20, peopleAffected: 5, orgMaxPeople: 10, risk: 25, regulatoryFlag: null, requiresJudgment: false,
  roi1y: 1.5, paybackMonths: 6,
};

describe("scoreOpportunity", () => {
  it("weights sum to 100 and cover all 8 factors", () => {
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(FACTOR_ORDER).toHaveLength(8);
    const s = scoreOpportunity(base);
    expect(s.factors.map((f) => f.key)).toEqual(FACTOR_ORDER);
    for (const f of s.factors) { expect(f.reason.length).toBeGreaterThan(10); expect(f.inputs.length).toBeGreaterThan(0); expect(f.weight).toBe(SCORE_WEIGHTS[f.key]); }
  });

  it("is deterministic", () => {
    const a = scoreOpportunity(base); const b = scoreOpportunity({ ...base });
    expect(a).toEqual(b);
  });

  it("total equals Σ value × weight ÷ 100 (rounded)", () => {
    const s = scoreOpportunity(base);
    const expected = s.factors.reduce((t, f) => t + (f.value * f.weight) / 100, 0);
    expect(s.total).toBeCloseTo(expected, 0);
    // hand values for a few factors
    expect(s.factors.find((f) => f.key === "financial")!.value).toBe(50);
    expect(s.factors.find((f) => f.key === "effort")!.value).toBeCloseTo(100 - 60 * 0.5 - 40 * 0.3, 6); // 58
    expect(s.factors.find((f) => f.key === "dataReadiness")!.value).toBeCloseTo(50 * 0.75 + 25 + 25, 6); // 87.5
    expect(s.factors.find((f) => f.key === "compliance")!.value).toBeCloseTo(100 - 15, 6);
  });

  it("stays within 0..100 for extreme inputs", () => {
    const extremes: ScoreInputs[] = [
      { ...base, realizableAnnual: 1e9, orgMaxRealizable: 1, feasibility: 500, implementationCost: -5, complexity: 9, sampleSize: 1e6, repetitionScore: 900, reworkRate: -1, hoursRecoverablePerWeek: 1e5, orgMaxHoursRecoverable: 1, peopleAffected: 1e3, orgMaxPeople: 1, risk: -50, roi1y: 1e3, paybackMonths: -10 },
      { ...base, realizableAnnual: 0, orgMaxRealizable: 0, feasibility: -10, implementationCost: 1e9, orgMaxImplementationCost: 0, complexity: -1, sampleSize: 0, basis: "assumed", performers: 0, performersWithCollector: 0, repetitionScore: -5, reworkRate: 5, hoursRecoverablePerWeek: 0, orgMaxHoursRecoverable: 0, peopleAffected: 0, orgMaxPeople: 0, risk: 400, regulatoryFlag: "HIPAA", requiresJudgment: true, roi1y: -9, paybackMonths: null },
    ];
    for (const x of extremes) {
      const s = scoreOpportunity(x);
      expect(s.total).toBeGreaterThanOrEqual(0); expect(s.total).toBeLessThanOrEqual(100);
      for (const f of s.factors) { expect(f.value).toBeGreaterThanOrEqual(0); expect(f.value).toBeLessThanOrEqual(100); expect(Number.isFinite(f.value)).toBe(true); }
    }
  });

  it("better inputs never lower the score (monotonic on value and risk)", () => {
    const s0 = scoreOpportunity(base).total;
    expect(scoreOpportunity({ ...base, realizableAnnual: 30_000 }).total).toBeGreaterThan(s0);
    expect(scoreOpportunity({ ...base, risk: 80, regulatoryFlag: "SOX" }).total).toBeLessThan(s0);
  });
});

describe("evidenceConfidence", () => {
  it("applies the High / Medium / Low rule", () => {
    expect(evidenceConfidence({ sampleSize: 150, basis: "observed", performers: 5, performersWithCollector: 4 }).level).toBe("High");
    expect(evidenceConfidence({ sampleSize: 150, basis: "observed", performers: 5, performersWithCollector: 3 }).level).toBe("Medium");
    expect(evidenceConfidence({ sampleSize: 40, basis: "estimated", performers: 2, performersWithCollector: 2 }).level).toBe("Medium");
    expect(evidenceConfidence({ sampleSize: 20, basis: "observed", performers: 2, performersWithCollector: 2 }).level).toBe("Low");
    expect(evidenceConfidence({ sampleSize: 500, basis: "assumed", performers: 2, performersWithCollector: 2 }).level).toBe("Low");
  });
});

describe("helpers", () => {
  it("quadrants and risk buckets", () => {
    expect(quadrantOf(80, 20, 50, 50)).toBe("quick_win");
    expect(quadrantOf(80, 80, 50, 50)).toBe("strategic");
    expect(quadrantOf(20, 20, 50, 50)).toBe("fill_in");
    expect(quadrantOf(20, 80, 50, 50)).toBe("reconsider");
    expect(riskBucket(10)).toBe("low"); expect(riskBucket(40)).toBe("medium"); expect(riskBucket(70)).toBe("high");
  });
});
