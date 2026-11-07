import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { computeOrgFinancials } from "@/engine/finance";
import { computeBusinessIntel } from "@/engine/business-intel";
import { idParam, parseDateRange } from "@/components/process/params";
import { BusinessClient } from "./business-client";

export const metadata = { title: "Business Intelligence" };
export const dynamic = "force-dynamic";

type SP = { bu?: string; dept?: string; loc?: string; from?: string; to?: string };

export default async function BusinessPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireCtx("workflows:read");
  const sp = await searchParams;
  const range = parseDateRange(sp.from, sp.to);
  const fin = await computeOrgFinancials(ctx.orgId);
  const bi = await computeBusinessIntel(ctx.orgId, { bu: idParam(sp.bu), dept: idParam(sp.dept), loc: idParam(sp.loc), from: range.from, to: range.to }, { fin, showEmployeeCosts: can(ctx.role, "employees:cost:read") });
  return <BusinessClient bi={bi} canManageStructure={can(ctx.role, "org:manage")} />;
}
