import { requireApiCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { extractText, ExtractError, MAX_UPLOAD_BYTES, MAX_UPLOAD_REQUEST_BYTES, guessCategory, sanitizeFilename } from "@/engine/brain/extract";
import { assertBrainQuota, BrainQuotaError } from "@/engine/brain/quota";
import { hit, tooManyRequests } from "@/lib/rate-limit";
import { ingestDocument, KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from "@/engine/brain";
import { ensureSource } from "@/engine/brain/sources";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/brain/upload (multipart): files[] (≤10 MB each, ≤20 per request, ≤25 MB per request), category?, departmentId?, allowedRoles? (csv), allowNearDuplicate?
 * Hardening: rate limit (20 uploads / 10 min / user), content-length cap before parsing, sanitised filenames, magic-byte
 * and text sniffing + zip-bomb guard (extract.ts), per-org storage quota (quota.ts).
 * Requires employees:write or org:manage. Each file → extractText → ingestDocument (pending_review). Returns per-file results,
 * including duplicate / near-duplicate warnings so the UI can offer "upload anyway".
 */
export async function POST(req: Request) {
  const ctx = await requireApiCtx("workflows:read");
  if (ctx instanceof Response) return ctx;
  if (!can(ctx.role, "employees:write") && !can(ctx.role, "org:manage")) return Response.json({ error: "Your role cannot add knowledge (requires employees:write or org:manage)." }, { status: 403 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD_REQUEST_BYTES) return Response.json({ error: `Upload is larger than ${MAX_UPLOAD_REQUEST_BYTES / 1048576} MB in total — send fewer files at a time.` }, { status: 413 });
  const rl = await hit("upload", ctx.userId);
  if (!rl.ok) return tooManyRequests(rl, { message: "Too many uploads — wait a few minutes and try again." });
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
    const name = sanitizeFilename(f.name);
    if (f.size > MAX_UPLOAD_BYTES) { results.push({ name, status: "error", error: `"${name}" is larger than 10 MB.` }); continue; }
    try {
      const x = await extractText({ name, mimeType: f.type || undefined, bytes: new Uint8Array(await f.arrayBuffer()) });
      await assertBrainQuota(ctx.orgId, Buffer.byteLength(x.text, "utf8"));
      const r = await ingestDocument(ctx.orgId, ctx.userId, { title: x.title, content: x.text, category: category ?? guessCategory(x.title), mimeType: x.mimeType, departmentId, allowedRoles, sourceId }, { allowNearDuplicate });
      results.push({ name, title: x.title, format: x.format, warnings: x.warnings, ...r });
    } catch (e) {
      results.push({ name, status: "error", error: e instanceof ExtractError || e instanceof BrainQuotaError || e instanceof Error ? e.message : "Upload failed" });
    }
  }
  return Response.json({ results });
}
