/**
 * Process-mining provider catalog for the Process Mining page.
 * Power Automate / UiPath / Mimica status comes from src/engine/adapters/process-mining.ts (processMiningStatuses()).
 * Celonis has no adapter yet — its status is declared here, honestly: not built, license required.
 */
export type ProviderCard = { key: string; name: string; product: string; status: "license_required" | "not_configured" | "configured" | "not_built"; requirement: string; envVars: string[]; docsUrl: string; built: boolean };

export const CELONIS_PROVIDER: ProviderCard = {
  key: "celonis",
  name: "Celonis",
  product: "Celonis Process Intelligence (EMS)",
  status: "not_built",
  requirement: "The documented Celonis Intelligence API and Data Integration API require a Celonis EMS license, a team URL and an application/API key with access to the relevant data pool and knowledge model. No BridgeBox connector has been built for Celonis yet — nothing on this page comes from Celonis.",
  envVars: ["CELONIS_TEAM_URL", "CELONIS_API_KEY"],
  docsUrl: "https://docs.celonis.com/en/celonis-apis.html",
  built: false,
};

export const PROVIDER_LABELS: Record<string, { name: string; product: string }> = {
  power_automate: { name: "Microsoft", product: "Power Automate Process Mining" },
  uipath: { name: "UiPath", product: "UiPath Process Mining / Task Mining" },
  mimica: { name: "Mimica", product: "Mimica Mapper" },
};
