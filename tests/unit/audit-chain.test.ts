/** Audit-log hash chain (task 10): chaining, concurrency, tamper / deletion / insertion detection. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema, pg } from "@/db/client";
import { audit, verifyAuditChain, canonicalJson, auditRowHash } from "@/lib/audit";
import { randomToken } from "@/lib/crypto";

const S = randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x");
let orgA = "", orgB = "";
const rows = async (o: string) => db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, o)).orderBy(asc(schema.auditLog.id));
beforeAll(async () => {
  const [a] = await db.insert(schema.organizations).values({ name: `Chain A ${S}`, slug: `chain-a-${S}` }).returning();
  const [b] = await db.insert(schema.organizations).values({ name: `Chain B ${S}`, slug: `chain-b-${S}` }).returning();
  orgA = a.id; orgB = b.id;
});
afterAll(async () => {
  await db.delete(schema.auditLog).where(sql`${schema.auditLog.orgId} in (${orgA}, ${orgB})`);
  await db.delete(schema.organizations).where(sql`${schema.organizations.id} in (${orgA}, ${orgB})`);
  await pg.end({ timeout: 5 });
});

describe("canonical JSON", () => {
  it("is key-order independent and stable through jsonb", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe("audit hash chain", () => {
  it("chains each org independently; first row has prev_hash null; verify passes", async () => {
    await audit({ orgId: orgA, action: "test.one", details: { z: 1, a: "x", nested: { k: [1, 2] }, when: new Date("2026-01-01T00:00:00Z") } as Record<string, unknown> });
    await audit({ orgId: orgB, action: "test.b1" });
    await audit({ orgId: orgA, action: "test.two", entityType: "thing", entityId: "42", ipHash: "abc" });
    const a = await rows(orgA);
    expect(a.length).toBe(2);
    expect(a[0].prevHash).toBeNull(); expect(a[1].prevHash).toBe(a[0].hash);
    expect(a[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await rows(orgB))[0].prevHash).toBeNull();
    const v = await verifyAuditChain(orgA);
    expect(v).toMatchObject({ ok: true, checked: 2, legacy: 0, firstBreak: null, headHash: a[1].hash });
  });
  it("stays linear under 25 concurrent writers", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => audit({ orgId: orgA, action: "test.concurrent", details: { i } })));
    const v = await verifyAuditChain(orgA);
    expect(v.ok).toBe(true); expect(v.checked).toBe(27);
    const a = await rows(orgA);
    expect(new Set(a.map((r) => r.prevHash)).size).toBe(a.length); // no fork: every prev_hash used once
  });
  it("detects an edited entry (hash_mismatch) at the exact row", async () => {
    const a = await rows(orgA);
    const victim = a[5];
    await db.update(schema.auditLog).set({ details: { i: 999 } }).where(eq(schema.auditLog.id, victim.id));
    const v = await verifyAuditChain(orgA);
    expect(v.ok).toBe(false); expect(v.firstBreak).toMatchObject({ id: victim.id, reason: "hash_mismatch" }); expect(v.checked).toBe(5);
    await db.update(schema.auditLog).set({ details: victim.details }).where(eq(schema.auditLog.id, victim.id));
    expect((await verifyAuditChain(orgA)).ok).toBe(true);
  });
  it("detects a deleted entry and a forged inserted entry (prev_hash_mismatch)", async () => {
    const a = await rows(orgA);
    const del = a[10];
    await db.delete(schema.auditLog).where(eq(schema.auditLog.id, del.id));
    const v = await verifyAuditChain(orgA);
    expect(v.ok).toBe(false); expect(v.firstBreak).toMatchObject({ id: a[11].id, reason: "prev_hash_mismatch" });
    // re-insert the exact row: the chain is intact again (ids may differ, order is preserved by id)
    const { id: _id, ...rest } = del; void _id;
    await db.execute(sql`insert into audit_log (id, org_id, actor_user_id, actor_type, action, entity_type, entity_id, details, ip_hash, ts, prev_hash, hash) overriding system value values (${del.id}, ${rest.orgId}, ${rest.actorUserId}, ${rest.actorType}, ${rest.action}, ${rest.entityType}, ${rest.entityId}, ${JSON.stringify(rest.details)}::jsonb, ${rest.ipHash}, ${rest.ts.toISOString()}, ${rest.prevHash}, ${rest.hash})`);
    expect((await verifyAuditChain(orgA)).ok).toBe(true);
    // a forged row with a valid-looking hash but the wrong predecessor
    const ts = new Date();
    const forgedHash = auditRowHash("0".repeat(64), { orgId: orgA, actorUserId: null, actorType: "system", action: "forged", entityType: null, entityId: null, details: {}, ipHash: null, ts });
    await db.insert(schema.auditLog).values({ orgId: orgA, actorType: "system", action: "forged", details: {}, ts, prevHash: "0".repeat(64), hash: forgedHash });
    const f = await verifyAuditChain(orgA);
    expect(f.ok).toBe(false); expect(f.firstBreak?.reason).toBe("prev_hash_mismatch"); expect(f.firstBreak?.action).toBe("forged");
    await db.delete(schema.auditLog).where(and(eq(schema.auditLog.orgId, orgA), eq(schema.auditLog.action, "forged")));
  });
  it("reports pre-0005 rows without hashes as legacy, not as breaks", async () => {
    await db.insert(schema.auditLog).values({ orgId: orgB, action: "legacy.row", details: {} });
    const v = await verifyAuditChain(orgB);
    expect(v.ok).toBe(true); expect(v.legacy).toBe(1); expect(v.checked).toBe(1);
  });
});
