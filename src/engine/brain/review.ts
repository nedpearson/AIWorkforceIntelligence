/**
 * AI Brain — review queue, approval scope and document detail.
 *
 *  canApproveItem(role, approverDeptId, itemDeptId) → owner/admin: everything; manager: only items scoped to their own department.
 *  reviewQueue(orgId, approver)                       → pending documents + facts + AI-employee memory items, each with `canApprove`
 *  decideItems(orgId, userId, approver, items, decision) → bulk approve/reject; permission re-checked per item in code; audited
 *  documentDetail(orgId, id)                          → content, chunks, version chain, near-duplicates
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { reviewDocument, reviewFact, shingleSimilarity } from "./index";

export type Approver = { role: string; departmentId: string | null };
export const APPROVER_ROLES = ["owner", "admin", "manager"] as const;

export function canApproveItem(role: string, approverDeptId: string | null, itemDeptId: string | null | undefined): boolean {
  if (role === "owner" || role === "admin") return true;
  if (role === "manager") return !!approverDeptId && !!itemDeptId && approverDeptId === itemDeptId;
  return false;
}

export type QueueItem = { kind: "document" | "fact" | "memory"; id: string; title: string; detail: string; category: string; departmentId: string | null; createdAt: string; canApprove: boolean; derived?: boolean; version?: number; supersedesId?: string | null; aiEmployee?: string | null };

export async function reviewQueue(orgId: string, approver: Approver): Promise<QueueItem[]> {
  const d = await withTenant(orgId, async (tx) => {
    const docs = await tx.select({ id: schema.knowledgeDocuments.id, title: schema.knowledgeDocuments.title, content: schema.knowledgeDocuments.content, category: schema.knowledgeDocuments.category, departmentId: schema.knowledgeDocuments.departmentId, createdAt: schema.knowledgeDocuments.createdAt, version: schema.knowledgeDocuments.version, supersedesId: schema.knowledgeDocuments.supersedesId })
      .from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.orgId, orgId), eq(schema.knowledgeDocuments.status, "pending_review"))).orderBy(desc(schema.knowledgeDocuments.createdAt)).limit(300);
    const facts = await tx.select().from(schema.brainFacts).where(and(eq(schema.brainFacts.orgId, orgId), eq(schema.brainFacts.status, "pending_review"))).orderBy(desc(schema.brainFacts.createdAt)).limit(500);
    const mem = await tx.select({ id: schema.aiEmployeeMemory.id, kind: schema.aiEmployeeMemory.kind, text: schema.aiEmployeeMemory.text, createdAt: schema.aiEmployeeMemory.createdAt, name: schema.aiEmployees.firstName, title: schema.aiEmployees.title, departmentId: schema.aiEmployees.departmentId })
      .from(schema.aiEmployeeMemory).innerJoin(schema.aiEmployees, eq(schema.aiEmployees.id, schema.aiEmployeeMemory.aiEmployeeId))
      .where(and(eq(schema.aiEmployeeMemory.orgId, orgId), eq(schema.aiEmployeeMemory.status, "pending_review"))).orderBy(desc(schema.aiEmployeeMemory.createdAt)).limit(300);
    return { docs, facts, mem };
  });
  const ca = (dept: string | null) => canApproveItem(approver.role, approver.departmentId, dept);
  return [
    ...d.docs.map((x): QueueItem => ({ kind: "document", id: x.id, title: x.title, detail: x.content.slice(0, 220), category: x.category, departmentId: x.departmentId, createdAt: x.createdAt.toISOString(), canApprove: ca(x.departmentId), version: x.version, supersedesId: x.supersedesId })),
    ...d.facts.map((x): QueueItem => ({ kind: "fact", id: x.id, title: x.subject, detail: x.statement, category: x.category, departmentId: x.departmentId, createdAt: x.createdAt.toISOString(), canApprove: ca(x.departmentId), derived: x.confidence === "derived", version: x.version, supersedesId: x.supersedesId })),
    ...d.mem.map((x): QueueItem => ({ kind: "memory", id: x.id, title: `${x.name} (${x.title}) · ${x.kind}`, detail: x.text, category: "ai_employee", departmentId: x.departmentId, createdAt: x.createdAt.toISOString(), canApprove: ca(x.departmentId), aiEmployee: x.name })),
  ];
}

async function itemDepartment(orgId: string, kind: QueueItem["kind"], id: string): Promise<{ found: boolean; departmentId: string | null }> {
  return withTenant(orgId, async (tx) => {
    if (kind === "document") { const [r] = await tx.select({ d: schema.knowledgeDocuments.departmentId }).from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.id, id), eq(schema.knowledgeDocuments.orgId, orgId))).limit(1); return { found: !!r, departmentId: r?.d ?? null }; }
    if (kind === "fact") { const [r] = await tx.select({ d: schema.brainFacts.departmentId }).from(schema.brainFacts).where(and(eq(schema.brainFacts.id, id), eq(schema.brainFacts.orgId, orgId))).limit(1); return { found: !!r, departmentId: r?.d ?? null }; }
    const [r] = await tx.select({ d: schema.aiEmployees.departmentId }).from(schema.aiEmployeeMemory).innerJoin(schema.aiEmployees, eq(schema.aiEmployees.id, schema.aiEmployeeMemory.aiEmployeeId)).where(and(eq(schema.aiEmployeeMemory.id, id), eq(schema.aiEmployeeMemory.orgId, orgId))).limit(1);
    return { found: !!r, departmentId: r?.d ?? null };
  });
}

export async function decideItems(orgId: string, userId: string, approver: Approver, items: { kind: QueueItem["kind"]; id: string }[], decision: "approve" | "reject" | "archive", note?: string) {
  const done: string[] = []; const denied: string[] = []; const missing: string[] = [];
  for (const it of items) {
    const dep = await itemDepartment(orgId, it.kind, it.id);
    if (!dep.found) { missing.push(it.id); continue; }
    if (!canApproveItem(approver.role, approver.departmentId, dep.departmentId)) { denied.push(it.id); continue; }
    if (it.kind === "document") await reviewDocument(orgId, userId, it.id, decision);
    else if (it.kind === "fact") await reviewFact(orgId, userId, it.id, decision);
    else {
      const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "archived";
      await withTenant(orgId, (tx) => tx.update(schema.aiEmployeeMemory).set({ status, ...(decision === "approve" ? { approvedBy: userId, approvedAt: new Date() } : {}) }).where(and(eq(schema.aiEmployeeMemory.id, it.id), eq(schema.aiEmployeeMemory.orgId, orgId))));
      await audit({ orgId, actorUserId: userId, action: `brain.memory_${decision}d`, entityType: "ai_employee_memory", entityId: it.id });
    }
    done.push(it.id);
  }
  if (items.length > 1 || note) await audit({ orgId, actorUserId: userId, action: "brain.bulk_review", entityType: "brain", details: { decision, done: done.length, denied: denied.length, missing: missing.length, note: note?.slice(0, 200) } });
  return { done, denied, missing };
}

export type DocumentDetail = {
  id: string; title: string; status: string; category: string; version: number; departmentId: string | null; allowedRoles: string[]; content: string; wordCount: number; mimeType: string;
  createdAt: string; approvedAt: string | null; reviewEveryDays: number; supersedesId: string | null;
  chunks: { ordinal: number; heading: string | null; text: string }[];
  versions: { id: string; version: number; status: string; createdAt: string; approvedAt: string | null; title: string }[];
  similar: { id: string; title: string; status: string; similarity: number }[];
};

export async function documentDetail(orgId: string, id: string): Promise<DocumentDetail | null> {
  return withTenant(orgId, async (tx) => {
    const [d] = await tx.select().from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.id, id), eq(schema.knowledgeDocuments.orgId, orgId))).limit(1);
    if (!d) return null;
    const chunks = await tx.select({ ordinal: schema.knowledgeChunks.ordinal, heading: schema.knowledgeChunks.heading, text: schema.knowledgeChunks.text }).from(schema.knowledgeChunks).where(and(eq(schema.knowledgeChunks.documentId, id), eq(schema.knowledgeChunks.orgId, orgId))).orderBy(schema.knowledgeChunks.ordinal);
    // version chain: walk supersedesId back and forward (bounded)
    const chain = new Map<string, typeof d>([[d.id, d]]);
    let back = d.supersedesId; let guard = 0;
    while (back && guard++ < 50) { const [p] = await tx.select().from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.id, back), eq(schema.knowledgeDocuments.orgId, orgId))).limit(1); if (!p) break; chain.set(p.id, p); back = p.supersedesId; }
    let frontier = [d.id]; guard = 0;
    while (frontier.length && guard++ < 50) { const next = await tx.select().from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.orgId, orgId), inArray(schema.knowledgeDocuments.supersedesId, frontier))); frontier = next.filter((n) => !chain.has(n.id)).map((n) => n.id); next.forEach((n) => chain.set(n.id, n)); }
    const others = await tx.select({ id: schema.knowledgeDocuments.id, title: schema.knowledgeDocuments.title, status: schema.knowledgeDocuments.status, content: schema.knowledgeDocuments.content }).from(schema.knowledgeDocuments)
      .where(and(eq(schema.knowledgeDocuments.orgId, orgId), or(eq(schema.knowledgeDocuments.status, "approved"), eq(schema.knowledgeDocuments.status, "pending_review")))).orderBy(desc(schema.knowledgeDocuments.createdAt)).limit(200);
    const similar = others.filter((o) => !chain.has(o.id)).map((o) => ({ id: o.id, title: o.title, status: o.status, similarity: shingleSimilarity(d.content.slice(0, 20000), o.content.slice(0, 20000)) })).filter((o) => o.similarity >= 0.5).sort((a, b) => b.similarity - a.similarity).slice(0, 5);
    return {
      id: d.id, title: d.title, status: d.status, category: d.category, version: d.version, departmentId: d.departmentId, allowedRoles: d.allowedRoles, content: d.content.slice(0, 60000), wordCount: d.wordCount, mimeType: d.mimeType,
      createdAt: d.createdAt.toISOString(), approvedAt: d.approvedAt?.toISOString() ?? null, reviewEveryDays: d.reviewEveryDays, supersedesId: d.supersedesId,
      chunks, versions: [...chain.values()].sort((a, b) => b.version - a.version).map((v) => ({ id: v.id, version: v.version, status: v.status, createdAt: v.createdAt.toISOString(), approvedAt: v.approvedAt?.toISOString() ?? null, title: v.title })),
      similar,
    };
  });
}
