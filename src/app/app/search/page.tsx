import Link from "next/link";
import { and, eq, ilike, or } from "drizzle-orm";
import { Search as SearchIcon, Network, Users, Building2, Lightbulb, Bot } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { can } from "@/lib/rbac";
import { Badge, PageHeader } from "@/components/ui";
import { OPP_STATUS_TONE } from "@/components/dashboard/opportunity-card";
import { fmtNum } from "@/lib/utils";

export const metadata = { title: "Search" };
export const dynamic = "force-dynamic";

type Hit = { id: string; title: string; subtitle: string; href: string; badge?: { text: string; tone?: "neutral" | "brand" | "money" | "warn" | "danger" | "info" | "verified" | "projected" } };
type Group = { key: string; label: string; icon: React.ComponentType<{ size?: number; className?: string }>; hits: Hit[] };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireCtx();
  const q = ((await searchParams).q ?? "").trim().slice(0, 100);
  const like = `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
  const groups: Group[] = [];
  if (q.length >= 2) {
    const r = await withTenant(ctx.orgId, async (tx) => {
      const canWf = can(ctx.role, "workflows:read"), canEmp = can(ctx.role, "employees:read"), canOpp = can(ctx.role, "opportunities:read"), canAg = can(ctx.role, "agents:read");
      const [workflows, employees, departments, opportunities, agents] = await Promise.all([
        canWf ? tx.select({ id: schema.workflows.id, name: schema.workflows.name, hours: schema.workflows.hoursPerWeek, dept: schema.departments.name, automation: schema.workflows.automationScore }).from(schema.workflows).leftJoin(schema.departments, eq(schema.departments.id, schema.workflows.departmentId)).where(and(eq(schema.workflows.orgId, ctx.orgId), or(ilike(schema.workflows.name, like), ilike(schema.workflows.description, like)))).limit(20) : [],
        canEmp ? tx.select({ id: schema.employees.id, name: schema.employees.displayName, title: schema.employees.title, dept: schema.departments.name }).from(schema.employees).leftJoin(schema.departments, eq(schema.departments.id, schema.employees.departmentId)).where(and(eq(schema.employees.orgId, ctx.orgId), eq(schema.employees.isActive, true), or(ilike(schema.employees.displayName, like), ilike(schema.employees.title, like), ilike(schema.employees.email, like)))).limit(20) : [],
        canWf ? tx.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments).where(and(eq(schema.departments.orgId, ctx.orgId), ilike(schema.departments.name, like))).limit(20) : [],
        canOpp ? tx.select({ id: schema.opportunities.id, title: schema.opportunities.title, status: schema.opportunities.status, type: schema.opportunities.type, realizable: schema.opportunities.realizableAnnualSavings }).from(schema.opportunities).where(and(eq(schema.opportunities.orgId, ctx.orgId), or(ilike(schema.opportunities.title, like), ilike(schema.opportunities.summary, like)))).limit(20) : [],
        canAg ? tx.select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, category: schema.agents.category }).from(schema.agents).where(and(eq(schema.agents.orgId, ctx.orgId), or(ilike(schema.agents.name, like), ilike(schema.agents.category, like)))).limit(20) : [],
      ]);
      return { workflows, employees, departments, opportunities, agents };
    });
    groups.push(
      { key: "workflows", label: "Workflows", icon: Network, hits: r.workflows.map((w) => ({ id: w.id, title: w.name, subtitle: `${w.dept ?? "—"} · ${fmtNum(Number(w.hours), 1)} hrs/wk · automation ${Math.round(Number(w.automation))}`, href: `/app/workflows/${w.id}` })) },
      { key: "employees", label: "People", icon: Users, hits: r.employees.map((e) => ({ id: e.id, title: e.name, subtitle: `${e.title ?? "—"} · ${e.dept ?? "—"}`, href: `/app/employees/${e.id}` })) },
      { key: "departments", label: "Departments", icon: Building2, hits: r.departments.map((d) => ({ id: d.id, title: d.name, subtitle: "Department", href: `/app/departments/${d.id}` })) },
      { key: "opportunities", label: "Opportunities", icon: Lightbulb, hits: r.opportunities.map((o) => ({ id: o.id, title: o.title, subtitle: `${o.type.replace(/_/g, " ")} · realizable $${fmtNum(Number(o.realizable))}/yr`, href: `/app/opportunities/${o.id}`, badge: { text: o.status.replace("_", " "), tone: OPP_STATUS_TONE[o.status] } })) },
      { key: "agents", label: "AI Agents", icon: Bot, hits: r.agents.map((a) => ({ id: a.id, title: a.name, subtitle: a.category.replace(/_/g, " "), href: `/app/agents/${a.id}`, badge: { text: a.status, tone: a.status === "deployed" ? "money" : "neutral" } })) },
    );
  }
  const total = groups.reduce((s, g) => s + g.hits.length, 0);
  return (
    <div className="space-y-6" data-testid="search-page">
      <PageHeader title="Search" subtitle="Find a workflow, person, department, opportunity or agent." />
      <form method="get" action="/app/search" className="relative max-w-xl" data-testid="search-form">
        <SearchIcon size={16} className="pointer-events-none absolute left-3 top-3 text-ink-3" />
        <input name="q" defaultValue={q} autoFocus placeholder="e.g. invoice, Priya, Finance, ticket reply…" aria-label="Search" data-testid="search-input" className="h-10 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20" />
      </form>
      {q.length > 0 && q.length < 2 && <p className="text-xs text-ink-3">Type at least 2 characters.</p>}
      {q.length >= 2 && total === 0 && <div className="card p-6 text-center text-sm"><p className="font-medium">No results for &ldquo;{q}&rdquo;</p><p className="mt-1 text-xs text-ink-2">Try a shorter word, an app name (e.g. &ldquo;QuickBooks&rdquo;) or a person&apos;s first name.</p></div>}
      {q.length >= 2 && total > 0 && (
        <div className="space-y-4" data-testid="search-results">
          <p className="text-xs text-ink-3">{total} result{total === 1 ? "" : "s"} for &ldquo;{q}&rdquo;</p>
          {groups.filter((g) => g.hits.length).map((g) => (
            <section key={g.key} className="card p-0" data-testid={`search-group-${g.key}`}>
              <h2 className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-2"><g.icon size={14} />{g.label} <span className="font-normal text-ink-3">({g.hits.length})</span></h2>
              <ul className="divide-y divide-border">{g.hits.map((h) => (
                <li key={h.id}><Link href={h.href} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface-2" data-testid={`search-hit-${h.id}`}><span className="min-w-0"><span className="block truncate text-sm font-medium text-ink">{h.title}</span><span className="block truncate text-xs text-ink-2">{h.subtitle}</span></span>{h.badge && <Badge tone={h.badge.tone ?? "neutral"}>{h.badge.text}</Badge>}</Link></li>
              ))}</ul>
            </section>
          ))}
        </div>
      )}
      {!q && <p className="text-xs text-ink-3">Tip: you can link straight to a search with <code className="rounded bg-surface-2 px-1">/app/search?q=invoice</code>.</p>}
    </div>
  );
}
