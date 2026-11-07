/**
 * Audit log with a per-org hash chain (migration 0005).
 *  hash = sha256(canonical([prev_hash, org_id, actor_user_id, actor_type, action, entity_type, entity_id, details, ip_hash, ts]))
 * Inserts for one org are serialised with a transaction-scoped advisory lock so the chain never forks.
 * verifyAuditChain(orgId) walks the chain in id order and reports the first row whose hash or prev_hash does not match
 * (edited, inserted or deleted rows). Limits: deleting the newest rows is only detectable against an external anchor
 * (record the head hash elsewhere); rows written before 0005 have no hash and are reported as `legacy`.
 * Insert failures are logged and never block the request (unchanged behaviour; docs/SECURITY.md §13).
 */
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { sha256 } from "@/lib/crypto";

export type AuditEvent = { orgId?: string | null; actorUserId?: string | null; actorType?: "user" | "collector" | "system" | "agent"; action: string; entityType?: string; entityId?: string; details?: Record<string, unknown>; ipHash?: string };

/** JSON with recursively sorted keys — stable across the jsonb round trip (jsonb reorders keys). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

type ChainFields = { orgId: string | null; actorUserId: string | null; actorType: string; action: string; entityType: string | null; entityId: string | null; details: unknown; ipHash: string | null; ts: Date };
export function auditRowHash(prevHash: string | null, r: ChainFields): string {
  return sha256(canonicalJson([prevHash, r.orgId, r.actorUserId, r.actorType, r.action, r.entityType, r.entityId, r.details ?? {}, r.ipHash, r.ts.toISOString()]));
}

const chainLockKey = (orgId: string | null) => `audit:${orgId ?? "global"}`;

export async function audit(e: AuditEvent) {
  try {
    // Normalise exactly as the jsonb round trip will (drops undefined, Dates → ISO strings).
    const details = JSON.parse(JSON.stringify(e.details ?? {})) as Record<string, unknown>;
    const row: ChainFields = { orgId: e.orgId ?? null, actorUserId: e.actorUserId ?? null, actorType: e.actorType ?? "user", action: e.action, entityType: e.entityType ?? null, entityId: e.entityId ?? null, details, ipHash: e.ipHash ?? null, ts: new Date() };
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${chainLockKey(row.orgId)}, 0))`);
      const [last] = await tx.select({ hash: schema.auditLog.hash }).from(schema.auditLog)
        .where(and(row.orgId ? eq(schema.auditLog.orgId, row.orgId) : isNull(schema.auditLog.orgId), sql`${schema.auditLog.hash} is not null`))
        .orderBy(sql`${schema.auditLog.id} desc`).limit(1);
      const prevHash = last?.hash ?? null;
      await tx.insert(schema.auditLog).values({ ...row, entityType: row.entityType ?? undefined, entityId: row.entityId ?? undefined, ipHash: row.ipHash ?? undefined, details, prevHash, hash: auditRowHash(prevHash, row) });
    });
  } catch (err) { console.error("audit failed", err); }
}

export type AuditChainResult = { ok: boolean; orgId: string | null; checked: number; legacy: number; headHash: string | null; firstBreak: { id: number; reason: "hash_mismatch" | "prev_hash_mismatch"; action: string; ts: string } | null; verifiedAt: string };

/** Walk one org's chain (NULL = global chain) in id order. Batched; read-only. */
export async function verifyAuditChain(orgId: string | null, opts: { batch?: number } = {}): Promise<AuditChainResult> {
  const batch = opts.batch ?? 2000;
  const orgCond = orgId ? eq(schema.auditLog.orgId, orgId) : isNull(schema.auditLog.orgId);
  const [{ legacy }] = await db.select({ legacy: sql<number>`count(*)::int` }).from(schema.auditLog).where(and(orgCond, isNull(schema.auditLog.hash)));
  let prev: string | null = null; let checked = 0; let lastId = 0;
  for (;;) {
    const rows = await db.select().from(schema.auditLog).where(and(orgCond, sql`${schema.auditLog.hash} is not null`, gt(schema.auditLog.id, lastId))).orderBy(asc(schema.auditLog.id)).limit(batch);
    if (!rows.length) break;
    for (const r of rows) {
      const brk = (reason: "hash_mismatch" | "prev_hash_mismatch") => ({ ok: false, orgId, checked, legacy: Number(legacy), headHash: prev, firstBreak: { id: r.id, reason, action: r.action, ts: r.ts.toISOString() }, verifiedAt: new Date().toISOString() });
      if ((r.prevHash ?? null) !== prev) return brk("prev_hash_mismatch");
      const expect = auditRowHash(prev, { orgId: r.orgId, actorUserId: r.actorUserId, actorType: r.actorType, action: r.action, entityType: r.entityType, entityId: r.entityId, details: r.details ?? {}, ipHash: r.ipHash, ts: r.ts });
      if (expect !== r.hash) return brk("hash_mismatch");
      prev = r.hash; checked++; lastId = r.id;
    }
    if (rows.length < batch) break;
  }
  return { ok: true, orgId, checked, legacy: Number(legacy), headHash: prev, firstBreak: null, verifiedAt: new Date().toISOString() };
}
