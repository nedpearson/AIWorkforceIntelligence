"use server";
/**
 * Server actions for /app/savings — the savings ledger workflow.
 *  submit : finance:write
 *  decide : finance:write AND role owner/admin (finance approval authority). Self-approval is allowed but flagged (SoD).
 * zod-validated, tenant-scoped, audited (the engine writes savings.submitted / savings.approved|rejected).
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { submitLedgerEntry, decideLedgerEntry } from "@/engine/savings";

type Result = { ok: true; id: string; selfApproval?: boolean } | { ok: false; error: string };
const uuid = z.string().uuid();
const optId = z.union([uuid, z.literal("")]).optional().transform((v) => (v ? v : undefined));

const SubmitInput = z.object({
  tier: z.enum(["approved", "cost_avoidance", "realized_hard"]),
  title: z.string().trim().min(3, "Title must be at least 3 characters").max(200),
  annualAmount: z.coerce.number().min(0, "Annual amount must be ≥ 0").max(1e10),
  hoursPerYear: z.union([z.literal(""), z.coerce.number().min(0).max(1e7)]).optional().transform((v) => (v === "" || v == null ? undefined : v)),
  opportunityId: optId, projectId: optId, agentId: optId, workflowId: optId, departmentId: optId,
  effectiveFrom: z.string().min(8, "Effective date is required").refine((s) => !Number.isNaN(Date.parse(s)), "Invalid effective date"),
  evidence: z.array(z.object({ kind: z.string().trim().max(60), ref: z.string().trim().max(500), note: z.string().trim().max(500).optional() })).max(20).default([]),
  calculationNote: z.string().trim().max(2000).optional(),
}).superRefine((v, ctx) => {
  const ev = v.evidence.filter((e) => e.kind && e.ref);
  if (v.tier !== "approved" && ev.length === 0) ctx.addIssue({ code: "custom", path: ["evidence"], message: "Cost avoidance and realized hard savings require at least one evidence item (kind + reference)" });
});

export async function submitSavingsEntry(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("finance:write");
  const p = SubmitInput.safeParse(raw);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
  const v = p.data;
  try {
    // Linked records must belong to this tenant (FK checks alone do not enforce tenancy).
    const deptFromWf = await withTenant(ctx.orgId, async (tx) => {
      const own = async (table: typeof schema.opportunities | typeof schema.projects | typeof schema.agents | typeof schema.workflows | typeof schema.departments, id: string | undefined, what: string) => {
        if (!id) return;
        const r = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.orgId, ctx.orgId))).limit(1);
        if (!r.length) throw new Error(`${what} not found in this organization`);
      };
      await own(schema.opportunities, v.opportunityId, "Opportunity"); await own(schema.projects, v.projectId, "Project");
      await own(schema.agents, v.agentId, "Agent"); await own(schema.workflows, v.workflowId, "Workflow"); await own(schema.departments, v.departmentId, "Department");
      if (v.departmentId || !v.workflowId) return v.departmentId;
      const [w] = await tx.select({ d: schema.workflows.departmentId }).from(schema.workflows).where(and(eq(schema.workflows.id, v.workflowId), eq(schema.workflows.orgId, ctx.orgId))).limit(1);
      return w?.d ?? undefined;
    });
    const row = await submitLedgerEntry(ctx.orgId, ctx.userId, {
      tier: v.tier, title: v.title, annualAmount: v.annualAmount, hoursPerYear: v.hoursPerYear,
      opportunityId: v.opportunityId, projectId: v.projectId, agentId: v.agentId, workflowId: v.workflowId, departmentId: deptFromWf ?? undefined,
      effectiveFrom: new Date(v.effectiveFrom), evidence: v.evidence.map((e) => ({ kind: e.kind, ref: e.ref, ...(e.note ? { note: e.note } : {}) })),
      calculation: v.calculationNote ? { label: "Submitter's calculation", value: v.annualAmount, unit: "usd", basis: v.tier === "approved" ? "assumed" : "observed", formula: v.calculationNote, source: `Submitted by ${ctx.email ?? "user"}` } : undefined,
    });
    revalidatePath("/app/savings");
    return { ok: true, id: row.id };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

const DecideInput = z.object({ id: uuid, decision: z.enum(["approve", "reject"]), reason: z.string().trim().max(1000).optional() })
  .refine((v) => v.decision === "approve" || (v.reason && v.reason.length >= 3), { message: "A reason is required to reject an entry", path: ["reason"] });

export async function decideSavingsEntry(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("finance:write");
  if (ctx.role !== "owner" && ctx.role !== "admin") return { ok: false, error: "Only an owner or admin of this organization can approve or reject savings entries" };
  const p = DecideInput.safeParse(raw);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
  try {
    const row = await decideLedgerEntry(ctx.orgId, ctx.userId, p.data.id, p.data.decision, p.data.reason);
    revalidatePath("/app/savings"); revalidatePath("/app/opportunities"); revalidatePath("/app");
    return { ok: true, id: row.id, selfApproval: row.submittedBy === ctx.userId };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
