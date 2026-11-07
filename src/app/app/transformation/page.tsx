import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { computeCapacity } from "@/engine/capacity";
import { TransformationClient } from "./transformation-client";

export const metadata = { title: "Organizational Transformation" };
export const dynamic = "force-dynamic";

export default async function TransformationPage() {
  const ctx = await requireCtx("finance:read");
  const cap = await computeCapacity(ctx.orgId);
  return <TransformationClient cap={cap} canSubmit={can(ctx.role, "finance:write")} />;
}
