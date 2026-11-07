import { z } from "zod";
import { requireApiCtx } from "@/lib/session";
import { audit } from "@/lib/audit";
import { validateAssistantAction } from "@/engine/brain/universal";

export const dynamic = "force-dynamic";
const Body = z.object({ kind: z.string().max(40), href: z.string().max(300).optional(), payload: z.record(z.string(), z.unknown()).optional() });

/**
 * POST /api/assistant/action { kind, href?, payload? } — executes ONLY allow-listed assistant actions, re-validated server-side:
 *   navigate          → returns the allow-listed href
 *   open_demo         → returns the Experience Center demo href for a library persona
 *   provision_persona → requires agents:write; adds the library persona to the AI team via the workforce engine (draft, read-only)
 * Anything else → 400. Permission failures → 403. Every executed or rejected action is audited.
 */
export async function POST(req: Request) {
  const ctx = await requireApiCtx("workflows:read");
  if (ctx instanceof Response) return ctx;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: "invalid action" }, { status: 400 });
  const v = validateAssistantAction(p.data, ctx.role);
  if (!v.ok) {
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "assistant.action_rejected", entityType: "assistant", details: { kind: p.data.kind.slice(0, 40), status: v.status } });
    return Response.json({ error: v.error }, { status: v.status });
  }
  if (v.kind === "provision_persona") {
    let provision: ((orgId: string, userId: string | null, keys?: string[]) => Promise<{ created: unknown[]; existing: unknown[] }>) | undefined;
    try { provision = (await import("@/engine/workforce/core")).provisionTeam; } catch { provision = undefined; }
    if (typeof provision !== "function") return Response.json({ error: "Adding AI employees is not available yet." }, { status: 501 });
    const r = await provision(ctx.orgId, ctx.userId, [v.personaKey!]);
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "assistant.action_executed", entityType: "assistant", details: { kind: v.kind, personaKey: v.personaKey, created: r.created.length } });
    return Response.json({ ok: true, kind: v.kind, href: v.href, created: r.created.length, message: r.created.length ? "Added to your AI team as a draft, read-only AI employee." : "Already on your AI team." });
  }
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "assistant.action_executed", entityType: "assistant", details: { kind: v.kind, href: v.href } });
  return Response.json({ ok: true, kind: v.kind, href: v.href });
}
