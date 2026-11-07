/**
 * Thin adapter over the skills engine (`@/engine/skills`, owned by the skills engineer).
 * Imported dynamically so the workforce module degrades gracefully ("Skills engine unavailable") when the engine
 * is missing or fails to load. Everything typed against src/engine/skills/contract.ts.
 */
import type { SkillsApi, SkillDefinition, SkillResult } from "@/engine/skills/contract";

let cached: Promise<SkillsApi | null> | null = null;
/** Flat per-run unit cost published by the skills engine (SKILL_RUN_UNIT_COST_USD), when present. */
let flatUnitCost: number | null = null;
export async function loadSkills(): Promise<SkillsApi | null> {
  if (!cached) {
    cached = (async () => {
      try {
        const m = (await import("@/engine/skills")) as unknown as Partial<SkillsApi> & { SKILL_RUN_UNIT_COST_USD?: number };
        if (typeof m.SKILL_RUN_UNIT_COST_USD === "number") flatUnitCost = m.SKILL_RUN_UNIT_COST_USD;
        if (!m || !Array.isArray(m.SKILLS) || typeof m.runSkill !== "function") return null;
        return m as SkillsApi;
      } catch { return null; }
    })();
    // retry on next call if unavailable (the engine may land while the dev server runs)
    void cached.then((v) => { if (!v) cached = null; });
  }
  return cached;
}

/** Plain-JSON skill summary for client components (zod schemas and functions are stripped). */
export type SkillInfo = { key: string; name: string; description: string; category: string; access: string; manualBaselineMinutes: number; requiresProviders: string[]; outputDescription: string; alwaysApproveSteps: string[]; unitCost: number | null; sampleShape?: string };
export function skillInfo(d: SkillDefinition): SkillInfo {
  const extra = d as SkillDefinition & { unitCost?: number; unitCostUsd?: number };
  const unit = typeof extra.unitCostUsd === "number" ? extra.unitCostUsd : typeof extra.unitCost === "number" ? extra.unitCost : flatUnitCost;
  return { key: d.key, name: d.name, description: d.description, category: d.category, access: d.access, manualBaselineMinutes: d.manualBaselineMinutes, requiresProviders: d.requiresProviders ?? [], outputDescription: d.outputDescription, alwaysApproveSteps: d.alwaysApproveSteps ?? [], unitCost: unit };
}
export async function listSkillInfo(): Promise<SkillInfo[] | null> {
  const api = await loadSkills(); if (!api) return null;
  return api.SKILLS.map((d) => ({ ...skillInfo(d), sampleShape: sampleShape(d) }));
}
/** Humanized fallback name when the engine is unavailable. */
export const skillLabel = (key: string, infos?: SkillInfo[] | null) => infos?.find((s) => s.key === key)?.name ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export type RunArgs = Parameters<SkillsApi["runSkill"]>[0];
export async function runSkillSafe(args: RunArgs): Promise<SkillResult | { ok: false; status: "unavailable"; summary: string; error: string }> {
  const api = await loadSkills();
  if (!api) return { ok: false, status: "unavailable", summary: "Skills engine unavailable.", error: "skills_engine_unavailable" };
  return api.runSkill(args);
}

/** JSON of the synthetic sample input, used only as a format hint for live task input (never submitted as live data). */
function sampleShape(d: SkillDefinition): string | undefined {
  try { const v = d.sampleInput(); const s = JSON.stringify(v, null, 2); return s.length > 4000 ? s.slice(0, 4000) : s; } catch { return undefined; }
}

/** Skill catalog (incl. synthetic samples) for the skills engine's SkillRunnerPanel; null when the engine is unavailable. */
export async function skillCatalogSafe(keys?: string[]): Promise<import("@/engine/skills").SkillMeta[] | null> {
  try { const m = await import("@/engine/skills"); return typeof m.skillCatalog === "function" ? m.skillCatalog(keys) : null; } catch { return null; }
}
