import { requireConsultant } from "./_lib";
import { AdminShell } from "@/components/admin/admin-shell";
export const dynamic = "force-dynamic";
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { ctx, consultancy } = await requireConsultant();
  return <AdminShell email={ctx.email} role={consultancy.role} consultancyName={consultancy.name} primaryColor={consultancy.branding.primaryColor}>{children}</AdminShell>;
}
