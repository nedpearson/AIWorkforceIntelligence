/**
 * Guided tours — declarative definitions (pure; safe to import from client components).
 * Each step highlights a REAL element by data-testid. Missing targets are skipped by the tour host (logged), never faked.
 * Persistence lives in src/engine/tours-store.ts (tour_progress).
 */
export type TourStep = { target: string; title: string; body: string; route?: string; placement?: "auto" | "top" | "bottom" };
export type TourDef = { key: TourKey; title: string; description: string; steps: TourStep[] };
export type TourKey = "first-run" | "meet-ai-team" | "brain" | "savings";

export const TOURS: Record<TourKey, TourDef> = {
  "first-run": { key: "first-run", title: "Welcome tour", description: "Two minutes: where your numbers come from and where to go next.", steps: [
    { route: "/app", target: "home-band", title: "Five places to start", body: "Every card shows a live number from your own data. Start with whichever question matters most to you today." },
    { route: "/app", target: "cmd-primary", title: "Your headline numbers", body: "Labor analyzed, the automation opportunity, projected net savings and what has actually been verified. Click any number to see exactly how it was calculated." },
    { route: "/app", target: "cmd-waterfall", title: "From potential to proven", body: "The savings waterfall keeps projected value (gold) separate from verified, measured savings (green). Only approved ledger entries count as hard savings." },
    { route: "/app", target: "cmd-recommendations", title: "Your best opportunity", body: "Opportunities are ranked by realizable value, feasibility and risk. Each links to the workflow evidence it was built from." },
    { route: "/app", target: "entry-team", title: "Meet your AI team", body: "The Experience Center introduces the AI agents that could take on this work. They are AI — clearly labelled — and start read-only." },
  ] },
  "meet-ai-team": { key: "meet-ai-team", title: "Meet your AI team", description: "See the AI agents, open a profile and watch a demonstration.", steps: [
    { route: "/app/experience", target: "xp-hero", title: "The Experience Center", body: "Every AI employee here is an AI agent with an explicit badge — never a real person." },
    { route: "/app/experience", target: "xp-mosaic", title: "AI teams", body: "Agents are grouped by team: finance, sales, operations and more. Pick one to see what it does." },
    { route: "/app/experience", target: "xp-persona-charlotte", title: "An AI employee profile", body: "Responsibilities, skills and the permission level it starts with (read-only by default)." },
    { route: "/app/experience", target: "xp-stage", title: "Watch a demonstration", body: "Demos run on a clearly labelled synthetic sample, step by step, so nothing touches your real data." },
  ] },
  brain: { key: "brain", title: "AI Brain tour", description: "Teach the AI your company: upload, review, ask.", steps: [
    { route: "/app/brain", target: "brain-health", title: "Your company's memory", body: "Coverage by category shows what the AI knows — and which topics are still missing." },
    { route: "/app/brain?tab=library", target: "brain-upload", title: "Add knowledge", body: "Drop in policies, price sheets and procedures (Word, PDF, CSV, text). Nothing is used until a manager approves it." },
    { route: "/app/brain?tab=review", target: "brain-review", title: "Review before it's known", body: "New documents and facts wait here. Approve, reject, or correct — every decision is audited." },
    { route: "/app/brain?tab=ask", target: "brain-ask-input", title: "Ask the Brain", body: "Ask a question and see the answer with numbered citations to the exact approved passages it used." },
  ] },
  savings: { key: "savings", title: "Savings tour", description: "How BridgeBox separates projected value from money actually saved.", steps: [
    { route: "/app/savings", target: "tier-cards", title: "Seven savings tiers", body: "From potential (estimated) to realized hard savings (approved, evidenced). Each tier is clickable to its calculation." },
    { route: "/app/savings", target: "ledger-filters", title: "The savings ledger", body: "Every claimed saving is a ledger entry with evidence, submitted and approved by different people." },
    { route: "/app/savings", target: "reconciliation", title: "Reconciliation checks", body: "Automatic checks catch double counting, expired claims and savings without evidence." },
  ] },
};
export const TOUR_KEYS = Object.keys(TOURS) as TourKey[];
export const isTourKey = (k: unknown): k is TourKey => typeof k === "string" && (TOUR_KEYS as string[]).includes(k);

export type TourProgress = { tourKey: TourKey; step: number; completedAt: string | null; updatedAt: string };

/** Pure: next step index to resume at (clamped), or null when the tour is complete. */
export function resumeStep(tour: TourDef, p: Pick<TourProgress, "step" | "completedAt"> | null | undefined): number | null {
  if (!p) return 0;
  if (p.completedAt) return null;
  return Math.max(0, Math.min(tour.steps.length - 1, p.step));
}
/** Pure: whether the first-run tour should auto-start for this user. */
export const shouldAutoStart = (progress: TourProgress[]) => !progress.some((p) => p.tourKey === "first-run");
