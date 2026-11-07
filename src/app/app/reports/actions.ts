"use server";
/** Report generation from the Reports page. The PDF is stored on the `reports` row; download via /api/reports/[id]. */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { audit } from "@/lib/audit";
import { generateExecutiveReport } from "@/engine/finance";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): Result<never> => ({ ok: false, error });

const Input = z.object({
  kind: z.enum(["executive_roi", "investment_proposal", "monthly_performance"]),
  scenario: z.enum(["conservative", "expected", "aggressive"]).default("expected"),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
});

export async function generateReport(raw: unknown): Promise<Result<{ reportId: string }>> {
  const ctx = await requireCtx("reports:generate");
  const p = Input.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid input");
  const periodStart = p.data.periodStart ? new Date(`${p.data.periodStart}T00:00:00Z`) : undefined;
  const periodEnd = p.data.periodEnd ? new Date(`${p.data.periodEnd}T23:59:59Z`) : undefined;
  if (periodStart && periodEnd && !(periodEnd > periodStart)) return fail("period end must be after period start");
  try {
    const { reportId } = await generateExecutiveReport(ctx.orgId, p.data.kind, { generatedBy: ctx.userId, scenario: p.data.scenario, periodStart, periodEnd });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "report.generated", entityType: "report", entityId: reportId, details: { kind: p.data.kind, scenario: p.data.scenario, periodStart: periodStart?.toISOString() ?? null, periodEnd: periodEnd?.toISOString() ?? null, via: "reports_page" } });
    revalidatePath("/app/reports");
    return { ok: true, reportId };
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
}
