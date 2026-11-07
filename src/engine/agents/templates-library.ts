/**
 * Automation Studio template library — the business-function templates beyond the 12 originals in templates.ts.
 * Every template is a real node graph for the internal runtime, validated by `validateDefinition` in the unit tests.
 *
 * Rules every template follows:
 *  - External writes are `action` nodes with a `compensate` block (real undo call where the API has one; a logged
 *    manual-compensation note where it does not, e.g. an email that cannot be unsent).
 *  - Customer-facing or money-moving writes sit behind an `approval` node (sensitive).
 *  - Endpoints are the vendors' documented REST endpoints (QuickBooks Online v3, HubSpot CRM v3, Zendesk v2,
 *    Microsoft Graph v1.0, Slack Web API, Google Analytics Data API v1beta). Where a system has no single standard API
 *    (booking, LMS, vendor-management, bank feed, document store) the template calls YOUR system through an
 *    `http_bearer` credential and the description says so. A template never uses two `http_bearer` credentials,
 *    because the runner resolves a provider to one attached credential.
 *  - Minutes per run are ASSUMED baselines; the run ledger replaces them with observed values once deployed.
 */
import type { AgentTemplate, RequiredCredential } from "./templates";
import { AI, CONV, n, chain, llm, http, notify, approval, end, trigger } from "./template-helpers";

const QBO = "https://quickbooks.api.intuit.com/v3/company/{{secret.realmId}}";
const QB = { auth: "bearer", tokenField: "accessToken", credentialProvider: "quickbooks" };
const HSA = "https://api.hubapi.com";
const HS = { auth: "bearer", tokenField: "accessToken", credentialProvider: "hubspot" };
const ZDA = "https://{{secret.subdomain}}.zendesk.com/api/v2";
const ZD = { auth: "basic", userField: "email", passField: "apiToken", credentialProvider: "zendesk" };
const BR = { auth: "bearer", tokenField: "token", credentialProvider: "http_bearer" };

const C_QBO: RequiredCredential = { provider: "quickbooks", label: "QuickBooks Online", fields: ["realmId", "accessToken"] };
const C_HS: RequiredCredential = { provider: "hubspot", label: "HubSpot private app", fields: ["accessToken"] };
const C_ZD: RequiredCredential = { provider: "zendesk", label: "Zendesk", fields: ["subdomain", "email", "apiToken"] };
const C_SMTP: RequiredCredential = { provider: "smtp", label: "Outbound email", fields: ["host", "port", "user", "password", "from"] };
const bearer = (label: string): RequiredCredential => ({ provider: "http_bearer", label, fields: ["baseUrl", "token"] });
const GRAPH = "Microsoft Graph (base URL https://graph.microsoft.com/v1.0 + access token)";
const SLACK = "Slack (base URL https://slack.com/api + bot token)";

export const LIBRARY_TEMPLATES: AgentTemplate[] = [
  // ============================================ FINANCE ============================================
  {
    key: "finance_ar_payment_application", category: "ap_ar", fn: "finance", useCase: "Accounts receivable", apps: ["QuickBooks", "Excel", "Outlook"],
    name: "Customer payment application (AR)",
    description: "When a customer payment arrives (remittance email or bank notice), finds the matching open invoice in QuickBooks, and after a person confirms the match, records the payment against it. Needs: a QuickBooks Online token and the Anthropic key on the server. Compensation: deletes the recorded payment if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 8, expectedMinutesSavedPerRun: 6, requiredCredentials: [C_QBO],
    definition: chain([
      trigger("Payment received", { source: "webhook", example: { customerRef: "58", amount: 1240.5, reference: "INV-1003", remittanceText: "Paying invoice 1003" } }),
      n("open_invoices", "http", "Find open invoices for customer", { method: "GET", url: `${QBO}/query?query=select%20*%20from%20Invoice%20where%20CustomerRef%20%3D%20'{{input.customerRef}}'%20and%20Balance%20%3E%20'0'&minorversion=73`, ...QB }),
      llm("match", "Match payment to invoice", "Match the payment to one invoice. Return JSON {\"invoiceId\": string, \"confidence\": 0-1, \"reason\": string}.", "Payment {{input.amount}} ref {{input.reference}} ({{input.remittanceText}}). Open invoices: {{nodes.open_invoices.body.QueryResponse.Invoice}}"),
      approval("confirm", "Apply ${{input.amount}} from customer {{input.customerRef}} to the matched invoice", 1),
      http("apply", "Record payment in QuickBooks", { method: "POST", url: `${QBO}/payment?minorversion=73`, ...QB, body: { CustomerRef: { value: "{{input.customerRef}}" }, TotalAmt: "{{input.amount}}", PaymentRefNum: "{{input.reference}}" } },
        { kind: "http", method: "POST", url: `${QBO}/payment?operation=delete&minorversion=73`, ...QB, body: { Id: "{{nodes.apply.body.Payment.Id}}", SyncToken: "{{nodes.apply.body.Payment.SyncToken}}" }, note: "delete recorded payment" }),
      notify("notify", "Payment {{input.reference}} (${{input.amount}}) recorded"),
      end(),
    ]),
  },
  {
    key: "finance_collections_reminders", category: "ap_ar", fn: "finance", useCase: "Collections", apps: ["QuickBooks", "Outlook", "Excel"],
    name: "Overdue invoice collections",
    description: "Every weekday morning, pulls overdue invoices from QuickBooks, drafts a polite reminder whose tone steps up with days overdue, and after a person approves, has QuickBooks email the invoice again. Needs: a QuickBooks Online token and the Anthropic key on the server. Compensation: a sent email cannot be recalled, so a failure logs a manual follow-up note for the AR owner.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 20, expectedMinutesSavedPerRun: 15, requiredCredentials: [C_QBO],
    definition: chain([
      trigger("Weekdays 08:00", { source: "schedule", example: { asOf: "2026-11-09" } }),
      n("overdue", "http", "Fetch overdue invoices", { method: "GET", url: `${QBO}/query?query=select%20*%20from%20Invoice%20where%20Balance%20%3E%20'0'%20and%20DueDate%20%3C%20'{{input.asOf}}'&minorversion=73`, ...QB }),
      n("any", "condition", "Anything overdue?", { left: "nodes.overdue.body.QueryResponse.Invoice.0", op: "exists" }),
      llm("draft", "Draft reminder", "You write accounts-receivable reminders. Friendly under 30 days overdue, firm 30-60, final notice over 60. Never threaten legal action.", "Invoice {{nodes.overdue.body.QueryResponse.Invoice.0.DocNumber}} due {{nodes.overdue.body.QueryResponse.Invoice.0.DueDate}}, balance {{nodes.overdue.body.QueryResponse.Invoice.0.Balance}}"),
      approval("approve", "Re-send overdue invoice {{nodes.overdue.body.QueryResponse.Invoice.0.DocNumber}} with reminder", 2),
      http("send", "Re-send invoice via QuickBooks", { method: "POST", url: `${QBO}/invoice/{{nodes.overdue.body.QueryResponse.Invoice.0.Id}}/send?minorversion=73`, ...QB },
        { kind: "log", message: "Reminder for invoice {{nodes.overdue.body.QueryResponse.Invoice.0.DocNumber}} was emailed and cannot be recalled — AR owner to follow up manually." }),
      notify("notify", "Reminder sent for invoice {{nodes.overdue.body.QueryResponse.Invoice.0.DocNumber}}"),
      end(),
    ], [{ from: "any", to: "draft", when: "true" }, { from: "any", to: "end", when: "false" }], "0 8 * * 1-5"),
  },
  {
    key: "finance_bank_reconciliation", category: "reporting", fn: "finance", useCase: "Reconciliation", apps: ["QuickBooks", "Excel", "Chrome"],
    name: "Bank-to-books reconciliation",
    description: "Daily, compares yesterday's bank transactions (from your bank-feed API) with QuickBooks purchases, lists anything unmatched, and — only after a person approves — posts the agreed bank-fee adjustments as a journal entry. Needs: an HTTP bearer token for your bank-feed API, a QuickBooks Online token and the Anthropic key on the server. Compensation: deletes the journal entry if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 45, expectedMinutesSavedPerRun: 30, requiredCredentials: [bearer("Bank-feed API"), C_QBO],
    definition: chain([
      trigger("Daily 06:30", { source: "schedule", example: { date: "2026-11-08", feeAccountRef: "61", bankAccountRef: "35" } }),
      n("bank", "http", "Fetch bank transactions", { method: "GET", url: "{{secret.baseUrl}}/transactions?date={{input.date}}", ...BR }),
      n("books", "http", "Fetch QuickBooks purchases", { method: "GET", url: `${QBO}/query?query=select%20*%20from%20Purchase%20where%20TxnDate%20%3D%20'{{input.date}}'&minorversion=73`, ...QB }),
      llm("match", "Match bank lines to books", "Reconcile bank lines to ledger purchases by amount and date. Return JSON {\"unmatched\": [...], \"bankFees\": number}. Do not invent transactions.", "Bank: {{nodes.bank.body}}\nBooks: {{nodes.books.body.QueryResponse.Purchase}}"),
      n("has_fees", "condition", "Bank fees to post?", { left: "nodes.match.text", op: "contains", right: "bankFees" }),
      approval("approve", "Post bank-fee adjustment journal entry for {{input.date}}", 5),
      http("journal", "Post journal entry", { method: "POST", url: `${QBO}/journalentry?minorversion=73`, ...QB, body: { TxnDate: "{{input.date}}", PrivateNote: "Bank fees per BridgeBox reconciliation", Line: [{ DetailType: "JournalEntryLineDetail", Amount: "{{input.feeAmount}}", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "{{input.feeAccountRef}}" } } }, { DetailType: "JournalEntryLineDetail", Amount: "{{input.feeAmount}}", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "{{input.bankAccountRef}}" } } }] } },
        { kind: "http", method: "POST", url: `${QBO}/journalentry?operation=delete&minorversion=73`, ...QB, body: { Id: "{{nodes.journal.body.JournalEntry.Id}}", SyncToken: "{{nodes.journal.body.JournalEntry.SyncToken}}" }, note: "delete posted journal entry" }),
      notify("notify", "Reconciliation for {{input.date}} done; exceptions in run output"),
      end(),
    ], [{ from: "has_fees", to: "approve", when: "true" }, { from: "has_fees", to: "notify", when: "false" }], "30 6 * * *"),
  },
  {
    key: "finance_expense_analysis", category: "reporting", fn: "finance", useCase: "Expense analysis", apps: ["QuickBooks", "Excel"],
    name: "Monthly expense variance analysis",
    description: "On the 2nd of each month, pulls the Profit & Loss by month from QuickBooks, explains the biggest expense changes in plain English and emails the note to the owner. Read-only: it never changes the books. Needs: a QuickBooks Online token, SMTP for the email and the Anthropic key on the server.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 60, expectedMinutesSavedPerRun: 45, requiredCredentials: [C_QBO, C_SMTP],
    definition: chain([
      trigger("2nd of month 07:00", { source: "schedule", example: { start: "2026-08-01", end: "2026-10-31" } }),
      n("pnl", "http", "Fetch P&L by month", { method: "GET", url: `${QBO}/reports/ProfitAndLoss?start_date={{input.start}}&end_date={{input.end}}&summarize_column_by=Month&minorversion=73`, ...QB }),
      llm("analyze", "Explain variances", "You are a careful FP&A analyst. List the five largest month-over-month expense changes with the amount and a likely, clearly-labelled-as-hypothesis reason. Use only numbers in the report.", "{{nodes.pnl.body}}"),
      notify("send", "Expense variance note ready", { email: { to: "owner@yourcompany.example", subject: "Monthly expense variances" }, bodyPath: "nodes.analyze.text" }),
      end(),
    ], [], "0 7 2 * *"),
  },
  {
    key: "finance_month_end_pack", category: "reporting", fn: "finance", useCase: "Financial reporting", apps: ["QuickBooks", "Excel", "PowerPoint", "Word"],
    name: "Month-end reporting pack",
    description: "On the 3rd of each month, pulls the Balance Sheet, Profit & Loss and A/R aging from QuickBooks, drafts management commentary, and after a person approves, files the pack to your document store. Needs: a QuickBooks Online token, an HTTP bearer token for the document store and the Anthropic key on the server. Compensation: removes the filed pack if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 120, expectedMinutesSavedPerRun: 80, requiredCredentials: [C_QBO, bearer("Document store API")],
    definition: chain([
      trigger("3rd of month 08:00", { source: "schedule", example: { start: "2026-10-01", end: "2026-10-31", period: "2026-10" } }),
      n("bs", "http", "Fetch Balance Sheet", { method: "GET", url: `${QBO}/reports/BalanceSheet?start_date={{input.start}}&end_date={{input.end}}&minorversion=73`, ...QB }),
      n("pnl", "http", "Fetch Profit & Loss", { method: "GET", url: `${QBO}/reports/ProfitAndLoss?start_date={{input.start}}&end_date={{input.end}}&minorversion=73`, ...QB }),
      n("aging", "http", "Fetch A/R aging", { method: "GET", url: `${QBO}/reports/AgedReceivables?report_date={{input.end}}&minorversion=73`, ...QB }),
      llm("commentary", "Draft management commentary", "Write month-end commentary for owners: revenue, gross margin, opex, cash, receivables risk. Quote only numbers present in the reports.", "BS: {{nodes.bs.body}}\nPL: {{nodes.pnl.body}}\nAR aging: {{nodes.aging.body}}"),
      approval("approve", "File the {{input.period}} month-end pack", 10),
      http("file", "File pack to document store", { method: "POST", url: "{{secret.baseUrl}}/documents", ...BR, body: { title: "Month-end pack {{input.period}}", commentary: "{{nodes.commentary.text}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/documents/{{nodes.file.body.id}}", ...BR, note: "remove filed pack" }),
      notify("notify", "Month-end pack {{input.period}} filed"),
      end(),
    ], [], "0 8 3 * *"),
  },

  // ============================================ SALES ============================================
  {
    key: "sales_crm_call_notes", category: "sales_crm", fn: "sales", useCase: "CRM updates", apps: ["HubSpot", "Salesforce", "Outlook", "Teams"],
    name: "Call notes → CRM update",
    description: "Turns a rep's meeting notes into a structured HubSpot note on the contact, and — after the rep approves — moves the deal to the stage the notes support. Needs: a HubSpot private app token (crm.objects.contacts.write, crm.objects.deals.write) and the Anthropic key on the server. Compensation: deletes the note and restores the previous deal stage if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 10, expectedMinutesSavedPerRun: 8, requiredCredentials: [C_HS],
    definition: chain([
      trigger("Meeting notes submitted", { source: "webhook", example: { contactId: "901", dealId: "5501", currentStage: "appointmentscheduled", proposedStage: "qualifiedtobuy", notes: "Budget approved for Q1, wants 40 seats", timestamp: "2026-11-09T15:00:00Z" } }),
      llm("structure", "Structure notes", "Summarize sales call notes as: Needs, Budget, Timeline, Decision makers, Next step. Under 120 words.", "{{input.notes}}"),
      http("note", "Create CRM note on contact", { method: "POST", url: `${HSA}/crm/v3/objects/notes`, ...HS, body: { properties: { hs_timestamp: "{{input.timestamp}}", hs_note_body: "{{nodes.structure.text}}" }, associations: [{ to: { id: "{{input.contactId}}" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] } },
        { kind: "http", method: "DELETE", url: `${HSA}/crm/v3/objects/notes/{{nodes.note.body.id}}`, ...HS, note: "delete created note" }),
      approval("approve_stage", "Move deal {{input.dealId}} to stage {{input.proposedStage}}", 1),
      http("stage", "Update deal stage", { method: "PATCH", url: `${HSA}/crm/v3/objects/deals/{{input.dealId}}`, ...HS, body: { properties: { dealstage: "{{input.proposedStage}}" } } },
        { kind: "http", method: "PATCH", url: `${HSA}/crm/v3/objects/deals/{{input.dealId}}`, ...HS, body: { properties: { dealstage: "{{input.currentStage}}" } }, note: "restore previous deal stage" }),
      notify("notify", "CRM updated for deal {{input.dealId}}"),
      end(),
    ]),
  },
  {
    key: "sales_meeting_scheduler", category: "scheduling", fn: "sales", useCase: "Scheduling", apps: ["Outlook", "Teams", "HubSpot"],
    name: "Sales meeting scheduler",
    description: "When a prospect asks for a meeting, asks Microsoft Graph for times when the rep and prospect are free, books the first one with a Teams link and logs it. Needs: an HTTP bearer credential for Microsoft Graph (Calendars.ReadWrite). Compensation: deletes the created calendar event if a later step fails.",
    runtime: "internal", monthlyCost: CONV, baselineMinutesPerRun: 8, expectedMinutesSavedPerRun: 7, requiredCredentials: [bearer(GRAPH)],
    definition: chain([
      trigger("Meeting requested", { source: "webhook", example: { prospectEmail: "buyer@prospect.example", prospectName: "Jordan", topic: "Pricing walkthrough", durationMin: 30, windowStart: "2026-11-10T14:00:00Z", windowEnd: "2026-11-14T22:00:00Z" } }),
      n("find", "http", "Find meeting times", { method: "POST", url: "{{secret.baseUrl}}/me/findMeetingTimes", ...BR, body: { attendees: [{ type: "required", emailAddress: { address: "{{input.prospectEmail}}" } }], timeConstraint: { timeslots: [{ start: { dateTime: "{{input.windowStart}}", timeZone: "UTC" }, end: { dateTime: "{{input.windowEnd}}", timeZone: "UTC" } }] }, meetingDuration: "PT30M", maxCandidates: 3 } }),
      n("has", "condition", "A slot is free?", { left: "nodes.find.body.meetingTimeSuggestions.0", op: "exists" }),
      http("book", "Create calendar event", { method: "POST", url: "{{secret.baseUrl}}/me/events", ...BR, body: { subject: "{{input.topic}} — {{input.prospectName}}", start: "{{nodes.find.body.meetingTimeSuggestions.0.meetingTimeSlot.start}}", end: "{{nodes.find.body.meetingTimeSuggestions.0.meetingTimeSlot.end}}", attendees: [{ type: "required", emailAddress: { address: "{{input.prospectEmail}}", name: "{{input.prospectName}}" } }], isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/me/events/{{nodes.book.body.id}}", ...BR, note: "delete created event" }),
      notify("notify", "Booked {{input.topic}} with {{input.prospectEmail}}"),
      end(),
    ], [{ from: "has", to: "book", when: "true" }, { from: "has", to: "end", when: "false" }]),
  },
  {
    key: "sales_proposal_generator", category: "sales_crm", fn: "sales", useCase: "Proposal generation", apps: ["HubSpot", "Word", "PowerPoint"],
    name: "Proposal first draft",
    description: "Reads the deal from HubSpot, drafts a proposal (scope, pricing table from the deal amount, timeline, terms placeholders) and, after the rep approves the draft, saves it to your document store for final editing. Needs: a HubSpot private app token, an HTTP bearer token for the document store and the Anthropic key on the server. Compensation: removes the saved draft if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 90, expectedMinutesSavedPerRun: 55, requiredCredentials: [C_HS, bearer("Document store API")],
    definition: chain([
      trigger("Proposal requested", { source: "manual", example: { dealId: "5501", scopeNotes: "40 seats, onboarding, quarterly reviews" } }),
      n("deal", "http", "Fetch deal", { method: "GET", url: `${HSA}/crm/v3/objects/deals/{{input.dealId}}?properties=dealname,amount,dealstage,closedate`, ...HS }),
      llm("draft", "Draft proposal", "Draft a B2B proposal: summary, scope, pricing (use only the deal amount given), timeline, assumptions. Mark legal terms as [TO BE REVIEWED].", "Deal: {{nodes.deal.body.properties}}\nScope notes: {{input.scopeNotes}}"),
      approval("approve", "Save proposal draft for {{nodes.deal.body.properties.dealname}}", 5),
      http("save", "Save draft to document store", { method: "POST", url: "{{secret.baseUrl}}/documents", ...BR, body: { title: "Proposal — {{nodes.deal.body.properties.dealname}}", body: "{{nodes.draft.text}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/documents/{{nodes.save.body.id}}", ...BR, note: "remove saved draft" }),
      notify("notify", "Proposal draft saved for deal {{input.dealId}}"),
      end(),
    ]),
  },
  {
    key: "sales_follow_up_tasks", category: "sales_crm", fn: "sales", useCase: "Follow-ups", apps: ["HubSpot", "Outlook"],
    name: "Stalled-deal follow-ups",
    description: "Every weekday, finds open HubSpot deals with no activity for 14 days, drafts a suggested follow-up message and creates a task for the deal owner with the draft attached. It never emails the prospect itself. Needs: a HubSpot private app token and the Anthropic key on the server. Compensation: deletes the created task if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 15, expectedMinutesSavedPerRun: 12, requiredCredentials: [C_HS],
    definition: chain([
      trigger("Weekdays 09:00", { source: "schedule", example: { staleBeforeMs: 1762000000000, dueAt: "2026-11-10T17:00:00Z" } }),
      n("stale", "http", "Search stalled deals", { method: "POST", url: `${HSA}/crm/v3/objects/deals/search`, ...HS, body: { filterGroups: [{ filters: [{ propertyName: "notes_last_updated", operator: "LT", value: "{{input.staleBeforeMs}}" }, { propertyName: "hs_is_closed", operator: "EQ", value: "false" }] }], properties: ["dealname", "amount", "hubspot_owner_id"], limit: 10 } }),
      n("any", "condition", "Any stalled deal?", { left: "nodes.stale.body.results.0", op: "exists" }),
      llm("draft", "Draft follow-up", "Write a short, helpful follow-up email a rep could send to restart a stalled deal. No pressure tactics.", "Deal: {{nodes.stale.body.results.0.properties}}"),
      http("task", "Create task for deal owner", { method: "POST", url: `${HSA}/crm/v3/objects/tasks`, ...HS, body: { properties: { hs_timestamp: "{{input.dueAt}}", hs_task_subject: "Follow up: {{nodes.stale.body.results.0.properties.dealname}}", hs_task_body: "{{nodes.draft.text}}", hs_task_status: "NOT_STARTED", hs_task_priority: "MEDIUM", hubspot_owner_id: "{{nodes.stale.body.results.0.properties.hubspot_owner_id}}" } } },
        { kind: "http", method: "DELETE", url: `${HSA}/crm/v3/objects/tasks/{{nodes.task.body.id}}`, ...HS, note: "delete created task" }),
      notify("notify", "Follow-up task created for {{nodes.stale.body.results.0.properties.dealname}}"),
      end(),
    ], [{ from: "any", to: "draft", when: "true" }, { from: "any", to: "end", when: "false" }], "0 9 * * 1-5"),
  },
  {
    key: "sales_pipeline_forecast", category: "sales_crm", fn: "sales", useCase: "Forecasting", apps: ["HubSpot", "Excel", "Salesforce"],
    name: "Weekly pipeline forecast",
    description: "Every Monday, reads your HubSpot deal pipeline stages (with their probabilities) and open deals closing this quarter, computes a weighted forecast and emails a plain-English summary. Read-only. Needs: a HubSpot private app token (crm.objects.deals.read), SMTP and the Anthropic key on the server.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 50, expectedMinutesSavedPerRun: 40, requiredCredentials: [C_HS, C_SMTP],
    definition: chain([
      trigger("Monday 07:30", { source: "schedule", example: { quarterEndMs: 1767225599000 } }),
      n("stages", "http", "Fetch pipeline stages", { method: "GET", url: `${HSA}/crm/v3/pipelines/deals`, ...HS }),
      n("deals", "http", "Fetch open deals this quarter", { method: "POST", url: `${HSA}/crm/v3/objects/deals/search`, ...HS, body: { filterGroups: [{ filters: [{ propertyName: "closedate", operator: "LTE", value: "{{input.quarterEndMs}}" }, { propertyName: "hs_is_closed", operator: "EQ", value: "false" }] }], properties: ["dealname", "amount", "dealstage", "closedate"], limit: 100 } }),
      llm("forecast", "Weighted forecast", "Compute weighted pipeline = Σ amount × stage probability, using ONLY the stage probabilities given. Show commit / best case / pipeline and the 5 deals that matter most.", "Stages: {{nodes.stages.body.results}}\nDeals: {{nodes.deals.body.results}}"),
      notify("send", "Weekly forecast ready", { email: { to: "sales-leadership@yourcompany.example", subject: "Weekly pipeline forecast" }, bodyPath: "nodes.forecast.text" }),
      end(),
    ], [], "30 7 * * 1"),
  },

  // ============================================ OPERATIONS ============================================
  {
    key: "ops_purchase_requests", category: "inventory", fn: "operations", useCase: "Purchasing", apps: ["QuickBooks", "Excel", "Outlook", "NetSuite"],
    name: "Purchase request → purchase order",
    description: "Takes an employee purchase request, checks it against the budget limit you set, routes anything over the limit to a manager for approval, then creates the purchase order in QuickBooks. Needs: a QuickBooks Online token. Compensation: deletes the purchase order if a later step fails.",
    runtime: "internal", monthlyCost: CONV, baselineMinutesPerRun: 15, expectedMinutesSavedPerRun: 11, requiredCredentials: [C_QBO],
    definition: chain([
      trigger("Purchase request", { source: "webhook", example: { requester: "sam@yourcompany.example", vendorRef: "41", item: "Pallet wrap (20 rolls)", amount: 640, accountRef: "80", budgetLimit: 500 } }),
      n("shape", "transform", "Shape request", { mapping: { vendorRef: "input.vendorRef", item: "input.item", amount: "input.amount", accountRef: "input.accountRef", limit: "input.budgetLimit" } }),
      n("over", "condition", "Over budget limit?", { left: "nodes.shape.amount", op: "gt", right: "nodes.shape.limit" }),
      approval("approve", "Create PO for {{nodes.shape.item}} — ${{nodes.shape.amount}} (over limit)", 3),
      http("po", "Create purchase order", { method: "POST", url: `${QBO}/purchaseorder?minorversion=73`, ...QB, body: { VendorRef: { value: "{{nodes.shape.vendorRef}}" }, Line: [{ Amount: "{{nodes.shape.amount}}", DetailType: "AccountBasedExpenseLineDetail", Description: "{{nodes.shape.item}}", AccountBasedExpenseLineDetail: { AccountRef: { value: "{{nodes.shape.accountRef}}" } } }] } },
        { kind: "http", method: "POST", url: `${QBO}/purchaseorder?operation=delete&minorversion=73`, ...QB, body: { Id: "{{nodes.po.body.PurchaseOrder.Id}}", SyncToken: "{{nodes.po.body.PurchaseOrder.SyncToken}}" }, note: "delete created PO" }),
      notify("notify", "PO {{nodes.po.body.PurchaseOrder.DocNumber}} created for {{input.requester}}"),
      end(),
    ], [{ from: "over", to: "approve", when: "true" }, { from: "over", to: "po", when: "false" }]),
  },
  {
    key: "ops_vendor_compliance", category: "document", fn: "operations", useCase: "Vendor management", apps: ["Excel", "Outlook", "Adobe Acrobat"],
    name: "Vendor certificate & contract renewals",
    description: "Weekly, asks your vendor-management system for insurance certificates and contracts expiring in the next 30 days, drafts renewal requests and, after a person approves, logs the request against the vendor so the vendor portal emails them. Needs: an HTTP bearer token for your vendor-management API and the Anthropic key on the server. Compensation: withdraws the logged request if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 30, expectedMinutesSavedPerRun: 22, requiredCredentials: [bearer("Vendor-management API")],
    definition: chain([
      trigger("Monday 10:00", { source: "schedule" }),
      n("expiring", "http", "Fetch expiring documents", { method: "GET", url: "{{secret.baseUrl}}/vendor-documents?expiringWithinDays=30", ...BR }),
      n("any", "condition", "Anything expiring?", { left: "nodes.expiring.body.items.0", op: "exists" }),
      llm("draft", "Draft renewal request", "Write a brief, courteous request asking the vendor to send an updated document before the expiry date.", "{{nodes.expiring.body.items.0}}"),
      approval("approve", "Send renewal request to {{nodes.expiring.body.items.0.vendorName}}", 2),
      http("request", "Log renewal request", { method: "POST", url: "{{secret.baseUrl}}/vendors/{{nodes.expiring.body.items.0.vendorId}}/requests", ...BR, body: { documentId: "{{nodes.expiring.body.items.0.id}}", message: "{{nodes.draft.text}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/vendors/{{nodes.expiring.body.items.0.vendorId}}/requests/{{nodes.request.body.id}}", ...BR, note: "withdraw renewal request" }),
      notify("notify", "Renewal requested from {{nodes.expiring.body.items.0.vendorName}}"),
      end(),
    ], [{ from: "any", to: "draft", when: "true" }, { from: "any", to: "end", when: "false" }], "0 10 * * 1"),
  },
  {
    key: "ops_workflow_handoffs", category: "email_admin", fn: "operations", useCase: "Workflow coordination", apps: ["Slack", "Teams", "Excel", "Outlook"],
    name: "Cross-team handoff coordinator",
    description: "When a step finishes in one team (e.g. order picked), posts the handoff with the details the next team needs into their Slack channel and tags the owner — replacing manual status-chasing. Needs: an HTTP bearer credential for Slack (chat:write bot token). Compensation: deletes the posted message if a later step fails.",
    runtime: "internal", monthlyCost: CONV, baselineMinutesPerRun: 6, expectedMinutesSavedPerRun: 5, requiredCredentials: [bearer(SLACK)],
    definition: chain([
      trigger("Step completed", { source: "webhook", example: { step: "Order picked", orderId: "SO-2231", nextTeamChannel: "C0123SHIP", nextOwner: "U0456", details: "3 pallets, dock 2" } }),
      n("shape", "transform", "Build handoff", { mapping: { channel: "input.nextTeamChannel", owner: "input.nextOwner", step: "input.step", orderId: "input.orderId", details: "input.details" } }),
      http("post", "Post handoff to Slack", { method: "POST", url: "{{secret.baseUrl}}/chat.postMessage", ...BR, body: { channel: "{{nodes.shape.channel}}", text: "<@{{nodes.shape.owner}}> {{nodes.shape.step}} for {{nodes.shape.orderId}} — {{nodes.shape.details}}" } },
        { kind: "http", method: "POST", url: "{{secret.baseUrl}}/chat.delete", ...BR, body: { channel: "{{nodes.post.body.channel}}", ts: "{{nodes.post.body.ts}}" }, note: "delete posted message" }),
      end(),
    ]),
  },
  {
    key: "ops_document_extraction", category: "document", fn: "operations", useCase: "Document processing", apps: ["Adobe Acrobat", "Excel", "Outlook"],
    name: "Delivery document data extraction",
    description: "Reads a delivery receipt, bill of lading or packing slip, extracts the shipment fields, and creates the receiving record in your operations system — sending low-confidence extractions to a person first. Needs: an HTTP bearer token for your operations API and the Anthropic key on the server. Compensation: deletes the created receiving record if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 9, expectedMinutesSavedPerRun: 7, requiredCredentials: [bearer("Operations system API")],
    definition: chain([
      trigger("Document received", { source: "webhook", example: { documentId: "bol-77", text: "BILL OF LADING ... PO 4410 ... 12 cartons ...", poNumber: "4410" } }),
      llm("extract", "Extract shipment fields", "Extract carrier, PO number, item lines, quantities and received date as JSON, plus \"confidence\": \"high\"|\"low\". Do not guess missing fields.", "{{input.text}}"),
      n("low", "condition", "Low confidence?", { left: "nodes.extract.text", op: "contains", right: "\"low\"" }),
      approval("review", "Confirm extracted fields for document {{input.documentId}}", 2),
      http("create", "Create receiving record", { method: "POST", url: "{{secret.baseUrl}}/receipts", ...BR, body: { poNumber: "{{input.poNumber}}", sourceDocument: "{{input.documentId}}", extracted: "{{nodes.extract.text}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/receipts/{{nodes.create.body.id}}", ...BR, note: "delete receiving record" }),
      notify("notify", "Receiving record created for PO {{input.poNumber}}"),
      end(),
    ], [{ from: "low", to: "review", when: "true" }, { from: "low", to: "create", when: "false" }]),
  },

  // ============================================ CUSTOMER SERVICE ============================================
  {
    key: "cs_email_responses", category: "email_admin", fn: "customer_service", useCase: "Email responses", apps: ["Outlook", "Gmail"],
    name: "Customer email reply drafter",
    description: "For each customer email in a shared mailbox, drafts a reply in Outlook (as a real draft in the thread) and sends it only after a person approves. Needs: an HTTP bearer credential for Microsoft Graph (Mail.ReadWrite, Mail.Send) and the Anthropic key on the server. Compensation: deletes the draft if approval or sending fails; a sent email cannot be recalled, so that case logs a manual follow-up.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 7, expectedMinutesSavedPerRun: 5, requiredCredentials: [bearer(GRAPH)],
    definition: chain([
      trigger("Email received", { source: "webhook", example: { messageId: "AAMkAD...", from: "customer@example.com", subject: "Order status", body: "Has order 5541 shipped?" } }),
      llm("draft", "Draft reply", "You are a helpful customer service rep. Answer in under 120 words. If you do not know an order's status, say a teammate will confirm.", "From {{input.from}} — {{input.subject}}\n{{input.body}}"),
      http("create_draft", "Create reply draft in Outlook", { method: "POST", url: "{{secret.baseUrl}}/me/messages/{{input.messageId}}/createReply", ...BR, body: { comment: "{{nodes.draft.text}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/me/messages/{{nodes.create_draft.body.id}}", ...BR, note: "delete reply draft" }),
      approval("approve", "Send reply to {{input.from}} about \"{{input.subject}}\"", 1),
      http("send", "Send reply", { method: "POST", url: "{{secret.baseUrl}}/me/messages/{{nodes.create_draft.body.id}}/send", ...BR },
        { kind: "log", message: "Reply to {{input.from}} was sent and cannot be recalled — follow up manually if a later step failed." }),
      end(),
    ]),
  },
  {
    key: "cs_ticket_classification", category: "customer_service", fn: "customer_service", useCase: "Ticket classification", apps: ["Zendesk", "Freshdesk"],
    name: "Ticket classifier & router",
    description: "Classifies each new Zendesk ticket (billing, shipping, product, account, other) and urgency, then sets the ticket's tags and priority so it lands in the right view. Needs: a Zendesk API token and the Anthropic key on the server. Compensation: restores the ticket's original tags and priority if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 3, expectedMinutesSavedPerRun: 2.5, requiredCredentials: [C_ZD],
    definition: chain([
      trigger("Ticket created", { source: "webhook", example: { ticketId: "8812", subject: "Charged twice", body: "I see two charges for order 5541", tags: [], priority: "normal" } }),
      llm("classify", "Classify ticket", "Classify the ticket. Reply with exactly: <category> <priority> where category is billing|shipping|product|account|other and priority is low|normal|high|urgent.", "{{input.subject}}\n{{input.body}}"),
      n("shape", "transform", "Shape update", { mapping: { ticketId: "input.ticketId", label: "nodes.classify.text", oldTags: "input.tags", oldPriority: "input.priority" } }),
      http("update", "Set tags & priority", { method: "PUT", url: `${ZDA}/tickets/{{nodes.shape.ticketId}}.json`, ...ZD, body: { ticket: { additional_tags: ["bb_{{nodes.shape.label}}"] } } },
        { kind: "http", method: "PUT", url: `${ZDA}/tickets/{{nodes.shape.ticketId}}.json`, ...ZD, body: { ticket: { tags: "{{nodes.shape.oldTags}}", priority: "{{nodes.shape.oldPriority}}" } }, note: "restore original tags and priority" }),
      end(),
    ]),
  },
  {
    key: "cs_inquiry_answering", category: "customer_service", fn: "customer_service", useCase: "Customer inquiries", apps: ["Zendesk", "Chrome"],
    name: "Help-center answer suggester",
    description: "Searches your Zendesk Help Center for articles that answer a customer's question, drafts a reply that links them, and posts it on the ticket — routing anything the articles do not cover to a person first. Needs: a Zendesk API token and the Anthropic key on the server. Compensation: posts a correction comment if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 8, expectedMinutesSavedPerRun: 5, requiredCredentials: [C_ZD],
    definition: chain([
      trigger("Question received", { source: "webhook", example: { ticketId: "8813", question: "How do I change my delivery address?" } }),
      n("search", "http", "Search help center", { method: "GET", url: `${ZDA}/help_center/articles/search.json?query={{input.question}}`, ...ZD }),
      llm("answer", "Draft answer from articles", "Answer ONLY from the articles provided and link them. If they do not answer the question, reply exactly NEEDS_HUMAN.", "Question: {{input.question}}\nArticles: {{nodes.search.body.results}}"),
      n("uncovered", "condition", "Articles don't cover it?", { left: "nodes.answer.text", op: "contains", right: "NEEDS_HUMAN" }),
      approval("review", "Answer ticket {{input.ticketId}} (articles did not fully cover it)", 3),
      http("reply", "Post reply on ticket", { method: "PUT", url: `${ZDA}/tickets/{{input.ticketId}}.json`, ...ZD, body: { ticket: { comment: { body: "{{nodes.answer.text}}", public: true } } } },
        { kind: "http", method: "PUT", url: `${ZDA}/tickets/{{input.ticketId}}.json`, ...ZD, body: { ticket: { comment: { body: "Correction: please disregard the previous automated reply; a teammate will follow up.", public: true } } }, note: "post correction comment" }),
      end(),
    ], [{ from: "uncovered", to: "review", when: "true" }, { from: "uncovered", to: "reply", when: "false" }]),
  },
  {
    key: "cs_appointment_confirmations", category: "scheduling", fn: "customer_service", useCase: "Appointment confirmations", apps: ["Outlook", "Chrome", "Excel"],
    name: "Appointment confirmations & reminders",
    description: "Every afternoon, gets tomorrow's appointments from your booking system and asks it to send each customer a confirmation with reschedule instructions — fewer no-shows, no manual calls. Needs: an HTTP bearer token for your booking/scheduling API. Compensation: cancels the queued confirmation if a later step fails.",
    runtime: "internal", monthlyCost: CONV, baselineMinutesPerRun: 25, expectedMinutesSavedPerRun: 20, requiredCredentials: [bearer("Booking system API")],
    definition: chain([
      trigger("Daily 15:00", { source: "schedule", example: { date: "2026-11-10" } }),
      n("appts", "http", "Fetch tomorrow's appointments", { method: "GET", url: "{{secret.baseUrl}}/appointments?date={{input.date}}&status=booked", ...BR }),
      n("any", "condition", "Any appointments?", { left: "nodes.appts.body.items.0", op: "exists" }),
      http("confirm", "Queue confirmations", { method: "POST", url: "{{secret.baseUrl}}/notifications", ...BR, body: { type: "confirmation", appointmentIds: "{{nodes.appts.body.items}}", template: "confirm_with_reschedule_link" } },
        { kind: "http", method: "POST", url: "{{secret.baseUrl}}/notifications/{{nodes.confirm.body.id}}/cancel", ...BR, note: "cancel queued confirmations" }),
      notify("notify", "Confirmations queued for {{input.date}}"),
      end(),
    ], [{ from: "any", to: "confirm", when: "true" }, { from: "any", to: "end", when: "false" }], "0 15 * * *"),
  },
  {
    key: "cs_follow_up", category: "customer_service", fn: "customer_service", useCase: "Follow-ups", apps: ["Zendesk", "Outlook"],
    name: "Post-resolution follow-up",
    description: "When a ticket is solved, drafts a short personal check-in and, after a person approves, opens a follow-up ticket linked to the original so the conversation history stays together. Needs: a Zendesk API token and the Anthropic key on the server. Compensation: deletes the follow-up ticket if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 5, expectedMinutesSavedPerRun: 4, requiredCredentials: [C_ZD],
    definition: chain([
      trigger("Ticket solved", { source: "webhook", example: { ticketId: "8790", requesterId: "3301", subject: "Damaged item", resolution: "Replacement shipped" } }),
      llm("draft", "Draft check-in", "Write a two-sentence check-in asking if the resolution worked. Warm, no marketing.", "Issue: {{input.subject}}. Resolution: {{input.resolution}}"),
      approval("approve", "Open follow-up on ticket {{input.ticketId}}", 1),
      http("followup", "Create follow-up ticket", { method: "POST", url: `${ZDA}/tickets.json`, ...ZD, body: { ticket: { via_followup_source_id: "{{input.ticketId}}", requester_id: "{{input.requesterId}}", subject: "Following up: {{input.subject}}", comment: { body: "{{nodes.draft.text}}", public: true } } } },
        { kind: "http", method: "DELETE", url: `${ZDA}/tickets/{{nodes.followup.body.ticket.id}}.json`, ...ZD, note: "delete follow-up ticket" }),
      end(),
    ]),
  },

  // ============================================ HR ============================================
  {
    key: "hr_interview_scheduling", category: "scheduling", fn: "hr", useCase: "Scheduling admin", apps: ["Outlook", "Teams", "Workday"],
    name: "Interview scheduling",
    description: "Finds a time when the candidate's interview panel is free in Microsoft 365, books the interview with a Teams link and sends the invite. Needs: an HTTP bearer credential for Microsoft Graph (Calendars.ReadWrite). Compensation: deletes the created event if a later step fails.",
    runtime: "internal", monthlyCost: CONV, baselineMinutesPerRun: 20, expectedMinutesSavedPerRun: 16, requiredCredentials: [bearer(GRAPH)],
    definition: chain([
      trigger("Interview requested", { source: "webhook", example: { candidateEmail: "cand@example.com", candidateName: "Riley", role: "Warehouse lead", panel: [{ type: "required", emailAddress: { address: "manager@yourcompany.example" } }], windowStart: "2026-11-11T14:00:00Z", windowEnd: "2026-11-15T22:00:00Z" } }),
      n("find", "http", "Find panel availability", { method: "POST", url: "{{secret.baseUrl}}/me/findMeetingTimes", ...BR, body: { attendees: "{{input.panel}}", timeConstraint: { timeslots: [{ start: { dateTime: "{{input.windowStart}}", timeZone: "UTC" }, end: { dateTime: "{{input.windowEnd}}", timeZone: "UTC" } }] }, meetingDuration: "PT45M", maxCandidates: 3 } }),
      n("has", "condition", "Slot found?", { left: "nodes.find.body.meetingTimeSuggestions.0", op: "exists" }),
      http("book", "Book interview", { method: "POST", url: "{{secret.baseUrl}}/me/events", ...BR, body: { subject: "Interview: {{input.candidateName}} — {{input.role}}", start: "{{nodes.find.body.meetingTimeSuggestions.0.meetingTimeSlot.start}}", end: "{{nodes.find.body.meetingTimeSuggestions.0.meetingTimeSlot.end}}", attendees: "{{input.panel}}", isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/me/events/{{nodes.book.body.id}}", ...BR, note: "delete interview event" }),
      notify("notify", "Interview booked for {{input.candidateName}}"),
      end(),
    ], [{ from: "has", to: "book", when: "true" }, { from: "has", to: "end", when: "false" }]),
  },
  {
    key: "hr_document_collection", category: "onboarding", fn: "hr", useCase: "Document management", apps: ["Workday", "BambooHR", "Adobe Acrobat", "DocuSign"],
    name: "Employee document collection",
    description: "Checks your HR system for each new hire's missing required documents (I-9, W-4, signed handbook) and logs a reminder task in the HR system for the employee — it reads document status only, never document contents. Needs: an HTTP bearer token for your HR system API. Compensation: removes the reminder if a later step fails.",
    runtime: "internal", monthlyCost: CONV, baselineMinutesPerRun: 12, expectedMinutesSavedPerRun: 10, requiredCredentials: [bearer("HR system API")],
    definition: chain([
      trigger("Weekdays 09:30", { source: "schedule", example: { employeeId: "E-1042" } }),
      n("status", "http", "Fetch document checklist status", { method: "GET", url: "{{secret.baseUrl}}/employees/{{input.employeeId}}/documents?status=missing", ...BR }),
      n("missing", "condition", "Anything missing?", { left: "nodes.status.body.items.0", op: "exists" }),
      http("remind", "Log reminder task", { method: "POST", url: "{{secret.baseUrl}}/employees/{{input.employeeId}}/tasks", ...BR, body: { title: "Please complete your onboarding documents", items: "{{nodes.status.body.items}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/employees/{{input.employeeId}}/tasks/{{nodes.remind.body.id}}", ...BR, note: "remove reminder task" }),
      end(),
    ], [{ from: "missing", to: "remind", when: "true" }, { from: "missing", to: "end", when: "false" }], "30 9 * * 1-5"),
  },
  {
    key: "hr_policy_answers", category: "onboarding", fn: "hr", useCase: "Policy information", apps: ["SharePoint", "Slack", "Teams", "Word"],
    name: "HR policy Q&A",
    description: "Answers employees' policy questions (PTO, expenses, remote work) from your handbook with a citation, and replies in Slack. Questions about leave, medical, discipline or termination always go to HR for review first — the agent is not legal advice. Needs: an HTTP bearer credential for Slack and the Anthropic key on the server; the handbook text is passed in the trigger. Compensation: deletes the posted reply if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 10, expectedMinutesSavedPerRun: 7, requiredCredentials: [bearer(SLACK)],
    definition: chain([
      trigger("Question asked", { source: "webhook", example: { channel: "D0789", question: "How many PTO days carry over?", handbookExcerpt: "Up to 5 unused PTO days carry over to the next year..." } }),
      llm("answer", "Answer from handbook", "Answer ONLY from the handbook excerpt and quote the sentence you used. If the excerpt does not answer it, say HR will reply. Never give legal advice.", "Q: {{input.question}}\nHandbook: {{input.handbookExcerpt}}"),
      n("sensitive_topic", "condition", "Leave / medical / discipline topic?", { left: "input.question", op: "contains", right: "leave" }),
      approval("hr_review", "HR to review answer to: {{input.question}}", 4),
      http("reply", "Reply in Slack", { method: "POST", url: "{{secret.baseUrl}}/chat.postMessage", ...BR, body: { channel: "{{input.channel}}", text: "{{nodes.answer.text}}" } },
        { kind: "http", method: "POST", url: "{{secret.baseUrl}}/chat.delete", ...BR, body: { channel: "{{nodes.reply.body.channel}}", ts: "{{nodes.reply.body.ts}}" }, note: "delete posted reply" }),
      end(),
    ], [{ from: "sensitive_topic", to: "hr_review", when: "true" }, { from: "sensitive_topic", to: "reply", when: "false" }]),
  },
  {
    key: "hr_training_coordination", category: "onboarding", fn: "hr", useCase: "Training coordination", apps: ["Workday", "Excel", "Outlook"],
    name: "Required-training enrollment",
    description: "When someone joins or changes role, checks your learning system for the courses that role requires, enrolls them in anything missing and notifies their manager. Needs: an HTTP bearer token for your LMS API. Compensation: removes the enrollments made in this run if a later step fails.",
    runtime: "internal", monthlyCost: CONV, baselineMinutesPerRun: 15, expectedMinutesSavedPerRun: 12, requiredCredentials: [bearer("Learning system (LMS) API")],
    definition: chain([
      trigger("Role assigned", { source: "webhook", example: { employeeId: "E-1042", role: "forklift_operator", manager: "dana@yourcompany.example" } }),
      n("gaps", "http", "Find missing required courses", { method: "GET", url: "{{secret.baseUrl}}/users/{{input.employeeId}}/required-courses?role={{input.role}}&status=not_enrolled", ...BR }),
      n("any", "condition", "Any gaps?", { left: "nodes.gaps.body.items.0", op: "exists" }),
      http("enroll", "Enroll in missing courses", { method: "POST", url: "{{secret.baseUrl}}/enrollments", ...BR, body: { userId: "{{input.employeeId}}", courseIds: "{{nodes.gaps.body.items}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/enrollments/{{nodes.enroll.body.batchId}}", ...BR, note: "remove enrollments from this run" }),
      notify("notify", "Enrolled {{input.employeeId}} in required training; manager {{input.manager}} notified"),
      end(),
    ], [{ from: "any", to: "enroll", when: "true" }, { from: "any", to: "end", when: "false" }]),
  },

  // ============================================ MARKETING ============================================
  {
    key: "mkt_campaign_email_draft", category: "marketing", fn: "marketing", useCase: "Campaigns", apps: ["HubSpot", "Canva", "Chrome"],
    name: "Campaign email builder",
    description: "Turns a campaign brief into subject-line options and body copy, and after a marketer approves the copy, creates the email as a DRAFT in HubSpot Marketing for them to design and schedule — it never sends. Needs: a HubSpot private app token with the content scope (Marketing Hub) and the Anthropic key on the server. Compensation: deletes the draft email if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 60, expectedMinutesSavedPerRun: 35, requiredCredentials: [C_HS],
    definition: chain([
      trigger("Campaign brief", { source: "manual", example: { campaign: "Winter smart-film promo", audience: "Commercial property managers", offer: "Free site survey", tone: "confident" } }),
      llm("copy", "Write campaign copy", "Write 3 subject lines and one 150-word email body for the brief. Clear call to action. No unverifiable claims.", "{{input.campaign}} for {{input.audience}}. Offer: {{input.offer}}. Tone: {{input.tone}}"),
      approval("approve", "Create HubSpot draft email for \"{{input.campaign}}\"", 5),
      http("draft", "Create draft marketing email", { method: "POST", url: `${HSA}/marketing/v3/emails`, ...HS, body: { name: "{{input.campaign}} (BridgeBox draft)", subject: "{{input.campaign}}", content: { widgets: { body: { body: { html: "{{nodes.copy.text}}" } } } } } },
        { kind: "http", method: "DELETE", url: `${HSA}/marketing/v3/emails/{{nodes.draft.body.id}}`, ...HS, note: "delete draft email" }),
      notify("notify", "Draft email for {{input.campaign}} is in HubSpot"),
      end(),
    ]),
  },
  {
    key: "mkt_lead_nurturing", category: "marketing", fn: "marketing", useCase: "Lead nurturing", apps: ["HubSpot", "Outlook"],
    name: "Lead nurture track assignment",
    description: "When a new lead arrives, picks the right nurture track from what they asked about and adds the contact to that track's HubSpot list (which your existing workflow emails). Needs: a HubSpot private app token (crm.lists.write) and the Anthropic key on the server. Compensation: removes the contact from the list if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 4, expectedMinutesSavedPerRun: 3.5, requiredCredentials: [C_HS],
    definition: chain([
      trigger("Lead created", { source: "webhook", example: { contactId: "901", interest: "Pricing for 40 seats", nurtureListId: "123" } }),
      llm("track", "Choose nurture track", "Choose one track: evaluation, education, or pricing. Reply with the single word.", "Lead interest: {{input.interest}}"),
      http("add", "Add to nurture list", { method: "PUT", url: `${HSA}/crm/v3/lists/{{input.nurtureListId}}/memberships/add`, ...HS, body: ["{{input.contactId}}"] },
        { kind: "http", method: "PUT", url: `${HSA}/crm/v3/lists/{{input.nurtureListId}}/memberships/remove`, ...HS, body: ["{{input.contactId}}"], note: "remove from nurture list" }),
      end(),
    ]),
  },
  {
    key: "mkt_weekly_analytics", category: "marketing", fn: "marketing", useCase: "Analytics", apps: ["Chrome", "Excel", "Google Analytics"],
    name: "Weekly marketing analytics digest",
    description: "Every Monday, runs a Google Analytics 4 report (sessions and key events by channel for the last 7 days) and emails a plain-English summary of what moved. Read-only. Needs: an HTTP bearer credential whose base URL is https://analyticsdata.googleapis.com/v1beta/properties/<your property id> with an OAuth access token (analytics.readonly), SMTP and the Anthropic key on the server.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 40, expectedMinutesSavedPerRun: 32, requiredCredentials: [bearer("Google Analytics Data API (property base URL + access token)"), C_SMTP],
    definition: chain([
      trigger("Monday 08:00", { source: "schedule" }),
      n("report", "http", "Run GA4 report", { method: "POST", url: "{{secret.baseUrl}}:runReport", ...BR, body: { dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }, { startDate: "14daysAgo", endDate: "8daysAgo" }], dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }, { name: "keyEvents" }] } }),
      llm("summary", "Summarize", "Summarize week-over-week changes by channel in 5 bullets for a non-technical owner. Use only the numbers given.", "{{nodes.report.body}}"),
      notify("send", "Marketing digest ready", { email: { to: "marketing@yourcompany.example", subject: "Weekly marketing analytics" }, bodyPath: "nodes.summary.text" }),
      end(),
    ], [], "0 8 * * 1"),
  },
  {
    key: "mkt_segmentation", category: "marketing", fn: "marketing", useCase: "Segmentation", apps: ["HubSpot", "Excel"],
    name: "Audience segment builder",
    description: "Counts contacts by lifecycle stage and industry in HubSpot (counts only — no personal data leaves HubSpot), proposes a target segment for a campaign, and after a marketer approves, creates the (empty, manual) list in HubSpot for them to fill. Needs: a HubSpot private app token (crm.objects.contacts.read, crm.lists.write) and the Anthropic key on the server. Compensation: deletes the created list if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 45, expectedMinutesSavedPerRun: 30, requiredCredentials: [C_HS],
    definition: chain([
      trigger("Segment request", { source: "manual", example: { goal: "Re-engage customers in construction", lifecycleStage: "customer", industry: "CONSTRUCTION" } }),
      n("count", "http", "Count matching contacts", { method: "POST", url: `${HSA}/crm/v3/objects/contacts/search`, ...HS, body: { filterGroups: [{ filters: [{ propertyName: "lifecyclestage", operator: "EQ", value: "{{input.lifecycleStage}}" }, { propertyName: "industry", operator: "EQ", value: "{{input.industry}}" }] }], properties: ["hs_object_id"], limit: 1 } }),
      llm("propose", "Propose segment", "Given the goal and the matching contact COUNT (field total), propose a segment name and definition in 2 sentences.", "Goal: {{input.goal}}. Matching contacts: {{nodes.count.body.total}}"),
      approval("approve", "Create HubSpot list for segment: {{input.goal}}", 3),
      http("create_list", "Create list", { method: "POST", url: `${HSA}/crm/v3/lists`, ...HS, body: { name: "BridgeBox segment — {{input.goal}}", objectTypeId: "0-1", processingType: "MANUAL" } },
        { kind: "http", method: "DELETE", url: `${HSA}/crm/v3/lists/{{nodes.create_list.body.list.listId}}`, ...HS, note: "delete created list" }),
      end(),
    ]),
  },
];
