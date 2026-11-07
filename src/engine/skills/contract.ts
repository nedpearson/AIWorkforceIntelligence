/**
 * Skills contract — the interface between AI employees (UI, workforce engine) and the skills engine.
 * Implementation lives in src/engine/skills/index.ts (owned by the skills engineer). UI code imports ONLY from "@/engine/skills".
 *
 * A skill is a typed, permissioned unit of work with explicit inputs/outputs, validation and error handling.
 *  - mode "sandbox": synthetic sample data, no external side effects, clearly labelled "Synthetic sample".
 *  - mode "live": real org data/integrations, subject to the AI employee's permissionLevel:
 *      read_only        → may read & analyze only (no drafts persisted outside BridgeBox)
 *      draft_only       → may produce drafts stored in BridgeBox for a human to use
 *      act_with_approval→ consequential actions create an approval; executed only after a human approves
 *      autonomous       → never the default; owner must set explicitly; still blocked for steps flagged `alwaysApprove`
 *  - budgets: monthlyRunBudget / monthlyCostBudget on ai_employees are enforced before execution.
 */
import type { z } from "zod";
import type { Citation } from "@/engine/brain";

export type SkillAccess = "read" | "draft" | "act";
export type SkillStep = { key: string; label: string; status: "done" | "skipped" | "failed" | "awaiting_approval"; ms: number; detail?: string; data?: Record<string, unknown> };
export type SkillResult = {
  ok: boolean; status: "succeeded" | "failed" | "awaiting_approval" | "rejected";
  summary: string; // plain-English outcome for non-technical users
  output: Record<string, unknown>; steps: SkillStep[]; citations: Citation[];
  durationMs: number; manualBaselineMinutes: number; humanReviewMinutes: number;
  synthetic: boolean; error?: string; skillRunId?: string;
};
export type SkillDefinition<I = unknown> = {
  key: string; name: string; description: string; category: "finance" | "sales" | "operations" | "marketing" | "hr" | "customer_service" | "executive";
  access: SkillAccess; // highest access the skill can need
  alwaysApproveSteps?: string[]; // step keys that always require human approval in live mode
  inputSchema: z.ZodType<I>; outputDescription: string;
  manualBaselineMinutes: number; // documented manual time per execution (assumption, shown as such)
  sampleInput: () => I; // synthetic sample for sandbox demos
  requiresProviders?: string[]; // integrations needed for live mode (catalog keys)
};
/** Functions the skills engine exports from "@/engine/skills": */
export type SkillsApi = {
  SKILLS: SkillDefinition[];
  getSkill(key: string): SkillDefinition | undefined;
  /** Validates, enforces permission level + budgets + RBAC-scoped knowledge, executes, persists a skill_runs row, audits. */
  runSkill(args: { orgId: string; aiEmployeeId: string; skillKey: string; mode: "sandbox" | "live"; input?: unknown; actorUserId: string; actorRole: string }): Promise<SkillResult>;
  /** Approve/reject a live run waiting on a human; executes the gated step on approval. */
  decideSkillRun(args: { orgId: string; skillRunId: string; decision: "approve" | "reject"; actorUserId: string; note?: string }): Promise<SkillResult>;
  /** Manager feedback on output → creates pending ai_employee_memory (correction/procedure). Never changes permissions. */
  reviewSkillRun(args: { orgId: string; skillRunId: string; verdict: "accepted" | "corrected" | "rejected"; note?: string; improvement?: string; actorUserId: string }): Promise<void>;
};
