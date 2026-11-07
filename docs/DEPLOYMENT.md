# Deployment

Two supported shapes — (A) Vercel + managed Postgres, (B) Docker Compose on one host — plus collector rollout,
Windows development notes, and backup / upgrade / rollback procedures. Secrets never go in the repo; `.env.example`
is the list, `.env` is git- and docker-ignored.

## Environment variables (every key in `.env.example`)

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres connection string. The role must own the schema (migrations run `CREATE ROLE bridgebox_app`, `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `GRANT`). It is an admin credential — see `docs/SECURITY.md` §12. |
| `AUTH_SECRET` | **yes** | Auth.js JWT/cookie signing key, ≥ 32 bytes. Also the HMAC key for IP/hostname hashes. Rotating it signs everyone out. `openssl rand -base64 32` |
| `AUTH_URL` | **yes** | Canonical public URL (`https://app.example.com`). Used for OAuth callbacks and absolute links. |
| `NEXT_PUBLIC_APP_URL` | **yes** | Same URL, exposed to the browser (invite links, collector install commands). |
| `VAULT_KEY` | **yes** | 32-byte base64 AES-256-GCM key for `credentials` and MFA secrets. Without it the vault, MFA and agent runs throw. `openssl rand -base64 32` |
| `CRON_SECRET` | **yes** (for jobs) | Shared secret for `/api/jobs/run` (`x-cron-secret` header or `Authorization: Bearer`). Vercel sends the Bearer form automatically for cron routes when this env var is set. `openssl rand -hex 32` |
| `N8N_BASE_URL`, `N8N_API_KEY` | no | Platform-wide n8n fallback; per-client config in Settings → Integrations overrides it. |
| `STRIPE_SECRET_KEY` | no | `sk_test_…` / `sk_live_…`. Without it billing says "Stripe is not configured" and names the missing vars. |
| `STRIPE_WEBHOOK_SECRET` | no | `whsec_…` for `POST /api/billing/webhook` (503 when unset, 400 on bad signature). |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_ENTERPRISE` | no | Recurring Price ids for the three plans. |
| `STRIPE_PRICE_EXTRA_SEAT`, `STRIPE_PRICE_EXTRA_AGENT` | no | Per-unit recurring Prices for add-ons; a checkout with extra seats/slots refuses without them. (Used by `src/engine/billing.ts`; added to `.env.example` by this doc set.) |
| `ANTHROPIC_API_KEY` | no | Enables the assistant's LLM mode and agent `llm` nodes. Unset → deterministic retrieval / `skipped`. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | no | Registers the "Single Sign-On" provider when issuer + client id are present. |
| `POWER_AUTOMATE_TENANT_ID`, `POWER_AUTOMATE_CLIENT_ID`, `POWER_AUTOMATE_CLIENT_SECRET` | no | Reserved for the Power Automate Process Mining adapter; the adapter reports `license_required` regardless in this build. |
| `UIPATH_ORG`, `UIPATH_TENANT`, `UIPATH_CLIENT_ID`, `UIPATH_CLIENT_SECRET` | no | Same, UiPath Task Mining. |
| `MIMICA_API_KEY` | no | Same, Mimica. |
| `SEED_PASSWORD` | no | Password for seeded demo accounts (`scripts/seed.ts`), default `Demo!Pass123`. Dev only. |
| `WORKER_POLL_MS` | no | `scripts/worker.ts` poll interval, default 5000. |
| `E2E_BASE_URL`, `E2E_TZ` | no | Playwright target and browser time zone (defaults `http://localhost:3000`, `America/Chicago`). |

Generate the three secrets:

```bash
# bash / macOS / WSL
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # VAULT_KEY
openssl rand -hex 32      # CRON_SECRET
```
```powershell
# PowerShell 7
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))   # AUTH_SECRET / VAULT_KEY
[Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()   # CRON_SECRET
```

## A. Vercel + managed Postgres (Supabase or Neon)

### 1. Database
- **Supabase:** create a project, open *Project Settings → Database*. Use the **direct / session-mode** (port 5432)
  connection string for `npm run db:migrate` (`rls.sql` is a multi-statement script with `DO` blocks). For the app,
  the transaction-mode pooler (port 6543) is acceptable: `withTenant` sets `app.current_org` and the role with
  `set_config(…, is_local = true)` inside one explicit transaction, so nothing leaks between pooled connections, and
  `src/db/client.ts` already sets `prepare: false` (required by PgBouncer transaction mode). If in doubt, use session
  mode everywhere; the app opens at most 10 connections per instance (`max: 10`).
- **Neon:** same rule — direct string for migrations; pooled string for the app is fine.
- Run migrations from your machine or CI, never from a Vercel build step:
  ```bash
  DATABASE_URL="postgresql://…" npm run db:migrate     # drizzle migrations, then drizzle/rls.sql
  ```
  `rls.sql` is idempotent (DROP POLICY IF EXISTS / CREATE) and must run after **every** schema migration because
  `ALTER DEFAULT PRIVILEGES` only covers new tables and policies are per table. `scripts/migrate.ts` does both.
- Seeding synthetic demo data into production is optional: `npm run db:seed` (never `db:reset`, which drops the schema).

### 2. Vercel project
1. Import the repo; framework preset Next.js; Node 22. Build command `npm run build`, no custom output directory.
2. Environment variables: every **required** row above plus whichever integrations you use, for Production and
   Preview. `AUTH_URL` / `NEXT_PUBLIC_APP_URL` must match the deployed domain.
3. `vercel.json` (committed) schedules `GET /api/jobs/run` every 5 minutes. Vercel adds `Authorization: Bearer
   $CRON_SECRET` when the `CRON_SECRET` env var exists; the route accepts that form. Cron frequency below daily
   requires a Pro plan. The route runs up to 10 jobs per tick within `maxDuration = 60`.
4. Large tenants: `runAnalysis` on tens of thousands of events can exceed 60 s. Run `npm run worker` on a small VPS or
   container pointed at the same database (it is safe to run alongside the cron tick).
5. Add the domain, confirm HSTS is on at the platform (the app does not set it; `docs/SECURITY.md` §8).

### 3. Stripe
- Webhook endpoint: `https://<your-domain>/api/billing/webhook`, events `checkout.session.completed`,
  `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
  `invoice.payment_failed`. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.
- Create recurring Prices for Starter $499, Growth $1,499, Enterprise $4,999 and (optional) extra seat $19 / extra
  agent $149; put the ids in the `STRIPE_PRICE_*` vars.
- Local testing: `stripe listen --forward-to localhost:3000/api/billing/webhook`.

### 4. OIDC SSO
- **Microsoft Entra ID:** App registration → Web platform → redirect URI
  `https://<domain>/api/auth/callback/oidc`; `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`;
  client id + a client secret. Ensure the `email` claim is emitted (add the optional claim or use `preferred_username`
  mapping in `src/lib/auth.ts` `profile()` if your tenant does not send `email`).
- **Okta:** Applications → Create App Integration → OIDC Web; redirect URI as above;
  `OIDC_ISSUER=https://<org>.okta.com` (or the custom authorization server URL); client id/secret.
- **Google Workspace:** `OIDC_ISSUER=https://accounts.google.com`.
- Behaviour: first SSO login creates the user just-in-time; they still need an invitation/membership to see an org.
  **This path has not been exercised against a live provider** (`docs/PRODUCTION_READINESS.md`).

### 5. n8n
Options: n8n Cloud (set `N8N_BASE_URL=https://<workspace>.app.n8n.cloud`, API key from *Settings → n8n API*), or
self-host (profile `n8n` in `docker-compose.yml`, or any container host). Per-client n8n instances are configured in
Settings → Integrations and stored as a vault credential. Credentials for the client's SMTP / QuickBooks / Zendesk live
inside n8n; the exported workflow JSON references them by name.

## B. Docker Compose on one host

`Dockerfile` is a plain multi-stage `node:22-alpine` image: `npm ci` → `next build` → runtime with the full
`node_modules` (the worker and migrate scripts run through `tsx`, a devDependency; keeping one image and zero code
changes was preferred over `output: "standalone"`, which is not set in `next.config.ts`). Image ≈ 600 MB.

```bash
cp .env.example .env
# fill: AUTH_SECRET, AUTH_URL=https://app.example.com, NEXT_PUBLIC_APP_URL, VAULT_KEY, CRON_SECRET
# DATABASE_URL=postgresql://bridgebox:bridgebox@db:5432/bridgebox   (db = the compose service)
docker compose build
docker compose up -d db
docker compose run --rm migrate                    # migrations + RLS
docker compose run --rm migrate npm run db:seed    # optional synthetic demo
docker compose up -d app worker
docker compose --profile n8n up -d                 # optional n8n (needs N8N_ENCRYPTION_KEY in .env)
```

Services: `db` (postgres:16-alpine, volume `pgdata`, not published), `app` (`npm run start`, :3000), `worker`
(`npm run worker` — no cron needed; it enqueues housekeeping itself), `migrate` (profile `tools`, one-shot), `n8n`
(profile `n8n`). Put Caddy/nginx/Traefik in front of `app:3000` for TLS and HSTS; set `AUTH_URL` to the public URL.

Health: `docker compose ps` (the app has a `HEALTHCHECK` on `/login`), `docker compose logs -f worker`.

## C. Collector rollout

Full detail in `docs/COLLECTOR.md` and `collector/README.md`. Sequence per client:

1. Owner signs the **Authorization** on Data Collection. Publish the **Notice** (or keep the default).
2. Create a **Campaign** (dates, departments/people, schedule, `titleMode`, extra blocked apps) and start it.
3. Build the collector (`cd collector && npm install && npm run build`; single binaries via `@yao-pkg/pkg`, see README).
   **Binaries are unsigned in this build**: Windows SmartScreen and macOS Gatekeeper will warn or block. Code signing
   + notarization is roadmap item 5.2.
4. Issue **enrollment codes** (one per employee, 7-day, single use; seat limits apply) and deliver them out of band.
5. Deploy via Intune / GPO / Jamf samples in `collector/README.md` (samples, not validated against a tenant), with
   `BRIDGEBOX_URL` set to `NEXT_PUBLIC_APP_URL`. macOS needs Screen Recording permission (PPPC profile).
6. Watch **Collectors** health tiles; `offline` after 15 minutes without heartbeat. Employees manage pause/withdraw on
   `/app/trust`.
7. After the campaign: **Run analysis now** (enqueues the `analysis` job; the worker or cron must be running).

## D. Windows development notes (PowerShell)

- Install Node 22 LTS and Postgres 16 (installer or `winget install PostgreSQL.PostgreSQL.16`). Create the role/db:
  ```powershell
  & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE ROLE bridgebox LOGIN PASSWORD 'bridgebox' CREATEDB;"
  & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE DATABASE bridgebox OWNER bridgebox;"
  ```
- `Copy-Item .env.example .env`, then edit. Generate secrets with the PowerShell snippets above (no `openssl` needed).
- `npm i; npm run db:reset; npm run dev` — all npm scripts are cross-platform (`tsx`, `next`, `drizzle-kit`; no bash
  in `package.json`).
- Setting env vars per command: `$env:DATABASE_URL="postgresql://bridgebox:bridgebox@localhost:5432/bridgebox_test"; npx vitest run`
  (the `VAR=value cmd` form is bash-only). Use `Remove-Item Env:DATABASE_URL` to unset.
- Playwright: `npx playwright install chromium` once; `npm run test:e2e`. The config starts the production build
  itself if nothing listens on :3000. Line endings: keep `core.autocrlf=false` or `.gitattributes` LF to avoid
  Prettier/tsc noise.
- Docker Desktop with WSL2 backend runs `docker-compose.yml` unchanged. Inside WSL use the Linux instructions.
- Collector on the dev machine: `npm run collector:dev -- --simulate --accept-notice` (synthetic day, no `active-win`).
  Real sampling on Windows: `cd collector; npm install; npm run build; node dist\collector\src\index.js --url http://localhost:3000 --enroll-code BB-…`.

## E. Backup, restore, upgrade, rollback

### Backup
- Everything is in Postgres (including PDFs and the audit log). Managed providers: enable daily backups + PITR
  (Supabase Pro / Neon history). Self-hosted:
  ```bash
  docker compose exec -T db pg_dump -U bridgebox -Fc bridgebox > bridgebox-$(date +%F).dump
  ```
  Ship dumps off-host (object storage) and test a restore monthly.
- Also back up `.env` (or the secret manager entries): **`VAULT_KEY` loss makes every stored credential and MFA
  secret unrecoverable.**
- Collector state lives on employee machines and is disposable (re-enrol).

### Restore
```bash
docker compose stop app worker
docker compose exec -T db dropdb -U bridgebox bridgebox && docker compose exec -T db createdb -U bridgebox bridgebox
docker compose exec -T db pg_restore -U bridgebox -d bridgebox --no-owner < bridgebox-YYYY-MM-DD.dump
docker compose run --rm migrate            # re-applies rls.sql (roles/policies are in the dump, this is a safety net)
docker compose start app worker
```

### Upgrade
1. Take a backup.
2. Pull the new version; `npm run db:generate` is only for developers — production applies committed migrations:
   `npm run db:migrate` (Vercel: from CI/your machine; Compose: `docker compose run --rm migrate`).
3. Deploy the app (Vercel deploy / `docker compose build && docker compose up -d app worker`).
4. Smoke test: `/login`, `/app` as the demo owner, `GET /api/jobs/run` with the secret returns `ok: true`.

Migrations are additive by convention; a release that drops or renames a column must ship a two-step migration (add →
backfill → remove in the next release) so that rollback remains possible.

### Rollback
- **App only:** Vercel → promote the previous deployment; Compose → `docker compose up -d` with the previous image
  tag. Safe whenever the schema change was additive.
- **Schema:** Drizzle has no down migrations. Restore the pre-upgrade dump (above), then redeploy the previous app
  version. Accept the data loss window or replay the audit log by hand.
- **Secrets:** rotating `AUTH_SECRET` back restores old sessions only until they expire (12 h); rotating `VAULT_KEY`
  back is required if credentials were saved under the old key and no re-encryption tool was run.
