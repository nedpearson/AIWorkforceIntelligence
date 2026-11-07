/**
 * Media assets for the workforce module: AI employee portraits (provenance ai_generated | licensed) and consented
 * employee photos (provenance employee_consented, with consentRecordedBy/consentAt). Stored inline (≤ 1 MB).
 * Content type is decided by magic bytes, never by the client-declared type.
 */
import { and, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";

export const MAX_MEDIA_BYTES = 1_048_576;
export const PORTRAIT_PROVENANCE = ["ai_generated", "licensed"] as const;
export type MediaKind = "ai_portrait" | "employee_photo";

export function sniffImage(b: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export type UploadCheck = { ok: true; mimeType: "image/png" | "image/jpeg" | "image/webp" } | { ok: false; status: 400 | 413 | 415; error: string };
export function validateUpload(i: { kind: MediaKind; bytes: Uint8Array; provenance: string | null | undefined; consent?: boolean }): UploadCheck {
  if (!i.bytes.length) return { ok: false, status: 400, error: "Empty file." };
  if (i.bytes.length > MAX_MEDIA_BYTES) return { ok: false, status: 413, error: "Image is larger than 1 MB." };
  const mimeType = sniffImage(i.bytes);
  if (!mimeType) return { ok: false, status: 415, error: "Only PNG, JPEG or WebP images are accepted." };
  if (i.kind === "ai_portrait" && !(PORTRAIT_PROVENANCE as readonly string[]).includes(i.provenance ?? "")) return { ok: false, status: 400, error: "Provenance is required: choose AI-generated or licensed. Never upload a real person's likeness for an AI employee." };
  if (i.kind === "employee_photo" && (i.provenance !== "employee_consented" || !i.consent)) return { ok: false, status: 400, error: "Employee photos require recorded consent from the employee." };
  return { ok: true, mimeType };
}

export async function saveMedia(orgId: string, userId: string, i: { kind: MediaKind; bytes: Uint8Array; provenance: string; credit?: string | null; consent?: boolean; aiEmployeeId?: string | null; employeeId?: string | null }) {
  const v = validateUpload(i); if (!v.ok) return v;
  return withTenant(orgId, async (tx) => {
    if (i.kind === "ai_portrait" && i.aiEmployeeId) {
      const [e] = await tx.select({ id: schema.aiEmployees.id }).from(schema.aiEmployees).where(and(eq(schema.aiEmployees.orgId, orgId), eq(schema.aiEmployees.id, i.aiEmployeeId))).limit(1);
      if (!e) return { ok: false as const, status: 400 as const, error: "AI employee not found." };
    }
    if (i.kind === "employee_photo" && i.employeeId) {
      const [e] = await tx.select({ id: schema.employees.id }).from(schema.employees).where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.id, i.employeeId))).limit(1);
      if (!e) return { ok: false as const, status: 400 as const, error: "Employee not found." };
    }
    const [m] = await tx.insert(schema.mediaAssets).values({
      orgId, kind: i.kind, mimeType: v.mimeType, bytesBase64: Buffer.from(i.bytes).toString("base64"), provenance: i.provenance, credit: i.credit?.slice(0, 200) ?? null,
      consentRecordedBy: i.kind === "employee_photo" ? userId : null, consentAt: i.kind === "employee_photo" ? new Date() : null, createdBy: userId,
    }).returning({ id: schema.mediaAssets.id });
    const url = `/api/media/${m.id}`;
    if (i.kind === "ai_portrait" && i.aiEmployeeId) await tx.update(schema.aiEmployees).set({ portraitUrl: url, portraitProvenance: i.provenance, updatedAt: new Date() }).where(and(eq(schema.aiEmployees.orgId, orgId), eq(schema.aiEmployees.id, i.aiEmployeeId)));
    if (i.kind === "employee_photo" && i.employeeId) await tx.update(schema.employees).set({ photoAssetId: m.id, updatedAt: new Date() }).where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.id, i.employeeId)));
    await audit({ orgId, actorUserId: userId, action: "media.upload", entityType: "media_asset", entityId: m.id, details: { kind: i.kind, provenance: i.provenance, bytes: i.bytes.length, mimeType: v.mimeType, aiEmployeeId: i.aiEmployeeId ?? null, employeeId: i.employeeId ?? null } });
    return { ok: true as const, id: m.id, url, mimeType: v.mimeType };
  });
}

/** Tenant-scoped read. Returns null for unknown ids AND for other tenants' assets (no existence leak). */
export async function readMedia(orgId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [m] = await withTenant(orgId, (tx) => tx.select().from(schema.mediaAssets).where(and(eq(schema.mediaAssets.orgId, orgId), eq(schema.mediaAssets.id, id))).limit(1));
  if (!m) return null;
  if (m.kind === "employee_photo" && (m.provenance !== "employee_consented" || !m.consentAt)) return null;
  return { mimeType: m.mimeType, bytes: Buffer.from(m.bytesBase64, "base64"), provenance: m.provenance, createdAt: m.createdAt };
}
