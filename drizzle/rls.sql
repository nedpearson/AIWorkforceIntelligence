-- Row-level security for every tenant table. Applied by scripts/migrate.ts after drizzle migrations.
-- The application role `bridgebox_app` is NOT a superuser, so policies are enforced for it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bridgebox_app') THEN
    CREATE ROLE bridgebox_app NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO bridgebox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bridgebox_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bridgebox_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bridgebox_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO bridgebox_app;

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
    'reports','subscriptions','invoices','integrations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END $$;

-- organizations: app role may read only its own org (and a consultancy may read its clients).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_self ON organizations;
CREATE POLICY org_self ON organizations USING (id = app_current_org() OR parent_org_id = app_current_org());
-- users table is reachable through the admin handle only; app role gets id/name/email for joins
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_in_org ON users;
CREATE POLICY users_in_org ON users USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.org_id = app_current_org()));
-- audit_log and jobs: insert-only for app role, read own org
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_org ON audit_log;
CREATE POLICY audit_org ON audit_log USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY; ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jobs_org ON jobs;
CREATE POLICY jobs_org ON jobs USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
