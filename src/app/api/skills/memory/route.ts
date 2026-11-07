import { z } from "zod";
import { requireApiCtx } from "@/lib/session";
import { decideMemory } from "@/engine/skills";

export const dynamic = "force-dynamic";
const Body = z.object({ memoryId: z.string().uuid(), decision: z.enum(["approve", "reject"]) });

/** POST /api/skills/memory { memoryId, decision } → { status }. Owner/admin/consultant (agents:write). Security-altering text is refused. */
export async function POST(req: Request) {
  const ctx = await requireApiCtx("agents:write");
  if (ctx instanceof Response) return ctx;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: "memoryId and decision (approve|reject) are required" }, { status: 400 });
  try { return Response.json(await decideMemory({ orgId: ctx.orgId, memoryId: p.data.memoryId, decision: p.data.decision, actorUserId: ctx.userId })); }
  catch (e) { const m = e instanceof Error ? e.message : "failed"; return Response.json({ error: m }, { status: /not found/.test(m) ? 404 : 422 }); }
}
