import { z } from "zod";
import { requireApiCtx } from "@/lib/session";
import { reviewSkillRun } from "@/engine/skills";

export const dynamic = "force-dynamic";
const Body = z.object({ skillRunId: z.string().uuid(), verdict: z.enum(["accepted", "corrected", "rejected"]), note: z.string().trim().max(2000).optional(), improvement: z.string().trim().max(2000).optional() });

/** POST /api/skills/review { skillRunId, verdict, note?, improvement? } → { ok }. An improvement becomes PENDING memory that an
 *  owner/admin must approve; feedback can never change permissions, approvals, budgets or credentials. */
export async function POST(req: Request) {
  const ctx = await requireApiCtx("agents:approve");
  if (ctx instanceof Response) return ctx;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: "skillRunId and verdict (accepted|corrected|rejected) are required" }, { status: 400 });
  try {
    await reviewSkillRun({ orgId: ctx.orgId, skillRunId: p.data.skillRunId, verdict: p.data.verdict, note: p.data.note, improvement: p.data.improvement, actorUserId: ctx.userId });
    return Response.json({ ok: true, memoryPending: !!p.data.improvement });
  } catch (e) { const m = e instanceof Error ? e.message : "review failed"; return Response.json({ error: m }, { status: /not found/.test(m) ? 404 : 403 }); }
}
