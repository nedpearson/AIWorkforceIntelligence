import { requireCtx, listUserOrgs } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  const orgs = await listUserOrgs(ctx.userId);
  const [org] = await db.select({ isDemo: schema.organizations.isDemo, branding: schema.organizations.branding }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1);
  return <AppShell ctx={ctx} orgs={orgs} isDemo={!!org?.isDemo} branding={org?.branding ?? {}}>{children}</AppShell>;
}
