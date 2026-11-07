import { z } from "zod";
import { requireApiCtx } from "@/lib/session";
import { decideSkillRun } from "@/engine/skills";

export const dynamic = "force-dynamic";
const Body = z.object({ skillRunId: z.string().uuid(), decision: z.enum(["approve", "reject"]), note: z.string().trim().max(1000).optional(), confirm: z.literal(true) });

/** POST /api/skills/decide { skillRunId, decision, note?, confirm: true } → SkillResult. Requires agents:approve; over-threshold
 *  actions additionally require owner/admin (checked in decideSkillRun). `confirm` makes the human decision explicit. */
export async function POST(req: Request) {
  const ctx = await requireApiCtx("agents:approve");
  if (ctx instanceof Response) return ctx;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: "skillRunId, decision (approve|reject) and confirm: true are required" }, { status: 400 });
  try {
    const r = await decideSkillRun({ orgId: ctx.orgId, skillRunId: p.data.skillRunId, decision: p.data.decision, actorUserId: ctx.userId, note: p.data.note });
    return Response.json(r, { status: r.ok || r.status === "rejected" ? 200 : /not found/.test(r.error ?? "") ? 404 : 409 });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "decision failed" }, { status: 500 }); }
}
