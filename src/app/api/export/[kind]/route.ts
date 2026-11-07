import { requireApiCtx } from "@/lib/session";
import { audit } from "@/lib/audit";
import { computeExecutiveModel, deckFromModel, sanitizeOverrides, workbookFromModel } from "@/engine/exports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TYPES = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

/**
 * GET /api/export/executive?format=xlsx|pptx&scenario=&automationPct=&adoptionRate=&realizationRate=&from=&to=
 * Executive workbook (exceljs) or boardroom deck (pptxgenjs) built from the same ExecutiveModel as /app and /present.
 */
export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const ctx = await requireApiCtx("finance:read");
  if (ctx instanceof Response) return ctx;
  const { kind } = await params;
  if (kind !== "executive") return Response.json({ error: `unknown export '${kind}'` }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const format = q.get("format");
  if (format !== "xlsx" && format !== "pptx") return Response.json({ error: "format must be xlsx or pptx" }, { status: 400 });
  const overrides = sanitizeOverrides({ scenario: q.get("scenario") ?? undefined, automationPct: q.get("automationPct") ?? undefined, adoptionRate: q.get("adoptionRate") ?? undefined, realizationRate: q.get("realizationRate") ?? undefined, periodStart: q.get("from") ?? undefined, periodEnd: q.get("to") ?? undefined });
  if (overrides.periodStart && overrides.periodEnd && !(overrides.periodEnd > overrides.periodStart)) return Response.json({ error: "period end must be after period start" }, { status: 400 });
  try {
    const model = await computeExecutiveModel(ctx.orgId, overrides);
    const body = format === "xlsx" ? Buffer.from(await workbookFromModel(model).xlsx.writeBuffer()) : (await deckFromModel(model)).buffer;
    const slug = model.org.name.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "org";
    const filename = `${slug}-executive-${format === "xlsx" ? "workbook" : "briefing"}-${new Date().toISOString().slice(0, 10)}.${format}`;
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "export.generated", entityType: "export", entityId: kind, details: { format, scenario: model.overrides.scenario, automationPct: overrides.automationPct ?? null, adoptionRate: overrides.adoptionRate ?? null, realizationRate: overrides.realizationRate ?? null, bytes: body.length } });
    return new Response(new Uint8Array(body), { headers: { "content-type": TYPES[format], "content-disposition": `attachment; filename="${filename}"`, "content-length": String(body.length), "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "export failed" }, { status: 500 });
  }
}
