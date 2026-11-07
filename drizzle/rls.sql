-- Row-level security for every tenant table. Applied by scripts/migrate.ts after drizzle migrations.
-- The application role `bridgebox_app` is NOT a superuser, so policies are enforced for it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bridgebox_app') THEN
    BEGIN CREATE ROLE bridgebox_app NOLOGIN; EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION 'Create role bridgebox_app as a DB admin first: CREATE ROLE bridgebox_app NOLOGIN; GRANT bridgebox_app TO <app user>;'; END;
  END IF;
END $$;
GRANT USAGE ON SCHEMA __SCHEMA__ TO bridgebox_app;
-- Let the connecting (owner) role switch into the RLS-enforced role.
DO $$ BEGIN
  -- PG16+: membership must carry SET option for SET ROLE; the creator gets ADMIN but not SET by default (Neon/RDS).
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT bridgebox_app TO %I WITH SET TRUE, INHERIT TRUE', current_user);
  ELSE
    EXECUTE format('GRANT bridgebox_app TO %I', current_user);
  END IF;
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN RAISE NOTICE 'grant bridgebox_app to % manually: %', current_user, SQLERRM; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA __SCHEMA__ TO bridgebox_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA __SCHEMA__ TO bridgebox_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA __SCHEMA__ GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bridgebox_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA __SCHEMA__ GRANT USAGE, SELECT ON SEQUENCES TO bridgebox_app;

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships','invitations','departments','employees','consent_records','authorizations','collectors',
    'observation_campaigns','activity_events','workflows','workflow_employees','analysis_runs','opportunities',
    'credentials','agents','agent_runs','approvals','savings_measurements','financial_models','projects',
    'reports','subscriptions','invoices','integrations','business_units','locations','project_milestones',
    'project_risks','opportunity_decisions','savings_ledger','evaluations','benchmark_datasets','dashboard_views','agent_versions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t); -- owner = admin handle (auth, jobs, seed); app role is always policy-bound
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END $$;

-- organizations: app role may read only its own org (and a consultancy may read its clients).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY; ALTER TABLE organizations NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_self ON organizations;
CREATE POLICY org_self ON organizations USING (id = app_current_org() OR parent_org_id = app_current_org());
-- users table is reachable through the admin handle only; app role gets id/name/email for joins
ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_in_org ON users;
CREATE POLICY users_in_org ON users USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.org_id = app_current_org()));
-- audit_log and jobs: insert-only for app role, read own org
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_org ON audit_log;
CREATE POLICY audit_org ON audit_log USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY; ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jobs_org ON jobs;
CREATE POLICY jobs_org ON jobs USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
