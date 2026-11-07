/**
 * Pure formatting + shared constants for the Executive Command Center, Presentation Mode and exports.
 * No server or React imports: safe for client components, the export engine and unit tests.
 */
export type Fmt = "usd" | "usdCompact" | "hours" | "pct" | "months" | "count" | "text";
export type Accent = "royal" | "purple" | "cyan" | "emerald" | "gold" | "coral" | "indigo" | "midnight";
export type Basis = "observed" | "estimated" | "assumed";

export const ACCENT_HEX: Record<Accent, string> = { royal: "#2563EB", purple: "#8B5CF6", cyan: "#06B6D4", emerald: "#10B981", gold: "#F59E0B", coral: "#F43F5E", indigo: "#6366F1", midnight: "#071426" };

const usdFull = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 });
const numFmt = (d: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: d });

export function fmtValue(v: number | null | undefined, f: Fmt): string {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (f) {
    case "usd": return usdFull.format(v);
    case "usdCompact": return Math.abs(v) < 1000 ? usdFull.format(v) : usdCompact.format(v);
    case "hours": return `${numFmt(v < 10 ? 1 : 0).format(v)} hrs`;
    case "pct": return `${(v * 100).toFixed(Math.abs(v) < 0.1 && v !== 0 ? 1 : 0)}%`;
    case "months": return v > 60 ? "> 5 yrs" : `${numFmt(1).format(v)} mo`;
    case "count": return numFmt(0).format(v);
    default: return String(v);
  }
}

export const TYPE_LABEL: Record<string, string> = { ai_agent: "AI agent", rpa: "RPA bot", conventional_automation: "Integration", process_change: "Process change", role_consolidation: "Role consolidation" };
export const OPP_TYPES = ["ai_agent", "rpa", "conventional_automation", "process_change", "role_consolidation"] as const;

/** Evidence sample size → confidence. The rule is shown verbatim in the UI tooltip. */
export const CONFIDENCE_RULE = "Confidence = observed occurrences behind the estimate: High ≥ 200, Medium 50–199, Low < 50.";
export function confidenceOf(sampleSize: number): "High" | "Medium" | "Low" {
  return sampleSize >= 200 ? "High" : sampleSize >= 50 ? "Medium" : "Low";
}

/** Department priority from its share of enterprise realizable savings. Rule shown in the UI. */
export const PRIORITY_RULE = "Priority = department's share of enterprise realizable savings: High ≥ 25%, Medium ≥ 10%, Low > 0%.";
export function priorityOf(share: number): "High" | "Medium" | "Low" | "None" {
  return share >= 0.25 ? "High" : share >= 0.1 ? "Medium" : share > 0 ? "Low" : "None";
}

/** Sections of the command center that a user can hide / reorder (hero is always shown). */
export const COMMAND_SECTIONS = [
  { key: "financials", label: "Primary financial cards" },
  { key: "secondary", label: "Capacity, agents, ROI & projections" },
  { key: "viz", label: "Savings waterfall & opportunity heatmap" },
  { key: "departments", label: "Department intelligence" },
  { key: "recommendations", label: "AI recommendations" },
  { key: "tracker", label: "Transformation tracker" },
  { key: "insights", label: "Insight center" },
] as const;
export type CommandSectionKey = (typeof COMMAND_SECTIONS)[number]["key"];
export const SECTION_KEYS = COMMAND_SECTIONS.map((s) => s.key) as CommandSectionKey[];

/** Presentation-mode scenario control bounds (also enforced server-side). */
export const SCENARIO_BOUNDS = { automationPct: [0.5, 1.5], adoptionRate: [0.3, 1], realizationRate: [0.2, 1] } as const;
