/** Graph-building helpers shared by the template files (kept separate to avoid an import cycle). */
import type { AgentDefinition, AgentNode } from "@/db/schema";
import { IMPLEMENTATION_PROFILES } from "@/engine/costing";

export const AI = IMPLEMENTATION_PROFILES.ai_agent.monthlyRun;
export const CONV = IMPLEMENTATION_PROFILES.conventional_automation.monthlyRun;
export const RETRIES = { max: 2, backoffMs: 500 };

// ---- graph helpers --------------------------------------------------------------------------
export const n = (id: string, type: AgentNode["type"], label: string, config: Record<string, unknown> = {}, extra: Partial<AgentNode> = {}): AgentNode => ({ id, type, label, config, ...extra });
/** Chain nodes linearly. Approval nodes get approved→next and rejected→end edges. */
export function chain(nodes: AgentNode[], extraEdges: AgentDefinition["edges"] = [], schedule?: string): AgentDefinition {
  const edges: AgentDefinition["edges"] = [];
  const end = nodes.find((x) => x.type === "end")!;
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    if (a.type === "approval") { edges.push({ from: a.id, to: b.id, when: "approved" }); edges.push({ from: a.id, to: end.id, when: "rejected" }); }
    else if (a.type === "condition") { /* explicit edges supplied by caller */ }
    else edges.push({ from: a.id, to: b.id });
  }
  return { nodes, edges: [...edges, ...extraEdges], retries: RETRIES, ...(schedule ? { schedule } : {}) };
}
export const llm = (id: string, label: string, system: string, prompt: string) => n(id, "llm", label, { system, prompt, maxTokens: 1024 });
export const http = (id: string, label: string, cfg: Record<string, unknown>, compensate?: Record<string, unknown>) => n(id, "action", label, { kind: "http", ...cfg }, compensate ? { compensate } : {});
export const notify = (id: string, message: string, extra: Record<string, unknown> = {}) => n(id, "notify", "Notify owner", { message, ...extra });
export const approval = (id: string, action: string, reviewMinutes = 2) => n(id, "approval", "Human approval", { action, reviewMinutes }, { sensitive: true });
export const end = (cfg: Record<string, unknown> = {}) => n("end", "end", "Done", cfg);
export const trigger = (label: string, cfg: Record<string, unknown> = {}) => n("trigger", "trigger", label, cfg);

