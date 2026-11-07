"use server";
/** Financial model actions: live recompute from slider overrides, save/reset the default model. */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { computeOrgFinancials, ensureDefaultFinancialModel, type OrgFinancials } from "@/engine/finance";
import { workflowCosts, realizedVsProjected, type WorkflowCostRow, type MonthPoint } from "./lib";
import type { FinancialAssumptions } from "@/db/schema";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): Result<never> => ({ ok: false, error });

const AssumptionsInput = z.object({
  automationPct: z.number().min(0.3).max(1.2),
  adoptionRate: z.number().min(0).max(1),
  realizationRate: z.number().min(0).max(1),
  benefitsLoadPct: z.number().min(0).max(1),
  consultingHourly: z.number().min(0).max(1000),
  perAgentMonthly: z.number().min(0).max(5000),
  platformFeeMonthly: z.number().min(0).max(20000),
  rampMonths: z.number().int().min(0).max(24),
  discountRate: z.number().min(0).max(0.5),
  workWeeksPerYear: z.number().min(30).max(52),
  implementationCostOverride: z.number().min(0).optional(),
  annualOpexOverride: z.number().min(0).optional(),
});
const RecomputeInput = z.object({
  assumptions: AssumptionsInput,
  scenario: z.enum(["conservative", "expected", "aggressive"]).default("expected"),
  opportunityIds: z.array(z.string().uuid()).max(500).optional(),
});

export type RecomputeResult = { fin: OrgFinancials; workflows: WorkflowCostRow[]; months: MonthPoint[] };

export async function recompute(raw: unknown): Promise<Result<RecomputeResult>> {
  const ctx = await requireCtx("finance:read");
  const p = RecomputeInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid input");
  try {
    const fin = await computeOrgFinancials(ctx.orgId, { ...p.data.assumptions, scenario: p.data.scenario, opportunityIds: p.data.opportunityIds });
    const [workflows, months] = await Promise.all([workflowCosts(ctx.orgId, fin.assumptions, fin), realizedVsProjected(ctx.orgId, fin.realizableAnnualSavings)]);
    return { ok: true, fin, workflows, months };
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
}

export async function saveDefaultModel(raw: unknown): Promise<Result<{ assumptions: FinancialAssumptions }>> {
  const ctx = await requireCtx("finance:write");
  const p = AssumptionsInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid input");
  const model = await ensureDefaultFinancialModel(ctx.orgId);
  const before = model.assumptions;
  const assumptions: FinancialAssumptions = { ...before, ...p.data };
  await withTenant(ctx.orgId, (tx) => tx.update(schema.financialModels).set({ assumptions, updatedAt: new Date() }).where(and(eq(schema.financialModels.id, model.id), eq(schema.financialModels.orgId, ctx.orgId))));
  const changed = Object.fromEntries(Object.entries(assumptions).filter(([k, v]) => (before as Record<string, unknown>)[k] !== v).map(([k, v]) => [k, { from: (before as Record<string, unknown>)[k] ?? null, to: v }]));
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "financial_model.updated", entityType: "financial_model", entityId: model.id, details: { changed } });
  revalidatePath("/app/finance"); revalidatePath("/app");
  return { ok: true, assumptions };
}
