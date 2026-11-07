# Rollback plan

Scope: production on Vercel project `bridgebox-aiwi` (https://app.bridgebox.ai, Hobby plan) with Neon Postgres.
**Nothing in this document has been rehearsed against production.** The `rollback` and `backup_restore` release
gates at `/admin/readiness` stay *Not verified* until someone performs the rehearsal below and records it with
`npm run readiness:record`.

## 1. Decide what to roll back

| Symptom after a deploy | Roll back |
|---|---|
| Pages error / blank, API 500s, no schema change in the release | **App only** (§2) |
| Release added a migration and the new code misbehaves, data is fine | **App only** (§2) — every migration since 0001 is additive, the previous build ignores the new columns/tables |
| A migration itself damaged data, or the previous build cannot run against the new schema | **App** (§2) **then data** (§4, Neon restore) |
| You need to physically remove the new schema objects (rare) | §3 per-migration SQL, after §2 |

## 2. App rollback — Vercel instant rollback

1. Vercel dashboard → project `bridgebox-aiwi` → **Deployments** → the last known-good production deployment →
   **⋯ → Promote to Production** (or "Instant Rollback" on the current production deployment). The domain alias moves
   in seconds; no rebuild, so `scripts/bootstrap-on-build.ts` does **not** run again (no migration, no seed).
2. CLI equivalent: `vercel rollback <deployment-url>` / `vercel promote <deployment-url>`.
3. Verify: `curl -s https://app.bridgebox.ai/api/health` → `{"ok":true,"version":"<previous 7-char sha>"}`; sign in;
   open `/admin/readiness` as the platform owner (it shows the RC commit from `VERCEL_GIT_COMMIT_SHA`).
4. Note: Vercel's auto-assignment of production domains is paused after a rollback; re-enable by promoting again
   once the fix is deployed.

Sessions survive an app rollback. After rolling back **past** migration 0005 the old code ignores
`users.session_version`, so revoked sessions would be honoured again until their 12 h expiry — rotate `AUTH_SECRET`
if a revocation must hold (signs everyone out).

## 3. Per-migration rollback SQL (forward-only migrations)

`scripts/migrate.ts` / `src/engine/migrate.ts` apply `drizzle/NNNN_*.sql` once each and record them in
`__bb_migrations`. Drizzle has no down migrations. The SQL below reverses each recent migration; run it **only after
the app is rolled back to a build that predates the migration**, in a transaction, against the direct (non-pooled)
connection string, after taking a Neon branch/snapshot (§4). Then re-run `drizzle/rls.sql` is **not** needed (it only
adds policies/grants; dropped tables take their policies with them). Data in dropped objects is lost.

### 0005_security_readiness (this release)

```sql
BEGIN;
DROP TABLE IF EXISTS security_findings;
DROP TABLE IF EXISTS readiness_evidence;
DROP TABLE IF EXISTS rate_limits;
DROP INDEX IF EXISTS audit_org_id;
ALTER TABLE audit_log DROP COLUMN IF EXISTS hash, DROP COLUMN IF EXISTS prev_hash;   -- loses the hash chain
ALTER TABLE users DROP COLUMN IF EXISTS session_version;                             -- loses revocation state
DELETE FROM __bb_migrations WHERE name = '0005_security_readiness.sql';
COMMIT;
```
Code from before 0005 runs fine with these objects still present; dropping them is optional.

### 0004_brain_search

```sql
BEGIN;
DROP INDEX IF EXISTS facts_tsv;
ALTER TABLE brain_facts DROP COLUMN IF EXISTS tsv;
DROP INDEX IF EXISTS kchunks_tsv;
ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS tsv;
DELETE FROM __bb_migrations WHERE name = '0004_brain_search.sql';
COMMIT;
```
Code that predates 0004 does not read `tsv`; the columns are generated, so nothing is lost.

### 0003_ai_brain_workforce

```sql
BEGIN;
ALTER TABLE employees DROP COLUMN IF EXISTS photo_asset_id;
DROP TABLE IF EXISTS tour_progress, ai_messages, ai_conversations, ai_employee_memory, skill_runs,
  ai_employees, media_assets, brain_facts, knowledge_chunks, knowledge_documents, knowledge_sources CASCADE;
DROP TYPE IF EXISTS permission_level;
DROP TYPE IF EXISTS knowledge_status;
DROP TYPE IF EXISTS ai_employee_status;
DELETE FROM __bb_migrations WHERE name = '0003_ai_brain_workforce.sql';
COMMIT;
```
Destroys every AI Brain document, AI employee, skill run, conversation and uploaded media. Only for a build that
predates Phase B. If 0004 is still applied, run its rollback first.

The SQL above was written from the migration files (`drizzle/0003_ai_brain_workforce.sql`, `0004_brain_search.sql`,
`0005_security_readiness.sql`) and has **not** been executed against any database; rehearse it on a Neon branch.

## 4. Data rollback — Neon point-in-time restore / branching

Neon keeps history for the project's history-retention window (plan-dependent; check *Project settings → Storage →
History retention* — on the Free plan it is short). Two ways back:

1. **Branch from a timestamp (preferred — non-destructive).** Neon console → *Branches → Create branch* → parent
   `main`, "Point in time" = just before the bad deploy/migration. Inspect it with `psql`. To switch production to
   it: set the Vercel `DATABASE_URL` (Production) to the new branch's connection string (pooled for the app; direct
   for migrations) and redeploy/promote. The old branch stays available for forensics.
2. **Restore the branch in place.** Neon console → branch `main` → *Restore* → timestamp. Neon keeps a backup branch
   of the pre-restore state. Everything written after the timestamp is gone (sign-ins, audit rows, collector events).

After either: open `/admin/readiness` → *Production configuration* (migrations applied vs files) and *Monitoring*
(audit chains verify). A restore that predates 0005 shows 0005 as missing until the matching app build is promoted or
migrations are re-applied (`DATABASE_URL=<direct> npm run db:migrate`).

## 5. Rehearsal (to pass the `rollback` and `backup_restore` gates)

1. Create a Neon branch from 1 hour ago; point a **Preview** deployment's `DATABASE_URL` at it; sign in; compare row
   counts of `organizations`, `users`, `audit_log` with production. Record:
   `npm run readiness:record -- --gate backup_restore --status pass --environment production --command "neon branch create --parent main@<ts>; preview <url>" --evidence "<counts>"`
2. In a quiet window, promote the previous production deployment, check `/api/health` version, promote the current one
   back. Record the `rollback` gate the same way.
