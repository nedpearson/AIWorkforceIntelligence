# Findings from the e2e acceptance suite

Application issues discovered while writing and running `tests/e2e`. None were patched in app code; each is either
worked around in the spec with a note, or captured as a `test.fixme` that points here.

## 1. `<Button href>` drops `data-testid` (and every other prop) — FIXED in Phase A

- **Where:** `src/components/ui/index.tsx`, `Button`:
  `if (href) return <Link href={href} className={cls}>{children}</Link>;` — the rest-props (`...p`) are only spread on
  the `<button>` branch.
- **Effect:** every link-style button renders without its `data-testid`, contradicting `docs/CONVENTIONS.md`
  ("Every interactive element gets a `data-testid`"). Affected testids include `automate-<id>` (opportunity cards,
  executive top-opportunities), `opp-automate`, `opp-use-template`, `wf-automate`, `exec-onboarding`, `exec-reports`,
  `exec-empty-cta`, `finance-empty-cta`, `consent-go-employees`, `agents-new`, `agents-approvals`, `agents-credentials`
  and the "Back"/"All agents" links. (The admin portal avoids this with `LinkButton`.)
- **Repro:** sign in as `admin@gulfcoast.demo`, open `/app/opportunities`, inspect the "Automate this" link on any card:
  `<a href="/app/agents/new?opportunityId=…" class="…">` — no `data-testid` attribute.
- **Failing assertion (first run of `agents.spec.ts`):**
  `expect(count, "an opportunity without an agent is available").toBeGreaterThan(0)` → `Received: 0` for
  `page.getByTestId("opp-list").locator("a[data-testid^='automate-']")`.
- **Suite handling:** `agents.spec.ts` locates "Automate this" by accessible name (`getByRole("link", { name: "Automate this" })`)
  and says so in a comment. Not marked fixme because the user-visible behaviour is correct; only the test hook is missing.
- **Suggested fix:** `if (href) return <Link href={href} className={cls} {...(p as object)}>{children}</Link>;`
  (filter out button-only props such as `type`/`disabled`).

## 2. (FIXED in Phase A — the default-dates test passes) "New campaign" default start date is the UTC date, stored as local midnight → events dropped until tomorrow

- **Where:** `src/app/app/collection/collection-client.tsx`, `emptyForm()`:
  `startsAt: new Date().toISOString().slice(0, 10)` (UTC calendar date), later submitted as
  `new Date(f.startsAt + "T00:00:00").toISOString()` (local midnight of that date). `endsAt` has the same shape.
- **Effect:** in the organization's time zone (`America/Chicago`, the schema default) between 18:00 and 23:59 local
  the default "Starts" is **tomorrow**. A campaign created with the defaults and started immediately is shown as
  `running`, but `/api/collect/events` rejects everything with `outside_campaign_window` until local midnight, and the
  Trust page tells employees they are being observed while nothing is recorded. Any UTC-negative time zone is affected
  for part of every day.
- **Repro (as `admin@gulfcoast.demo`, browser in America/Chicago, between 18:00 and 23:59 local):**
  1. `/app/collection` → Campaigns → New campaign → name it, untick "Only observe on these days and hours", keep the
     default dates → Create → Start.
  2. `observation_campaigns.starts_at` is `tomorrow 06:00+00` (observed: created at 03:50 UTC, `starts_at = 2026-11-07 06:00:00+00`).
  3. Create an enrollment code, `POST /api/collect/enroll`, `POST /api/collect/consent`, then
     `POST /api/collect/events` with `ts = now`.
- **Failing assertion (first run of `collection.spec.ts`):**
  `expect(b).toMatchObject({ accepted: 20, dropped: 0 })` → received
  `{"accepted":0,"dropped":20,"reasons":{"outside_campaign_window":20}}`.
- **Suite handling:** the main collection test sets explicit local dates (yesterday → +14 days) so it exercises the rest
  of the flow; `collection.spec.ts` carries a `test.fixme` ("a campaign created with the form's default dates accepts
  events immediately…") that reproduces this with the defaults. The fixme only fails during the affected hours.
- **Suggested fix:** build the default from local date parts (`getFullYear/getMonth/getDate`) or send the date string and
  let the server interpret it in `organizations.timezone`.

## 3. `/favicon.ico` returns 404 → a console error on every page

- **Where:** no `src/app/icon.*`, `src/app/favicon.ico` or `public/favicon.ico`.
- **Effect:** Chromium logs `Failed to load resource: the server responded with a status of 404 (Not Found)` on every
  page load; the "no console errors" checks had to whitelist it (`IGNORED_CONSOLE` in `nav.spec.ts`).
- **Repro:** `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/favicon.ico` → `404`.
- **Suggested fix:** add `src/app/icon.svg` (or `public/favicon.ico`).

## 4. Seeded consent records carry a notice version that does not match the organization's current notice

- **Where:** `scripts/seed.ts` inserts `consent_records.notice_version = "2026-10-v1"`, while the org has no
  `settings.noticeVersion`, so the current notice version is `DEFAULT_NOTICE_VERSION = "1"` (`src/collector-protocol/schema.ts`).
- **Effect:** on `/app/collection` → Notice & consent, all six Gulf Coast employees show consent **outdated** (the
  "Consent by employee" summary reads `0 acknowledged · … 6 missing/outdated`), the Notice & consent tab dot is amber, and
  the enrollment-code employee picker labels everyone `(consent: outdated)`. The seed comment and the demo narrative say
  the baseline campaign was fully consented. (The collector API itself still accepts events because
  `consentState()` ignores the version — so the UI and the ingest path disagree about the same employees.)
- **Repro:** `npm run db:reset`, sign in as `admin@gulfcoast.demo`, open `/app/collection` → Notice & consent.
  DB: `select distinct notice_version from consent_records` → `2026-10-v1`; `select settings->>'noticeVersion' from organizations where slug='gulf-coast-supply-demo'` → `null`.
- **Suite handling:** no test depends on seeded consent status; `collection.spec.ts` acknowledges consent for the
  employee it enrolls through the collector API (version `1`), which is what the UI then shows as acknowledged.
- **Suggested fix:** seed consents with `DEFAULT_NOTICE_VERSION` (or set `settings.noticeVersion = "2026-10-v1"` on the org),
  and decide whether `consentState()` in `src/app/api/collect/_lib.ts` should also require the current version.

## Phase A verification (2026-11-07)

5. **Type filter on /app/opportunities had no options** — `page.tsx` (server) imported `OPP_TYPE_LABEL` from the
   `"use client"` module `opportunity-card.tsx`, so it received a client-reference proxy and `Object.entries()` was `[]`.
   Same pattern in `/app/search` (`OPP_STATUS_TONE`, badge tones undefined). Fixed: constants moved to
   `src/components/dashboard/opportunity-meta.ts` (re-exported from the card). Covered by `opportunities.spec.ts`.
6. **Excel / PDF exported from /app disagreed with the screen once custom assumptions were saved** — the command center
   always sent `scenario=expected`, which applies the Expected preset, while the page shows the saved model. Repro: save
   adoption 50% on /app/finance → /app net $22,715, workbook $42,455. Fixed in `command-center.tsx` (only pin a scenario the
   user picked) and `generateExecutiveReport` (no scenario → saved model). Covered by `reconciliation.spec.ts`.
7. **Hidden tooltips widened the page** (`Tooltip`, opacity-0 popover at the right edge → `/admin` 1504 px wide at 1440).
   Now `display:none` until hover/focus; the info icon is keyboard-focusable and carries the text as its name.
8. **Accessibility** (axe, 106 page×theme scans): 49 serious/critical page-level failures before → 0 after. See the report.
9. **Leftover running e2e campaigns captured events** of later runs (events go to the first matching running campaign),
   making `collection.spec.ts` order-dependent. The spec now completes its own campaigns.
10. **Crawl hazard**: a select on /app/settings/members saves on change; an unrestricted crawl promoted the seeded manager
    to owner. The crawl only changes view/filter controls now; the manager row was restored.

## Phase B verification (AI Workforce, 2026-11-07) — all fixed in app code

1. **Floating "Ask AI" launcher covered the Send button on `/app/assistant`** (`assistant-search.spec.ts` failed: the click
   on `assistant-send` was intercepted by `assistant-launcher`; the panel also duplicated the page's `assistant-*` testids).
   Fixed in `src/components/assistant/assistant-panel.tsx`: no launcher/panel on `/app/assistant` (it is the assistant).
2. **Launcher failed WCAG 2.5.3 Label in Name** (axe `label-content-name-mismatch`, serious, on every page): visible "Ask AI",
   accessible name "Open the AI assistant (press / or Ctrl+K)". Fixed: name comes from the visible text; the hint is a `title`.
3. **Demo PO register could never match** — `parsePoRegister` required ≥ 3 digits right after `PO-`, so the AI Brain demo
   register's `PO-24-1194` rows were ignored and every live invoice reported "no PO source connected". Repro: pilot Charlotte at
   act_with_approval, live `process_invoice` with `Purchase Order: PO-24-1194` → `poMatch.status = "no_source"`. Fixed in
   `src/engine/skills/invoice.ts` (year-prefixed numbers, ≥ 3 digits total); unit test in `skills-parser.test.ts`.
4. **Pilot AI employees had no runtime agent** → live skill runs never reached the run ledger, so no verified savings could
   ever be measured for them (`employeeFinancials` note "No executable agent is linked"). Fixed: `setStatus(…, "pilot"|"active")`
   calls the new `src/engine/workforce/pilot-agent.ts#ensurePilotAgent` — reuses the employee's / opportunity's agent, else
   creates one from the matching template (process_invoice → `ap_ar_invoice_intake`), status `deployed`, internal runtime,
   schedule removed, version 1 recorded, audited (`agent.created` + `ai_employee.agent_linked`); never changes permission or
   the opportunity's status. Unit-tested in `workforce.test.ts`.
5. **"View my work" / "Review my savings" showed stale runs** after a task was run in "Assign me a task" (history.replaceState +
   router.refresh kept the old page segment's props). Fixed in `profile.tsx`: those tabs navigate with `router.replace`.
6. **Run history had no steps or approval** — "View my work" now lists each run's steps and its approval decision; the profile
   Savings tab links to the linked agent's Results tab to record a measurement.
7. **Approval summary** read "Approved by a owner and completed." and dropped the posting result. Now "Approved by an owner and
   completed. Draft posted to BridgeBox AP queue — no accounting system connected (…)" (`src/engine/skills/index.ts`).
8. **Workforce server actions surfaced `NEXT_REDIRECT`** as the error text when a role lacked the permission (requireCtx
   redirects inside try/catch). Now "Your role can't do this (requires agents:write)." (`src/app/app/workforce/actions.ts`).
9. **Manager's work queue offered "Approve" on over-threshold runs** the server then refused. Now shows "Over the approval
   threshold — an owner or admin must approve" (server check unchanged).
10. **Assistant navigate allow-list accepted dot segments** — `/app/workforce/../../admin` passed the prefix check and resolves
    to `/admin`. Fixed in `isAllowedHref` (raw and percent-encoded dot segments rejected); unit + e2e tests.
11. Crawl safety: "retire", provisioning ("Meet", "Add all 26 …"), permission/lifecycle/portrait controls and sandbox-run
    buttons are never clicked by the crawler (a crawl click on "Retire" would have permanently retired a seeded AI employee).

Known, not changed: the live approval reason cites the first AI Brain sentence that states the $5,000 threshold, which is the
PO register's note ("Purchase orders over $5,000 follow the controller approval threshold …") rather than the AP Policy
itself — same threshold and approver, less precise source.
