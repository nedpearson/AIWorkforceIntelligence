import { z } from "zod";
import { requireApiCtx } from "@/lib/session";
import { hit, tooManyRequests } from "@/lib/rate-limit";
import { runSkill, getSkillRun } from "@/engine/skills";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const Body = z.object({ aiEmployeeId: z.string().uuid(), skillKey: z.string().min(2).max(60), mode: z.enum(["sandbox", "live"]), input: z.unknown().optional() });

/** POST /api/skills/run { aiEmployeeId, skillKey, mode, input? } → SkillResult. orgId/role come from the session, never the body.
 *  Permission level, status, budgets and live RBAC (agents:write) are enforced inside runSkill. */
export async function POST(req: Request) {
  const ctx = await requireApiCtx("agents:read");
  if (ctx instanceof Response) return ctx;
  const rl = await hit("skillRun", `${ctx.orgId}:${ctx.userId}`);
  if (!rl.ok) return tooManyRequests(rl, { message: "Too many skill runs in the last minute — wait and try again." });
  const raw = await req.text();
  if (raw.length > 8_000_000) return Response.json({ error: "Request too large (5 MB file limit)" }, { status: 413 });
  let json: unknown = null; try { json = JSON.parse(raw); } catch { /* handled below */ }
  const p = Body.safeParse(json);
  if (!p.success) return Response.json({ error: "aiEmployeeId (uuid), skillKey and mode (sandbox|live) are required" }, { status: 400 });
  try {
    const r = await runSkill({ orgId: ctx.orgId, aiEmployeeId: p.data.aiEmployeeId, skillKey: p.data.skillKey, mode: p.data.mode, input: p.data.input, actorUserId: ctx.userId, actorRole: ctx.role });
    const status = r.ok ? 200 : r.skillRunId ? 422 : /not found|Unknown skill/.test(r.error ?? "") ? 404 : 400;
    return Response.json(r, { status });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "skill run failed" }, { status: 500 }); }
}

/** GET /api/skills/run?id=<skillRunId> → the persisted run (for polling / reopening). */
export async function GET(req: Request) {
  const ctx = await requireApiCtx("agents:read");
  if (ctx instanceof Response) return ctx;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const r = await getSkillRun(ctx.orgId, id);
  return r ? Response.json(r) : Response.json({ error: "not found" }, { status: 404 });
}
