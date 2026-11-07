import { desc, eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { num } from "@/lib/utils";
import { requireConsultant, listClients } from "../_lib";
import { PipelineView, type PipelineRow } from "@/components/admin/pipeline-view";

export const metadata = { title: "Pipeline — Consulting Portal" };
export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const { consultancy } = await requireConsultant();
  const clients = await listClients(consultancy.id);
  const rows: PipelineRow[] = [];
  for (const c of clients) {
    const opps = await withTenant(c.id, (tx) => tx.select({ o: schema.opportunities, dept: schema.departments.name }).from(schema.opportunities).leftJoin(schema.departments, eq(schema.departments.id, schema.opportunities.departmentId)).where(eq(schema.opportunities.orgId, c.id)).orderBy(desc(schema.opportunities.realizableAnnualSavings)));
    for (const { o, dept } of opps) rows.push({ id: o.id, clientId: c.id, clientName: c.name, rank: o.rank, title: o.title, summary: o.summary, type: o.type, status: o.status, department: dept, feasibility: num(o.feasibility), risk: num(o.risk), hours: num(o.hoursRecoverablePerWeek), gross: num(o.grossAnnualSavings), realizable: num(o.realizableAnnualSavings), impl: num(o.implementationCost), opex: num(o.annualOperatingCost), payback: o.paybackMonths != null ? num(o.paybackMonths) : null, basis: o.basis, agentId: o.agentId });
  }
  return <PipelineView rows={rows} clients={clients.map((c) => ({ id: c.id, name: c.name }))} />;
}
