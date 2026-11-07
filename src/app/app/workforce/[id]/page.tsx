import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { computeOrgFinancials } from "@/engine/finance";
import { listConnectorStates } from "@/engine/connectors/service";
import { getEmployee, runCounts, employeeFinancials, defaultRange, conversationHistory, listSkillInfo, personaByKey, providersForApps, checkStatusTransition, PERSONAS } from "@/engine/workforce";
import { skillCatalogSafe } from "@/engine/workforce/skills-adapter";
import { Profile } from "./profile";

export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("agents:read"); const e = await getEmployee(ctx.orgId, (await params).id);
  return { title: e ? `Meet ${e.firstName} (AI agent)` : "AI employee" };
}

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("agents:read");
  const { id } = await params; const sp = await searchParams;
  const emp = await getEmployee(ctx.orgId, id); if (!emp) notFound();
  const persona = personaByKey(emp.personaKey);
  const fin = await computeOrgFinancials(ctx.orgId);
  const [counts, efin, chat, skills, connectors, rows] = await Promise.all([
    runCounts(ctx.orgId, emp.id), employeeFinancials(ctx.orgId, emp.id, defaultRange(), { fin }), conversationHistory(ctx.orgId, ctx.userId, emp.id), listSkillInfo(), listConnectorStates(ctx.orgId),
    withTenant(ctx.orgId, async (tx) => {
      const runs = await tx.select().from(schema.skillRuns).where(and(eq(schema.skillRuns.orgId, ctx.orgId), eq(schema.skillRuns.aiEmployeeId, emp.id))).orderBy(desc(schema.skillRuns.createdAt)).limit(60);
      const memory = await tx.select().from(schema.aiEmployeeMemory).where(and(eq(schema.aiEmployeeMemory.orgId, ctx.orgId), eq(schema.aiEmployeeMemory.aiEmployeeId, emp.id))).orderBy(desc(schema.aiEmployeeMemory.createdAt)).limit(100);
      const depts = await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, ctx.orgId));
      const members = await tx.select({ userId: schema.memberships.userId, role: schema.memberships.role, name: schema.users.name, email: schema.users.email }).from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(eq(schema.memberships.orgId, ctx.orgId));
      const docs = await tx.select({ id: schema.knowledgeDocuments.id, title: schema.knowledgeDocuments.title, category: schema.knowledgeDocuments.category, departmentId: schema.knowledgeDocuments.departmentId }).from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.orgId, ctx.orgId), eq(schema.knowledgeDocuments.status, "approved"))).limit(300);
      const [opp] = emp.opportunityId ? await tx.select({ id: schema.opportunities.id, title: schema.opportunities.title }).from(schema.opportunities).where(and(eq(schema.opportunities.orgId, ctx.orgId), eq(schema.opportunities.id, emp.opportunityId))).limit(1) : [];
      return { runs, memory, depts, members, docs, opp: opp ?? null };
    }),
  ]);
  const catalog = await skillCatalogSafe(emp.skills);
  const apps = persona?.apps ?? [];
  const skillReq = [...new Set(emp.skills.flatMap((k) => skills?.find((s) => s.key === k)?.requiresProviders ?? []))];
  const recommended = providersForApps(apps).filter((p) => !skillReq.includes(p));
  const conn = [...skillReq.map((p) => ({ key: p, required: true })), ...recommended.map((p) => ({ key: p, required: false }))].map((r) => {
    const s = connectors.find((c) => c.key === r.key);
    return { key: r.key, required: r.required, name: s?.name ?? r.key, status: s?.status ?? "not_built", purpose: s?.purpose ?? "", envVars: s?.envVars ?? [] };
  });
  const gate = (to: "pilot" | "active") => { const g = checkStatusTransition(to === "active" ? "pilot" : "sandbox", to, { role: ctx.role, ...counts }); return g.ok ? null : g.reason; };
  const demoSkill = persona?.demoSkill ?? emp.skills[0] ?? null;
  const me = rows.members.find((m) => m.userId === ctx.userId);
  return (
    <Profile
      tab={sp.tab ?? "talk"}
      employee={{ id: emp.id, firstName: emp.firstName, title: emp.title, team: emp.team, intro: emp.intro, status: emp.status, permissionLevel: emp.permissionLevel, portraitUrl: emp.portraitUrl, portraitProvenance: emp.portraitProvenance,
        responsibilities: emp.responsibilities, expertise: emp.expertise, skills: emp.skills, knowledgeScope: emp.knowledgeScope, instructions: emp.instructions, instructionsVersion: emp.instructionsVersion,
        departmentId: emp.departmentId, approvalOwnerUserId: emp.approvalOwnerUserId, monthlyRunBudget: emp.monthlyRunBudget, monthlyCostBudget: Number(emp.monthlyCostBudget), connectedProviders: emp.connectedProviders, personaKey: emp.personaKey, agentId: emp.agentId }}
      opportunity={rows.opp} demoSkill={demoSkill} skills={skills} allSkillKeys={[...new Set(PERSONAS.flatMap((p) => p.skills))]}
      counts={counts} gates={{ pilot: gate("pilot"), active: gate("active") }}
      runs={rows.runs.map((r) => ({ id: r.id, skillKey: r.skillKey, mode: r.mode, status: r.status, summary: String((r.output as Record<string, unknown>)?.summary ?? ""), createdAt: r.createdAt.toISOString(), durationMs: r.durationMs, manualBaselineMinutes: Number(r.manualBaselineMinutes ?? 0), humanReviewMinutes: Number(r.humanReviewMinutes ?? 0), reviewStatus: r.reviewStatus, reviewNote: r.reviewNote, error: r.error,
        steps: ((r.steps ?? []) as { key: string; label: string; status: string; detail?: string }[]).map((st) => ({ key: st.key, label: st.label, status: st.status, detail: (st.detail ?? "").slice(0, 400) })),
        approval: (() => { const a = (r.output as { approval?: { status?: string; decidedRole?: string; decidedAt?: string; approverRole?: string; elevated?: boolean } })?.approval; return a ? { status: a.status ?? "pending", decidedRole: a.decidedRole ?? null, decidedAt: a.decidedAt ?? null, approverRole: a.approverRole ?? null, elevated: !!a.elevated } : null; })() }))}
      memory={rows.memory.map((m) => ({ id: m.id, kind: m.kind, text: m.text, status: m.status, createdAt: m.createdAt.toISOString(), sourceSkillRunId: m.sourceSkillRunId }))}
      chat={chat} connections={conn} financials={JSON.parse(JSON.stringify(efin))}
      departments={rows.depts} members={rows.members.map((m) => ({ userId: m.userId, label: `${m.name ?? m.email} (${m.role})` }))} documents={rows.docs}
      perms={{ write: can(ctx.role, "agents:write"), approve: can(ctx.role, "agents:approve"), elevated: ["owner", "admin"].includes(ctx.role) }}
      userName={me?.name ?? ctx.email ?? "You"} catalog={catalog} role={ctx.role} />
  );
}
