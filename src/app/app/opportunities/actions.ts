"use server";
/**
 * Server actions for the AI Opportunity Center. zod-validated, permission-checked, tenant-scoped, audited.
 *  - setOpportunityStatus / decideOpportunity  (opportunities:write) → opportunity_decisions + opportunities.status
 *  - createProjectFromOpportunity              (opportunities:write) → roadmap project linked to the opportunity
 *  - submitBusinessCase                        (finance:write)       → savings ledger entry, tier "approved"
 */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { analyzeOpportunities } from "@/engine/opportunity-score";
import { candidatesFromAnalyses, createProject, roadmapPriority } from "@/engine/roadmap";
import { submitLedgerEntry } from "@/engine/savings";

type Result = { ok: true; status: string } | { ok: false; error: string };
export type Decision = "approve" | "reject" | "postpone" | "request_analysis" | "reopen" | "review";
type Status = "approved" | "rejected" | "identified" | "reviewing" | "postponed" | "analysis_requested";
const Input = z.object({ id: z.string().uuid(), action: z.enum(["approve", "reject", "postpone", "request_analysis", "reopen", "review"]), note: z.string().trim().max(1000).optional() });

/** Allowed transitions. Deployed/verified/in-progress opportunities are owned by their agent and cannot be changed here. */
const NEXT: Record<Decision, { from: string[]; to: Status }> = {
  approve: { from: ["identified", "reviewing", "rejected", "postponed", "analysis_requested"], to: "approved" },
  reject: { from: ["identified", "reviewing", "approved", "postponed", "analysis_requested"], to: "rejected" },
  postpone: { from: ["identified", "reviewing", "approved", "analysis_requested"], to: "postponed" },
  request_analysis: { from: ["identified", "reviewing", "approved", "postponed"], to: "analysis_requested" },
  reopen: { from: ["rejected", "approved", "postponed", "analysis_requested"], to: "identified" },
  review: { from: ["identified"], to: "reviewing" },
};

function revalidate(id?: string) {
  revalidatePath("/app/opportunities"); if (id) revalidatePath(`/app/opportunities/${id}`);
  revalidatePath("/app"); revalidatePath("/app/roadmap"); revalidatePath("/app/onboarding");
}

export async function decideOpportunity(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("opportunities:write");
  const p = Input.safeParse(raw); if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
  const { id, action, note } = p.data; const t = NEXT[action];
  if ((action === "reject" || action === "postpone" || action === "request_analysis") && note !== undefined && note.length === 0) return { ok: false, error: "add a short note explaining the decision" };
  try {
    const result = await withTenant(ctx.orgId, async (tx) => {
      const [o] = await tx.select({ id: schema.opportunities.id, status: schema.opportunities.status, title: schema.opportunities.title }).from(schema.opportunities).where(and(eq(schema.opportunities.id, id), eq(schema.opportunities.orgId, ctx.orgId))).limit(1);
      if (!o) throw new Error("opportunity not found in this organization");
      if (!t.from.includes(o.status)) throw new Error(`cannot ${action.replace("_", " ")} an opportunity that is ${o.status.replace(/_/g, " ")}`);
      await tx.update(schema.opportunities).set({ status: t.to, updatedAt: new Date() }).where(and(eq(schema.opportunities.id, id), eq(schema.opportunities.orgId, ctx.orgId)));
      await tx.insert(schema.opportunityDecisions).values({ orgId: ctx.orgId, opportunityId: id, decision: action, note: note || null, decidedBy: ctx.userId });
      return { from: o.status, title: o.title };
    });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: `opportunity.${action}`, entityType: "opportunity", entityId: id, details: { from: result.from, to: t.to, note: note ?? null, title: result.title } });
    revalidate(id);
    return { ok: true, status: t.to };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** Back-compat entry point used by the approve / reject / reopen buttons. */
export async function setOpportunityStatus(raw: unknown): Promise<Result> { return decideOpportunity(raw); }

const IdInput = z.object({ id: z.string().uuid() });

export async function createProjectFromOpportunity(raw: unknown): Promise<{ ok: true; projectId: string } | { ok: false; error: string }> {
  const ctx = await requireCtx("opportunities:write");
  const p = IdInput.safeParse(raw); if (!p.success) return { ok: false, error: "invalid input" };
  try {
    const existing = await withTenant(ctx.orgId, (tx) => tx.select({ id: schema.projects.id, opportunityIds: schema.projects.opportunityIds }).from(schema.projects).where(eq(schema.projects.orgId, ctx.orgId)));
    const linked = existing.find((x) => (x.opportunityIds ?? []).includes(p.data.id));
    if (linked) return { ok: true, projectId: linked.id };
    const a = await analyzeOpportunities(ctx.orgId);
    const o = a.all.find((x) => x.id === p.data.id); if (!o) return { ok: false, error: "opportunity not found in this organization" };
    if (o.status === "rejected") return { ok: false, error: "reopen a rejected opportunity before planning a project for it" };
    const cand = candidatesFromAnalyses(a.all).find((c) => c.opportunityId === o.id);
    const agentIds = o.agent ? [o.agent.id] : [];
    const row = await createProject(ctx.orgId, ctx.userId, {
      name: o.title.replace(/^(AI agent|RPA bot|Integration \/ scripted automation|Process redesign):\s*/i, "") + " transformation",
      opportunityIds: [o.id], agentIds, targetAnnualSavings: o.line.realizableAnnualSavings, budget: o.line.implementationCost,
      priorityScore: cand ? roadmapPriority(cand).score : null, notes: `Created from opportunity "${o.title}". Target = realizable savings from the finance engine; budget = estimated implementation cost.`,
    });
    revalidate(o.id);
    return { ok: true, projectId: row.id };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

export async function submitBusinessCase(raw: unknown): Promise<{ ok: true; entryId: string } | { ok: false; error: string }> {
  const ctx = await requireCtx("finance:write");
  const p = z.object({ id: z.string().uuid(), note: z.string().trim().max(1000).optional() }).safeParse(raw); if (!p.success) return { ok: false, error: "invalid input" };
  try {
    const a = await analyzeOpportunities(ctx.orgId);
    const o = a.all.find((x) => x.id === p.data.id); if (!o) return { ok: false, error: "opportunity not found in this organization" };
    if (!o.inScope) return { ok: false, error: "rejected opportunities cannot be submitted for finance approval" };
    const dedupe = o.workflowId ?? o.id;
    const open = await withTenant(ctx.orgId, (tx) => tx.select({ id: schema.savingsLedger.id, status: schema.savingsLedger.status }).from(schema.savingsLedger)
      .where(and(eq(schema.savingsLedger.orgId, ctx.orgId), eq(schema.savingsLedger.tier, "approved"), eq(schema.savingsLedger.dedupeKey, dedupe), inArray(schema.savingsLedger.status, ["submitted", "approved"]))));
    if (open.length) return { ok: false, error: `a business case for this workflow is already ${open[0].status}` };
    const row = await submitLedgerEntry(ctx.orgId, ctx.userId, {
      tier: "approved", title: `Business case: ${o.title}`, annualAmount: Math.round(o.line.realizableAnnualSavings * 100) / 100, hoursPerYear: o.answers.annualHoursSaved,
      opportunityId: o.id, workflowId: o.workflowId ?? undefined, departmentId: o.departmentId ?? undefined, agentId: o.agent?.id, effectiveFrom: new Date(),
      evidence: [{ kind: "opportunity_analysis", ref: `/app/opportunities/${o.id}`, note: p.data.note || `Score ${o.score.total}/100 · ${o.score.confidence.level} confidence · ${o.evidence.sampleSize} runs observed` }],
      calculation: o.line.tree, basis: "estimated",
    });
    revalidate(o.id); revalidatePath("/app/savings");
    return { ok: true, entryId: row.id };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
