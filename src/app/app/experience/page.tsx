import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { computeOrgFinancials } from "@/engine/finance";
import { listEmployees, recommendations, listSkillInfo, PERSONAS, TEAMS } from "@/engine/workforce";
import { Showroom } from "./showroom";

export const metadata = { title: "Meet Your New AI Workforce" };
export const dynamic = "force-dynamic";

export default async function ExperiencePage() {
  const ctx = await requireCtx("agents:read");
  const fin = await computeOrgFinancials(ctx.orgId);
  const [emps, recs, skills] = await Promise.all([listEmployees(ctx.orgId), recommendations(ctx.orgId, { fin }), listSkillInfo()]);
  const byKey = Object.fromEntries(emps.filter((e) => e.personaKey).map((e) => [e.personaKey!, { id: e.id, status: e.status, portraitUrl: e.portraitUrl, portraitProvenance: e.portraitProvenance, intro: e.intro }]));
  const custom = emps.filter((e) => !e.personaKey && e.status !== "retired").map((e) => ({ id: e.id, firstName: e.firstName, title: e.title, team: e.team, intro: e.intro, portraitUrl: e.portraitUrl, portraitProvenance: e.portraitProvenance, status: e.status, skills: e.skills }));
  return (
    <Showroom orgName={ctx.orgName} canWrite={can(ctx.role, "agents:write")} userName={ctx.email ?? "You"}
      personas={PERSONAS.map((p) => ({ key: p.key, firstName: p.firstName, title: p.title, team: p.team, intro: p.intro, responsibilities: p.responsibilities, expertise: p.expertise, skills: p.skills, portrait: p.portrait, demoSkill: p.demoSkill }))}
      teams={Object.entries(TEAMS).map(([key, t]) => ({ key, label: t.label }))} existing={byKey} custom={custom}
      recs={recs.map((r) => ({ ...r, tree: r.tree }))} skillNames={Object.fromEntries((skills ?? []).map((s) => [s.key, s.name]))} skillsAvailable={!!skills}
      workweeks={fin.assumptions.workWeeksPerYear} />
  );
}
