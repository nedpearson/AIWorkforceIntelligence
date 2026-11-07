/**
 * BridgeBox AI Workforce Intelligence — database schema.
 *
 * Tenancy model:
 *  - `organizations` are tenants. kind = 'consultancy' (BridgeBox admin org) or 'client'.
 *  - A client org may have `parentOrgId` pointing at the consultancy that manages it.
 *  - Every tenant-scoped table carries `orgId`. Postgres RLS (see drizzle/rls.sql) enforces
 *    `org_id = current_setting('app.current_org')` for the application role, and the app layer
 *    additionally scopes every query through `withTenant()` (src/db/tenant.ts). Defence in depth.
 *
 * Evidence model:
 *  - Every analytical number is tagged with `basis`: 'observed' | 'estimated' | 'assumed'.
 */
import {
  pgTable, pgEnum, text, timestamp, integer, boolean, jsonb, uuid, numeric, index, uniqueIndex, bigint, primaryKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ---------- enums ----------
export const orgKind = pgEnum("org_kind", ["consultancy", "client"]);
export const roleEnum = pgEnum("member_role", ["owner", "admin", "manager", "employee", "consultant", "viewer"]);
export const basisEnum = pgEnum("basis", ["observed", "estimated", "assumed"]);
export const collectorStatus = pgEnum("collector_status", ["pending", "active", "paused", "revoked", "offline"]);
export const campaignStatus = pgEnum("campaign_status", ["draft", "scheduled", "running", "paused", "completed", "archived"]);
export const eventType = pgEnum("event_type", [
  "app_focus", "app_switch", "idle_start", "idle_end", "click_burst", "navigation", "data_entry",
  "copy_paste", "document_open", "document_save", "form_submit", "print", "email_compose", "handoff",
]);
export const opportunityType = pgEnum("opportunity_type", ["ai_agent", "rpa", "conventional_automation", "process_change", "role_consolidation"]);
export const opportunityStatus = pgEnum("opportunity_status", ["identified", "reviewing", "approved", "in_progress", "deployed", "verified", "rejected", "postponed", "analysis_requested"]);
export const agentStatus = pgEnum("agent_status", ["draft", "configured", "deployed", "paused", "retired", "error"]);
export const runStatus = pgEnum("run_status", ["queued", "running", "awaiting_approval", "succeeded", "failed", "rolled_back", "cancelled"]);
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected", "expired"]);
export const integrationProvider = pgEnum("integration_provider", ["n8n", "power_automate", "uipath", "mimica", "stripe", "oidc", "anthropic", "celonis", "uipath_process_mining", "microsoft_365", "google_workspace", "salesforce", "hubspot", "sap", "oracle", "netsuite", "workday", "adp", "quickbooks", "servicenow", "slack", "teams", "sharepoint", "zendesk", "scim"]);
export const integrationStatus = pgEnum("integration_status", ["not_configured", "configured", "connected", "error", "license_required"]);
export const subscriptionStatus = pgEnum("subscription_status", ["trialing", "active", "past_due", "canceled", "unpaid"]);
export const planEnum = pgEnum("plan", ["starter", "growth", "enterprise"]);
export const savingsTier = pgEnum("savings_tier", ["approved", "cost_avoidance", "realized_hard"]);
export const ledgerStatus = pgEnum("ledger_status", ["draft", "submitted", "approved", "rejected"]);
export const buKind = pgEnum("bu_kind", ["subsidiary", "division", "business_unit"]);
export const milestoneStatus = pgEnum("milestone_status", ["not_started", "in_progress", "blocked", "done"]);
export const projectStatus = pgEnum("project_status", ["proposed", "approved", "in_progress", "live", "measuring", "closed"]);

const ts = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const upd = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

// ---------- tenancy & identity ----------
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  kind: orgKind("kind").notNull().default("client"),
  parentOrgId: uuid("parent_org_id"),
  industry: text("industry"),
  timezone: text("timezone").notNull().default("America/Chicago"),
  currency: text("currency").notNull().default("USD"),
  branding: jsonb("branding").$type<{ logoUrl?: string; primaryColor?: string; reportName?: string; footer?: string }>().default({}),
  settings: jsonb("settings").$type<OrgSettings>().default({}),
  retentionDays: integer("retention_days").notNull().default(180),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: ts(), updatedAt: upd(),
});
export type OrgSettings = {
  benefitsLoadPct?: number; // loaded cost multiplier on base pay, default 0.30
  workHoursPerWeek?: number; // default 40
  workWeeksPerYear?: number; // default 48
  adoptionRate?: number; // 0..1 default 0.75
  realizationRate?: number; // share of recovered hours that becomes realizable $ (default 0.6)
  idleThresholdSec?: number;
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  mfaSecretEnc: text("mfa_secret_enc"),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  ssoSubject: text("sso_subject"),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: ts(), updatedAt: upd(),
});

export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  role: roleEnum("role").notNull().default("viewer"),
  employeeId: uuid("employee_id"),
  createdAt: ts(),
}, (t) => [uniqueIndex("memberships_user_org").on(t.userId, t.orgId), index("memberships_org").on(t.orgId)]);

export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: roleEnum("role").notNull(),
  employeeId: uuid("employee_id"),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: uuid("invited_by").references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: ts(),
}, (t) => [index("invitations_org").on(t.orgId)]);

// ---------- org structure ----------
export const businessUnits = pgTable("business_units", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: buKind("kind").notNull().default("business_unit"),
  parentBusinessUnitId: uuid("parent_business_unit_id"),
  country: text("country"),
  currency: text("currency").notNull().default("USD"),
  createdAt: ts(),
}, (t) => [index("bu_org").on(t.orgId)]);

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  city: text("city"),
  region: text("region"),
  country: text("country").notNull().default("US"),
  timezone: text("timezone").notNull().default("America/Chicago"),
  createdAt: ts(),
}, (t) => [index("locations_org").on(t.orgId)]);

export const departments = pgTable("departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  parentDepartmentId: uuid("parent_department_id"),
  headEmployeeId: uuid("head_employee_id"),
  businessUnitId: uuid("business_unit_id"),
  locationId: uuid("location_id"),
  annualOverhead: numeric("annual_overhead", { precision: 14, scale: 2 }), // non-labor dept costs (software, facilities) — entered, basis per row
  overheadBasis: basisEnum("overhead_basis").notNull().default("assumed"),
  createdAt: ts(),
}, (t) => [index("departments_org").on(t.orgId)]);

export const employees = pgTable("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
  managerEmployeeId: uuid("manager_employee_id"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  displayName: text("display_name").notNull(),
  email: text("email"),
  title: text("title"),
  location: text("location"),
  locationId: uuid("location_id"),
  businessUnitId: uuid("business_unit_id"),
  // Compensation inputs used ONLY for loaded-cost math. Stored per-employee; never shown to peers.
  baseAnnualCost: numeric("base_annual_cost", { precision: 12, scale: 2 }),
  loadedHourlyCost: numeric("loaded_hourly_cost", { precision: 10, scale: 2 }),
  costBasis: basisEnum("cost_basis").notNull().default("assumed"),
  hoursPerWeek: numeric("hours_per_week", { precision: 5, scale: 2 }).default("40"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("employees_org").on(t.orgId), index("employees_dept").on(t.departmentId)]);

// ---------- consent, notice, collectors ----------
export const consentRecords = pgTable("consent_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
  noticeVersion: text("notice_version").notNull(),
  noticeText: text("notice_text").notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  method: text("method").notNull().default("collector_ui"), // collector_ui | web | hr_system
  ipHash: text("ip_hash"),
  createdAt: ts(),
}, (t) => [index("consent_org_emp").on(t.orgId, t.employeeId)]);

export const authorizations = pgTable("authorizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  signedByUserId: uuid("signed_by_user_id").references(() => users.id),
  signerName: text("signer_name").notNull(),
  signerTitle: text("signer_title").notNull(),
  scope: text("scope").notNull(),
  documentText: text("document_text").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [index("authorizations_org").on(t.orgId)]);

export const collectors = pgTable("collectors", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  platform: text("platform").notNull(), // windows | macos | linux | simulated
  hostnameHash: text("hostname_hash"),
  tokenHash: text("token_hash").notNull().unique(),
  enrollmentCodeHash: text("enrollment_code_hash"),
  status: collectorStatus("status").notNull().default("pending"),
  version: text("version"),
  config: jsonb("config").$type<CollectorConfig>().default({}),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  eventsReceived: bigint("events_received", { mode: "number" }).notNull().default(0),
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("collectors_org").on(t.orgId)]);
export type CollectorConfig = {
  sampleIntervalMs?: number; batchIntervalMs?: number; idleThresholdSec?: number;
  schedule?: { days: number[]; start: string; end: string; tz?: string }; // observation windows
  blockedApps?: string[]; // never record these at all
  titleMode?: "hash" | "category" | "none"; // never raw titles by default
};

export const observationCampaigns = pgTable("observation_campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  status: campaignStatus("status").notNull().default("draft"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  departmentIds: jsonb("department_ids").$type<string[]>().default([]),
  employeeIds: jsonb("employee_ids").$type<string[]>().default([]),
  config: jsonb("config").$type<CollectorConfig>().default({}),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("campaigns_org").on(t.orgId)]);

// ---------- raw activity (metadata only, never content) ----------
export const activityEvents = pgTable("activity_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: uuid("org_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  collectorId: uuid("collector_id").notNull(),
  campaignId: uuid("campaign_id"),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  type: eventType("type").notNull(),
  app: text("app").notNull(), // normalized app name e.g. "Excel", "QuickBooks", "Chrome"
  appCategory: text("app_category"), // spreadsheet | erp | email | browser | crm | ...
  titleCategory: text("title_category"), // coarse: "invoice", "report", "customer record" — never raw title
  titleHash: text("title_hash"), // salted hash for sequence detection; not reversible
  durationMs: integer("duration_ms").notNull().default(0),
  meta: jsonb("meta").$type<Record<string, number | string | boolean>>().default({}),
  // meta examples: { clicks: 42, keysCount: 310 (count only, never contents), pasteCount: 3, fieldCount: 12 }
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("events_org_emp_ts").on(t.orgId, t.employeeId, t.ts),
  index("events_org_ts").on(t.orgId, t.ts),
  index("events_campaign").on(t.campaignId),
]);

// ---------- discovered workflows ----------
export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  signature: text("signature").notNull(), // canonical step sequence key
  steps: jsonb("steps").$type<WorkflowStep[]>().notNull().default([]),
  processMap: jsonb("process_map").$type<ProcessMap>(), // directly-follows graph
  avgDurationMin: numeric("avg_duration_min", { precision: 10, scale: 2 }).notNull().default("0"),
  runsPerWeek: numeric("runs_per_week", { precision: 10, scale: 2 }).notNull().default("0"),
  hoursPerWeek: numeric("hours_per_week", { precision: 10, scale: 2 }).notNull().default("0"),
  employeeCount: integer("employee_count").notNull().default(0),
  repetitionScore: numeric("repetition_score", { precision: 5, scale: 2 }).notNull().default("0"), // 0..100
  automationScore: numeric("automation_score", { precision: 5, scale: 2 }).notNull().default("0"), // 0..100
  reworkRate: numeric("rework_rate", { precision: 5, scale: 4 }).default("0"),
  handoffCount: integer("handoff_count").default(0),
  isManual: boolean("is_manual").notNull().default(true),
  requiresJudgment: boolean("requires_judgment").notNull().default(false),
  regulatoryFlag: text("regulatory_flag"), // e.g. "HIPAA", "SOX", "PII"
  duplicateOfWorkflowId: uuid("duplicate_of_workflow_id"),
  basis: basisEnum("basis").notNull().default("observed"),
  evidence: jsonb("evidence").$type<Evidence>().notNull().default({ eventIds: [], sampleSize: 0, observedFrom: "", observedTo: "" }),
  analysisRunId: uuid("analysis_run_id"),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("workflows_org").on(t.orgId), index("workflows_dept").on(t.departmentId)]);
export type WorkflowStep = { idx: number; app: string; action: string; avgMs: number; share: number; category?: string };
export type ProcessMap = { nodes: { id: string; label: string; count: number; avgMs: number }[]; edges: { from: string; to: string; count: number }[] };
export type Evidence = { eventIds: number[]; sampleSize: number; observedFrom: string; observedTo: string; employeeIds?: string[]; notes?: string[] };

export const workflowEmployees = pgTable("workflow_employees", {
  orgId: uuid("org_id").notNull(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
  runsPerWeek: numeric("runs_per_week", { precision: 10, scale: 2 }).notNull().default("0"),
  hoursPerWeek: numeric("hours_per_week", { precision: 10, scale: 2 }).notNull().default("0"),
  avgDurationMin: numeric("avg_duration_min", { precision: 10, scale: 2 }).notNull().default("0"),
}, (t) => [primaryKey({ columns: [t.workflowId, t.employeeId] }), index("wf_emp_org").on(t.orgId, t.employeeId)]);

export const analysisRuns = pgTable("analysis_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  campaignId: uuid("campaign_id"),
  status: text("status").notNull().default("queued"), // queued | running | done | failed
  windowStart: timestamp("window_start", { withTimezone: true }),
  windowEnd: timestamp("window_end", { withTimezone: true }),
  eventsAnalyzed: integer("events_analyzed").default(0),
  workflowsFound: integer("workflows_found").default(0),
  opportunitiesFound: integer("opportunities_found").default(0),
  summary: jsonb("summary").$type<Record<string, unknown>>().default({}),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: ts(),
}, (t) => [index("analysis_runs_org").on(t.orgId)]);

// ---------- opportunities ----------
export const opportunities = pgTable("opportunities", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
  departmentId: uuid("department_id"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  type: opportunityType("type").notNull(),
  status: opportunityStatus("status").notNull().default("identified"),
  rank: integer("rank").notNull().default(0),
  feasibility: numeric("feasibility", { precision: 5, scale: 2 }).notNull(), // 0..100
  risk: numeric("risk", { precision: 5, scale: 2 }).notNull(), // 0..100
  automationPct: numeric("automation_pct", { precision: 5, scale: 4 }).notNull(), // share of workflow time removable
  hoursRecoverablePerWeek: numeric("hours_recoverable_per_week", { precision: 10, scale: 2 }).notNull(),
  grossAnnualSavings: numeric("gross_annual_savings", { precision: 12, scale: 2 }).notNull(),
  realizableAnnualSavings: numeric("realizable_annual_savings", { precision: 12, scale: 2 }).notNull(),
  implementationCost: numeric("implementation_cost", { precision: 12, scale: 2 }).notNull(),
  annualOperatingCost: numeric("annual_operating_cost", { precision: 12, scale: 2 }).notNull(),
  paybackMonths: numeric("payback_months", { precision: 6, scale: 1 }),
  recommendedAgentCategory: text("recommended_agent_category"),
  requiresHumanJudgment: boolean("requires_human_judgment").notNull().default(false),
  regulatoryFlag: text("regulatory_flag"),
  basis: basisEnum("basis").notNull().default("estimated"),
  calculation: jsonb("calculation").$type<CalcTree>().notNull(), // drill-down tree
  evidence: jsonb("evidence").$type<Evidence>().notNull(),
  agentId: uuid("agent_id"),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("opportunities_org").on(t.orgId), index("opportunities_wf").on(t.workflowId)]);
/** A calculation tree is what every drill-down renders: label, value, formula, basis, children. */
export type CalcTree = { label: string; value: number; unit?: string; formula?: string; basis: "observed" | "estimated" | "assumed"; source?: string; children?: CalcTree[] };

// ---------- agents & execution ----------
export const credentials = pgTable("credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  provider: text("provider").notNull(), // e.g. "smtp", "quickbooks", "hubspot", "n8n", "http_bearer"
  // AES-256-GCM: iv:tag:ciphertext (base64). Decrypted only inside agent runner.
  secretEnc: text("secret_enc").notNull(),
  fields: jsonb("fields").$type<string[]>().default([]), // names of fields inside secret, never values
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("credentials_org").on(t.orgId)]);

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
  workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  category: text("category").notNull(), // customer_service | scheduling | sales_crm | email_admin | ap_ar | invoice | reporting | inventory | marketing | onboarding | document | data_entry
  templateKey: text("template_key").notNull(),
  status: agentStatus("status").notNull().default("draft"),
  runtime: text("runtime").notNull().default("internal"), // internal | n8n
  externalId: text("external_id"), // n8n workflow id
  definition: jsonb("definition").$type<AgentDefinition>().notNull(),
  credentialIds: jsonb("credential_ids").$type<string[]>().default([]),
  approvalPolicy: jsonb("approval_policy").$type<ApprovalPolicy>().default({ mode: "sensitive_only" }),
  expectedMinutesSavedPerRun: numeric("expected_minutes_saved_per_run", { precision: 8, scale: 2 }).default("0"),
  baselineMinutesPerRun: numeric("baseline_minutes_per_run", { precision: 8, scale: 2 }).default("0"),
  monthlyCost: numeric("monthly_cost", { precision: 10, scale: 2 }).default("0"),
  deployedAt: timestamp("deployed_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("agents_org").on(t.orgId)]);
export type AgentNode = { id: string; type: "trigger" | "action" | "condition" | "approval" | "llm" | "http" | "transform" | "notify" | "end"; label: string; config: Record<string, unknown>; sensitive?: boolean; compensate?: Record<string, unknown> };
export type AgentDefinition = { nodes: AgentNode[]; edges: { from: string; to: string; when?: "true" | "false" | "approved" | "rejected" }[]; schedule?: string; retries?: { max: number; backoffMs: number } };
export type ApprovalPolicy = { mode: "none" | "sensitive_only" | "all"; approverRole?: "admin" | "manager" | "owner"; timeoutHours?: number };

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  status: runStatus("status").notNull().default("queued"),
  trigger: text("trigger").notNull().default("manual"),
  input: jsonb("input").$type<Record<string, unknown>>().default({}),
  output: jsonb("output").$type<Record<string, unknown>>().default({}),
  logs: jsonb("logs").$type<RunLog[]>().notNull().default([]),
  currentNodeId: text("current_node_id"),
  attempt: integer("attempt").notNull().default(1),
  error: text("error"),
  minutesSaved: numeric("minutes_saved", { precision: 8, scale: 2 }),
  humanMinutes: numeric("human_minutes", { precision: 8, scale: 2 }), // time a human still spent (review/approval)
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: ts(),
}, (t) => [index("agent_runs_org_agent").on(t.orgId, t.agentId), index("agent_runs_status").on(t.status)]);
export type RunLog = { t: string; level: "info" | "warn" | "error"; nodeId?: string; msg: string; data?: Record<string, unknown> };

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull(),
  nodeId: text("node_id").notNull(),
  status: approvalStatus("status").notNull().default("pending"),
  requestedAction: text("requested_action").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: ts(),
}, (t) => [index("approvals_org_status").on(t.orgId, t.status)]);

// ---------- measured savings (verified, post-deployment) ----------
export const savingsMeasurements = pgTable("savings_measurements", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  method: text("method").notNull(), // run_ledger | before_after_observation | manual_attestation
  runs: integer("runs").notNull().default(0),
  hoursSaved: numeric("hours_saved", { precision: 10, scale: 2 }).notNull(),
  hoursBaseline: numeric("hours_baseline", { precision: 10, scale: 2 }),
  hoursAfter: numeric("hours_after", { precision: 10, scale: 2 }),
  dollarsSaved: numeric("dollars_saved", { precision: 12, scale: 2 }).notNull(),
  costIncurred: numeric("cost_incurred", { precision: 12, scale: 2 }).notNull().default("0"),
  basis: basisEnum("basis").notNull().default("observed"),
  calculation: jsonb("calculation").$type<CalcTree>().notNull(),
  verifiedBy: uuid("verified_by").references(() => users.id),
  createdAt: ts(),
}, (t) => [index("savings_org").on(t.orgId)]);

// ---------- financial model ----------
export const financialModels = pgTable("financial_models", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("Default"),
  assumptions: jsonb("assumptions").$type<FinancialAssumptions>().notNull(),
  isDefault: boolean("is_default").notNull().default(true),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("fin_models_org").on(t.orgId)]);
export type FinancialAssumptions = {
  automationPct: number; adoptionRate: number; realizationRate: number; benefitsLoadPct: number;
  implementationCostOverride?: number; annualOpexOverride?: number; discountRate: number;
  rampMonths: number; platformFeeMonthly: number; perAgentMonthly: number; consultingHourly: number;
  workWeeksPerYear: number;
};

// ---------- projects, reports, billing ----------
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: projectStatus("status").notNull().default("proposed"),
  opportunityIds: jsonb("opportunity_ids").$type<string[]>().default([]),
  agentIds: jsonb("agent_ids").$type<string[]>().default([]),
  budget: numeric("budget", { precision: 12, scale: 2 }),
  spent: numeric("spent", { precision: 12, scale: 2 }).default("0"),
  startDate: timestamp("start_date", { withTimezone: true }),
  targetDate: timestamp("target_date", { withTimezone: true }),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  notes: text("notes"),
  targetAnnualSavings: numeric("target_annual_savings", { precision: 14, scale: 2 }),
  priorityScore: numeric("priority_score", { precision: 5, scale: 2 }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verifiedBy: uuid("verified_by"),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("projects_org").on(t.orgId)]);

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // executive_roi | monthly_performance | investment_proposal | department
  title: text("title").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  pdfBytes: text("pdf_bytes"), // base64; small reports only. Larger deployments should use object storage.
  generatedBy: uuid("generated_by").references(() => users.id),
  createdAt: ts(),
}, (t) => [index("reports_org").on(t.orgId)]);

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }).unique(),
  plan: planEnum("plan").notNull().default("starter"),
  status: subscriptionStatus("status").notNull().default("trialing"),
  seats: integer("seats").notNull().default(10), // monitored employees
  agentSlots: integer("agent_slots").notNull().default(3),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  createdAt: ts(), updatedAt: upd(),
});

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  stripeInvoiceId: text("stripe_invoice_id"),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("usd"),
  status: text("status").notNull(), // draft | open | paid | void | uncollectible
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  lineItems: jsonb("line_items").$type<{ description: string; amountCents: number; qty: number }[]>().default([]),
  pdfUrl: text("pdf_url"),
  createdAt: ts(),
}, (t) => [index("invoices_org").on(t.orgId)]);

export const projectMilestones = pgTable("project_milestones", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: milestoneStatus("status").notNull().default("not_started"),
  startDate: timestamp("start_date", { withTimezone: true }),
  dueDate: timestamp("due_date", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  dependsOnMilestoneId: uuid("depends_on_milestone_id"),
  ownerUserId: uuid("owner_user_id"),
  sort: integer("sort").notNull().default(0),
  createdAt: ts(),
}, (t) => [index("milestones_project").on(t.projectId), index("milestones_org").on(t.orgId)]);

export const projectRisks = pgTable("project_risks", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  severity: integer("severity").notNull().default(3), // 1..5
  likelihood: integer("likelihood").notNull().default(3), // 1..5
  mitigation: text("mitigation"),
  status: text("status").notNull().default("open"), // open | mitigated | closed
  createdAt: ts(),
}, (t) => [index("risks_project").on(t.projectId), index("risks_org").on(t.orgId)]);

/** Executive decision history on opportunities (approve / reject / postpone / request analysis). */
export const opportunityDecisions = pgTable("opportunity_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  opportunityId: uuid("opportunity_id").notNull().references(() => opportunities.id, { onDelete: "cascade" }),
  decision: text("decision").notNull(), // approve | reject | postpone | request_analysis | reopen
  note: text("note"),
  decidedBy: uuid("decided_by"),
  createdAt: ts(),
}, (t) => [index("opp_decisions_org").on(t.orgId, t.opportunityId)]);

/**
 * Savings ledger — the human-attested tiers of the Savings Intelligence Engine.
 * Potential / verified-time / capacity tiers are computed live from opportunities and measurements;
 * these three tiers require an explicit, evidenced, approved entry:
 *   approved       — finance-approved business case for an opportunity (annual $)
 *   cost_avoidance — future expense demonstrably avoided (e.g. a req not opened), with evidence
 *   realized_hard  — confirmed reduction in an actual expense line (payroll, vendor, overtime)
 * `dedupeKey` (defaults to workflow id) prevents two entries claiming the same saving in the same tier+period.
 */
export const savingsLedger = pgTable("savings_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  tier: savingsTier("tier").notNull(),
  status: ledgerStatus("status").notNull().default("submitted"),
  title: text("title").notNull(),
  annualAmount: numeric("annual_amount", { precision: 14, scale: 2 }).notNull(),
  hoursPerYear: numeric("hours_per_year", { precision: 12, scale: 2 }),
  opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
  departmentId: uuid("department_id"),
  dedupeKey: text("dedupe_key").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  evidence: jsonb("evidence").$type<{ kind: string; ref: string; note?: string }[]>().notNull().default([]),
  calculation: jsonb("calculation").$type<CalcTree>(),
  basis: basisEnum("basis").notNull().default("observed"),
  submittedBy: uuid("submitted_by"),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("ledger_org_tier").on(t.orgId, t.tier, t.status), index("ledger_dedupe").on(t.orgId, t.tier, t.dedupeKey)]);

/** Point-in-time Business Evaluations (Transformation Score snapshots). */
export const evaluations = pgTable("evaluations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("in_progress"), // in_progress | presented | approved
  steps: jsonb("steps").$type<Record<string, { done: boolean; at?: string; note?: string }>>().notNull().default({}),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
  createdBy: uuid("created_by"),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("evaluations_org").on(t.orgId)]);

/** External benchmark datasets. Never seeded with invented data — every row must cite a source. */
export const benchmarkDatasets = pgTable("benchmark_datasets", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  source: text("source").notNull(),
  sourceUrl: text("source_url"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  sampleDescription: text("sample_description").notNull(),
  applicability: text("applicability"),
  metrics: jsonb("metrics").$type<{ key: string; label: string; value: number; unit: string }[]>().notNull().default([]),
  createdBy: uuid("created_by"),
  createdAt: ts(),
}, (t) => [index("benchmarks_org").on(t.orgId)]);

/** Saved dashboard views (filters + layout) per user. */
export const dashboardViews = pgTable("dashboard_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  page: text("page").notNull(),
  name: text("name").notNull(),
  filters: jsonb("filters").$type<Record<string, string>>().notNull().default({}),
  layout: jsonb("layout").$type<{ hidden?: string[]; order?: string[] }>().notNull().default({}),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: ts(),
}, (t) => [index("views_org_user").on(t.orgId, t.userId, t.page)]);

// ---------- integrations, retention, audit ----------
export const integrations = pgTable("integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  provider: integrationProvider("provider").notNull(),
  status: integrationStatus("status").notNull().default("not_configured"),
  credentialId: uuid("credential_id").references(() => credentials.id, { onDelete: "set null" }),
  config: jsonb("config").$type<Record<string, unknown>>().default({}),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [uniqueIndex("integrations_org_provider").on(t.orgId, t.provider)]);

export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: uuid("org_id"),
  actorUserId: uuid("actor_user_id"),
  actorType: text("actor_type").notNull().default("user"), // user | collector | system | agent
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  details: jsonb("details").$type<Record<string, unknown>>().default({}),
  ipHash: text("ip_hash"),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("audit_org_ts").on(t.orgId, t.ts)]);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id"),
  kind: text("kind").notNull(), // analysis | retention_sweep | agent_run | report | stripe_sync
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
  status: text("status").notNull().default("queued"), // queued | running | done | failed
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  runAfter: timestamp("run_after", { withTimezone: true }).defaultNow().notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  error: text("error"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  createdAt: ts(), updatedAt: upd(),
}, (t) => [index("jobs_status_run_after").on(t.status, t.runAfter)]);

// ---------- relations (for query API) ----------
export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships), departments: many(departments), employees: many(employees),
}));
export const employeesRelations = relations(employees, ({ one, many }) => ({
  department: one(departments, { fields: [employees.departmentId], references: [departments.id] }),
  workflowLinks: many(workflowEmployees),
}));
export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  department: one(departments, { fields: [workflows.departmentId], references: [departments.id] }),
  opportunities: many(opportunities), employees: many(workflowEmployees),
}));
export const workflowEmployeesRelations = relations(workflowEmployees, ({ one }) => ({
  workflow: one(workflows, { fields: [workflowEmployees.workflowId], references: [workflows.id] }),
  employee: one(employees, { fields: [workflowEmployees.employeeId], references: [employees.id] }),
}));
export const opportunitiesRelations = relations(opportunities, ({ one }) => ({
  workflow: one(workflows, { fields: [opportunities.workflowId], references: [workflows.id] }),
}));
export const agentsRelations = relations(agents, ({ many }) => ({ runs: many(agentRuns) }));
export const agentRunsRelations = relations(agentRuns, ({ one }) => ({ agent: one(agents, { fields: [agentRuns.agentId], references: [agents.id] }) }));

/** Tables that carry org_id and must be covered by RLS. Used by tests to assert policy coverage. */
export const TENANT_TABLES = [
  "memberships", "invitations", "departments", "employees", "consent_records", "authorizations", "collectors",
  "observation_campaigns", "activity_events", "workflows", "workflow_employees", "analysis_runs", "opportunities",
  "credentials", "agents", "agent_runs", "approvals", "savings_measurements", "financial_models", "projects",
  "reports", "subscriptions", "invoices", "integrations", "business_units", "locations", "project_milestones",
  "project_risks", "opportunity_decisions", "savings_ledger", "evaluations", "benchmark_datasets", "dashboard_views",
] as const;
export const _sql = sql;
