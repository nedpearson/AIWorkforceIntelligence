CREATE TYPE "public"."bu_kind" AS ENUM('subsidiary', 'division', 'business_unit');--> statement-breakpoint
CREATE TYPE "public"."ledger_status" AS ENUM('draft', 'submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."milestone_status" AS ENUM('not_started', 'in_progress', 'blocked', 'done');--> statement-breakpoint
CREATE TYPE "public"."savings_tier" AS ENUM('approved', 'cost_avoidance', 'realized_hard');--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'celonis';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'uipath_process_mining';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'microsoft_365';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'google_workspace';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'salesforce';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'hubspot';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'sap';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'oracle';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'netsuite';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'workday';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'adp';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'quickbooks';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'servicenow';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'slack';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'teams';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'sharepoint';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'zendesk';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'scim';--> statement-breakpoint
ALTER TYPE "public"."opportunity_status" ADD VALUE 'postponed';--> statement-breakpoint
ALTER TYPE "public"."opportunity_status" ADD VALUE 'analysis_requested';--> statement-breakpoint
CREATE TABLE "benchmark_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"published_at" timestamp with time zone,
	"sample_description" text NOT NULL,
	"applicability" text,
	"metrics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "bu_kind" DEFAULT 'business_unit' NOT NULL,
	"parent_business_unit_id" uuid,
	"country" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"page" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"layout" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"business_unit_id" uuid,
	"name" text NOT NULL,
	"city" text,
	"region" text,
	"country" text DEFAULT 'US' NOT NULL,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "milestone_status" DEFAULT 'not_started' NOT NULL,
	"start_date" timestamp with time zone,
	"due_date" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"depends_on_milestone_id" uuid,
	"owner_user_id" uuid,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"severity" integer DEFAULT 3 NOT NULL,
	"likelihood" integer DEFAULT 3 NOT NULL,
	"mitigation" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"tier" "savings_tier" NOT NULL,
	"status" "ledger_status" DEFAULT 'submitted' NOT NULL,
	"title" text NOT NULL,
	"annual_amount" numeric(14, 2) NOT NULL,
	"hours_per_year" numeric(12, 2),
	"opportunity_id" uuid,
	"project_id" uuid,
	"agent_id" uuid,
	"workflow_id" uuid,
	"department_id" uuid,
	"dedupe_key" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calculation" jsonb,
	"basis" "basis" DEFAULT 'observed' NOT NULL,
	"submitted_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "business_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "annual_overhead" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "overhead_basis" "basis" DEFAULT 'assumed' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "business_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "target_annual_savings" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "priority_score" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "verified_by" uuid;--> statement-breakpoint
ALTER TABLE "benchmark_datasets" ADD CONSTRAINT "benchmark_datasets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_views" ADD CONSTRAINT "dashboard_views_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_decisions" ADD CONSTRAINT "opportunity_decisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_decisions" ADD CONSTRAINT "opportunity_decisions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_ledger" ADD CONSTRAINT "savings_ledger_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_ledger" ADD CONSTRAINT "savings_ledger_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_ledger" ADD CONSTRAINT "savings_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_ledger" ADD CONSTRAINT "savings_ledger_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_ledger" ADD CONSTRAINT "savings_ledger_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "benchmarks_org" ON "benchmark_datasets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "bu_org" ON "business_units" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "views_org_user" ON "dashboard_views" USING btree ("org_id","user_id","page");--> statement-breakpoint
CREATE INDEX "evaluations_org" ON "evaluations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "locations_org" ON "locations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "opp_decisions_org" ON "opportunity_decisions" USING btree ("org_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "milestones_project" ON "project_milestones" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "milestones_org" ON "project_milestones" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "risks_project" ON "project_risks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "risks_org" ON "project_risks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ledger_org_tier" ON "savings_ledger" USING btree ("org_id","tier","status");--> statement-breakpoint
CREATE INDEX "ledger_dedupe" ON "savings_ledger" USING btree ("org_id","tier","dedupe_key");