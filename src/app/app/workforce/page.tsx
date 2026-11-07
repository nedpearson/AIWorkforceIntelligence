import { eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { computeOrgFinancials } from "@/engine/finance";
import { listEmployees, directoryStats, recommendations, TEAMS } from "@/engine/workforce";
import { Directory } from "./directory";

export const metadata = { title: "AI Workforce" };
export const dynamic = "force-dynamic";

export default async function WorkforcePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("agents:read");
  const sp = await searchParams;
  const [emps, fin, depts] = await Promise.all([
    listEmployees(ctx.orgId), computeOrgFinancials(ctx.orgId),
    withTenant(ctx.orgId, (tx) => tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(eq(schema.departments.orgId, ctx.orgId))),
  ]);
  const { stats, kpis } = await directoryStats(ctx.orgId, emps, fin);
  const recs = emps.length ? [] : await recommendations(ctx.orgId, { fin });
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const filtered = emps.filter((e) => e.status !== "retired" || sp.status === "retired")
    .filter((e) => !sp.team || e.team === sp.team).filter((e) => !sp.status || e.status === sp.status).filter((e) => !sp.dept || e.departmentId === sp.dept);
  const cards = filtered.map((e) => ({
    id: e.id, firstName: e.firstName, title: e.title, team: e.team, status: e.status, permissionLevel: e.permissionLevel, portraitUrl: e.portraitUrl, portraitProvenance: e.portraitProvenance,
    expertise: e.expertise, departmentName: e.departmentId ? deptName.get(e.departmentId) ?? null : null, stats: stats[e.id],
  }));
  const teams = [...Object.entries(TEAMS).map(([key, t]) => ({ key, label: t.label })), { key: "custom", label: "Your Custom AI Team" }];
  return (
    <Directory cards={cards} total={emps.length} kpis={kpis} teams={teams} canWrite={can(ctx.role, "agents:write")}
      recommendedKeys={[...new Set(recs.map((r) => r.persona.key))]} recommendedNames={[...new Set(recs.map((r) => r.persona.firstName))]}
      filterDefs={[
        { key: "team", label: "Team", all: "All teams", options: teams.map((t) => ({ value: t.key, label: t.label })) },
        { key: "status", label: "Status", all: "All statuses", options: ["draft", "sandbox", "pilot", "active", "paused", "retired"].map((s) => ({ value: s, label: s })) },
        { key: "dept", label: "Department", options: depts.map((d) => ({ value: d.id, label: d.name })) },
      ]} />
  );
}
