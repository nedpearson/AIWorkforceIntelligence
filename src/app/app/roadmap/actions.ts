"use server";
/** Server actions for /app/roadmap. zod-validated, opportunities:write, tenant-scoped (engine uses withTenant), audited by the engine. */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import {
  createProject, updateProject, deleteProject, upsertMilestone, deleteMilestone, upsertRisk, deleteRisk, verifyProject, PROJECT_STATUSES, MILESTONE_STATUSES,
} from "@/engine/roadmap";

type R = { ok: true; id?: string } | { ok: false; error: string };
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform((v) => (v ? new Date(`${v}T00:00:00Z`) : v === null ? null : undefined));
const money = z.number().min(0).max(1e10).nullable().optional();

async function run(fn: (orgId: string, userId: string) => Promise<string | void>): Promise<R> {
  const ctx = await requireCtx("opportunities:write");
  try { const id = await fn(ctx.orgId, ctx.userId); revalidatePath("/app/roadmap"); revalidatePath("/app/savings"); revalidatePath("/app"); return { ok: true, id: id ?? undefined }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
const fail = (e: z.ZodError): R => ({ ok: false, error: e.issues[0] ? `${e.issues[0].path.join(".") || "input"}: ${e.issues[0].message}` : "invalid input" });

const ProjectFields = z.object({
  name: z.string().trim().min(2).max(160), status: z.enum(PROJECT_STATUSES).optional(), opportunityIds: z.array(uuid).max(50).optional(), agentIds: z.array(uuid).max(50).optional(),
  budget: money, spent: money, targetAnnualSavings: money, startDate: date, targetDate: date, ownerUserId: uuid.nullable().optional(), notes: z.string().max(4000).nullable().optional(),
});

export async function saveProject(raw: unknown): Promise<R> {
  const p = ProjectFields.extend({ id: uuid.optional() }).safeParse(raw); if (!p.success) return fail(p.error);
  const { id, ...i } = p.data;
  if (i.startDate && i.targetDate && i.targetDate < i.startDate) return { ok: false, error: "target date must be on or after the start date" };
  return run(async (orgId, userId) => (id ? (await updateProject(orgId, userId, id, i)).id : (await createProject(orgId, userId, i)).id));
}

export async function moveProject(raw: unknown): Promise<R> {
  const p = z.object({ id: uuid, status: z.enum(PROJECT_STATUSES) }).safeParse(raw); if (!p.success) return fail(p.error);
  return run(async (orgId, userId) => (await updateProject(orgId, userId, p.data.id, { status: p.data.status })).id);
}

export async function removeProject(raw: unknown): Promise<R> {
  const p = z.object({ id: uuid }).safeParse(raw); if (!p.success) return fail(p.error);
  return run((orgId, userId) => deleteProject(orgId, userId, p.data.id));
}

export async function verifyProjectCompletion(raw: unknown): Promise<R> {
  const p = z.object({ id: uuid }).safeParse(raw); if (!p.success) return fail(p.error);
  return run(async (orgId, userId) => (await verifyProject(orgId, userId, p.data.id)).id);
}

export async function saveMilestone(raw: unknown): Promise<R> {
  const p = z.object({ id: uuid.optional(), projectId: uuid, name: z.string().trim().min(1).max(160), status: z.enum(MILESTONE_STATUSES).optional(), startDate: date, dueDate: date, dependsOnMilestoneId: uuid.nullable().optional() }).safeParse(raw);
  if (!p.success) return fail(p.error);
  const { id, projectId, ...i } = p.data;
  return run(async (orgId, userId) => (await upsertMilestone(orgId, userId, projectId, i, id)).id);
}
export async function removeMilestone(raw: unknown): Promise<R> {
  const p = z.object({ id: uuid }).safeParse(raw); if (!p.success) return fail(p.error);
  return run((orgId, userId) => deleteMilestone(orgId, userId, p.data.id));
}

export async function saveRisk(raw: unknown): Promise<R> {
  const p = z.object({ id: uuid.optional(), projectId: uuid, title: z.string().trim().min(2).max(200), severity: z.number().int().min(1).max(5), likelihood: z.number().int().min(1).max(5), mitigation: z.string().max(2000).nullable().optional(), status: z.enum(["open", "mitigated", "closed"]).optional() }).safeParse(raw);
  if (!p.success) return fail(p.error);
  const { id, projectId, ...i } = p.data;
  return run(async (orgId, userId) => (await upsertRisk(orgId, userId, projectId, i, id)).id);
}
export async function removeRisk(raw: unknown): Promise<R> {
  const p = z.object({ id: uuid }).safeParse(raw); if (!p.success) return fail(p.error);
  return run((orgId, userId) => deleteRisk(orgId, userId, p.data.id));
}
