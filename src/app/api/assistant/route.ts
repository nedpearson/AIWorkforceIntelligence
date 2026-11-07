import { z } from "zod";
import { requireApiCtx } from "@/lib/session";
import { hit, tooManyRequests } from "@/lib/rate-limit";
import { answerQuestion } from "@/engine/assistant";
import { answerUniversal, saveExchange, latestConversation } from "@/engine/brain/universal";

export const dynamic = "force-dynamic";
const Body = z.object({ question: z.string().trim().min(2).max(1000), universal: z.boolean().optional(), conversationId: z.string().uuid().nullish() });

/**
 * POST /api/assistant { question }                         → evidence-pack answer { answer, citations, mode, basis } (AI Strategy Advisor page)
 * POST /api/assistant { question, universal: true, conversationId? }
 *   → universal assistant: evidence pack + AI Brain + intent routing { answer, citations, mode, intent, actions, passages, note, conversationId }
 *     persisted to ai_conversations / ai_messages (aiEmployeeId null).
 * GET  /api/assistant → the caller's latest universal conversation.
 */
export async function POST(req: Request) {
  const ctx = await requireApiCtx("workflows:read");
  if (ctx instanceof Response) return ctx;
  const rl = await hit("assistantAsk", ctx.userId);
  if (!rl.ok) return tooManyRequests(rl, { message: "You're asking very quickly — wait a minute and try again." });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: "question is required (2–1000 characters)" }, { status: 400 });
  try {
    if (!p.data.universal) return Response.json(await answerQuestion(ctx.orgId, p.data.question, { userId: ctx.userId, role: ctx.role }));
    const result = await answerUniversal(ctx.orgId, p.data.question, { userId: ctx.userId, role: ctx.role, employeeId: ctx.employeeId });
    const conversationId = await saveExchange(ctx.orgId, ctx.userId, p.data.conversationId ?? null, p.data.question, result);
    return Response.json({ ...result, conversationId });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "assistant failed" }, { status: 500 });
  }
}

export async function GET() {
  const ctx = await requireApiCtx("workflows:read");
  if (ctx instanceof Response) return ctx;
  return Response.json({ conversation: await latestConversation(ctx.orgId, ctx.userId) });
}
