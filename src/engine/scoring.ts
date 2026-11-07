/**
 * Scoring — PURE functions (no DB). Weights are documented in docs/ANALYSIS_METHOD.md; keep both in sync.
 */
import type { WorkflowMetrics } from "./mining";
import { jaccard } from "./mining";

export type AgentCategory = "customer_service" | "scheduling" | "sales_crm" | "email_admin" | "ap_ar" | "invoice" | "reporting" | "inventory" | "marketing" | "onboarding" | "document" | "data_entry";
export type OpportunityType = "ai_agent" | "rpa" | "conventional_automation" | "process_change" | "role_consolidation";

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));

// ---------- weights (see ANALYSIS_METHOD.md) ----------
export const REPETITION_WEIGHTS = { frequency: 40, consistency: 35, structuredShare: 25 } as const;
export const AUTOMATION_WEIGHTS = { structuredEntry: 35, swivelChair: 15, apiFriendliness: 30, lowVariance: 20, penaltyJudgment: 20, penaltyRegulatory: 10, penaltyHandoff: 10 } as const;
/** How API-friendly an app category is (0..1). Reading/judgment categories score low. */
export const API_FRIENDLY: Record<string, number> = { erp: 0.95, accounting: 0.95, crm: 0.9, helpdesk: 0.9, email: 0.8, spreadsheet: 0.8, calendar: 0.7, browser: 0.5, chat: 0.5, presentation: 0.4, document: 0.3, idle: 0, meeting: 0 };
/** Browser titles that are really business systems (which usually expose APIs). */
const BROWSER_SYSTEM = /(system|portal|dashboard|analytics|crm|knowledge base|console|admin)/i;

/** Titles implying a human decision. "approval request" (asking someone else to approve) is clerical and does not match. */
const JUDGMENT = /(contract|reconcil|review|approve|approval decision|dispute|exception|negotiat|legal|audit|credit decision|underwrit)/i;
const REGULATORY: [RegExp, string][] = [
  [/(patient|medical|clinical|phi|claim|hipaa|prescription)/i, "HIPAA"],
  [/(reconcil|journal entry|general ledger|bank|sox|financial close|audit)/i, "SOX"],
  [/(contract|nda|agreement|legal|litigation)/i, "Legal"],
  [/(hr system|onboarding|employee record|payroll|ssn|personnel|benefits|background check|i-9|w-4)/i, "PII"],
];

export type Flags = { requiresJudgment: boolean; regulatoryFlag: string | null; reasons: string[] };
export function detectFlags(m: Pick<WorkflowMetrics, "titleTime" | "categoryShare" | "steps">): Flags {
  const titles = Object.keys(m.titleTime);
  const reasons: string[] = [];
  let requiresJudgment = false; let regulatoryFlag: string | null = null;
  for (const t of titles) { if (JUDGMENT.test(t)) { requiresJudgment = true; reasons.push(`"${t}" implies human judgment`); break; } }
  // Long document reading dominates → judgment work (reading a document is not data entry)
  const docRead = m.steps.filter((s) => s.category === "document" && s.action.includes("document open")).reduce((s, x) => s + x.share, 0);
  if (!requiresJudgment && docRead >= 0.5) { requiresJudgment = true; reasons.push(`${Math.round(docRead * 100)}% of time is reading documents`); }
  for (const [re, flag] of REGULATORY) { const hit = titles.find((t) => re.test(t)); if (hit) { regulatoryFlag = flag; reasons.push(`"${hit}" → ${flag}`); break; } }
  return { requiresJudgment, regulatoryFlag, reasons };
}

export type ScoreBreakdown = { score: number; parts: Record<string, number> };

/** Repetition 0..100: frequency (sqrt-scaled, 25 runs/week saturates), sequence consistency, share of structured events. */
export function repetitionScore(m: Pick<WorkflowMetrics, "runsPerWeek" | "canonicalShare" | "typeShare">): ScoreBreakdown {
  const frequency = REPETITION_WEIGHTS.frequency * Math.min(1, Math.sqrt(m.runsPerWeek / 25));
  const consistency = REPETITION_WEIGHTS.consistency * m.canonicalShare;
  const structured = REPETITION_WEIGHTS.structuredShare * ((m.typeShare.data_entry ?? 0) + (m.typeShare.copy_paste ?? 0) + (m.typeShare.navigation ?? 0));
  const parts = { frequency, consistency, structured };
  return { score: clamp(frequency + consistency + structured), parts };
}

export function apiFriendliness(m: Pick<WorkflowMetrics, "steps">): number {
  let num = 0, den = 0;
  for (const s of m.steps) {
    let f = API_FRIENDLY[s.category ?? ""] ?? 0.4;
    if (s.category === "browser" && BROWSER_SYSTEM.test(s.action)) f = 0.75;
    num += f * s.share; den += s.share;
  }
  return den ? num / den : 0;
}

/** Automation 0..100. */
export function automationScore(m: WorkflowMetrics, flags: Flags): ScoreBreakdown {
  const W = AUTOMATION_WEIGHTS;
  const structuredShare = (m.typeShare.data_entry ?? 0) + (m.typeShare.copy_paste ?? 0) + (m.typeShare.form_submit ?? 0);
  const structuredEntry = W.structuredEntry * structuredShare;
  const pasteStepShare = m.steps.length ? m.pasteSteps / m.steps.length : 0;
  const swivel = m.distinctApps >= 2 ? W.swivelChair * Math.min(1, 2 * pasteStepShare) : 0;
  const api = W.apiFriendliness * apiFriendliness(m);
  const variance = W.lowVariance * (0.5 * (1 - Math.min(1, m.durationCv)) + 0.5 * m.canonicalShare);
  const pJudgment = flags.requiresJudgment ? W.penaltyJudgment : 0;
  const pRegulatory = flags.regulatoryFlag ? W.penaltyRegulatory : 0;
  const pHandoff = W.penaltyHandoff * Math.min(1, m.handoffRate);
  const parts = { structuredEntry, swivel, api, variance, pJudgment: -pJudgment, pRegulatory: -pRegulatory, pHandoff: -pHandoff };
  return { score: clamp(structuredEntry + swivel + api + variance - pJudgment - pRegulatory - pHandoff), parts };
}

/** Complexity 0..1 for implementation effort: apps involved, handoffs, judgment. */
export function complexity(m: Pick<WorkflowMetrics, "distinctApps" | "handoffRate">, flags: Flags): number {
  return Math.min(1, Math.max(0, 0.5 * Math.min(1, (m.distinctApps - 1) / 5) + 0.25 * Math.min(1, m.handoffRate) + (flags.requiresJudgment ? 0.25 : 0)));
}

// ---------- duplicate work ----------
export type DuplicateCandidate = { key: string; tokens: string[]; hoursPerWeek: number; departmentIds: string[] };
export type DuplicatePair = { smaller: string; larger: string; overlap: number; reason: string };
/** Two workflows whose token sets overlap ≥ 80% → the smaller (by hours/week) is a duplicate of the larger. */
export function findDuplicates(cands: DuplicateCandidate[], threshold = 0.8): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  const taken = new Set<string>();
  const sorted = cands.slice().sort((a, b) => b.hoursPerWeek - a.hoursPerWeek);
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    if (taken.has(sorted[j].key)) continue;
    const overlap = jaccard(sorted[i].tokens, sorted[j].tokens);
    if (overlap >= threshold) { taken.add(sorted[j].key); pairs.push({ smaller: sorted[j].key, larger: sorted[i].key, overlap, reason: `${Math.round(overlap * 100)}% of steps overlap with the larger workflow` }); }
  }
  return pairs;
}
/** Same workflow performed in more than one department (a note, not a separate workflow). */
export function crossDepartmentNote(departmentNames: string[]): string | null {
  const d = Array.from(new Set(departmentNames.filter(Boolean)));
  return d.length > 1 ? `Duplicate work: the same workflow is performed in ${d.length} departments (${d.join(", ")}).` : null;
}

// ---------- recommendations ----------
export function opportunityType(m: WorkflowMetrics, auto: number, flags: Flags, isDuplicate: boolean): OpportunityType {
  if (isDuplicate) return "role_consolidation";
  if (m.reworkRate > 0.15 && auto < 50) return "process_change";
  const cs = m.categoryShare; const ts = m.typeShare;
  const sheet = cs.spreadsheet ?? 0; const erp = (cs.erp ?? 0) + (cs.accounting ?? 0);
  const firstNav = m.steps.findIndex((s) => s.action.includes("(navigation)") && (s.category === "erp" || s.category === "browser" || s.category === "accounting"));
  const firstSheet = m.steps.findIndex((s) => s.category === "spreadsheet");
  if (sheet >= 0.35 && (ts.copy_paste ?? 0) >= 0.2 && firstNav >= 0 && firstNav < firstSheet) return "conventional_automation"; // export → spreadsheet → report
  if (erp >= 0.3 && (m.pasteSteps > 0 || m.distinctApps >= 3)) return "rpa"; // swivel-chair into ERP/accounting
  const human = (cs.email ?? 0) + (cs.helpdesk ?? 0) + (cs.calendar ?? 0) + (cs.document ?? 0) + (cs.chat ?? 0);
  if (human >= 0.3 || flags.requiresJudgment) return "ai_agent";
  return "conventional_automation";
}

const CATEGORY_RULES: [RegExp, AgentCategory][] = [
  [/(invoice|bill entry|vendor)/, "invoice"],
  [/(reconcil|bank|payment|receivable|payable|journal)/, "ap_ar"],
  [/(ticket|support|case|complaint)/, "customer_service"],
  [/(schedul|availability|appointment|calendar)/, "scheduling"],
  [/(onboarding|hr system|new hire|employee record)/, "onboarding"],
  [/(inventory|count sheet|variance|stock)/, "inventory"],
  [/(campaign|ads|social|marketing)/, "marketing"],
  [/(report|deck|dashboard|export|analytics)/, "reporting"],
  [/(order|quote|customer portal|crm|lead|sales)/, "sales_crm"],
  [/(contract|agreement|memo|policy|document)/, "document"],
];
export function agentCategory(m: Pick<WorkflowMetrics, "titleTime" | "categoryShare" | "typeShare">): AgentCategory {
  const titles = Object.entries(m.titleTime).sort((a, b) => b[1] - a[1]);
  for (const [re, cat] of CATEGORY_RULES) if (titles.some(([t]) => re.test(t))) return cat;
  if ((m.categoryShare.email ?? 0) >= 0.4) return "email_admin";
  if ((m.typeShare.data_entry ?? 0) >= 0.3) return "data_entry";
  return "email_admin";
}

export type RiskInput = { regulatoryFlag: string | null; requiresJudgment: boolean; employeeCount: number; handoffRate: number };
export function riskScore(r: RiskInput): number {
  return clamp((r.regulatoryFlag ? 35 : 0) + (r.requiresJudgment ? 30 : 0) + Math.min(25, r.employeeCount * 5) + 10 * Math.min(1, r.handoffRate));
}
export function feasibilityScore(auto: number, api: number, integrationConnected: boolean): number {
  return clamp(auto + 10 * api - (integrationConnected ? 0 : 5));
}
/** automation % of workflow time removable = score/100 × 0.85, capped at 0.8. */
export function automationPct(auto: number): number { return Math.min(0.8, (auto / 100) * 0.85); }
/** Rank value: higher is better. */
export function rankValue(realizableAnnualSavings: number, feasibility: number, risk: number): number { return (realizableAnnualSavings * (feasibility / 100)) / (1 + risk / 100); }
