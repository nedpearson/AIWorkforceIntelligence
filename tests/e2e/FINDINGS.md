# Findings from the e2e acceptance suite

Application issues discovered while writing and running `tests/e2e`. None were patched in app code; each is either
worked around in the spec with a note, or captured as a `test.fixme` that points here.

## 1. `<Button href>` drops `data-testid` (and every other prop)

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

## 2. "New campaign" default start date is the UTC date, stored as local midnight → events dropped until tomorrow

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
