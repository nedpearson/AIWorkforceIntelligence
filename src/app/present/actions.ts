"use server";
import { z } from "zod";
import { requireCtx } from "@/lib/session";
import { buildDeckSlides, computeExecutiveModel, sanitizeOverrides } from "@/engine/exports";
import { deckSummary, type DeckState } from "./summary";

const Input = z.object({
  scenario: z.enum(["conservative", "expected", "aggressive"]),
  automationPct: z.number().finite().optional(),
  adoptionRate: z.number().finite().optional(),
  realizationRate: z.number().finite().optional(),
});

/** Re-runs computeOrgFinancials + savings for the live scenario controls; every slide is rebuilt from that one model. */
export async function recomputeDeck(input: unknown): Promise<{ ok: true; state: DeckState } | { ok: false; error: string }> {
  const ctx = await requireCtx("finance:read");
  const p = Input.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid scenario controls" };
  const model = await computeExecutiveModel(ctx.orgId, sanitizeOverrides(p.data));
  return { ok: true, state: { slides: buildDeckSlides(model), overrides: model.overrides, summary: deckSummary(model), computedAt: model.computedAt } };
}
