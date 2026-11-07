import { desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { requireConsultant, listClients } from "../_lib";
import { PageHeader } from "@/components/ui";
import { ReportList, type ReportRow } from "@/components/admin/client-tabs-2";

export const metadata = { title: "Reports — Consulting Portal" };
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const { consultancy } = await requireConsultant();
  const clients = await listClients(consultancy.id);
  const rows: ReportRow[] = [];
  for (const c of clients) {
    const rs = await withTenant(c.id, (tx) => tx.select({ id: schema.reports.id, kind: schema.reports.kind, title: schema.reports.title, periodStart: schema.reports.periodStart, periodEnd: schema.reports.periodEnd, createdAt: schema.reports.createdAt, hasPdf: sql<boolean>`${schema.reports.pdfBytes} is not null` }).from(schema.reports).where(eq(schema.reports.orgId, c.id)).orderBy(desc(schema.reports.createdAt)).limit(50));
    for (const r of rs) rows.push({ id: r.id, kind: r.kind, title: r.title, periodStart: r.periodStart?.toISOString() ?? null, periodEnd: r.periodEnd?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), hasPdf: !!r.hasPdf, clientId: c.id, clientName: c.name });
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div data-testid="reports-page">
      <PageHeader title="Reports" subtitle="Every generated PDF across all clients. Generate new ones from a client's Reports tab." />
      <ReportList reports={rows} showClient />
    </div>
  );
}
