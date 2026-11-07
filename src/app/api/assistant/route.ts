import { z } from "zod";
import { requireApiCtx } from "@/lib/session";
import { answerQuestion } from "@/engine/assistant";

export const dynamic = "force-dynamic";
const Body = z.object({ question: z.string().trim().min(2).max(1000) });

/** POST /api/assistant { question } → { answer, citations, mode, basis } */
export async function POST(req: Request) {
  const ctx = await requireApiCtx("workflows:read");
  if (ctx instanceof Response) return ctx;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: "question is required (2–1000 characters)" }, { status: 400 });
  try {
    const result = await answerQuestion(ctx.orgId, p.data.question, { userId: ctx.userId, role: ctx.role });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "assistant failed" }, { status: 500 });
  }
}
