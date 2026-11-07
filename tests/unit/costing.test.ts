import { describe, it, expect } from "vitest";
import { DEFAULTS, SCENARIOS, IMPLEMENTATION_PROFILES, loadedHourlyCost, opportunityEconomics, threeYearProjection, type ScenarioKey } from "@/engine/costing";

describe("loadedHourlyCost", () => {
  it("applies benefits load over paid hours", () => {
    // 60,000 × 1.3 ÷ (40 × 48) = 78,000 ÷ 1,920 = 40.625
    const r = loadedHourlyCost(60_000);
    expect(r.value).toBeCloseTo(40.625, 6);
    expect(r.tree.basis).toBe("estimated");
    expect(r.tree.children?.map((c) => c.basis)).toEqual(["observed", "assumed", "assumed"]);
  });
  it("honours custom load and hours", () => {
    // 100,000 × 1.25 ÷ (37.5 × 50) = 125,000 ÷ 1,875 = 66.667
    expect(loadedHourlyCost(100_000, 0.25, 37.5, 50).value).toBeCloseTo(66.6667, 3);
  });
});

describe("opportunityEconomics", () => {
  const base = { type: "ai_agent" as const, hoursPerWeek: 20, automationPct: 0.5, avgLoadedHourly: 50, employeeCount: 2, complexity: 0.5 };
  // Hand values derived from the profile so they survive profile tuning but stay checkable.
  // With ai_agent = 24 h / $500 / $149/mo and complexity 0.5: impl = 24 × 1.5 × 175 + 500 = 6,800; opex = 1,788.
  const AI = IMPLEMENTATION_PROFILES.ai_agent;
  const IMPL = AI.consultingHours * (1 + base.complexity) * DEFAULTS.consultingHourly + AI.toolingOneTime;
  const OPEX = AI.monthlyRun * 12;
  it("matches hand calculation with defaults", () => {
    const e = opportunityEconomics(base);
    // recoverable = 20 × 0.5 × 0.75 = 7.5
    expect(e.hoursRecoverablePerWeek).toBeCloseTo(7.5, 9);
    // gross = 7.5 × 48 × 50 = 18,000
    expect(e.grossAnnualSavings).toBeCloseTo(18_000, 6);
    // realizable = 18,000 × 0.6 = 10,800
    expect(e.realizableAnnualSavings).toBeCloseTo(10_800, 6);
    // implementation = consultingHours × (1 + 0.5) × 175 + tooling
    expect(e.implementationCost).toBeCloseTo(IMPL, 6);
    // operating = monthlyRun × 12
    expect(e.annualOperatingCost).toBeCloseTo(OPEX, 6);
    const NET = 10_800 - OPEX;
    expect(e.netAnnualSavings).toBeCloseTo(NET, 6);
    // payback = implementation ÷ (net ÷ 12)
    expect(e.paybackMonths).toBeCloseTo(IMPL / (NET / 12), 6);
    expect(e.roi1y).toBeCloseTo((NET - IMPL) / IMPL, 9);
    expect(e.roi3y).toBeCloseTo((NET * 3 - IMPL) / IMPL, 9);
    expect(e.tree.basis).toBe("estimated");
    expect(e.tree.children?.every((c) => c.basis)).toBe(true);
  });
  it("returns null payback when net ≤ 0", () => {
    const e = opportunityEconomics({ ...base, hoursPerWeek: 0.1 });
    expect(e.netAnnualSavings).toBeLessThan(0);
    expect(e.paybackMonths).toBeNull();
  });
  it("respects adoption/realization/consulting overrides", () => {
    const e = opportunityEconomics({ ...base, adoptionRate: 1, realizationRate: 1, consultingHourly: 100, weeksPerYear: 50 });
    expect(e.hoursRecoverablePerWeek).toBeCloseTo(10, 9);
    expect(e.grossAnnualSavings).toBeCloseTo(10 * 50 * 50, 6);
    expect(e.realizableAnnualSavings).toBeCloseTo(e.grossAnnualSavings, 6);
    expect(e.implementationCost).toBeCloseTo(AI.consultingHours * 1.5 * 100 + AI.toolingOneTime, 6);
  });
  it("perAgentMonthly replaces the ai_agent run cost only; costMult scales costs", () => {
    const ai = opportunityEconomics({ ...base, perAgentMonthly: 99 });
    expect(ai.annualOperatingCost).toBeCloseTo(99 * 12, 6);
    const rpa = opportunityEconomics({ ...base, type: "rpa", perAgentMonthly: 99 });
    expect(rpa.annualOperatingCost).toBeCloseTo(IMPLEMENTATION_PROFILES.rpa.monthlyRun * 12, 6);
    const scaled = opportunityEconomics({ ...base, costMult: 1.3 });
    expect(scaled.implementationCost).toBeCloseTo(IMPL * 1.3, 6);
    expect(scaled.annualOperatingCost).toBeCloseTo(OPEX * 1.3, 6);
    expect(scaled.realizableAnnualSavings).toBeCloseTo(10_800, 6);
  });
  it("process_change has no tooling or run cost", () => {
    const e = opportunityEconomics({ ...base, type: "process_change", complexity: 0 });
    const PC = IMPLEMENTATION_PROFILES.process_change;
    expect(PC.toolingOneTime).toBe(0); expect(PC.monthlyRun).toBe(0);
    expect(e.implementationCost).toBeCloseTo(PC.consultingHours * DEFAULTS.consultingHourly, 6);
    expect(e.annualOperatingCost).toBe(0);
  });
});

describe("scenarios", () => {
  it("are monotonic conservative < expected < aggressive on savings and reverse on cost", () => {
    const base = { type: "ai_agent" as const, hoursPerWeek: 30, automationPct: 0.6, avgLoadedHourly: 45, employeeCount: 3, complexity: 0.3 };
    const run = (k: ScenarioKey) => { const s = SCENARIOS[k]; return opportunityEconomics({ ...base, automationPct: Math.min(1, base.automationPct * s.automationMult), adoptionRate: s.adoptionRate, realizationRate: s.realizationRate, costMult: s.costMult }); };
    const c = run("conservative"), e = run("expected"), a = run("aggressive");
    expect(c.hoursRecoverablePerWeek).toBeLessThan(e.hoursRecoverablePerWeek);
    expect(e.hoursRecoverablePerWeek).toBeLessThan(a.hoursRecoverablePerWeek);
    expect(c.realizableAnnualSavings).toBeLessThan(e.realizableAnnualSavings);
    expect(e.realizableAnnualSavings).toBeLessThan(a.realizableAnnualSavings);
    expect(c.implementationCost).toBeGreaterThan(e.implementationCost);
    expect(e.implementationCost).toBeGreaterThan(a.implementationCost);
    expect(c.netAnnualSavings).toBeLessThan(e.netAnnualSavings);
    expect(e.netAnnualSavings).toBeLessThan(a.netAnnualSavings);
  });
});

describe("threeYearProjection", () => {
  it("ramps year 1 and charges implementation once", () => {
    const p = threeYearProjection({ realizableAnnual: 120_000, operatingAnnual: 12_000, implementationCost: 30_000, rampMonths: 6, discountRate: 0.1, platformAnnual: 6_000 });
    // y1 factor = 1 − 6/24 = 0.75 → savings 90,000; costs 12,000 + 6,000 + 30,000 = 48,000; net 42,000
    expect(p.years[0].savings).toBeCloseTo(90_000, 6);
    expect(p.years[0].costs).toBeCloseTo(48_000, 6);
    expect(p.years[0].net).toBeCloseTo(42_000, 6);
    // y2, y3: savings 120,000; costs 18,000; net 102,000
    expect(p.years[1].net).toBeCloseTo(102_000, 6);
    expect(p.years[2].net).toBeCloseTo(102_000, 6);
    expect(p.years[2].cumulative).toBeCloseTo(42_000 + 102_000 * 2, 6);
    expect(p.totalNet).toBeCloseTo(246_000, 6);
    expect(p.roi3y).toBeCloseTo(246_000 / 30_000, 9);
    const npv = 42_000 / 1.1 + 102_000 / 1.1 ** 2 + 102_000 / 1.1 ** 3;
    expect(p.npv).toBeCloseTo(npv, 4);
    expect(p.years[0].savings).toBeLessThan(p.years[1].savings);
    expect(p.years[1].savings).toBe(p.years[2].savings);
  });
  it("uses default ramp and discount when omitted", () => {
    const p = threeYearProjection({ realizableAnnual: 100, operatingAnnual: 0, implementationCost: 0 });
    expect(p.years[0].savings).toBeCloseTo(100 * (1 - DEFAULTS.rampMonths / 24), 9);
    expect(p.roi3y).toBe(0);
  });
});
