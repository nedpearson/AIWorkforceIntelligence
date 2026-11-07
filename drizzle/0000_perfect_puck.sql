CREATE TYPE "public"."agent_status" AS ENUM('draft', 'configured', 'deployed', 'paused', 'retired', 'error');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."basis" AS ENUM('observed', 'estimated', 'assumed');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'scheduled', 'running', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."collector_status" AS ENUM('pending', 'active', 'paused', 'revoked', 'offline');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('app_focus', 'app_switch', 'idle_start', 'idle_end', 'click_burst', 'navigation', 'data_entry', 'copy_paste', 'document_open', 'document_save', 'form_submit', 'print', 'email_compose', 'handoff');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('n8n', 'power_automate', 'uipath', 'mimica', 'stripe', 'oidc', 'anthropic');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('not_configured', 'configured', 'connected', 'error', 'license_required');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('identified', 'reviewing', 'approved', 'in_progress', 'deployed', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."opportunity_type" AS ENUM('ai_agent', 'rpa', 'conventional_automation', 'process_change', 'role_consolidation');--> statement-breakpoint
CREATE TYPE "public"."org_kind" AS ENUM('consultancy', 'client');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('starter', 'growth', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('proposed', 'approved', 'in_progress', 'live', 'measuring', 'closed');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'manager', 'employee', 'consultant', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'rolled_back', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'canceled', 'unpaid');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"collector_id" uuid NOT NULL,
	"campaign_id" uuid,
	"ts" timestamp with time zone NOT NULL,
	"type" "event_type" NOT NULL,
	"app" text NOT NULL,
	"app_category" text,
	"title_category" text,
	"title_hash" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb,
	"output" jsonb DEFAULT '{}'::jsonb,
	"logs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_node_id" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"minutes_saved" numeric(8, 2),
	"human_minutes" numeric(8, 2),
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"workflow_id" uuid,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"template_key" text NOT NULL,
	"status" "agent_status" DEFAULT 'draft' NOT NULL,
	"runtime" text DEFAULT 'internal' NOT NULL,
	"external_id" text,
	"definition" jsonb NOT NULL,
	"credential_ids" jsonb DEFAULT '[]'::jsonb,
	"approval_policy" jsonb DEFAULT '{"mode":"sensitive_only"}'::jsonb,
	"expected_minutes_saved_per_run" numeric(8, 2) DEFAULT '0',
	"baseline_minutes_per_run" numeric(8, 2) DEFAULT '0',
	"monthly_cost" numeric(10, 2) DEFAULT '0',
	"deployed_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"events_analyzed" integer DEFAULT 0,
	"workflows_found" integer DEFAULT 0,
	"opportunities_found" integer DEFAULT 0,
	"summary" jsonb DEFAULT '{}'::jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid,
	"actor_user_id" uuid,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"details" jsonb DEFAULT '{}'::jsonb,
	"ip_hash" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"signed_by_user_id" uuid,
	"signer_name" text NOT NULL,
	"signer_title" text NOT NULL,
	"scope" text NOT NULL,
	"document_text" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "collectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"employee_id" uuid,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"hostname_hash" text,
	"token_hash" text NOT NULL,
	"enrollment_code_hash" text,
	"status" "collector_status" DEFAULT 'pending' NOT NULL,
	"version" text,
	"config" jsonb DEFAULT '{}'::jsonb,
	"last_seen_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"events_received" bigint DEFAULT 0 NOT NULL,
	"paused_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collectors_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"notice_version" text NOT NULL,
	"notice_text" text NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"method" text DEFAULT 'collector_ui' NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"secret_enc" text NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb,
	"last_used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_department_id" uuid,
	"head_employee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"department_id" uuid,
	"manager_employee_id" uuid,
	"user_id" uuid,
	"display_name" text NOT NULL,
	"email" text,
	"title" text,
	"location" text,
	"base_annual_cost" numeric(12, 2),
	"loaded_hourly_cost" numeric(10, 2),
	"cost_basis" "basis" DEFAULT 'assumed' NOT NULL,
	"hours_per_week" numeric(5, 2) DEFAULT '40',
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text DEFAULT 'Default' NOT NULL,
	"assumptions" jsonb NOT NULL,
	"is_default" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"status" "integration_status" DEFAULT 'not_configured' NOT NULL,
	"credential_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" NOT NULL,
	"employee_id" uuid,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"stripe_invoice_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"status" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"line_items" jsonb DEFAULT '[]'::jsonb,
	"pdf_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'viewer' NOT NULL,
	"employee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observation_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"department_ids" jsonb DEFAULT '[]'::jsonb,
	"employee_ids" jsonb DEFAULT '[]'::jsonb,
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workflow_id" uuid,
	"department_id" uuid,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"type" "opportunity_type" NOT NULL,
	"status" "opportunity_status" DEFAULT 'identified' NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"feasibility" numeric(5, 2) NOT NULL,
	"risk" numeric(5, 2) NOT NULL,
	"automation_pct" numeric(5, 4) NOT NULL,
	"hours_recoverable_per_week" numeric(10, 2) NOT NULL,
	"gross_annual_savings" numeric(12, 2) NOT NULL,
	"realizable_annual_savings" numeric(12, 2) NOT NULL,
	"implementation_cost" numeric(12, 2) NOT NULL,
	"annual_operating_cost" numeric(12, 2) NOT NULL,
	"payback_months" numeric(6, 1),
	"recommended_agent_category" text,
	"requires_human_judgment" boolean DEFAULT false NOT NULL,
	"regulatory_flag" text,
	"basis" "basis" DEFAULT 'estimated' NOT NULL,
	"calculation" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "org_kind" DEFAULT 'client' NOT NULL,
	"parent_org_id" uuid,
	"industry" text,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"retention_days" integer DEFAULT 180 NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "project_status" DEFAULT 'proposed' NOT NULL,
	"opportunity_ids" jsonb DEFAULT '[]'::jsonb,
	"agent_ids" jsonb DEFAULT '[]'::jsonb,
	"budget" numeric(12, 2),
	"spent" numeric(12, 2) DEFAULT '0',
	"start_date" timestamp with time zone,
	"target_date" timestamp with time zone,
	"owner_user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"data" jsonb NOT NULL,
	"pdf_bytes" text,
	"generated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid,
	"workflow_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"hours_saved" numeric(10, 2) NOT NULL,
	"hours_baseline" numeric(10, 2),
	"hours_after" numeric(10, 2),
	"dollars_saved" numeric(12, 2) NOT NULL,
	"cost_incurred" numeric(12, 2) DEFAULT '0' NOT NULL,
	"basis" "basis" DEFAULT 'observed' NOT NULL,
	"calculation" jsonb NOT NULL,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"plan" "plan" DEFAULT 'starter' NOT NULL,
	"status" "subscription_status" DEFAULT 'trialing' NOT NULL,
	"seats" integer DEFAULT 10 NOT NULL,
	"agent_slots" integer DEFAULT 3 NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"mfa_secret_enc" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"sso_subject" text,
	"email_verified" timestamp with time zone,
	"image" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workflow_employees" (
	"org_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"runs_per_week" numeric(10, 2) DEFAULT '0' NOT NULL,
	"hours_per_week" numeric(10, 2) DEFAULT '0' NOT NULL,
	"avg_duration_min" numeric(10, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "workflow_employees_workflow_id_employee_id_pk" PRIMARY KEY("workflow_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"department_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"signature" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"process_map" jsonb,
	"avg_duration_min" numeric(10, 2) DEFAULT '0' NOT NULL,
	"runs_per_week" numeric(10, 2) DEFAULT '0' NOT NULL,
	"hours_per_week" numeric(10, 2) DEFAULT '0' NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"repetition_score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"automation_score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"rework_rate" numeric(5, 4) DEFAULT '0',
	"handoff_count" integer DEFAULT 0,
	"is_manual" boolean DEFAULT true NOT NULL,
	"requires_judgment" boolean DEFAULT false NOT NULL,
	"regulatory_flag" text,
	"duplicate_of_workflow_id" uuid,
	"basis" "basis" DEFAULT 'observed' NOT NULL,
	"evidence" jsonb DEFAULT '{"eventIds":[],"sampleSize":0,"observedFrom":"","observedTo":""}'::jsonb NOT NULL,
	"analysis_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_signed_by_user_id_users_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collectors" ADD CONSTRAINT "collectors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collectors" ADD CONSTRAINT "collectors_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_models" ADD CONSTRAINT "financial_models_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_campaigns" ADD CONSTRAINT "observation_campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_campaigns" ADD CONSTRAINT "observation_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_measurements" ADD CONSTRAINT "savings_measurements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_measurements" ADD CONSTRAINT "savings_measurements_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_measurements" ADD CONSTRAINT "savings_measurements_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_measurements" ADD CONSTRAINT "savings_measurements_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_employees" ADD CONSTRAINT "workflow_employees_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_employees" ADD CONSTRAINT "workflow_employees_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_org_emp_ts" ON "activity_events" USING btree ("org_id","employee_id","ts");--> statement-breakpoint
CREATE INDEX "events_org_ts" ON "activity_events" USING btree ("org_id","ts");--> statement-breakpoint
CREATE INDEX "events_campaign" ON "activity_events" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "agent_runs_org_agent" ON "agent_runs" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_runs_status" ON "agent_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agents_org" ON "agents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "analysis_runs_org" ON "analysis_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "approvals_org_status" ON "approvals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "audit_org_ts" ON "audit_log" USING btree ("org_id","ts");--> statement-breakpoint
CREATE INDEX "authorizations_org" ON "authorizations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "collectors_org" ON "collectors" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "consent_org_emp" ON "consent_records" USING btree ("org_id","employee_id");--> statement-breakpoint
CREATE INDEX "credentials_org" ON "credentials" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "departments_org" ON "departments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "employees_org" ON "employees" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "employees_dept" ON "employees" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "fin_models_org" ON "financial_models" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_org_provider" ON "integrations" USING btree ("org_id","provider");--> statement-breakpoint
CREATE INDEX "invitations_org" ON "invitations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "invoices_org" ON "invoices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "jobs_status_run_after" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_org" ON "memberships" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "memberships_org" ON "memberships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "campaigns_org" ON "observation_campaigns" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "opportunities_org" ON "opportunities" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "opportunities_wf" ON "opportunities" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "projects_org" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "reports_org" ON "reports" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "savings_org" ON "savings_measurements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "wf_emp_org" ON "workflow_employees" USING btree ("org_id","employee_id");--> statement-breakpoint
CREATE INDEX "workflows_org" ON "workflows" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "workflows_dept" ON "workflows" USING btree ("department_id");