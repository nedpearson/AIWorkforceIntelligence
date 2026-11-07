# Phase A brief — read fully before writing code

You are one of five engineers upgrading **BridgeBox AI Workforce Intelligence** (`/home/claude/bridgebox`, Next.js 15 App Router, TS strict, Tailwind v4, Drizzle + Postgres 16, Auth.js) into a Fortune-500-grade product. Others work in the same tree **concurrently**. Touch ONLY files you are told you own. If you need a change in a shared file, write the smallest local alternative in your own folder and mention it in your report.

## Must-read (in order)
`docs/CONVENTIONS.md` · `src/db/schema.ts` · `src/components/ui/index.tsx` · `src/components/ui/enterprise.tsx` (NEW kit: KpiCard, AnimatedNumber, SectionHeader, Tabs, Segmented, ScoreRing, Meter, StatusPill, Drawer, ExportButton, InsightCard, FilterBar, CheckRow, ACCENT_HEX) · `src/components/app-shell.tsx` (NAV_GROUPS — the routes you build) · `src/app/globals.css` (tokens) · `src/engine/finance.ts` + `finance.types.ts` (computeOrgFinancials — single source of truth for financial numbers) · `src/engine/savings.ts` (Savings Intelligence Engine — 7 tiers, lineage, reconciliation; single source of truth for savings) · `src/components/calc-tree.tsx` · `src/lib/session.ts`, `src/lib/rbac.ts`, `src/db/tenant.ts` · an existing page pair for patterns, e.g. `src/app/app/opportunities/page.tsx` + its client component · `src/components/charts/*` (Recharts wrappers & theme).

## Design language (non-negotiable)
- Palette meaning: **gold** = financial opportunity / projected, **emerald** = verified / realized, **purple** = AI, **cyan** = automation, **coral** = risk, **royal** = primary/navigation, **indigo** = premium highlight, **midnight** = executive surfaces. Use token classes (`bg-gold-soft text-gold-ink`, `text-emerald-ink`, …). Hex for charts via `ACCENT_HEX`. `*-ink` tokens are the only text colors allowed on these hues (contrast).
- Module landing pages use `<PageHeader hero eyebrow="…" icon={…} …/>`; inner sections use `<SectionHeader accent=…>`. KPIs use `<KpiCard>` (animated, clickable → drill-down showing a CalcTree via `<CalcTreeView>`). Cards get `card card-hover`. Lists animate with `stagger`.
- Must look excellent in **light and dark** (`data-theme`), at **390px** and **1440px**. Tables scroll inside `<Table>`. No horizontal page scroll.
- Accessibility: WCAG 2.2 AA: labelled controls, keyboard reachable, visible focus, `aria-*` on custom widgets, charts get a text alternative (aria-label/summary).

## Data integrity (non-negotiable)
- Every number comes from the DB via the engines (`computeOrgFinancials`, `computeSavingsIntelligence`, or a new engine function you own). No hardcoded metrics, no invented benchmarks, no fake integrations, no fake AI output. Each financial number is clickable to its CalcTree / lineage.
- Tenant data via `withTenant(ctx.orgId, …)`; permission via `requireCtx("perm")`; mutations are server actions (zod, permission, `audit()`), next to the page in `actions.ts`.
- Numeric DB columns are strings → `num()`.
- Time saved ≠ payroll cut. Never recommend terminating individuals. Staffing/role recommendations are framed as capacity and require management + HR/legal review (say so in UI).
- Global filters: use `<FilterBar>` (URL params `bu, dept, loc, role, wf, agent, from, to, scenario, status, risk, savings`). Read them server-side from `searchParams` and actually filter.
- Every interactive element: `data-testid`. Every page: meaningful empty state with next action.

## Environment
- Your DB, port and build dir are given in your task. Run dev as `NEXT_DIST_DIR=.next-<you> DATABASE_URL=<yours> npx next dev -p <port>`. Never run `npm run db:reset` on another engineer's DB. Never `next build` into `.next`. Before finishing: `npx tsc --noEmit` must be clean for your files; run your unit tests with your DATABASE_URL; screenshot your pages with Playwright (`require('/home/claude/bridgebox/node_modules/playwright')`, chromium preinstalled — do NOT run playwright install) at 1440 light, 1440 dark (`colorScheme: 'dark'`), and 390 light; **look at the screenshots** (Read tool) and fix what looks wrong. Save shots to `/tmp/claude-0/-home-claude/e1b1e815-e513-58d3-b9a3-f097358285d9/scratchpad/phaseA/<you>/`.
- Logins (password `Demo!Pass123`): `admin@gulfcoast.demo` (client owner — use this for most work), `manager@gulfcoast.demo` (manager), `owner@bridgebox.demo` (consultancy owner), `admin@bayoudental.demo` (other tenant, empty).
- Do not commit; the lead commits.

## Report back
Files created/changed, engine function signatures, tests run + results, screenshot paths you reviewed, anything shared you needed changed, anything not done.
