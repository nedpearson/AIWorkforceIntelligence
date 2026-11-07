# Engineering conventions (read before touching code)

## Stack
Next.js 15 App Router + TS strict, Tailwind v4 (tokens in `src/app/globals.css`), Drizzle + Postgres 16, Auth.js v5, Vitest, Playwright.
Local DB: `postgresql://bridgebox:bridgebox@localhost:5432/bridgebox` (test DB: `bridgebox_test`). `npm run db:reset` rebuilds + seeds.

## Tenancy — non-negotiable
- Every tenant-scoped query runs through `withTenant(orgId, tx => ...)` from `src/db/tenant.ts`. It sets `app.current_org` and switches to the RLS-enforced `bridgebox_app` role. Even if you also filter by `orgId` (do both).
- `db` from `src/db/client.ts` is the admin handle: only for auth, collector-token lookup, job runner, seed/tests, and cross-org consultancy views that explicitly check parent/child.
- Never accept `orgId` from the request. Get it from `requireCtx()` / `requireApiCtx()` in `src/lib/session.ts`.
- Check permissions with `requireCtx("perm")` (page) or `requireApiCtx("perm")` (route). Matrix in `src/lib/rbac.ts`.
- Write an `audit()` (`src/lib/audit.ts`) for every mutation.

## Numbers
- Every analytical number persisted or shown carries a `basis` (`observed|estimated|assumed`) and, for money, a `CalcTree` (`src/db/schema.ts`) rendered by `<CalcTreeView>` (`src/components/calc-tree.tsx`).
- All formulas live in `src/engine/costing.ts`. Do not re-derive savings math elsewhere.
- Numeric columns come back from Postgres as strings — wrap with `num()` from `src/lib/utils.ts`.
- Time saved ≠ payroll cut. Always show gross vs realizable, projected vs verified.

## UI
- Primitives in `src/components/ui/index.tsx` (`Card, CardHeader, Button, Badge, BasisChip, Input, Select, Textarea, Modal, Tooltip, Empty, PageHeader, Table/Th/Td`). Use them; don't add a component library.
- Pages are server components that load data inside `withTenant` and pass plain JSON to `"use client"` components for interactivity. Server actions live next to the page in `actions.ts` (`"use server"`), validated with zod, permission-checked, audited.
- Every interactive element gets a `data-testid`. Every page handles the empty state with `<Empty>` + a next action. No placeholder metrics. If a feature depends on an unconfigured integration, say so in the UI with the exact env var / license needed.
- Plain English labels; a `Tooltip` on anything a non-technical owner might not understand.
- Charts: Recharts; colors from CSS tokens (`--color-brand`, `--color-money`, `--color-projected`, `--color-verified`, `--color-warn`). Projected = purple, Verified = teal, everywhere.
- Mobile-first: works at 375px. Tables scroll horizontally inside `<Table>`.

## Files
- `src/engine/*` pure logic + DB orchestration, unit tested in `tests/unit/*.test.ts`.
- `src/app/app/<area>/page.tsx` client-facing app; `src/app/admin/*` consultancy portal; `src/app/api/*` route handlers (collector ingest, webhooks, assistant).
- Scripts: `scripts/*.ts` run with `tsx` — never import `server-only` from anything they reach (engine, db, lib/crypto, lib/audit).

## Honesty
- Integrations that need a license/credentials we don't have (Power Automate, UiPath, Mimica, Stripe live, n8n live) must be implemented against the real API shape, carry `status: license_required|not_configured`, be surfaced in the UI as such, and documented in `docs/INTEGRATIONS.md`. Never fake a success.
