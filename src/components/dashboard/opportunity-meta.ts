/**
 * Opportunity labels / tones shared by server and client components. Lives outside opportunity-card.tsx because that file is
 * "use client": a server component importing a plain object from it receives a client-reference proxy, not the object
 * (Object.entries(OPP_TYPE_LABEL) was [] on the server → the Type filter on /app/opportunities had no options).
 */
export const OPP_TYPE_LABEL: Record<string, string> = { ai_agent: "AI agent", rpa: "RPA bot", conventional_automation: "Integration", process_change: "Process change", role_consolidation: "Consolidation" };
export const OPP_STATUS_TONE: Record<string, "neutral" | "brand" | "money" | "warn" | "danger" | "info" | "verified" | "projected" | "purple"> = { identified: "neutral", reviewing: "info", approved: "brand", in_progress: "warn", deployed: "money", verified: "verified", rejected: "danger", postponed: "warn", analysis_requested: "purple" };
/** Chart / chip hue per opportunity type (purple = AI, cyan = automation, royal = integration, indigo = process). */
export const OPP_TYPE_ACCENT: Record<string, "purple" | "cyan" | "royal" | "indigo" | "emerald"> = { ai_agent: "purple", rpa: "cyan", conventional_automation: "royal", process_change: "indigo", role_consolidation: "emerald" };
