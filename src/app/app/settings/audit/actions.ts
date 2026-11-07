"use server";
import { requireCtx } from "@/lib/session";
import { verifyAuditChain, type AuditChainResult } from "@/lib/audit";

/** Read-only verification of the current organization's audit hash chain (audit:read). */
export async function verifyAuditChainAction(): Promise<AuditChainResult | (Omit<AuditChainResult, "ok"> & { ok: false; error: string })> {
  const ctx = await requireCtx("audit:read");
  try { return await verifyAuditChain(ctx.orgId); }
  catch (e) { return { ok: false, orgId: ctx.orgId, checked: 0, legacy: 0, headHash: null, firstBreak: null, verifiedAt: new Date().toISOString(), error: e instanceof Error ? e.message : "verification failed" }; }
}
