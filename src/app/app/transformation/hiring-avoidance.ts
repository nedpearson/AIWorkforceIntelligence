/**
 * Pure redeployment math, shared by the capacity engine (src/engine/capacity.ts re-exports it), the server action
 * that submits cost avoidance, and the browser planner. No imports with side effects — safe in client bundles.
 * Avoided future hires = min(planned hires, FTE released × utilization), valued at loaded cost per FTE.
 */
import type { CalcTree } from "@/db/schema";

export type HiringAvoidanceInput = { plannedHires: number; fteReleased: number; utilization: number; loadedCostPerFte: number };
export function hiringAvoidance(i: HiringAvoidanceInput): { avoidedHires: number; value: number; usableFte: number; tree: CalcTree } {
  const util = Math.min(1, Math.max(0, i.utilization));
  const usableFte = Math.max(0, i.fteReleased) * util;
  const avoidedHires = Math.min(Math.max(0, i.plannedHires), usableFte);
  const value = avoidedHires * Math.max(0, i.loadedCostPerFte);
  return { avoidedHires, usableFte, value, tree: { label: "Hiring avoidance potential", value, unit: "usd", basis: "estimated", formula: "min(planned hires, FTE released × utilization) × loaded cost per FTE", children: [
    { label: "Planned hires (next 12 months)", value: i.plannedHires, unit: "FTE", basis: "assumed", source: "Entered in the redeployment planner" },
    { label: "FTE capacity released", value: i.fteReleased, unit: "FTE", basis: "estimated" },
    { label: "Utilization of released capacity", value: util, unit: "pct", basis: "assumed", source: "Entered in the redeployment planner" },
    { label: "Loaded cost per FTE", value: i.loadedCostPerFte, unit: "usd", basis: "estimated", source: "Department labor ÷ headcount (finance engine)" },
  ] } };
}
