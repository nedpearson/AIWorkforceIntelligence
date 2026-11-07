/** Tour progress persistence (tour_progress, unique per org+user+tour). Server-only usage; definitions are in ./tours. */
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { TOURS, isTourKey, type TourKey, type TourProgress } from "./tours";

export async function listTourProgress(orgId: string, userId: string): Promise<TourProgress[]> {
  const rows = await withTenant(orgId, (tx) => tx.select().from(schema.tourProgress).where(and(eq(schema.tourProgress.orgId, orgId), eq(schema.tourProgress.userId, userId))));
  return rows.filter((r) => isTourKey(r.tourKey)).map((r) => ({ tourKey: r.tourKey as TourKey, step: r.step, completedAt: r.completedAt?.toISOString() ?? null, updatedAt: r.updatedAt.toISOString() }));
}

/** Upsert progress. `completed` marks done; `reset` clears completion and rewinds to step 0 (replay). */
export async function saveTourProgress(orgId: string, userId: string, tourKey: string, i: { step: number; completed?: boolean; reset?: boolean }): Promise<TourProgress> {
  if (!isTourKey(tourKey)) throw new Error("unknown tour");
  const max = TOURS[tourKey].steps.length - 1;
  const step = i.reset ? 0 : Math.max(0, Math.min(max, Math.floor(i.step)));
  const completedAt = i.completed ? new Date() : null;
  const [r] = await withTenant(orgId, (tx) => tx.insert(schema.tourProgress).values({ orgId, userId, tourKey, step, completedAt, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [schema.tourProgress.orgId, schema.tourProgress.userId, schema.tourProgress.tourKey], set: { step, completedAt, updatedAt: new Date() } }).returning());
  return { tourKey, step: r.step, completedAt: r.completedAt?.toISOString() ?? null, updatedAt: r.updatedAt.toISOString() };
}
