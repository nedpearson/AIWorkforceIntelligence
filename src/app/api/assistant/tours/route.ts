import { z } from "zod";
import { requireApiCtx } from "@/lib/session";
import { listTourProgress, saveTourProgress } from "@/engine/tours-store";
import { isTourKey } from "@/engine/tours";

export const dynamic = "force-dynamic";
const Body = z.object({ tourKey: z.string().max(40), step: z.number().int().min(0).max(100), completed: z.boolean().optional(), reset: z.boolean().optional() });

/** GET → this user's tour progress. POST { tourKey, step, completed?, reset? } → upsert (pause/resume/replay). Any signed-in member. */
export async function GET() {
  const ctx = await requireApiCtx();
  if (ctx instanceof Response) return ctx;
  return Response.json({ progress: await listTourProgress(ctx.orgId, ctx.userId) });
}
export async function POST(req: Request) {
  const ctx = await requireApiCtx();
  if (ctx instanceof Response) return ctx;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success || !isTourKey(p.data.tourKey)) return Response.json({ error: "invalid tour progress" }, { status: 400 });
  return Response.json({ progress: await saveTourProgress(ctx.orgId, ctx.userId, p.data.tourKey, p.data) });
}
