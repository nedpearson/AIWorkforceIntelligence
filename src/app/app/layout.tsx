import { requireCtx, listUserOrgs, enforceMfaEnrollment } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { TimeZoneProvider } from "@/components/time-zone";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  await enforceMfaEnrollment(ctx);
  const orgs = await listUserOrgs(ctx.userId);
  const [org] = await db.select({ isDemo: schema.organizations.isDemo, branding: schema.organizations.branding, timezone: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1);
  return <TimeZoneProvider timeZone={org?.timezone}><AppShell ctx={ctx} orgs={orgs} isDemo={!!org?.isDemo} branding={org?.branding ?? {}}>{children}</AppShell></TimeZoneProvider>;
}
