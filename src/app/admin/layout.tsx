import { requireConsultant } from "./_lib";
import { AdminShell } from "@/components/admin/admin-shell";
import { TimeZoneProvider } from "@/components/time-zone";
export const dynamic = "force-dynamic";
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { ctx, consultancy } = await requireConsultant();
  return <TimeZoneProvider timeZone={consultancy.timezone}><AdminShell email={ctx.email} role={consultancy.role} consultancyName={consultancy.name} primaryColor={consultancy.branding.primaryColor}>{children}</AdminShell></TimeZoneProvider>;
}
