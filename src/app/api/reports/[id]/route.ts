import { and, eq } from "drizzle-orm";
import { requireApiCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";

export const dynamic = "force-dynamic";

/** GET /api/reports/[id] → the stored PDF. Tenant-scoped: another org's id is a 404, never a 403 that confirms existence. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireApiCtx("finance:read");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const row = await withTenant(ctx.orgId, async (tx) => (await tx.select({ id: schema.reports.id, kind: schema.reports.kind, title: schema.reports.title, pdfBytes: schema.reports.pdfBytes, createdAt: schema.reports.createdAt })
    .from(schema.reports).where(and(eq(schema.reports.id, id), eq(schema.reports.orgId, ctx.orgId))).limit(1))[0]);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  if (!row.pdfBytes) return Response.json({ error: "this report has no stored PDF" }, { status: 404 });
  const bytes = Buffer.from(row.pdfBytes, "base64");
  const filename = `${row.kind}-${row.createdAt.toISOString().slice(0, 10)}.pdf`;
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${filename}"`, "content-length": String(bytes.length), "cache-control": "private, no-store" } });
}
