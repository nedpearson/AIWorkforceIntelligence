/** GET /api/admin/reports/[id]?org=<clientOrgId> — download a client's report PDF as a consultant. */
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { getConsultant } from "@/app/admin/_lib";
import { assertClientOfConsultancy, OnboardingError } from "@/engine/onboarding";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getConsultant(); if (!c) return Response.json({ error: "forbidden" }, { status: 403 });
  const org = new URL(req.url).searchParams.get("org") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(org)) return Response.json({ error: "bad request" }, { status: 400 });
  try { await assertClientOfConsultancy(c.consultancy.id, org); } catch (e) { if (e instanceof OnboardingError) return Response.json({ error: "not found" }, { status: 404 }); throw e; }
  const [r] = await withTenant(org, (tx) => tx.select({ title: schema.reports.title, pdf: schema.reports.pdfBytes, kind: schema.reports.kind }).from(schema.reports).where(and(eq(schema.reports.id, id), eq(schema.reports.orgId, org))).limit(1));
  if (!r?.pdf) return Response.json({ error: "not found" }, { status: 404 });
  await audit({ orgId: org, actorUserId: c.ctx.userId, action: "report.downloaded", entityType: "report", entityId: id, details: { by: "consultant" } });
  const name = `${r.title.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase() || r.kind}.pdf`;
  return new Response(new Uint8Array(Buffer.from(r.pdf, "base64")), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" } });
}
