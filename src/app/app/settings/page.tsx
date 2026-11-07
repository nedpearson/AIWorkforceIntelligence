import { eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { DEFAULTS } from "@/engine/costing";
import { OrgForm } from "./org-form";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function OrgSettingsPage() {
  const ctx = await requireCtx("org:manage");
  const [org] = await withTenant(ctx.orgId, (tx) => tx.select().from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1));
  const s = org.settings ?? {}; const b = org.branding ?? {};
  return <OrgForm initial={{ name: org.name, industry: org.industry ?? "", timezone: org.timezone, currency: org.currency, retentionDays: org.retentionDays, workHoursPerWeek: s.workHoursPerWeek ?? DEFAULTS.workHoursPerWeek, workWeeksPerYear: s.workWeeksPerYear ?? DEFAULTS.workWeeksPerYear, benefitsLoadPct: s.benefitsLoadPct ?? DEFAULTS.benefitsLoadPct, branding: { reportName: b.reportName ?? "", primaryColor: b.primaryColor ?? "", footer: b.footer ?? "", logoUrl: b.logoUrl ?? "" } }} slug={org.slug} isDemo={org.isDemo} />;
}
