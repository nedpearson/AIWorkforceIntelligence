/**
 * Per-organization AI Brain storage quota: bytes of stored document text (knowledge_documents.content, all versions).
 * Default 50 MB per org; override with BRAIN_ORG_QUOTA_BYTES. Uploaded files are not stored, only their extracted text.
 */
import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";

export const DEFAULT_BRAIN_QUOTA_BYTES = 50 * 1024 * 1024;
export function brainQuotaBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.BRAIN_ORG_QUOTA_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BRAIN_QUOTA_BYTES;
}
export async function brainStorageUsed(orgId: string): Promise<number> {
  const [r] = await withTenant(orgId, (tx) => tx.select({ n: sql<string>`coalesce(sum(octet_length(${schema.knowledgeDocuments.content})), 0)` }).from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.orgId, orgId)));
  return Number(r?.n ?? 0);
}
export class BrainQuotaError extends Error { constructor(public used: number, public quota: number) { super(`This organization's AI Brain storage is full (${(used / 1048576).toFixed(1)} of ${(quota / 1048576).toFixed(0)} MB of document text). Archive or delete documents first.`); this.name = "BrainQuotaError"; } }
/** Throws BrainQuotaError when adding `addBytes` of text would exceed the quota. */
export async function assertBrainQuota(orgId: string, addBytes: number, env: Record<string, string | undefined> = process.env): Promise<void> {
  const quota = brainQuotaBytes(env); const used = await brainStorageUsed(orgId);
  if (used + addBytes > quota) throw new BrainQuotaError(used, quota);
}
