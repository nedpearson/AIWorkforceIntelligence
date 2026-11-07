import { and, eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { computeOrgFinancials } from "@/engine/finance";
import { listConnectorStates } from "@/engine/connectors/service";
import { recommendations, listSkillInfo, PERSONAS, TEAMS, departmentForTeam, providersForApps, getEmployee } from "@/engine/workforce";
import { Builder } from "./builder";

export const metadata = { title: "AI Employee Builder" };
export const dynamic = "force-dynamic";

export default async function NewEmployeePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("agents:write");
  const sp = await searchParams;
  const fin = await computeOrgFinancials(ctx.orgId);
  const [recs, skills, connectors, rows, resume] = await Promise.all([
    recommendations(ctx.orgId, { fin }), listSkillInfo(), listConnectorStates(ctx.orgId),
    withTenant(ctx.orgId, async (tx) => ({
      depts: await tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, ctx.orgId)),
      docs: await tx.select({ id: schema.knowledgeDocuments.id, title: schema.knowledgeDocuments.title, category: schema.knowledgeDocuments.category, departmentId: schema.knowledgeDocuments.departmentId }).from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.orgId, ctx.orgId), eq(schema.knowledgeDocuments.status, "approved"))).limit(300),
      members: await tx.select({ userId: schema.memberships.userId, role: schema.memberships.role, name: schema.users.name, email: schema.users.email }).from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(eq(schema.memberships.orgId, ctx.orgId)),
      existing: await tx.select({ personaKey: schema.aiEmployees.personaKey, id: schema.aiEmployees.id }).from(schema.aiEmployees).where(eq(schema.aiEmployees.orgId, ctx.orgId)),
    })),
    sp.id ? getEmployee(ctx.orgId, sp.id) : Promise.resolve(null),
  ]);
  const personas = PERSONAS.map((p) => ({ key: p.key, firstName: p.firstName, title: p.title, team: p.team, intro: p.intro, responsibilities: p.responsibilities, skills: p.skills, portrait: p.portrait, demoSkill: p.demoSkill,
    providers: providersForApps(p.apps), deptId: departmentForTeam(p.team, rows.depts), existingId: rows.existing.find((e) => e.personaKey === p.key)?.id ?? null }));
  return (
    <Builder departments={rows.depts} personas={personas} teams={Object.entries(TEAMS).map(([k, t]) => ({ key: k, label: t.label }))} skills={skills}
      recs={recs.map((r) => ({ personaKey: r.persona.key, departmentId: r.departmentId, opportunityId: r.opportunityId, title: r.opportunityTitle, workflowLabel: r.workflowLabel, observedHoursPerWeek: r.observedHoursPerWeek, hoursRecoverablePerWeek: r.hoursRecoverablePerWeek, realizableAnnualSavings: r.realizableAnnualSavings, annualOperatingCost: r.annualOperatingCost, tree: r.tree }))}
      connectors={connectors.map((c) => ({ key: c.key, name: c.name, category: c.category, status: c.status, envVars: c.envVars ?? [] }))} documents={rows.docs}
      members={rows.members.map((m) => ({ userId: m.userId, label: `${m.name ?? m.email} (${m.role})` }))} meId={ctx.userId} role={ctx.role}
      resume={resume ? { id: resume.id, personaKey: resume.personaKey, firstName: resume.firstName, title: resume.title, team: resume.team, departmentId: resume.departmentId, responsibilities: resume.responsibilities, skills: resume.skills, knowledgeScope: resume.knowledgeScope, monthlyRunBudget: resume.monthlyRunBudget, monthlyCostBudget: Number(resume.monthlyCostBudget), approvalOwnerUserId: resume.approvalOwnerUserId, connectedProviders: resume.connectedProviders, portraitUrl: resume.portraitUrl, portraitProvenance: resume.portraitProvenance } : null} />
  );
}
