/**
 * POST /api/media — multipart upload (file, kind, provenance, credit?, aiEmployeeId? | employeeId? + consent).
 * ai_portrait: agents:write, provenance ai_generated|licensed. employee_photo: employees:write + recorded consent.
 * Max 1 MB; PNG/JPEG/WebP verified by magic bytes.
 */
import { requireApiCtx } from "@/lib/session";
import { hit, tooManyRequests } from "@/lib/rate-limit";
import { can } from "@/lib/rbac";
import { saveMedia, MAX_MEDIA_BYTES, type MediaKind } from "@/engine/workforce/media";

export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const ctx = await requireApiCtx();
  if (ctx instanceof Response) return ctx;
  const rl = await hit("upload", ctx.userId);
  if (!rl.ok) return tooManyRequests(rl);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_MEDIA_BYTES + 64_000) return Response.json({ error: "Image is larger than 1 MB." }, { status: 413 });
  let form: FormData;
  try { form = await req.formData(); } catch { return Response.json({ error: "Expected multipart form data." }, { status: 400 }); }
  const kind = String(form.get("kind") ?? "ai_portrait") as MediaKind;
  if (kind !== "ai_portrait" && kind !== "employee_photo") return Response.json({ error: "invalid kind" }, { status: 400 });
  if (kind === "ai_portrait" && !can(ctx.role, "agents:write")) return Response.json({ error: "forbidden", permission: "agents:write" }, { status: 403 });
  if (kind === "employee_photo" && !can(ctx.role, "employees:write")) return Response.json({ error: "forbidden", permission: "employees:write" }, { status: 403 });
  const file = form.get("file");
  if (!(file instanceof Blob)) return Response.json({ error: "file is required" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const uuid = (v: FormDataEntryValue | null) => { const s = v ? String(v) : ""; return /^[0-9a-f-]{36}$/i.test(s) ? s : null; };
  const r = await saveMedia(ctx.orgId, ctx.userId, { kind, bytes, provenance: String(form.get("provenance") ?? ""), credit: form.get("credit") ? String(form.get("credit")) : null, consent: form.get("consent") === "true", aiEmployeeId: uuid(form.get("aiEmployeeId")), employeeId: uuid(form.get("employeeId")) });
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json(r, { status: 201 });
}
