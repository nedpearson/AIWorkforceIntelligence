# Privacy by design

How BridgeBox limits what it knows about employees, and where each limit is enforced. This is an engineering
document, not legal advice; §10 lists compliance considerations for counsel to confirm per client and jurisdiction.

## 1. What is collected, what is not

The wire protocol (`src/collector-protocol/schema.ts`) is the contract. A `WireEvent` has exactly these fields:

| Field | Content | Example |
|---|---|---|
| `ts` | timestamp | `2026-11-06T14:02:11-06:00` |
| `type` | one of 14 event kinds: `app_focus`, `app_switch`, `idle_start`, `idle_end`, `click_burst`, `navigation`, `data_entry`, `copy_paste`, `document_open`, `document_save`, `form_submit`, `print`, `email_compose`, `handoff` | `data_entry` |
| `app` | normalised application name (≤ 80 chars) | `QuickBooks` |
| `appCategory` | coarse app class | `accounting` |
| `titleCategory` | coarse document class derived on-device from the window title by regex (`collector/src/normalize.ts`) | `invoice` |
| `titleHash` | `HMAC-SHA256(normalised title, per-machine random salt)[:24]`; the salt never leaves the machine, so the server cannot reverse or even compare hashes across machines | `k3f9…` |
| `durationMs` | 0 … 24 h | `184000` |
| `meta` | flat map, ≤ 32 keys, values are finite numbers / strings ≤ 64 chars / booleans. **Keys containing** `key`, `text`, `title`, `url`, `content`, `clipboard`, `password`, `screenshot`, `body`, `message`, `subject`, `filename`, `path` **are rejected** (`isForbiddenMetaKey`); the only allowed exception is `keysCount` (a count, never contents) | `{ fieldCount: 12, pasteCount: 3 }` |

Never collected, and structurally impossible to send through this schema: keystrokes, clipboard contents,
screenshots, URLs, raw window titles, file names, email/chat/document contents, and anything from blocked apps.
`DEFAULT_BLOCKED_APPS` covers password managers (1Password, Bitwarden, LastPass, KeePass, Dashlane, Keychain),
banking/finance (Quicken, Mint, named banks), health (MyChart, "health", "medical", "therapy", BetterHelp) and
personal messaging (Signal, WhatsApp, Telegram, iMessage/Messages); organizations and campaigns add their own. The
collector skips blocked apps before normalisation; the server drops them again with reason `blocked_app`.

The collector has no input hooks and ignores `active-win`'s `url` field; the raw title exists only inside
`normalize.ts` and is discarded in memory. `tests/unit/collect-api.test.ts` ("content-bearing meta → 400") and
`tests/e2e/collection.spec.ts` (forbidden meta key rejected) exercise the schema gate.

## 2. Authorization record (employer side)

Before any campaign can start, an owner/officer must sign an `authorizations` row (`signer_name`, `signer_title`,
`scope`, `document_text`, timestamp) on **Data Collection → Authorization**. `setCampaignStatus` refuses to start a
campaign without one. The record is audited (`authorization.recorded`) and exported with the org's data.

## 3. Notice and consent (employee side)

1. The organization publishes a notice (`settings.noticeText` / `settings.noticeVersion`, default
   `DEFAULT_NOTICE_TEXT` v`1`; audited `notice.updated`). The default notice states what is and is not recorded, the
   pause/withdraw rights, retention, and that the purpose is finding repetitive work, not evaluating individuals.
2. On first run the collector prints the notice and waits for `y`; nothing is sampled until then. The acknowledgement
   is posted to `POST /api/collect/consent` and stored in `consent_records` (`notice_version`, `notice_text` as shown,
   `acknowledged_at`, `method = collector_ui`). A managed install may pass `--accept-notice` only when HR already
   delivered the notice; the record is still written.
3. The ingest gate (`consentState()` in `src/app/api/collect/_lib.ts`) drops every event unless the employee's latest
   consent record is acknowledged and not withdrawn (reason `consent_missing` / `consent_withdrawn`).
4. If the notice version changes, the Collection page shows the employee's consent as **outdated** and the collector
   re-prompts on its next config refresh. **Known inconsistency:** the ingest gate itself does not compare versions, so
   events keep flowing from an employee who acknowledged an older notice until they re-acknowledge or are paused.
   `docs/COLLECTOR.md` describes the gate as version-aware; the code is not. Tracked in `docs/SECURITY.md` §13.

Consent events are audited: `consent.requested`, `consent.acknowledged`, `consent.withdrawn`.

## 4. Employee controls — the Trust page (`/app/trust`, permission `self:read`, every role)

| Control | Effect | Where enforced |
|---|---|---|
| Read what is / is not collected, the current notice, the retention period, and the role-visibility matrix (generated from `PERMISSIONS`) | transparency | page |
| **Pause 1 hour / Pause until I resume / Resume** | `collectors.paused_until` or status `paused`; the server drops events with `collector_paused` even if a collector keeps sending | `trust/actions.ts`, `_lib.ts`; audited `collector.paused` / `collector.resumed` |
| **Withdraw consent & pause** | `consent_records.withdrawn_at` set and the employee's collectors paused | `consent-lib.ts`; audited `consent.withdrawn` |
| **Re-acknowledge** a new notice version | new consent row | audited `consent.acknowledged` |
| Collector CLI `pause [min]` / `resume` / `status` / `stop`; `SIGUSR1`/`SIGUSR2` on macOS/Linux | same server-side effect | collector `control.json` → heartbeat |

An employee login is linked to their employee row through `memberships.employee_id`; without that link the Trust page
shows the org-level information only.

## 5. Campaign boundaries

Collection happens only inside a `running` campaign that names the employee (directly, by department, or org-wide)
and only inside the campaign's daily schedule in the organization's time zone (`src/collector-protocol/schedule.ts`,
checked on both sides). Outside the window the collector sleeps; the server drops `outside_campaign_window` /
`no_active_campaign`. Campaign start/pause/complete are audited (`campaign.<status>`).

## 6. Data minimisation: `titleMode`

Per collector and per campaign (`CollectorConfig.titleMode`, server-enforced on ingest):

| Mode | Stored | Use when |
|---|---|---|
| `hash` (default) | `title_category` + salted `title_hash` | sequence detection needs to tell two documents of the same category apart |
| `category` | `title_category` only | the category is enough (demo seed uses this) |
| `none` | neither | app-level timing only |

Tested in `tests/unit/collect-api.test.ts` › `describe("titleMode")`.

## 7. Retention and deletion

- `organizations.retention_days` (default 180) is shown on the Trust page and in **Settings → Data & privacy**.
- The `retention_sweep` job deletes `activity_events` older than the cutoff for every org and audits the count
  (`retention.sweep`); it is enqueued hourly by the worker or on every cron tick. Owners can run it immediately
  (`runRetentionNow`, audited `privacy.retention_sweep`).
- **Delete all activity events** (owner only, must type the org name) wipes raw events and resets collector counters
  (`privacy.activity_events_deleted`). Derived workflows and opportunities remain; they contain aggregates, step
  sequences and up to 200 sample event ids per workflow, not raw events.
- Organization deletion cascades through every tenant table (`onDelete: cascade`).
- PDFs in `reports.pdf_bytes` and `savings_measurements` are not covered by the sweep.

## 8. Who sees what

| Data | owner / admin | consultant | manager | viewer | employee |
|---|---|---|---|---|---|
| Per-employee activity hours, workflows performed | ✓ | ✓ | ✓ | ✓ | own only (Trust page) |
| Employee compensation (`employees:cost:read`) | ✓ | ✓ | — | — | — |
| Raw `activity_events` | never shown as a list; only sample events on a workflow detail (category, app, duration) | same | same | same | — |
| Audit log | ✓ | ✓ | — | — | — |
| Reports (contain department and opportunity figures, never per-employee compensation) | ✓ | ✓ | — | — | — |
| Consultancy staff | any child client org, as `consultant` | | | | |

The analysis engine attributes workflows to performers (`workflow_employees`) so savings can be modelled per role; the
product narrative, the notice and the report methodology page all say the purpose is work design, not individual
performance review. That is a policy the client must honour; the software cannot enforce intent.

## 9. Access, export and erasure paths (DSAR-style)

| Request | Path today |
|---|---|
| "What do you hold about me?" (employee) | Trust page shows consent, collector status, campaign membership; a fuller per-person export does not exist — the owner uses the org export and filters by `employeeId` |
| Org-level export | **Settings → Data & privacy → Export** (`exportOrgData`, `org:manage`): JSON of org, departments, employees, workflows, opportunities, agents, runs (no outputs), measurements, financial models, projects, report metadata, integrations (no secrets), collectors (no token hashes), campaigns, consents, memberships, invitations; raw events as a count only. Audited `privacy.export`. |
| Erase raw activity | Delete all events (owner) or retention sweep |
| Erase a person | delete the employee row (cascades events, consents, collectors, workflow links through FKs); no UI button yet — SQL or a future action |
| Erase an organization | delete the org row (cascade) — SQL only |
| Correction | employee record editable by `employees:write` |

Gaps: no per-employee export/erase button; no automated DSAR workflow; no deletion certificate.

## 10. Compliance notes (general guidance, not legal advice)

- **United States.** Employer monitoring of company-owned devices is broadly permitted, but several states require
  written or electronic notice before electronic monitoring (for example Connecticut Gen. Stat. § 31-48d, Delaware
  Code tit. 19 § 705, New York Civil Rights Law § 52-c). BridgeBox's authorization + notice + acknowledgement flow is
  designed to produce that record; confirm the exact wording and delivery method per state. CCPA/CPRA applies to
  employee data of covered California employers: the notice at collection, purpose limitation, retention disclosure
  and access/deletion rights map to §§3, 7 and 9 above, with the per-person export/erase gap noted.
- **GDPR / UK GDPR (if any employee is in scope).** Consent is a weak lawful basis in employment because of the power
  imbalance; expect to rely on legitimate interests with a documented balancing test, a DPIA (monitoring is listed as
  high-risk), works-council consultation where applicable, and a data-processing agreement between the client
  (controller) and the consultancy/BridgeBox (processor). The metadata-only design, salted hashes, retention sweep,
  blocked-app list and employee pause rights are the minimisation and transparency measures to cite in the DPIA.
- **Health, finance, legal workloads.** The engine flags regulatory context (HIPAA/SOX/legal/PII keywords) on
  workflows; it does not see protected data itself, but the client should still avoid enrolling roles whose window
  titles would be sensitive, or set `titleMode = none` for them.
- **Hosting.** Choose the Postgres region to match the client's data-residency expectations; the Anthropic and n8n
  integrations send workflow summaries / agent payloads to those services only when configured (see `docs/COSTS.md`
  and `docs/DEPLOYMENT.md`).
- **Recommended client-facing artefacts** (not in this repo): employee notice template per state, DPIA template,
  processor agreement, retention schedule.
