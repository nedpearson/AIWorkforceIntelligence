/**
 * Skill runtime — the execution context every skill runs inside, the permission gate, and the shared
 * "record processing time" + "calculate savings" finalization steps.
 *
 * Permission gate (live mode) — checked in code, never by a model, never changeable by skill input or feedback:
 *   read_only          read & analyze only: draft persistence and actions are skipped
 *   draft_only         drafts stored in BridgeBox (skill_runs.output) for a human to use; no approvals, no actions
 *   act_with_approval  consequential actions create an approval; executed only after a human approves (decideSkillRun)
 *   autonomous         actions execute directly, EXCEPT steps in `alwaysApproveSteps` or that policy says need approval
 * Sandbox mode: every gate is "simulated" — nothing leaves BridgeBox, outputs are labelled "Synthetic sample".
 */
import type { z } from "zod";
import type { Citation, Passage } from "@/engine/brain";
import type { CalcTree } from "@/db/schema";
import type { SkillAccess, SkillDefinition, SkillStep } from "./contract";
import { approvedDocs, approvedFacts, rankedPassages, type KDoc, type KFact, type KnowledgeScope } from "./knowledge";
import { modelAvailable, polishWithModel } from "./llm";

export type PermissionLevel = "read_only" | "draft_only" | "act_with_approval" | "autonomous";
export type Mode = "sandbox" | "live";
export type MemoryItem = { id: string; kind: string; text: string; version: number };
export type EmployeeInfo = { id: string; firstName: string; title: string; team: string; departmentId: string | null; agentId: string | null; knowledgeScope: KnowledgeScope; skills: string[]; permissionLevel: PermissionLevel; status: string };

export type PendingAction = { stepKey: string; label: string; requestedAction: string; reasons: string[]; approverRole: string; elevated: boolean; payload: Record<string, unknown>; requestedAt: string };
export type GateDecision = "execute" | "pending" | "blocked" | "simulated";

export type SkillSample<I> = { key: string; label: string; description?: string; input: I };
export type ExecOut = { output: Record<string, unknown>; summary: string; humanReviewMinutes?: number; pending?: PendingAction | null };

/** Internal skill implementation (superset of the public SkillDefinition). */
export interface SkillImpl<I = unknown> extends SkillDefinition<I> {
  inputSchema: z.ZodType<I>;
  samples: () => SkillSample<I>[];
  /** documented human review minutes per run (assumption) */
  reviewMinutes: number;
  /** human-readable basis for manualBaselineMinutes */
  baselineBasis: string;
  /** whether the skill can use the model for prose (only when ANTHROPIC_API_KEY is set) */
  generative?: boolean;
  execute(ctx: SkillCtx, input: I): Promise<ExecOut>;
  /** executes the gated action after approval (or directly when autonomous). Returns a step detail + output patch. */
  performAction?(ctx: SkillCtx, pending: PendingAction, output: Record<string, unknown>): Promise<{ detail: string; data?: Record<string, unknown>; outputPatch?: Record<string, unknown> }>;
}

export type StepOut<T> = { value: T; detail?: string; data?: Record<string, unknown>; status?: SkillStep["status"] };

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class SkillCtx {
  steps: SkillStep[] = [];
  citations: Citation[] = [];
  llmUsed = false;
  constructor(
    public readonly orgId: string,
    public readonly mode: Mode,
    public readonly employee: EmployeeInfo,
    public readonly actorUserId: string,
    public readonly actorRole: string,
    public readonly skill: SkillImpl<unknown>,
    public readonly memory: MemoryItem[],
    private readonly onStep?: (steps: SkillStep[]) => Promise<void> | void,
  ) {}
  get synthetic() { return this.mode === "sandbox"; }
  get permissionLevel(): PermissionLevel { return this.employee.permissionLevel; }
  today() { return new Date().toISOString().slice(0, 10); }

  cite(...cs: (Citation | undefined | null)[]) { for (const c of cs) if (c && !this.citations.some((x) => x.type === c.type && x.id === c.id)) this.citations.push(c); }

  /** Run one timed step; failures are recorded as a failed step and re-thrown. */
  async step<T>(key: string, label: string, fn: () => Promise<StepOut<T>> | StepOut<T>): Promise<T> {
    const t0 = now();
    try {
      const r = await fn();
      this.steps.push({ key, label, status: r.status ?? "done", ms: Math.max(0, Math.round((now() - t0) * 100) / 100), ...(r.detail ? { detail: r.detail } : {}), ...(r.data ? { data: r.data } : {}) });
      await this.onStep?.(this.steps);
      return r.value;
    } catch (e) {
      this.steps.push({ key, label, status: "failed", ms: Math.max(0, Math.round((now() - t0) * 100) / 100), detail: e instanceof Error ? e.message : String(e) });
      await this.onStep?.(this.steps);
      throw e;
    }
  }
  skip(key: string, label: string, detail: string, data?: Record<string, unknown>) { this.steps.push({ key, label, status: "skipped", ms: 0, detail, ...(data ? { data } : {}) }); }

  // ---- knowledge (approved, scoped, role-filtered)
  async facts(categories?: string[]): Promise<KFact[]> { return approvedFacts(this.orgId, this.employee.knowledgeScope, categories); }
  async docs(categories?: string[]): Promise<KDoc[]> { return approvedDocs(this.orgId, this.employee.knowledgeScope, this.actorRole, categories); }
  async passages(query: string, limit = 6): Promise<Passage[]> { return rankedPassages(this.orgId, query, this.employee.knowledgeScope, this.actorRole, limit); }

  // ---- permissions
  /** Can this run persist drafts? (sandbox: yes, labelled synthetic) */
  canDraft(): boolean { return this.mode === "sandbox" || this.permissionLevel !== "read_only"; }
  /** Gate a consequential action. `policyRequiresApproval` forces an approval even when autonomous. */
  gate(stepKey: string, policyRequiresApproval = false): GateDecision {
    if (this.mode === "sandbox") return "simulated";
    switch (this.permissionLevel) {
      case "read_only": case "draft_only": return "blocked";
      case "act_with_approval": return "pending";
      case "autonomous": return policyRequiresApproval || (this.skill.alwaysApproveSteps ?? []).includes(stepKey) ? "pending" : "execute";
    }
  }
  gateDetail(d: GateDecision, what: string): string {
    if (d === "simulated") return `Synthetic sample — would ${what}; nothing was sent.`;
    if (d === "blocked") return this.permissionLevel === "read_only" ? `Not done: this AI employee is read-only, so it can only read and analyze.` : `Not done: this AI employee is draft-only — the draft is stored in BridgeBox for a person to use.`;
    if (d === "pending") return `Waiting for a person to approve before it will ${what}.`;
    return `Done automatically (autonomous permission).`;
  }

  // ---- optional model polish (generative skills only)
  async polish(task: string, draft: string, passages: Passage[], userContent?: string): Promise<{ text: string; mode: "llm" | "deterministic"; note?: string }> {
    if (!this.skill.generative || !modelAvailable()) return { text: draft, mode: "deterministic" };
    const r = await polishWithModel({ task, draft, passages, userContent, memory: this.memory.map((m) => m.text) });
    if ("text" in r) { this.llmUsed = true; return { text: r.text, mode: "llm" }; }
    return { text: draft, mode: "deterministic", note: r.error };
  }
}

// ---------------------------------------------------------------------------------------------- savings
export type RateInfo = { hourly: number | null; basis: "observed" | "estimated" | "assumed"; source: string; performers: number };
export type BaselineInfo = { minutes: number; basis: "observed" | "estimated" | "assumed"; source: string };
export type SavingsCalc = {
  baselineMinutes: number; baselineBasis: BaselineInfo["basis"]; baselineSource: string;
  automatedMinutes: number; reviewMinutes: number; minutesSaved: number;
  hourlyRate: number | null; hourlyBasis: RateInfo["basis"]; hourlySource: string; valueUsd: number | null;
  countsTowardSavings: boolean; countsNote: string; tree: CalcTree;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeSavings(p: { baseline: BaselineInfo; durationMs: number; reviewMinutes: number; rate: RateInfo; mode: Mode; status: string; agentLinked: boolean }): SavingsCalc {
  const automatedMinutes = r2(p.durationMs / 60000);
  const minutesSaved = r2(Math.max(0, p.baseline.minutes - automatedMinutes - p.reviewMinutes));
  const valueUsd = p.rate.hourly != null ? r2((minutesSaved / 60) * p.rate.hourly) : null;
  const counts = p.mode === "live" && p.status === "succeeded";
  const countsNote = p.mode === "sandbox" ? "Synthetic sample — never counted in savings."
    : p.status !== "succeeded" ? `Not counted until the run succeeds (currently ${p.status.replace(/_/g, " ")}).`
    : p.agentLinked ? "Counted: recorded on the linked agent's run ledger (agent_runs) for verified-savings measurement."
    : "Recorded in this AI employee's work history; link an agent to include it in the verified run-ledger measurement.";
  const tree: CalcTree = { label: "Time value of this run", value: valueUsd ?? 0, unit: "usd", basis: p.mode === "live" ? (p.rate.basis === "observed" && p.baseline.basis === "observed" ? "observed" : "estimated") : "assumed", formula: "minutes saved ÷ 60 × loaded hourly rate", source: p.mode === "sandbox" ? "Synthetic sample run" : "Live run", children: [
    { label: "Minutes saved", value: minutesSaved, unit: "minutes", basis: p.baseline.basis, formula: "manual baseline − automated time − human review", children: [
      { label: "Manual baseline", value: p.baseline.minutes, unit: "minutes", basis: p.baseline.basis, source: p.baseline.source },
      { label: "Automated processing time", value: automatedMinutes, unit: "minutes", basis: "observed", source: `${Math.round(p.durationMs)} ms measured` },
      { label: "Human review time", value: p.reviewMinutes, unit: "minutes", basis: "assumed", source: "Documented review allowance per run (+ approval time when approved)" },
    ] },
    { label: "Loaded hourly rate", value: p.rate.hourly ?? 0, unit: "usd", basis: p.rate.basis, source: p.rate.source },
  ] };
  return { baselineMinutes: p.baseline.minutes, baselineBasis: p.baseline.basis, baselineSource: p.baseline.source, automatedMinutes, reviewMinutes: p.reviewMinutes, minutesSaved, hourlyRate: p.rate.hourly, hourlyBasis: p.rate.basis, hourlySource: p.rate.source, valueUsd, countsTowardSavings: counts && p.agentLinked, countsNote, tree };
}

export const money = (n: number | null | undefined) => n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export type { SkillAccess };
