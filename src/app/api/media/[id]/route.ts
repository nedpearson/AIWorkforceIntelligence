/** GET /api/media/:id — tenant-checked image bytes (AI portraits, consented employee photos). */
import { requireApiCtx } from "@/lib/session";
import { readMedia } from "@/engine/workforce/media";

export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireApiCtx();
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const m = await readMedia(ctx.orgId, id);
  if (!m) return Response.json({ error: "not_found" }, { status: 404 });
  const etag = `"${id}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, max-age=86400, immutable" } });
  return new Response(new Uint8Array(m.bytes), { headers: {
    "Content-Type": m.mimeType, "Content-Length": String(m.bytes.length), "Cache-Control": "private, max-age=86400, immutable", ETag: etag,
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'", "Content-Disposition": "inline", "X-Media-Provenance": m.provenance,
  } });
}
