import { requireConsultant, listClients } from "./_lib";
import { clientSummary } from "./_data";
import { Portfolio } from "@/components/admin/portfolio";

export const metadata = { title: "Clients — Consulting Portal" };
export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const { consultancy } = await requireConsultant();
  const clients = await listClients(consultancy.id);
  const rows = await Promise.all(clients.map((c) => clientSummary(c)));
  return <Portfolio rows={rows} consultancyName={consultancy.name} />;
}
