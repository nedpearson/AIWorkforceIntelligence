import { requireCtx } from "@/lib/session";
import { computeOrgProcessMining } from "@/engine/process-mining-org";
import { processMiningStatuses } from "@/engine/adapters/process-mining";
import { CELONIS_PROVIDER, PROVIDER_LABELS, type ProviderCard } from "@/components/process/providers";
import { idParam } from "@/components/process/params";
import { ProcessMiningClient } from "./process-mining-client";

export const metadata = { title: "Process Mining" };
export const dynamic = "force-dynamic";

export default async function ProcessMiningPage({ searchParams }: { searchParams: Promise<{ bu?: string; dept?: string; loc?: string; wf?: string }> }) {
  const ctx = await requireCtx("workflows:read");
  const sp = await searchParams;
  const pm = await computeOrgProcessMining(ctx.orgId, { bu: idParam(sp.bu), dept: idParam(sp.dept), loc: idParam(sp.loc), wf: idParam(sp.wf) });
  // Adapter statuses are evaluated server-side (they read env presence only — never values).
  const providers: ProviderCard[] = [
    ...processMiningStatuses().map((s) => ({ key: s.provider, name: PROVIDER_LABELS[s.provider]?.name ?? s.provider, product: PROVIDER_LABELS[s.provider]?.product ?? s.provider, status: s.status, requirement: s.requirement, envVars: s.envVars, docsUrl: s.docsUrl, built: true })),
    CELONIS_PROVIDER,
  ];
  return <ProcessMiningClient pm={pm} providers={providers} />;
}
