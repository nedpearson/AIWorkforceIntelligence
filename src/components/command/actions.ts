"use server";
/**
 * Command-center personalization: section layout (default view) and named saved views (filters + layout).
 * Stored in `dashboard_views` (page = "command"), scoped to the signed-in user inside their active org.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { SECTION_KEYS } from "./format";

const PAGE = "command";
const Section = z.enum(SECTION_KEYS as [string, ...string[]]);
const Layout = z.object({ hidden: z.array(Section).max(20), order: z.array(Section).max(20) });
const FILTER_KEYS = ["bu", "dept", "loc", "scenario", "from", "to", "period"] as const;
const Filters = z.record(z.string(), z.string().max(64)).transform((f) => Object.fromEntries(Object.entries(f).filter(([k, v]) => (FILTER_KEYS as readonly string[]).includes(k) && v)));

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

export async function saveCommandLayout(input: unknown): Promise<ActionResult> {
  const ctx = await requireCtx("finance:read");
  const p = Layout.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid layout" };
  const id = await withTenant(ctx.orgId, async (tx) => {
    const where = and(eq(schema.dashboardViews.orgId, ctx.orgId), eq(schema.dashboardViews.userId, ctx.userId), eq(schema.dashboardViews.page, PAGE), eq(schema.dashboardViews.isDefault, true));
    const [existing] = await tx.select({ id: schema.dashboardViews.id }).from(schema.dashboardViews).where(where).limit(1);
    if (existing) { await tx.update(schema.dashboardViews).set({ layout: p.data }).where(eq(schema.dashboardViews.id, existing.id)); return existing.id; }
    const [row] = await tx.insert(schema.dashboardViews).values({ orgId: ctx.orgId, userId: ctx.userId, page: PAGE, name: "Default", isDefault: true, layout: p.data, filters: {} }).returning({ id: schema.dashboardViews.id });
    return row.id;
  });
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "dashboard.layout_saved", entityType: "dashboard_view", entityId: id, details: { page: PAGE, hidden: p.data.hidden, order: p.data.order } });
  revalidatePath("/app");
  return { ok: true, id };
}

export async function saveCommandView(input: unknown): Promise<ActionResult> {
  const ctx = await requireCtx("finance:read");
  const p = z.object({ name: z.string().trim().min(1).max(60), filters: Filters, layout: Layout.optional() }).safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Invalid view" };
  const [row] = await withTenant(ctx.orgId, (tx) => tx.insert(schema.dashboardViews).values({ orgId: ctx.orgId, userId: ctx.userId, page: PAGE, name: p.data.name, isDefault: false, filters: p.data.filters, layout: p.data.layout ?? {} }).returning({ id: schema.dashboardViews.id }));
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "dashboard.view_saved", entityType: "dashboard_view", entityId: row.id, details: { page: PAGE, name: p.data.name, filters: p.data.filters } });
  revalidatePath("/app");
  return { ok: true, id: row.id };
}

export async function deleteCommandView(id: unknown): Promise<ActionResult> {
  const ctx = await requireCtx("finance:read");
  const p = z.string().uuid().safeParse(id);
  if (!p.success) return { ok: false, error: "Invalid id" };
  const deleted = await withTenant(ctx.orgId, (tx) => tx.delete(schema.dashboardViews).where(and(eq(schema.dashboardViews.id, p.data), eq(schema.dashboardViews.orgId, ctx.orgId), eq(schema.dashboardViews.userId, ctx.userId), eq(schema.dashboardViews.isDefault, false))).returning({ id: schema.dashboardViews.id }));
  if (!deleted.length) return { ok: false, error: "View not found" };
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "dashboard.view_deleted", entityType: "dashboard_view", entityId: p.data, details: { page: PAGE } });
  revalidatePath("/app");
  return { ok: true };
}
