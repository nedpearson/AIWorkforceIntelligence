# How the workflow analysis works

This is the plain-English description of what `src/engine/analysis.ts` (orchestration), `src/engine/mining.ts` (pattern discovery) and `src/engine/scoring.ts` (scoring and recommendations) do. Every number the engine stores is tagged **observed**, **estimated** or **assumed**; the last section says which is which.

## 1. What goes in

The collector records *metadata only*: which application had focus, a coarse category of the window title ("invoice", "sales order", "ticket reply" — never the title itself), what kind of action happened (data entry, copy/paste, navigation, document open/save, form submit, email compose, handoff, idle), how long it lasted, and counts (fields, pastes, clicks — never contents). The engine loads these events for one organization (optionally one campaign or time window), one employee at a time, ordered by time, so memory stays bounded however many events there are.

## 2. From events to task instances (sessionization)

Ambient events are stripped first: plain app focus/switch events, chat and meeting windows, and generic titles such as "inbox" or "general". They still count toward total observed time and the "ad-hoc" figure, but they are not part of any task.

The remaining events for one person are cut into **task sessions** at:

1. **Idle** — an idle start/end marker always ends the current task.
2. **Gaps** — more than 10 minutes between the end of one event and the start of the next.
3. **Task boundaries** — a *producing* event (data entry, paste, submit, save, email send, handoff, print) followed by a *starting* event (document open or navigation). One exception: re-navigating to a screen already visited in this session — but not the screen the session started on — is treated as a loop back (rework), not a new task. Going back to the first screen is a new run.
4. **Unrelated document** — a document opened in a different app with a different title right after another document open starts a new task (an ad-hoc memo before an invoice is not part of the invoice).

Each session becomes a **task instance**: the ordered list of steps `app : title category : action`, with consecutive duplicates collapsed. Sessions with fewer than two distinct steps are ad-hoc work, not workflows, and are not mined further (their time is reported as "ad-hoc hours").

**Rework** is detected when a step appears again after other steps intervened, or when the collector flags events as rework. **Handoffs** are explicit handoff events (sending work to another person).

## 3. From instances to workflows (clustering)

Instances with identical step sequences are grouped. Groups are then merged into one **workflow** when their steps overlap enough: similarity = 0.85 × Jaccard overlap of the step sets + 0.15 × how much of the order is shared (longest common subsequence). Groups at ≥ 70% similarity to a workflow's canonical sequence join it. The **canonical sequence** is the most common sequence in the cluster. Workflows with fewer than 3 observed instances are dropped.

Workflows are named from the title category that consumed the most time plus the distinct applications in order, e.g. *"Bill entry (Outlook → Adobe Acrobat → QuickBooks → Excel)"*. The department is the one most of the runs came from.

### Per-workflow metrics (all observed)

| Metric | How |
|---|---|
| Observed weeks | distinct days with activity ÷ 5 (so a 20-workday campaign = 4 weeks) |
| Runs/week | instances ÷ observed weeks |
| Avg duration | mean wall-clock time from the first step's start to the last step's end |
| Hours/week | runs/week × avg duration |
| Employee stats | the same three numbers per person (`workflow_employees`) |
| Rework rate | share of instances with rework |
| Handoff count | handoff events across all instances |
| Process map | nodes = steps with counts and average time; edges = directly-follows pairs with counts |
| Evidence | up to 200 sample event ids (first event of each instance), instance count, first/last observation, performer ids, notes |

## 4. Scores (0–100)

Weights live in `scoring.ts` (`REPETITION_WEIGHTS`, `AUTOMATION_WEIGHTS`) and must match this table.

### Repetition score — "how often and how consistently is this done the same way?"

| Component | Points | Signal |
|---|---|---|
| Frequency | 40 | √(runs per week ÷ 25), capped at 1 — 25 runs/week scores full marks |
| Consistency | 35 | share of runs that follow the canonical step sequence exactly |
| Structured share | 25 | share of time in data entry, copy/paste or navigation |

### Automation score — "how much of this could software do?"

| Component | Points | Signal |
|---|---|---|
| Structured entry | 35 | share of time in data entry, copy/paste or form submit |
| Swivel-chair | 15 | share of steps that paste data, when ≥ 2 applications are involved (full marks at half the steps) |
| API-friendliness | 30 | time-weighted friendliness of the app categories: ERP/accounting 0.95, CRM/helpdesk 0.9, email/spreadsheet 0.8, calendar 0.7, browser 0.5 (0.75 when the title names a system/portal/dashboard), presentation 0.4, document 0.3 |
| Low variance | 20 | half from low duration variance (1 − coefficient of variation), half from sequence consistency |
| Judgment penalty | −20 | title implies a human decision (contract, reconcile, review, approve, dispute, exception, audit…), or ≥ 50% of time is reading documents. "Approval request" (asking someone else) is clerical and not penalised |
| Regulatory penalty | −10 | HIPAA (patient, claim…), SOX (reconcile, bank, journal entry…), Legal (contract, NDA…), PII (HR system, onboarding, payroll…) |
| Handoff penalty | −10 × share of runs with a handoff | a person must still receive the work |

`requiresJudgment` and `regulatoryFlag` are set from the same heuristics and copied onto the opportunity.

### Duplicate work

Two workflows whose step sets overlap ≥ 80% are duplicates: the one with fewer hours/week gets `duplicateOfWorkflowId` and a note. The same workflow performed by people in more than one department is one workflow with a "performed in N departments" note (e.g. order entry done by Operations clerks and a Sales coordinator).

## 5. Opportunities

Every workflow with automation score ≥ 35 (or flagged as a duplicate) gets exactly one opportunity.

**Type**, first rule that matches:
1. duplicate workflow → `role_consolidation`
2. rework > 15% and automation score < 50 → `process_change`
3. ≥ 35% of time in spreadsheets, ≥ 20% copy/paste, and a system/browser navigation step before the spreadsheet → `conventional_automation` (export → spreadsheet → report)
4. ≥ 30% of time in ERP/accounting with pasting or ≥ 3 apps → `rpa` (swivel-chair)
5. ≥ 30% of time in email/helpdesk/calendar/documents/chat, or judgment flagged → `ai_agent`
6. otherwise `conventional_automation`

**Agent category** from the dominant titles: invoice/bill → `invoice`; reconcile/bank/payment → `ap_ar`; ticket/support → `customer_service`; scheduling/availability → `scheduling`; onboarding/HR → `onboarding`; inventory/count/variance → `inventory`; campaign/ads/social → `marketing`; report/deck/dashboard → `reporting`; order/CRM/sales → `sales_crm`; contract/memo/policy → `document`; else `email_admin` or `data_entry`.

**Numbers**
- Automation % of workflow time = automation score ÷ 100 × 0.85, capped at 80%.
- Complexity (0–1) = 0.5 × (apps − 1)/5 + 0.25 × handoff share + 0.25 if judgment — raises implementation hours.
- Hours and money come **only** from `opportunityEconomics()` in `src/engine/costing.ts`, with the org's adoption rate, realization rate and working weeks; its calculation tree is stored on the opportunity so the UI can show every step. The average loaded hourly cost is weighted by each performer's hours on the workflow. If a performer has no cost data, $35/h is assumed and the evidence says so.
- Feasibility = automation score + 10 × API-friendliness, −5 when no automation platform (n8n / Power Automate / UiPath) is connected.
- Risk = 35 if regulatory + 30 if judgment + 5 per performer (max 25) + 10 × handoff share.
- Rank: sort descending by realizable annual savings × feasibility/100 ÷ (1 + risk/100); rank 1 is best.

Each opportunity carries a one-paragraph summary that cites the evidence (runs, weeks, people, minutes, entry share, swivel-chair, rework, handoffs, flags) and the money with its assumptions.

## 6. Re-running

A new run replaces all workflows and `identified` opportunities. Opportunities that are being worked (any other status) are kept: they are matched to the new workflow by step signature (exact, else ≥ 70% similar), re-pointed to it and their numbers refreshed — title, type and status are untouched. If the workflow is no longer observed, the old workflow row is kept too so the opportunity survives. Everything else from earlier runs is deleted.

## 7. The run summary

`analysis_runs.summary` holds: observed window and weeks, employees and active days, total active hours/week, hours/week inside mined workflows, **repetitive hours/week** (workflows with repetition score ≥ 50), ad-hoc hours/week, idle share, ambient/noise share, task sessions, top apps by time, top workflows, duplicate pairs.

## 8. Observed vs estimated vs assumed

| | Examples |
|---|---|
| **Observed** (counted from events) | runs, durations, hours/week, who performs it, step sequences, rework rate, handoffs, process map, idle share, apps |
| **Estimated** (model output from observed inputs) | repetition and automation scores, flags, automation %, complexity, feasibility, risk, gross and realizable savings, implementation cost, payback |
| **Assumed** (settings, overridable) | adoption rate, realization rate, benefits load, working weeks per year, hourly cost when none is recorded, implementation profiles and platform costs |

Limits worth saying out loud: the collector sees applications and categories, not whether the work was *correct*; "judgment" and "regulatory" are keyword heuristics on title categories, not legal advice; savings are capacity freed, not payroll cut (see realization rate); and a workflow needs at least three observed runs to appear at all.
