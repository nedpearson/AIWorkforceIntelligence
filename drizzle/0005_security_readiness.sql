-- 0005 security + production readiness (hand-written, like 0004). Additive only; rollback SQL in docs/ROLLBACK_PLAN.md.
-- Session revocation: every JWT carries the user's session_version; bumping it invalidates all of that user's tokens.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Shared fixed-window rate limiter (src/lib/rate-limit.ts). Not tenant data: keys are HMAC hashes.
CREATE TABLE IF NOT EXISTS "rate_limits" (
  "key" text PRIMARY KEY NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "hits" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limits_expires" ON "rate_limits" ("expires_at");--> statement-breakpoint
-- Audit-log hash chain (per org; NULL org = the global chain). Rows written before 0005 stay unchained (legacy).
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "prev_hash" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "hash" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_org_id" ON "audit_log" ("org_id", "id");--> statement-breakpoint
-- Release-gate evidence recorded by `npm run readiness:record` (platform-level, not tenant data).
CREATE TABLE IF NOT EXISTS "readiness_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "gate" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('pass', 'fail', 'blocked')),
  "commit_sha" text NOT NULL,
  "command" text NOT NULL,
  "environment" text NOT NULL,
  "evidence" text NOT NULL,
  "recorded_by" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "readiness_evidence_gate" ON "readiness_evidence" ("gate", "recorded_at");--> statement-breakpoint
-- Security findings register (synced from src/engine/readiness/findings.ts by `npm run readiness:record -- --sync-findings`).
CREATE TABLE IF NOT EXISTS "security_findings" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "severity" text NOT NULL CHECK ("severity" IN ('critical', 'high', 'medium', 'low', 'info')),
  "status" text NOT NULL CHECK ("status" IN ('open', 'remediated', 'accepted')),
  "component" text NOT NULL,
  "summary" text NOT NULL,
  "fix" text NOT NULL,
  "evidence" text NOT NULL,
  "owner" text NOT NULL,
  "next_action" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
