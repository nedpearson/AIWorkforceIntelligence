import { requireApiCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { extractText, ExtractError, MAX_UPLOAD_BYTES, guessCategory } from "@/engine/brain/extract";
import { ingestDocument, KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from "@/engine/brain";
import { ensureSource } from "@/engine/brain/sources";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/brain/upload (multipart): files[] (≤10 MB each, ≤20 per request), category?, departmentId?, allowedRoles? (csv), allowNearDuplicate?
 * Requires employees:write or org:manage. Each file → extractText → ingestDocument (pending_review). Returns per-file results,
 * including duplicate / near-duplicate warnings so the UI can offer "upload anyway".
 */
export async function POST(req: Request) {
  const ctx = await requireApiCtx("workflows:read");
  if (ctx instanceof Response) return ctx;
  if (!can(ctx.role, "employees:write") && !can(ctx.role, "org:manage")) return Response.json({ error: "Your role cannot add knowledge (requires employees:write or org:manage)." }, { status: 403 });
  let form: FormData;
  try { form = await req.formData(); } catch { return Response.json({ error: "Expected a multipart form upload" }, { status: 400 }); }
  const files = form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
  if (!files.length) return Response.json({ error: "No files received" }, { status: 400 });
  if (files.length > 20) return Response.json({ error: "Upload at most 20 files at a time" }, { status: 400 });
  const catRaw = String(form.get("category") ?? "");
  const category = (KNOWLEDGE_CATEGORIES as readonly string[]).includes(catRaw) ? (catRaw as KnowledgeCategory) : undefined;
  const dept = String(form.get("departmentId") ?? "");
  const departmentId = /^[0-9a-f-]{36}$/i.test(dept) ? dept : null;
  const allowedRoles = String(form.get("allowedRoles") ?? "").split(",").map((s) => s.trim()).filter((r) => ["owner", "admin", "manager", "employee", "consultant", "viewer"].includes(r));
  const allowNearDuplicate = form.get("allowNearDuplicate") === "1";
  const sourceId = await ensureSource(ctx.orgId, "upload", "Uploaded files", null, ctx.userId);
  const results = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD_BYTES) { results.push({ name: f.name, status: "error", error: `"${f.name}" is larger than 10 MB.` }); continue; }
    try {
      const x = await extractText({ name: f.name, mimeType: f.type || undefined, bytes: new Uint8Array(await f.arrayBuffer()) });
      const r = await ingestDocument(ctx.orgId, ctx.userId, { title: x.title, content: x.text, category: category ?? guessCategory(x.title), mimeType: x.mimeType, departmentId, allowedRoles, sourceId }, { allowNearDuplicate });
      results.push({ name: f.name, title: x.title, format: x.format, warnings: x.warnings, ...r });
    } catch (e) {
      results.push({ name: f.name, status: "error", error: e instanceof ExtractError || e instanceof Error ? e.message : "Upload failed" });
    }
  }
  return Response.json({ results });
}
