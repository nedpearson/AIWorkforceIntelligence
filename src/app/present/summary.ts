import type { ExecutiveModel, SlideSpec } from "@/engine/exports";

export type DeckSummary = { realizable: number; net: number; roi1y: number; paybackMonths: number | null; hoursPerWeek: number; repetitiveShareAutomated: number | null; npv5y: number };
export type DeckState = { slides: SlideSpec[]; overrides: ExecutiveModel["overrides"]; summary: DeckSummary; computedAt: string };

export function deckSummary(m: ExecutiveModel): DeckSummary {
  const f = m.fin;
  return { realizable: f.realizableAnnualSavings, net: f.netAnnualSavings, roi1y: f.roi1y, paybackMonths: f.paybackMonths, hoursPerWeek: f.hoursRecoverablePerWeek, repetitiveShareAutomated: f.repetitiveHoursPerWeek > 0 ? f.hoursRecoverablePerWeek / f.repetitiveHoursPerWeek : null, npv5y: m.fiveYear.npv };
}
