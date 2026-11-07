"use server";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { SKILLS } from "@/engine/skills";

/** Owner-only: creates a clearly-labelled sandbox AI employee for internal skill previews (no persona, read-only, sandbox status). */
export async function createLabEmployee() {
  const ctx = await requireCtx("agents:write");
  if (ctx.role !== "owner") redirect("/app?denied=skills-lab");
  const id = await withTenant(ctx.orgId, async (tx) => {
    const [existing] = await tx.select({ id: schema.aiEmployees.id }).from(schema.aiEmployees).where(and(eq(schema.aiEmployees.orgId, ctx.orgId), eq(schema.aiEmployees.firstName, "Skills Lab"), isNull(schema.aiEmployees.personaKey))).limit(1);
    if (existing) return existing.id;
    const [e] = await tx.insert(schema.aiEmployees).values({ orgId: ctx.orgId, personaKey: null, firstName: "Skills Lab", title: "AI skills test agent (internal)", team: "operations", intro: "Hi, I'm the Skills Lab test agent — an AI agent used only to preview skills on synthetic samples.", skills: SKILLS.map((s) => s.key), status: "sandbox", permissionLevel: "read_only", createdBy: ctx.userId }).returning({ id: schema.aiEmployees.id });
    return e.id;
  });
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "skills_lab.employee_created", entityType: "ai_employee", entityId: id });
  redirect(`/app/skills-lab?emp=${id}`);
}
