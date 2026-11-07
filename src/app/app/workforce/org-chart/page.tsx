import { requireCtx } from "@/lib/session";
import { orgChart } from "@/engine/workforce";
import { OrgChartView } from "./org-chart";

export const metadata = { title: "AI + Human Org Chart" };
export const dynamic = "force-dynamic";

export default async function OrgChartPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("employees:read");
  const sp = await searchParams;
  const mode = sp.mode === "proposed" ? "proposed" : "current";
  const [chart, all] = await Promise.all([orgChart(ctx.orgId, { dept: sp.dept, loc: sp.loc, mode }), orgChart(ctx.orgId, { mode: "current" })]);
  return <OrgChartView chart={JSON.parse(JSON.stringify(chart))} deptOptions={all.departments.filter((d) => d.id).map((d) => ({ value: d.id!, label: d.name }))} locOptions={all.locations.map((l) => ({ value: l.id, label: l.name }))} />;
}
