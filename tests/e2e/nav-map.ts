/**
 * Client-app sidebar (src/components/app-shell.tsx NAV_GROUPS) → URL + the page's h1, and which seeded role sees it.
 * Kept as a static copy on purpose: nav.spec.ts asserts the rendered sidebar equals this list, so drift in either
 * direction fails loudly instead of silently shrinking the crawl.
 */
import type { Role } from "./fixtures";

export type NavEntry = { testid: string; path: string; h1: string; group: string; roles: Role[] };

const ALL: Role[] = ["owner", "manager", "consultant"];
const ADMINS: Role[] = ["owner", "consultant"];

export const APP_NAV: NavEntry[] = [
  { group: "Command", testid: "nav-executive", path: "/app", h1: "Enterprise Transformation Command Center", roles: ALL },
  { group: "Command", testid: "nav-business", path: "/app/business", h1: "Business Intelligence", roles: ALL },
  { group: "Command", testid: "nav-evaluation", path: "/app/evaluation", h1: "Company Transformation Score", roles: ALL },
  { group: "Intelligence", testid: "nav-employees", path: "/app/employees", h1: "People", roles: ALL },
  { group: "Intelligence", testid: "nav-departments", path: "/app/departments", h1: "Departments", roles: ALL },
  { group: "Intelligence", testid: "nav-process-mining", path: "/app/process-mining", h1: "Process Mining", roles: ALL },
  { group: "Intelligence", testid: "nav-workflows", path: "/app/workflows", h1: "Workflows", roles: ALL },
  { group: "Intelligence", testid: "nav-benchmarking", path: "/app/benchmarking", h1: "How each part of the business compares", roles: ALL },
  { group: "Automation", testid: "nav-opportunities", path: "/app/opportunities", h1: "Opportunities", roles: ALL },
  { group: "Automation", testid: "nav-agents", path: "/app/agents", h1: "AI Agent Command Center", roles: ALL },
  { group: "Automation", testid: "nav-automation", path: "/app/automation", h1: "Automation Studio", roles: ALL },
  { group: "Finance & Proof", testid: "nav-finance", path: "/app/finance", h1: "Financial Model", roles: ALL },
  { group: "Finance & Proof", testid: "nav-savings", path: "/app/savings", h1: "Every dollar, traced.", roles: ALL },
  { group: "Finance & Proof", testid: "nav-reports", path: "/app/reports", h1: "Reports", roles: ALL },
  { group: "Transformation", testid: "nav-roadmap", path: "/app/roadmap", h1: "Transformation Roadmap", roles: ALL },
  { group: "Transformation", testid: "nav-transformation", path: "/app/transformation", h1: "Organizational Transformation", roles: ALL },
  { group: "Transformation", testid: "nav-risk", path: "/app/risk", h1: "Risk & compliance register", roles: ALL },
  { group: "Transformation", testid: "nav-assistant", path: "/app/assistant", h1: "Ask BridgeBox", roles: ALL },
  { group: "Administration", testid: "nav-admin", path: "/admin", h1: "Client portfolio", roles: ["consultant"] },
  { group: "Administration", testid: "nav-structure", path: "/app/settings/structure", h1: "Settings", roles: ADMINS },
  { group: "Administration", testid: "nav-members", path: "/app/settings/members", h1: "Settings", roles: ADMINS },
  { group: "Administration", testid: "nav-integrations", path: "/app/integrations", h1: "Integrations Marketplace", roles: ADMINS },
  { group: "Administration", testid: "nav-collection", path: "/app/collection", h1: "Data Collection", roles: ADMINS },
  { group: "Administration", testid: "nav-audit", path: "/app/settings/audit", h1: "Settings", roles: ADMINS },
  { group: "Administration", testid: "nav-billing", path: "/app/billing", h1: "Subscription & Billing", roles: ADMINS },
  { group: "Administration", testid: "nav-settings", path: "/app/settings", h1: "Settings", roles: ADMINS },
  { group: "Administration", testid: "nav-trust", path: "/app/trust", h1: "Trust & Privacy", roles: ALL },
];

export const navFor = (role: Role) => APP_NAV.filter((n) => n.roles.includes(role));
export const EXEC_H1 = "Enterprise Transformation Command Center";

/**
 * Console output that is not an application error. Each entry is documented; everything else fails a test.
 *  - favicon: the app ships no /favicon.ico; Chromium logs the 404.
 *  - "Failed to load resource … 404": only accepted for the favicon (kept narrow on purpose).
 */
export const BENIGN_CONSOLE: RegExp[] = [/favicon\.ico/];
