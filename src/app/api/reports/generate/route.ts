import { z } from "zod";
import { requireApiCtx } from "@/lib/session";
import { generateExecutiveReport } from "@/engine/finance";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
const Body = z.object({
  kind: z.enum(["executive_roi", "investment_proposal", "monthly_performance"]),
  scenario: z.enum(["conservative", "expected", "aggressive"]).optional(),
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
  opportunityIds: z.array(z.string().uuid()).max(500).optional(),
});

/** POST /api/reports/generate → application/pdf (attachment). Stores the report row as well. */
export async function POST(req: Request) {
  const ctx = await requireApiCtx("reports:generate");
  if (ctx instanceof Response) return ctx;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: p.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  const { kind, scenario, opportunityIds } = p.data;
  const periodStart = p.data.periodStart ? new Date(p.data.periodStart) : undefined;
  const periodEnd = p.data.periodEnd ? new Date(p.data.periodEnd) : undefined;
  if (periodStart && periodEnd && !(periodEnd > periodStart)) return Response.json({ error: "period end must be after period start" }, { status: 400 });
  try {
    const { reportId, pdf } = await generateExecutiveReport(ctx.orgId, kind, { generatedBy: ctx.userId, scenario, periodStart, periodEnd, opportunityIds });
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "report.generated", entityType: "report", entityId: reportId, details: { kind, scenario: scenario ?? "expected", opportunityIds: opportunityIds?.length ?? null, via: "api" } });
    const filename = `${kind}-${new Date().toISOString().slice(0, 10)}.pdf`;
    return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${filename}"`, "content-length": String(pdf.length), "x-report-id": reportId, "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "report generation failed" }, { status: 500 });
  }
}
