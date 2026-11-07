/**
 * Shared types for the finance engine (src/engine/finance.ts).
 * Every number that leaves computeOrgFinancials is either on this type or inside one of its CalcTrees.
 */
import type { CalcTree, FinancialAssumptions } from "@/db/schema";
import type { ScenarioKey } from "./costing";

export type Basis = "observed" | "estimated" | "assumed";

/** Overrides accepted by computeOrgFinancials — this is what the dashboard sliders send. */
export type FinancialOverrides = Partial<FinancialAssumptions> & {
  /** Apply a named scenario (automation multiplier, adoption, realization, cost multiplier). Explicit fields win over the scenario. */
  scenario?: ScenarioKey;
  /** Restrict the roll-up to these opportunities (e.g. a proposal for a subset). Default: all non-rejected. */
  opportunityIds?: string[];
};

export type HeadlineNumbers = {
  hoursRecoverablePerWeek: number;
  grossAnnualSavings: number;
  realizableAnnualSavings: number;
  implementationCost: number;
  annualOperatingCost: number;
  platformAnnual: number;
  netAnnualSavings: number;
  roi1y: number;
  paybackMonths: number | null;
};

export type ThreeYear = {
  years: { year: number; savings: number; costs: number; net: number; cumulative: number; discounted: number }[];
  npv: number;
  totalNet: number;
  roi3y: number;
};

export type ScenarioResult = HeadlineNumbers & {
  key: ScenarioKey;
  label: string;
  threeYear: ThreeYear;
};

export type OpportunityLine = {
  id: string;
  title: string;
  type: string;
  status: string;
  rank: number;
  workflowId: string | null;
  workflowName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  feasibility: number;
  risk: number;
  automationPct: number;
  hoursPerWeek: number;
  hoursRecoverablePerWeek: number;
  grossAnnualSavings: number;
  realizableAnnualSavings: number;
  implementationCost: number;
  annualOperatingCost: number;
  netAnnualSavings: number;
  paybackMonths: number | null;
  roi1y: number;
  basis: Basis;
  deployed: boolean;
  tree: CalcTree;
};

export type DepartmentFinancials = {
  departmentId: string | null;
  name: string;
  employees: number;
  laborAnnual: number;
  hoursPerWeek: number;
  repetitiveHoursPerWeek: number;
  recoverableHoursPerWeek: number;
  grossAnnual: number;
  realizableAnnual: number;
  verifiedAnnual: number;
  /** recoverable hours ÷ observed hours */
  efficiencyGainPct: number;
  opportunities: number;
};

export type EmployeeFinancials = {
  employeeId: string;
  name: string;
  title: string | null;
  departmentId: string | null;
  departmentName: string | null;
  laborAnnual: number;
  loadedHourly: number;
  costBasis: Basis;
  hoursPerWeek: number;
  repetitiveHoursPerWeek: number;
  recoverableHoursPerWeek: number;
  realizableAnnual: number;
  efficiencyGainPct: number;
  topWorkflows: { workflowId: string; name: string; hoursPerWeek: number; repetitionScore: number }[];
};

export type OrgFinancials = {
  orgId: string;
  computedAt: string;
  totalAnnualLaborAnalyzed: number;
  employeesAnalyzed: number;
  hoursObservedPerWeek: number;
  repetitiveHoursPerWeek: number;
  repetitiveSharePct: number;
  hoursRecoverablePerWeek: number;
  grossAnnualSavings: number;
  realizableAnnualSavings: number;
  /** Measured, post-deployment — never mixed into projected figures. */
  verifiedAnnualizedSavings: number;
  verifiedHoursSaved: number;
  verifiedHoursSavedAnnualized: number;
  verifiedDollarsSaved: number;
  verifiedMeasurements: number;
  implementationCost: number;
  annualOperatingCost: number;
  platformAnnual: number;
  netAnnualSavings: number;
  roi1y: number;
  paybackMonths: number | null;
  /** verified annualized $ ÷ realizable projected $, capped at 100 */
  automationCompletionPct: number;
  /** deployed agents ÷ opportunities in scope, capped at 100 */
  deploymentCompletionPct: number;
  deployedAgents: number;
  opportunityCount: number;
  byDepartment: DepartmentFinancials[];
  byEmployee: EmployeeFinancials[];
  opportunities: OpportunityLine[];
  scenarios: Record<ScenarioKey, ScenarioResult>;
  threeYear: ThreeYear;
  trees: {
    totalLabor: CalcTree;
    repetitiveHours: CalcTree;
    recoverableHours: CalcTree;
    grossSavings: CalcTree;
    realizableSavings: CalcTree;
    verifiedSavings: CalcTree;
    implementationCost: CalcTree;
    operatingCost: CalcTree;
    netSavings: CalcTree;
    roi: CalcTree;
    payback: CalcTree;
    automationCompletion: CalcTree;
  };
  assumptions: FinancialAssumptions;
  scenario: ScenarioKey;
  basisSummary: { observed: number; estimated: number; assumed: number };
};

export type ReportKind = "executive_roi" | "investment_proposal" | "monthly_performance";

export type ReportOptions = {
  generatedBy?: string;
  periodStart?: Date;
  periodEnd?: Date;
  scenario?: ScenarioKey;
  opportunityIds?: string[];
};
