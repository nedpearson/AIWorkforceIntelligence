"use server";
/**
 * AI Brain server actions — zod-validated, permission-checked in code, tenant-scoped, audited (engine functions audit).
 *  read:            workflows:read            (askBrainAction, getDocumentAction)
 *  ingest/propose:  employees:write | org:manage (pasteTextAction, newVersionAction, proposeFactAction, learnFromPlatformAction, syncSourceAction)
 *  approve:         owner/admin; manager only for items in their own department (decideAction)
 *  demo knowledge:  owner, demo org only
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { can, type Role } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { ingestDocument, proposeFact, deriveFactsFromPlatform, KNOWLEDGE_CATEGORIES } from "@/engine/brain";
import { askBrain, brainScopeFor, memberDepartment, NO_DEPARTMENT } from "@/engine/brain/answer";
import { decideItems, documentDetail } from "@/engine/brain/review";
import { syncBrainSource, ensureSource } from "@/engine/brain/sources";
import { loadDemoKnowledge } from "@/engine/brain/demo-content";

type R<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string };
const canIngest = (role: Role) => can(role, "employees:write") || can(role, "org:manage");
const ROLES = ["owner", "admin", "manager", "employee", "consultant", "viewer"] as const;
const uuid = z.string().uuid();
const err = (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "Something went wrong" });
const done = () => { revalidatePath("/app/brain"); };

async function ingestCtx() { const ctx = await requireCtx("workflows:read"); if (!canIngest(ctx.role)) throw new Error("Your role cannot add knowledge (requires employees:write or org:manage)."); return ctx; }

const Paste = z.object({ title: z.string().trim().min(2).max(200), content: z.string().min(20).max(2_000_000), category: z.enum(KNOWLEDGE_CATEGORIES), departmentId: uuid.nullish(), allowedRoles: z.array(z.enum(ROLES)).max(6).default([]), allowNearDuplicate: z.boolean().optional(), supersedesId: uuid.nullish() });
export async function pasteTextAction(raw: unknown): Promise<R<{ status: string; documentId?: string; duplicateOf?: { id: string; title: string; similarity: number } }>> {
  try {
    const ctx = await ingestCtx();
    const p = Paste.safeParse(raw); if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
    const sourceId = await ensureSource(ctx.orgId, "manual", "Pasted text", null, ctx.userId);
    const r = await ingestDocument(ctx.orgId, ctx.userId, { title: p.data.title, content: p.data.content, category: p.data.category, departmentId: p.data.departmentId ?? null, allowedRoles: p.data.allowedRoles, sourceId, supersedesId: p.data.supersedesId ?? null, mimeType: "text/plain" }, { allowNearDuplicate: p.data.allowNearDuplicate });
    done(); return { ok: true, ...r };
  } catch (e) { return err(e); }
}

export async function getDocumentAction(id: string) {
  const ctx = await requireCtx("workflows:read");
  if (!uuid.safeParse(id).success) return null;
  const d = await documentDetail(ctx.orgId, id);
  if (!d) return null;
  // non-admins only see documents their role and department may read
  if (!["owner", "admin", "consultant"].includes(ctx.role)) {
    const dept = await memberDepartment(ctx.orgId, ctx);
    if ((d.allowedRoles.length && !d.allowedRoles.includes(ctx.role)) || (d.departmentId && d.departmentId !== dept)) return null;
  }
  return d;
}

const Decide = z.object({ items: z.array(z.object({ kind: z.enum(["document", "fact", "memory"]), id: uuid })).min(1).max(200), decision: z.enum(["approve", "reject", "archive"]), note: z.string().max(500).optional() });
export async function decideAction(raw: unknown): Promise<R<{ done: number; denied: number }>> {
  try {
    const ctx = await requireCtx("workflows:read");
    if (!["owner", "admin", "manager"].includes(ctx.role)) return { ok: false, error: "Only owners, admins and department managers can review knowledge." };
    const p = Decide.safeParse(raw); if (!p.success) return { ok: false, error: "invalid input" };
    const departmentId = ctx.role === "manager" ? await memberDepartment(ctx.orgId, ctx) : null;
    const r = await decideItems(ctx.orgId, ctx.userId, { role: ctx.role, departmentId }, p.data.items, p.data.decision, p.data.note);
    done();
    if (!r.done.length && r.denied.length) return { ok: false, error: "You can only review items scoped to your own department." };
    return { ok: true, done: r.done.length, denied: r.denied.length };
  } catch (e) { return err(e); }
}

const Fact = z.object({ category: z.enum(KNOWLEDGE_CATEGORIES), subject: z.string().trim().min(2).max(200), statement: z.string().trim().min(5).max(2000), departmentId: uuid.nullish(), supersedesId: uuid.nullish() });
export async function proposeFactAction(raw: unknown): Promise<R<{ id: string; duplicate: boolean }>> {
  try {
    const ctx = await ingestCtx();
    const p = Fact.safeParse(raw); if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
    const r = await proposeFact(ctx.orgId, ctx.userId, { ...p.data, departmentId: p.data.departmentId ?? null, supersedesId: p.data.supersedesId ?? null, confidence: "stated" });
    done(); return { ok: true, ...r };
  } catch (e) { return err(e); }
}

export async function learnFromPlatformAction(): Promise<R<{ proposed: number; created: number }>> {
  try { const ctx = await ingestCtx(); const r = await deriveFactsFromPlatform(ctx.orgId, ctx.userId); await syncBrainSource(ctx.orgId, ctx.userId, "bridgebox").catch(() => null); done(); return { ok: true, ...r }; } catch (e) { return err(e); }
}

export async function syncSourceAction(key: string): Promise<R<{ message: string }>> {
  try {
    const ctx = await ingestCtx();
    const r = await syncBrainSource(ctx.orgId, ctx.userId, z.string().max(40).parse(key));
    done(); return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
  } catch (e) { return err(e); }
}

const Ask = z.object({ question: z.string().trim().min(2).max(500), simulateRole: z.enum(ROLES).optional(), simulateDepartmentId: uuid.nullish() });
export async function askBrainAction(raw: unknown) {
  const ctx = await requireCtx("workflows:read");
  const p = Ask.safeParse(raw); if (!p.success) return { ok: false as const, error: "Ask a question of at least 2 characters." };
  const scope = await brainScopeFor(ctx.orgId, ctx);
  let role: string = scope.role; let departmentIds = scope.departmentIds; let simulated = false;
  if (p.data.simulateRole && ctx.role === "owner") {
    // owner-only permission check: retrieve exactly as that role would (department: chosen one, or org-wide only)
    role = p.data.simulateRole; simulated = true;
    departmentIds = ["owner", "admin", "consultant"].includes(role) ? null : [p.data.simulateDepartmentId ?? NO_DEPARTMENT];
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "brain.role_simulation", entityType: "brain", details: { role, department: p.data.simulateDepartmentId ?? null } });
  }
  const a = await askBrain(ctx.orgId, p.data.question, { role, departmentIds, userId: ctx.userId });
  return { ok: true as const, ...a, simulated, asRole: role };
}

export async function loadDemoKnowledgeAction(): Promise<R<{ created: number; skipped: number }>> {
  try {
    const ctx = await requireCtx("workflows:read");
    if (ctx.role !== "owner") return { ok: false, error: "Only the organization owner can load demo knowledge." };
    const r = await loadDemoKnowledge(ctx.orgId, ctx.userId); done(); return { ok: true, ...r };
  } catch (e) { return err(e); }
}
