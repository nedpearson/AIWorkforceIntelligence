import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { num, fmtUSD } from "@/lib/utils";
import { requireConsultant, listClients } from "../_lib";
import { Badge, Empty, PageHeader, Table, Th, Td, Button } from "@/components/ui";
import { formatDate } from "@/lib/datetime";

export const metadata = { title: "Projects — Consulting Portal" };
export const dynamic = "force-dynamic";
const projectTone = (s: string) => (s === "live" || s === "measuring" ? "money" : s === "in_progress" ? "info" : s === "closed" ? "neutral" : "brand") as "money" | "info" | "neutral" | "brand";

export default async function ProjectsPage() {
  const { consultancy } = await requireConsultant();
  const clients = await listClients(consultancy.id);
  const rows: { id: string; clientId: string; clientName: string; name: string; status: string; opps: number; agents: number; budget: number | null; spent: number; start: string | null; target: string | null }[] = [];
  for (const c of clients) {
    const ps = await withTenant(c.id, (tx) => tx.select().from(schema.projects).where(eq(schema.projects.orgId, c.id)).orderBy(desc(schema.projects.updatedAt)));
    for (const p of ps) rows.push({ id: p.id, clientId: c.id, clientName: c.name, name: p.name, status: p.status, opps: (p.opportunityIds ?? []).length, agents: (p.agentIds ?? []).length, budget: p.budget != null ? num(p.budget) : null, spent: num(p.spent), start: p.startDate ? formatDate(p.startDate, consultancy.timezone) : null, target: p.targetDate ? formatDate(p.targetDate, consultancy.timezone) : null });
  }
  const budget = rows.reduce((s, r) => s + (r.budget ?? 0), 0), spent = rows.reduce((s, r) => s + r.spent, 0);
  return (
    <div data-testid="projects-page">
      <PageHeader title="Projects" subtitle={`${rows.length} project(s) across ${clients.length} client(s) · budget ${fmtUSD(budget)} · spent ${fmtUSD(spent)}`} />
      {!rows.length ? <Empty title="No projects yet" body="Create projects inside a client workspace (Projects tab)." action={<Button href="/admin">Go to clients</Button>} /> : (
        <Table><thead><tr><Th>Client</Th><Th>Project</Th><Th>Status</Th><Th>Links</Th><Th className="text-right">Budget</Th><Th className="text-right">Spent</Th><Th>Dates</Th></tr></thead><tbody>{rows.map((r) => (
          <tr key={r.id} data-testid={`project-row-${r.id}`}><Td className="text-xs"><Link className="text-brand hover:underline" href={`/admin/clients/${r.clientId}?tab=projects`}>{r.clientName}</Link></Td><Td className="font-medium">{r.name}</Td><Td><Badge tone={projectTone(r.status)}>{r.status.replace("_", " ")}</Badge></Td><Td className="text-xs text-ink-2">{r.opps} opp · {r.agents} agents</Td><Td className="text-right">{r.budget != null ? fmtUSD(r.budget) : "—"}</Td><Td className="text-right">{fmtUSD(r.spent)}</Td><Td className="text-xs">{r.start ?? "—"} → {r.target ?? "—"}</Td></tr>))}</tbody></Table>
      )}
    </div>
  );
}
