"use server";
/**
 * Submit a department's hiring-avoidance potential to the savings ledger as tier "cost_avoidance" (finance:write).
 * The amount is recomputed server-side from the capacity engine — the client only sends the planning inputs.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { computeCapacity, hiringAvoidance } from "@/engine/capacity";
import { submitLedgerEntry } from "@/engine/savings";

const Input = z.object({
  departmentKey: z.string().min(1).max(64), plannedHires: z.number().min(0).max(10_000), utilization: z.number().min(0).max(1), basis: z.enum(["projected", "verified"]),
  evidence: z.object({ kind: z.string().trim().min(2).max(60), ref: z.string().trim().min(2).max(300), note: z.string().trim().max(1000).optional() }),
});

export async function submitCostAvoidance(raw: unknown): Promise<{ ok: true; entryId: string; amount: number } | { ok: false; error: string }> {
  const ctx = await requireCtx("finance:write");
  const p = Input.safeParse(raw); if (!p.success) return { ok: false, error: p.error.issues[0] ? `${p.error.issues[0].path.join(".")}: ${p.error.issues[0].message}` : "invalid input" };
  try {
    const cap = await computeCapacity(ctx.orgId);
    const d = cap.departments.find((x) => x.key === p.data.departmentKey); if (!d) return { ok: false, error: "department not found" };
    const fte = p.data.basis === "verified" ? d.verifiedFte : d.fteReleased;
    const h = hiringAvoidance({ plannedHires: p.data.plannedHires, fteReleased: fte, utilization: p.data.utilization, loadedCostPerFte: d.loadedCostPerFte ?? cap.totals.orgLoadedCostPerFte });
    if (h.value <= 0) return { ok: false, error: "nothing to submit — planned hires or released capacity is zero" };
    const year = new Date().getUTCFullYear();
    const row = await submitLedgerEntry(ctx.orgId, ctx.userId, {
      tier: "cost_avoidance", title: `Hiring avoidance — ${d.name} — ${year}`, annualAmount: Math.round(h.value * 100) / 100, hoursPerYear: h.avoidedHires * cap.hoursPerFte * cap.weeksPerYear,
      departmentId: d.key === "unassigned" ? undefined : d.key, effectiveFrom: new Date(), evidence: [{ kind: p.data.evidence.kind, ref: p.data.evidence.ref, note: p.data.evidence.note }],
      calculation: { ...h.tree, basis: p.data.basis === "verified" ? "observed" : "estimated", source: `${p.data.basis === "verified" ? "Verified" : "Projected"} capacity for ${d.name}. Capacity is not payroll reduction.` },
      basis: p.data.basis === "verified" ? "observed" : "estimated",
    });
    revalidatePath("/app/transformation"); revalidatePath("/app/savings");
    return { ok: true, entryId: row.id, amount: h.value };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
