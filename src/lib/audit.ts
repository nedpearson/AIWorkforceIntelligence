import { db, schema } from "@/db/client";
export async function audit(e: { orgId?: string | null; actorUserId?: string | null; actorType?: "user" | "collector" | "system" | "agent"; action: string; entityType?: string; entityId?: string; details?: Record<string, unknown>; ipHash?: string }) {
  try {
    await db.insert(schema.auditLog).values({ orgId: e.orgId ?? null, actorUserId: e.actorUserId ?? null, actorType: e.actorType ?? "user", action: e.action, entityType: e.entityType, entityId: e.entityId, details: e.details ?? {}, ipHash: e.ipHash });
  } catch (err) { console.error("audit failed", err); }
}
