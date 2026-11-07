import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { requireConsultant, getConsultant } from "./_lib";
import { enforceMfaEnrollment } from "@/lib/session";
import { canSeeReadiness } from "@/engine/readiness/access";
import { AdminShell } from "@/components/admin/admin-shell";
import { TimeZoneProvider } from "@/components/time-zone";
export const dynamic = "force-dynamic";
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // /admin/readiness: platform owner / consultancy owner only — everyone else gets a 404, not a redirect.
  // (The page re-checks; layouts render in parallel with pages and are not the security boundary.)
  const path = (await headers()).get("x-bb-path") ?? "";
  if (path === "/admin/readiness" || path.startsWith("/admin/readiness/")) {
    const c = await getConsultant();
    if (!c || !canSeeReadiness({ email: c.ctx.email, consultancyRole: c.consultancy.role })) notFound();
  }
  const { ctx, consultancy } = await requireConsultant();
  await enforceMfaEnrollment(ctx);
  return <TimeZoneProvider timeZone={consultancy.timezone}><AdminShell email={ctx.email} role={consultancy.role} consultancyName={consultancy.name} primaryColor={consultancy.branding.primaryColor}>{children}</AdminShell></TimeZoneProvider>;
}
