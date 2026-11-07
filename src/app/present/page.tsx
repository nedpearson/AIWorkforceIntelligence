import { requireCtx } from "@/lib/session";
import { buildDeckSlides, computeExecutiveModel, sanitizeOverrides } from "@/engine/exports";
import { PresentDeck } from "./deck";
import { deckSummary } from "./summary";

export const metadata = { title: "Presentation Mode" };
export const dynamic = "force-dynamic";

/** Full-screen boardroom deck, rendered from live data outside the app shell. */
export default async function PresentPage({ searchParams }: { searchParams: Promise<{ scenario?: string; slide?: string }> }) {
  const ctx = await requireCtx("finance:read");
  const sp = await searchParams;
  const model = await computeExecutiveModel(ctx.orgId, sanitizeOverrides({ scenario: sp.scenario }));
  const start = Math.min(12, Math.max(1, Number(sp.slide) || 1)) - 1;
  return (
    <PresentDeck initial={{ slides: buildDeckSlides(model), overrides: model.overrides, summary: deckSummary(model), computedAt: model.computedAt }} startIndex={start}
      org={{ name: model.org.name, isDemo: model.org.isDemo, reportName: model.org.branding.reportName ?? null, primaryColor: model.org.branding.primaryColor ?? null }} />
  );
}
