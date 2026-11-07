import { requireCtx } from "@/lib/session";
import { computeRiskRegister } from "@/engine/risk";
import { RiskClient } from "./risk-client";

export const metadata = { title: "Risk & Compliance" };
export const dynamic = "force-dynamic";

export default async function RiskPage({ searchParams }: { searchParams: Promise<{ risk?: string }> }) {
  const ctx = await requireCtx("workflows:read");
  const sp = await searchParams;
  const reg = await computeRiskRegister(ctx.orgId);
  return <RiskClient reg={reg} severity={sp.risk ?? ""} />;
}
