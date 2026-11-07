/**
 * Shared economics — the ONE place formulas live. Used by the analysis engine (per-opportunity numbers),
 * the finance engine (org roll-ups, scenarios) and the UI (drill-downs render the CalcTree returned here).
 * Pure functions, no DB. Every output carries a CalcTree so the UI can show "how was this computed".
 */
import type { CalcTree } from "@/db/schema";

export type Basis = "observed" | "estimated" | "assumed";
export const DEFAULTS = {
  benefitsLoadPct: 0.30, // employer taxes + benefits on top of base pay
  workHoursPerWeek: 40,
  workWeeksPerYear: 48, // after PTO/holidays
  adoptionRate: 0.75, // share of eligible runs that actually go through the automation
  realizationRate: 0.60, // share of recovered hours that becomes realizable $ (reassigned capacity, attrition, avoided hires)
  consultingHourly: 175,
  perAgentMonthly: 149, // platform + model + runtime cost per deployed agent (see docs/COSTS.md)
  platformFeeMonthly: 499,
  discountRate: 0.08,
  rampMonths: 3,
} as const;

export function loadedHourlyCost(baseAnnualCost: number, benefitsLoadPct: number = DEFAULTS.benefitsLoadPct, hoursPerWeek: number = DEFAULTS.workHoursPerWeek, weeksPerYear: number = DEFAULTS.workWeeksPerYear): { value: number; tree: CalcTree } {
  const annualHours = hoursPerWeek * weeksPerYear;
  const value = (baseAnnualCost * (1 + benefitsLoadPct)) / annualHours;
  return { value, tree: { label: "Loaded hourly cost", value, unit: "usd", basis: "estimated", formula: `base ${baseAnnualCost} × (1 + ${benefitsLoadPct}) ÷ (${hoursPerWeek} h/wk × ${weeksPerYear} wk)`, children: [
    { label: "Base annual cost", value: baseAnnualCost, unit: "usd", basis: "observed", source: "Employee record" },
    { label: "Benefits & taxes load", value: benefitsLoadPct, unit: "pct", basis: "assumed", source: "Org setting" },
    { label: "Paid hours per year", value: annualHours, unit: "hours", basis: "assumed", formula: `${hoursPerWeek} × ${weeksPerYear}` },
  ] } };
}

/** Implementation effort heuristics by opportunity type (consulting hours + tooling). */
export const IMPLEMENTATION_PROFILES: Record<string, { consultingHours: number; toolingOneTime: number; monthlyRun: number; label: string }> = {
  ai_agent: { consultingHours: 40, toolingOneTime: 1500, monthlyRun: DEFAULTS.perAgentMonthly, label: "AI agent (LLM + integrations)" },
  rpa: { consultingHours: 60, toolingOneTime: 3000, monthlyRun: 220, label: "RPA bot" },
  conventional_automation: { consultingHours: 24, toolingOneTime: 500, monthlyRun: 40, label: "Integration / scripted automation" },
  process_change: { consultingHours: 16, toolingOneTime: 0, monthlyRun: 0, label: "Process redesign (no software)" },
  role_consolidation: { consultingHours: 12, toolingOneTime: 0, monthlyRun: 0, label: "Role / capacity reallocation" },
};

export type OpportunityInput = {
  type: keyof typeof IMPLEMENTATION_PROFILES;
  hoursPerWeek: number; // observed workflow hours/week across all employees
  automationPct: number; // 0..1 share of workflow time the automation removes
  avgLoadedHourly: number; // weighted across the employees performing it
  employeeCount: number;
  complexity: number; // 0..1 (apps involved, judgment, handoffs) — raises implementation hours
  adoptionRate?: number; realizationRate?: number; weeksPerYear?: number; consultingHourly?: number;
  basisHours?: Basis;
  /** Monthly run cost for `ai_agent` opportunities (platform per-agent fee). Defaults to the profile's monthlyRun. */
  perAgentMonthly?: number;
  /** Multiplier on implementation + operating cost (scenario costMult). Default 1. */
  costMult?: number;
};
export type OpportunityEconomics = {
  hoursRecoverablePerWeek: number; grossAnnualSavings: number; realizableAnnualSavings: number;
  implementationCost: number; annualOperatingCost: number; netAnnualSavings: number; paybackMonths: number | null; roi1y: number; roi3y: number;
  tree: CalcTree;
};
export function opportunityEconomics(i: OpportunityInput): OpportunityEconomics {
  const adoption = i.adoptionRate ?? DEFAULTS.adoptionRate;
  const realization = i.realizationRate ?? DEFAULTS.realizationRate;
  const weeks = i.weeksPerYear ?? DEFAULTS.workWeeksPerYear;
  const hourly = i.consultingHourly ?? DEFAULTS.consultingHourly;
  const prof = IMPLEMENTATION_PROFILES[i.type];
  const hoursRecoverablePerWeek = i.hoursPerWeek * i.automationPct * adoption;
  const grossAnnualSavings = hoursRecoverablePerWeek * weeks * i.avgLoadedHourly;
  const realizableAnnualSavings = grossAnnualSavings * realization;
  const costMult = i.costMult ?? 1;
  const monthlyRun = i.type === "ai_agent" && i.perAgentMonthly != null ? i.perAgentMonthly : prof.monthlyRun;
  const consultingHours = prof.consultingHours * (1 + i.complexity) ;
  const implementationCost = (consultingHours * hourly + prof.toolingOneTime) * costMult;
  const annualOperatingCost = monthlyRun * 12 * costMult;
  const netAnnualSavings = realizableAnnualSavings - annualOperatingCost;
  const paybackMonths = netAnnualSavings > 0 ? (implementationCost / (netAnnualSavings / 12)) : null;
  const roi1y = implementationCost > 0 ? (netAnnualSavings - implementationCost) / implementationCost : 0;
  const roi3y = implementationCost > 0 ? (netAnnualSavings * 3 - implementationCost) / implementationCost : 0;
  const bh = i.basisHours ?? "observed";
  const tree: CalcTree = { label: "Realizable annual savings", value: realizableAnnualSavings, unit: "usd", basis: "estimated", formula: "gross annual savings × realization rate", children: [
    { label: "Gross annual savings", value: grossAnnualSavings, unit: "usd", basis: "estimated", formula: "recoverable hrs/wk × weeks/yr × avg loaded hourly", children: [
      { label: "Hours recoverable per week", value: hoursRecoverablePerWeek, unit: "hours", basis: "estimated", formula: "workflow hrs/wk × automation % × adoption rate", children: [
        { label: "Observed workflow hours per week", value: i.hoursPerWeek, unit: "hours", basis: bh, source: "Collector events (sum of step durations)" },
        { label: "Share of time automatable", value: i.automationPct, unit: "pct", basis: "estimated", source: "Automation scoring model" },
        { label: "Adoption rate", value: adoption, unit: "pct", basis: "assumed", source: "Financial model assumption" },
      ] },
      { label: "Working weeks per year", value: weeks, unit: "weeks", basis: "assumed" },
      { label: "Average loaded hourly cost", value: i.avgLoadedHourly, unit: "usd", basis: "estimated", source: `Weighted across ${i.employeeCount} employee(s)` },
    ] },
    { label: "Realization rate", value: realization, unit: "pct", basis: "assumed", source: "Share of freed time that becomes avoided hiring, reassigned revenue work or attrition backfill. Time saved ≠ payroll cut." },
    { label: "Implementation cost (one-time)", value: implementationCost, unit: "usd", basis: "estimated", formula: `(${consultingHours.toFixed(0)} consulting hrs × $${hourly} + $${prof.toolingOneTime} tooling)${costMult !== 1 ? ` × ${costMult}` : ""}`, children: [
      { label: "Base effort for " + prof.label, value: prof.consultingHours, unit: "hours", basis: "assumed" },
      { label: "Complexity multiplier", value: 1 + i.complexity, unit: "x", basis: "estimated", source: "Apps involved, handoffs, judgment flags" },
      ...(costMult !== 1 ? [{ label: "Scenario cost multiplier", value: costMult, unit: "x", basis: "assumed" as const, source: "Financial scenario" }] : []),
    ] },
    { label: "Annual operating cost", value: annualOperatingCost, unit: "usd", basis: "assumed", formula: `$${monthlyRun}/mo × 12${costMult !== 1 ? ` × ${costMult}` : ""}` },
    { label: "Net annual savings", value: netAnnualSavings, unit: "usd", basis: "estimated", formula: "realizable − operating" },
    { label: "Payback period", value: paybackMonths ?? 0, unit: "months", basis: "estimated", formula: "implementation ÷ (net annual ÷ 12)" },
  ] };
  return { hoursRecoverablePerWeek, grossAnnualSavings, realizableAnnualSavings, implementationCost, annualOperatingCost, netAnnualSavings, paybackMonths, roi1y, roi3y, tree };
}

export type ScenarioKey = "conservative" | "expected" | "aggressive";
export const SCENARIOS: Record<ScenarioKey, { label: string; automationMult: number; adoptionRate: number; realizationRate: number; costMult: number }> = {
  conservative: { label: "Conservative", automationMult: 0.7, adoptionRate: 0.6, realizationRate: 0.45, costMult: 1.3 },
  expected: { label: "Expected", automationMult: 1.0, adoptionRate: 0.75, realizationRate: 0.6, costMult: 1.0 },
  aggressive: { label: "Aggressive", automationMult: 1.15, adoptionRate: 0.9, realizationRate: 0.75, costMult: 0.9 },
};

/** Three-year cash flow with ramp. Returns yearly rows + NPV. */
export function threeYearProjection(p: { realizableAnnual: number; operatingAnnual: number; implementationCost: number; rampMonths?: number; discountRate?: number; platformAnnual?: number }) {
  const ramp = p.rampMonths ?? DEFAULTS.rampMonths; const r = p.discountRate ?? DEFAULTS.discountRate; const platform = p.platformAnnual ?? 0;
  const y1Factor = 1 - ramp / 24; // linear ramp over `ramp` months → average share in year 1
  const years = [1, 2, 3].map((y) => {
    const savings = p.realizableAnnual * (y === 1 ? y1Factor : 1);
    const costs = p.operatingAnnual + platform + (y === 1 ? p.implementationCost : 0);
    const net = savings - costs;
    return { year: y, savings, costs, net, cumulative: 0, discounted: net / Math.pow(1 + r, y) };
  });
  let cum = 0; for (const y of years) { cum += y.net; y.cumulative = cum; }
  const npv = years.reduce((s, y) => s + y.discounted, 0);
  return { years, npv, totalNet: cum, roi3y: p.implementationCost > 0 ? cum / p.implementationCost : 0 };
}
