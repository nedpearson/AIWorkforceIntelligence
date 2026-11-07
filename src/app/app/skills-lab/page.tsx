import { and, desc, eq, ne } from "drizzle-orm";
import { FlaskConical } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { skillCatalog } from "@/engine/skills";
import { Button, Empty, PageHeader } from "@/components/ui";
import { SkillRunnerPanel } from "@/components/skills";
import { createLabEmployee } from "./actions";

export const metadata = { title: "Skills Lab" };
export const dynamic = "force-dynamic";

/** Internal, owner-only preview of the skills engine (not in navigation). */
export default async function SkillsLabPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("agents:read");
  if (ctx.role !== "owner") return <Empty title="Skills Lab is owner-only" body="This internal preview page is limited to organization owners." />;
  const sp = await searchParams;
  const emps = await withTenant(ctx.orgId, (tx) => tx.select().from(schema.aiEmployees).where(and(eq(schema.aiEmployees.orgId, ctx.orgId), ne(schema.aiEmployees.status, "retired"))).orderBy(desc(schema.aiEmployees.createdAt)).limit(100));
  const emp = emps.find((e) => e.id === sp.emp) ?? emps[0];
  const header = <PageHeader hero eyebrow="Internal preview" icon={<FlaskConical className="h-5 w-5" aria-hidden />} title="Skills Lab" subtitle="Run any AI-employee skill on synthetic samples (or live data, when permitted) and inspect each timed step, the citations used and the savings math." />;
  if (!emp) return (<>{header}<Empty title="No AI employees yet" body="Create a sandbox-only, read-only test agent to preview skills on synthetic samples. Hire real AI employees from the AI Workforce module." action={<form action={createLabEmployee}><Button type="submit" data-testid="skills-lab-create">Create Skills Lab test agent</Button></form>} /></>);
  const skills = skillCatalog(sp.all === "1" || !emp.skills.length ? undefined : emp.skills);
  const live = can(ctx.role, "agents:write") && ["pilot", "active"].includes(emp.status);
  return (
    <>
      {header}
      {emps.length > 1 && (
        <form className="mb-4 flex flex-wrap items-end gap-2" data-testid="skills-lab-emp-form">
          <label className="text-xs text-ink-2">AI employee
            <select name="emp" defaultValue={emp.id} className="mt-1 block h-9 rounded-lg border border-border bg-surface px-3 text-sm text-ink" data-testid="skills-lab-emp">
              {emps.map((e) => <option key={e.id} value={e.id}>{e.firstName} — {e.title} (AI agent · {e.status})</option>)}
            </select>
          </label>
          <Button type="submit" variant="secondary" size="sm">Switch</Button>
        </form>
      )}
      <SkillRunnerPanel key={emp.id} aiEmployeeId={emp.id} employeeName={emp.firstName} skills={skills} defaultSkill={sp.skill ?? "process_invoice"}
        canRunLive={live} liveDisabledReason={!["pilot", "active"].includes(emp.status) ? `${emp.firstName} is in ${emp.status} status — live runs need pilot or active.` : undefined}
        canApprove={can(ctx.role, "agents:approve")} canApproveElevated={["owner", "admin"].includes(ctx.role)} canReview={can(ctx.role, "agents:approve")} permissionLevel={emp.permissionLevel} />
    </>
  );
}
