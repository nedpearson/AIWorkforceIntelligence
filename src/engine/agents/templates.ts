/**
 * Agent templates — one per opportunity category. Each template is a real, runnable node graph for the
 * internal runtime (src/engine/agents/runner.ts). Templates that map cleanly onto n8n also ship a real
 * n8n workflow export (nodes + connections) that `pushWorkflow` sends to the n8n public API.
 *
 * Costs come from IMPLEMENTATION_PROFILES / DEFAULTS in src/engine/costing.ts — never re-derived here.
 * Minutes per run are *assumed* baselines; the run ledger replaces them with observed values once deployed.
 */
import type { AgentDefinition, AgentNode } from "@/db/schema";
import { AI, CONV, n, chain, llm, http, notify, approval, end, trigger } from "./template-helpers";
import { LIBRARY_TEMPLATES } from "./templates-library";

export type AgentCategory = "customer_service" | "scheduling" | "sales_crm" | "email_admin" | "ap_ar" | "invoice" | "reporting" | "inventory" | "marketing" | "onboarding" | "document" | "data_entry";
export const AGENT_CATEGORIES: AgentCategory[] = ["customer_service", "scheduling", "sales_crm", "email_admin", "ap_ar", "invoice", "reporting", "inventory", "marketing", "onboarding", "document", "data_entry"];
export const CATEGORY_LABELS: Record<AgentCategory, string> = {
  customer_service: "Customer service", scheduling: "Scheduling", sales_crm: "Sales & CRM", email_admin: "Email admin", ap_ar: "AP / AR",
  invoice: "Invoicing", reporting: "Reporting", inventory: "Inventory", marketing: "Marketing", onboarding: "Onboarding", document: "Documents", data_entry: "Data entry",
};

export type RequiredCredential = { provider: string; label: string; fields: string[] };

/** Business functions used to group agents and the Automation Studio gallery. */
export type BusinessFunction = "finance" | "sales" | "operations" | "customer_service" | "hr" | "marketing";
export const BUSINESS_FUNCTIONS: { key: BusinessFunction; label: string; useCases: string[] }[] = [
  { key: "finance", label: "Finance", useCases: ["Accounts payable", "Accounts receivable", "Invoice processing", "Reconciliation", "Expense analysis", "Collections", "Financial reporting"] },
  { key: "sales", label: "Sales", useCases: ["Lead qualification", "CRM updates", "Scheduling", "Proposal generation", "Follow-ups", "Forecasting"] },
  { key: "operations", label: "Operations", useCases: ["Inventory", "Purchasing", "Vendor management", "Scheduling", "Document processing", "Workflow coordination"] },
  { key: "customer_service", label: "Customer Service", useCases: ["Email responses", "Ticket classification", "Customer inquiries", "Appointment confirmations", "Follow-ups"] },
  { key: "hr", label: "HR", useCases: ["Onboarding", "Scheduling admin", "Document management", "Policy information", "Training coordination"] },
  { key: "marketing", label: "Marketing", useCases: ["Campaigns", "Lead nurturing", "Content generation", "Analytics", "Segmentation"] },
];
export const FUNCTION_LABELS: Record<BusinessFunction, string> = Object.fromEntries(BUSINESS_FUNCTIONS.map((f) => [f.key, f.label])) as Record<BusinessFunction, string>;
/** Fallback function for an agent whose template is unknown. */
export const CATEGORY_FUNCTION: Record<AgentCategory, BusinessFunction> = {
  customer_service: "customer_service", scheduling: "operations", sales_crm: "sales", email_admin: "operations", ap_ar: "finance", invoice: "finance",
  reporting: "finance", inventory: "operations", marketing: "marketing", onboarding: "hr", document: "operations", data_entry: "operations",
};
export type N8nWorkflowJson = { name: string; nodes: Record<string, unknown>[]; connections: Record<string, unknown>; settings?: Record<string, unknown> };
export type AgentTemplate = {
  key: string; category: AgentCategory; name: string; description: string;
  definition: AgentDefinition; requiredCredentials: RequiredCredential[];
  baselineMinutesPerRun: number; expectedMinutesSavedPerRun: number; monthlyCost: number;
  runtime: "internal" | "n8n"; n8nWorkflowJson?: N8nWorkflowJson;
  /** Business function + use case for the gallery; `apps` are the desktop/web apps whose discovered workflows this template fits. */
  fn: BusinessFunction; useCase: string; apps: string[];
};
type BaseTemplate = Omit<AgentTemplate, "fn" | "useCase" | "apps">;

// ---- n8n exports (real node types / typeVersions from n8n 1.x) -------------------------------
const n8nWebhook = (name: string, path: string, pos: [number, number]) => ({ parameters: { httpMethod: "POST", path, responseMode: "onReceived", options: {} }, id: `wh-${path}`, name, type: "n8n-nodes-base.webhook", typeVersion: 2, position: pos, webhookId: path });
const n8nSchedule = (name: string, cron: string, pos: [number, number]) => ({ parameters: { rule: { interval: [{ field: "cronExpression", expression: cron }] } }, id: `sch-${name}`, name, type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: pos });
const n8nHttp = (name: string, url: string, method: string, body: Record<string, unknown> | undefined, pos: [number, number], extra: Record<string, unknown> = {}) => ({
  parameters: { method, url, sendBody: !!body, specifyBody: body ? "json" : undefined, jsonBody: body ? JSON.stringify(body) : undefined, options: { timeout: 15000 }, ...extra },
  id: `http-${name}`, name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos,
});
const n8nAnthropic = (name: string, system: string, promptExpr: string, pos: [number, number]) => ({
  parameters: {
    method: "POST", url: "https://api.anthropic.com/v1/messages", authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
    sendHeaders: true, headerParameters: { parameters: [{ name: "anthropic-version", value: "2023-06-01" }, { name: "content-type", value: "application/json" }] },
    sendBody: true, specifyBody: "json",
    jsonBody: `={{ JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, system: ${JSON.stringify(system)}, messages: [{ role: "user", content: ${promptExpr} }] }) }}`,
    options: { timeout: 30000 },
  },
  id: `llm-${name}`, name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos,
  credentials: { httpHeaderAuth: { id: "", name: "Anthropic x-api-key (set in n8n)" } },
});
const n8nIf = (name: string, leftExpr: string, op: string, right: string | number, pos: [number, number]) => ({
  parameters: { conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose" }, conditions: [{ id: `c-${name}`, leftValue: leftExpr, rightValue: right, operator: { type: typeof right === "number" ? "number" : "string", operation: op } }], combinator: "and" }, options: {} },
  id: `if-${name}`, name, type: "n8n-nodes-base.if", typeVersion: 2, position: pos,
});
const n8nSet = (name: string, assignments: { name: string; value: string; type?: string }[], pos: [number, number]) => ({
  parameters: { assignments: { assignments: assignments.map((a, i) => ({ id: `a${i}`, name: a.name, value: a.value, type: a.type ?? "string" })) }, options: {} },
  id: `set-${name}`, name, type: "n8n-nodes-base.set", typeVersion: 3.4, position: pos,
});
const n8nEmail = (name: string, to: string, subject: string, text: string, pos: [number, number]) => ({
  parameters: { fromEmail: "agents@example.com", toEmail: to, subject, emailFormat: "text", text, options: {} },
  id: `mail-${name}`, name, type: "n8n-nodes-base.emailSend", typeVersion: 2.1, position: pos, credentials: { smtp: { id: "", name: "SMTP (set in n8n)" } },
});
const conn = (pairs: [string, string, number?][]): Record<string, unknown> => {
  const c: Record<string, { main: { node: string; type: string; index: number }[][] }> = {};
  for (const [from, to, outIdx = 0] of pairs) {
    c[from] ??= { main: [] };
    while (c[from].main.length <= outIdx) c[from].main.push([]);
    c[from].main[outIdx].push({ node: to, type: "main", index: 0 });
  }
  return c;
};
const N8N_SETTINGS = { executionOrder: "v1", saveExecutionProgress: true, saveManualExecutions: true };

// ---- templates --------------------------------------------------------------------------------
const BASE_TEMPLATES: BaseTemplate[] = [
  {
    key: "customer_service_reply_drafting", category: "customer_service", name: "Support reply drafter",
    description: "Reads each incoming support ticket, drafts a reply in your tone, and posts it to the ticket. Replies that mention refunds or disputes wait for a person to approve first. Needs: a helpdesk API token (Zendesk) and the Anthropic key configured on the server. Compensation: posts a correction comment if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 9, expectedMinutesSavedPerRun: 6,
    requiredCredentials: [{ provider: "zendesk", label: "Helpdesk API", fields: ["subdomain", "email", "apiToken"] }],
    definition: chain([
      trigger("New ticket received", { source: "webhook", example: { ticketId: "123", subject: "Where is my order?", body: "Order 5541 hasn't arrived", customer: { name: "Dana" } } }),
      n("classify", "transform", "Extract ticket fields", { mapping: { ticketId: "input.ticketId", subject: "input.subject", body: "input.body", customer: "input.customer.name" } }),
      llm("draft", "Draft reply", "You are a courteous support agent. Reply in under 120 words. Never promise refunds; escalate billing disputes.", "Customer {{nodes.classify.customer}} wrote about \"{{nodes.classify.subject}}\":\n{{nodes.classify.body}}\n\nWrite the reply."),
      n("needs_escalation", "condition", "Mentions refund or dispute?", { left: "nodes.classify.body", op: "contains", right: "refund" }),
      approval("review", "Send drafted reply to customer", 2),
      http("post_reply", "Post reply to helpdesk", { method: "PUT", url: "https://{{secret.subdomain}}.zendesk.com/api/v2/tickets/{{nodes.classify.ticketId}}.json", auth: "basic", userField: "email", passField: "apiToken", credentialProvider: "zendesk", body: { ticket: { comment: { body: "{{nodes.draft.text}}", public: true } } } },
        { kind: "http", method: "PUT", url: "https://{{secret.subdomain}}.zendesk.com/api/v2/tickets/{{nodes.classify.ticketId}}.json", auth: "basic", userField: "email", passField: "apiToken", credentialProvider: "zendesk", body: { ticket: { comment: { body: "Correction: please disregard the previous automated reply; a teammate will follow up.", public: true } } } }),
      notify("notify", "Reply posted on ticket {{nodes.classify.ticketId}}"),
      end(),
    ], [{ from: "needs_escalation", to: "review", when: "true" }, { from: "needs_escalation", to: "post_reply", when: "false" }]),
    n8nWorkflowJson: {
      name: "BridgeBox — Support reply drafter",
      nodes: [
        n8nWebhook("Ticket webhook", "bridgebox/support-ticket", [0, 0]),
        n8nSet("Extract fields", [{ name: "ticketId", value: "={{ $json.body.ticketId }}" }, { name: "subject", value: "={{ $json.body.subject }}" }, { name: "body", value: "={{ $json.body.body }}" }], [220, 0]),
        n8nAnthropic("Draft reply", "You are a courteous support agent. Reply in under 120 words. Never promise refunds.", `"Subject: " + $json.subject + "\\n" + $json.body`, [440, 0]),
        n8nSet("Pick text", [{ name: "draft", value: "={{ $json.content[0].text }}" }, { name: "ticketId", value: "={{ $('Extract fields').item.json.ticketId }}" }], [660, 0]),
        n8nHttp("Post draft comment", "={{ 'https://' + $env.ZENDESK_SUBDOMAIN + '.zendesk.com/api/v2/tickets/' + $json.ticketId + '.json' }}", "PUT", { ticket: { comment: { body: "={{ $json.draft }}", public: false } } }, [880, 0], { authentication: "genericCredentialType", genericAuthType: "httpBasicAuth" }),
      ],
      connections: conn([["Ticket webhook", "Extract fields"], ["Extract fields", "Draft reply"], ["Draft reply", "Pick text"], ["Pick text", "Post draft comment"]]),
      settings: N8N_SETTINGS,
    },
  },
  {
    key: "scheduling_appointment_coordinator", category: "scheduling", name: "Appointment coordinator",
    description: "Takes a booking request, checks the calendar for a free slot via your calendar API, books it and emails a confirmation. Needs: an HTTP bearer token for your calendar/booking API and SMTP for the confirmation email.",
    runtime: "n8n", monthlyCost: CONV, baselineMinutesPerRun: 6, expectedMinutesSavedPerRun: 5,
    requiredCredentials: [{ provider: "http_bearer", label: "Calendar API", fields: ["baseUrl", "token"] }, { provider: "smtp", label: "Outbound email", fields: ["host", "port", "user", "password", "from"] }],
    definition: chain([
      trigger("Booking request", { source: "webhook", example: { requester: "dana@example.com", preferredStart: "2026-11-10T15:00:00Z", durationMin: 30, reason: "Consultation" } }),
      n("window", "transform", "Build search window", { mapping: { start: "input.preferredStart", durationMin: "input.durationMin", requester: "input.requester" } }),
      n("find_slot", "http", "Find free slot", { method: "GET", url: "{{secret.baseUrl}}/availability?from={{nodes.window.start}}&durationMin={{nodes.window.durationMin}}", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer" }),
      n("has_slot", "condition", "Slot found?", { left: "nodes.find_slot.body.slot", op: "exists" }),
      http("book", "Create booking", { method: "POST", url: "{{secret.baseUrl}}/bookings", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", body: { start: "{{nodes.find_slot.body.slot}}", durationMin: "{{nodes.window.durationMin}}", attendee: "{{nodes.window.requester}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/bookings/{{nodes.book.body.id}}", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer" }),
      notify("confirm", "Booked {{nodes.find_slot.body.slot}} for {{nodes.window.requester}}", { email: { to: "{{nodes.window.requester}}", subject: "Your appointment is confirmed" } }),
      end(),
    ], [{ from: "has_slot", to: "book", when: "true" }, { from: "has_slot", to: "end", when: "false" }]),
    n8nWorkflowJson: {
      name: "BridgeBox — Appointment coordinator",
      nodes: [
        n8nWebhook("Booking request", "bridgebox/booking", [0, 0]),
        n8nHttp("Find free slot", "={{ $env.CALENDAR_BASE_URL + '/availability?from=' + $json.body.preferredStart + '&durationMin=' + $json.body.durationMin }}", "GET", undefined, [220, 0], { authentication: "genericCredentialType", genericAuthType: "httpBearerAuth" }),
        n8nIf("Slot found?", "={{ $json.slot }}", "exists", "", [440, 0]),
        n8nHttp("Create booking", "={{ $env.CALENDAR_BASE_URL + '/bookings' }}", "POST", { start: "={{ $json.slot }}", attendee: "={{ $('Booking request').item.json.body.requester }}" }, [660, -100], { authentication: "genericCredentialType", genericAuthType: "httpBearerAuth" }),
        n8nEmail("Send confirmation", "={{ $('Booking request').item.json.body.requester }}", "Your appointment is confirmed", "={{ 'Booked for ' + $('Find free slot').item.json.slot }}", [880, -100]),
        n8nEmail("No slot email", "={{ $('Booking request').item.json.body.requester }}", "We could not find a slot", "A teammate will reach out with alternatives.", [660, 100]),
      ],
      connections: conn([["Booking request", "Find free slot"], ["Find free slot", "Slot found?"], ["Slot found?", "Create booking", 0], ["Slot found?", "No slot email", 1], ["Create booking", "Send confirmation"]]),
      settings: N8N_SETTINGS,
    },
  },
  {
    key: "sales_crm_lead_enrichment", category: "sales_crm", name: "Lead qualifier & CRM updater",
    description: "When a new lead arrives, summarizes what they want, scores fit against your ideal-customer notes and writes the summary and score to the CRM contact. Needs: a HubSpot private app token (or any CRM with a REST API) and the Anthropic key on the server.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 12, expectedMinutesSavedPerRun: 9,
    requiredCredentials: [{ provider: "hubspot", label: "HubSpot private app", fields: ["accessToken"] }],
    definition: chain([
      trigger("New lead", { source: "webhook", example: { contactId: "901", email: "lead@example.com", company: "Acme", message: "Looking for 40 licenses" } }),
      llm("score", "Score and summarize", "You qualify B2B leads. Return JSON {\"score\": 0-100, \"summary\": string, \"nextStep\": string}.", "Lead from {{input.company}} ({{input.email}}): {{input.message}}"),
      n("shape", "transform", "Prepare CRM properties", { mapping: { contactId: "input.contactId", notes: "nodes.score.text" } }),
      http("update_crm", "Update CRM contact", { method: "PATCH", url: "https://api.hubapi.com/crm/v3/objects/contacts/{{nodes.shape.contactId}}", auth: "bearer", tokenField: "accessToken", credentialProvider: "hubspot", body: { properties: { bridgebox_lead_notes: "{{nodes.shape.notes}}" } } },
        { kind: "http", method: "PATCH", url: "https://api.hubapi.com/crm/v3/objects/contacts/{{nodes.shape.contactId}}", auth: "bearer", tokenField: "accessToken", credentialProvider: "hubspot", body: { properties: { bridgebox_lead_notes: "" } } }),
      notify("notify", "Lead {{input.email}} scored and updated in CRM"),
      end(),
    ]),
  },
  {
    key: "email_admin_triage", category: "email_admin", name: "Inbox triage & routing",
    description: "Sorts each incoming email into a category (billing, support, sales, spam, other), labels it in the mailbox and forwards it to the right queue address. Needs: an HTTP bearer token for your mailbox API (Microsoft Graph or Gmail via a proxy), SMTP for forwarding and the Anthropic key on the server. Compensation: removes the applied label if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 4, expectedMinutesSavedPerRun: 3,
    requiredCredentials: [{ provider: "http_bearer", label: "Mailbox API", fields: ["baseUrl", "token"] }, { provider: "smtp", label: "Outbound email", fields: ["host", "port", "user", "password", "from"] }],
    definition: chain([
      trigger("Email received", { source: "webhook", example: { messageId: "m-1", from: "someone@example.com", subject: "Invoice question", body: "Can I get a copy of invoice 1002?" } }),
      llm("categorize", "Categorize", "Classify the email. Reply with exactly one word: billing, support, sales, spam, other.", "Subject: {{input.subject}}\n\n{{input.body}}"),
      n("is_spam", "condition", "Spam?", { left: "nodes.categorize.text", op: "contains", right: "spam" }),
      n("route", "transform", "Pick queue", { mapping: { queue: "nodes.categorize.text", from: "input.from", subject: "input.subject", messageId: "input.messageId" } }),
      http("label", "Apply queue label in mailbox", { method: "POST", url: "{{secret.baseUrl}}/messages/{{nodes.route.messageId}}/labels", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", body: { label: "{{nodes.route.queue}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/messages/{{nodes.route.messageId}}/labels/{{nodes.route.queue}}", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", note: "remove applied label" }),
      notify("forward", "Routed \"{{nodes.route.subject}}\" from {{nodes.route.from}} to {{nodes.route.queue}} queue", { email: { to: "{{nodes.route.queue}}@yourcompany.example", subject: "FWD: {{nodes.route.subject}}" } }),
      end(),
    ], [{ from: "is_spam", to: "end", when: "true" }, { from: "is_spam", to: "route", when: "false" }]),
  },
  {
    key: "ap_ar_invoice_intake", category: "ap_ar", name: "Vendor bill intake (AP)",
    description: "Reads a vendor bill from email or upload, extracts vendor, amount, due date and line items, checks it against the PO total, asks a person to approve bills over your threshold, then creates the bill in QuickBooks. Needs: a QuickBooks Online OAuth token and the Anthropic key on the server. Compensation: voids the created bill if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 14, expectedMinutesSavedPerRun: 11,
    requiredCredentials: [{ provider: "quickbooks", label: "QuickBooks Online", fields: ["realmId", "accessToken"] }],
    definition: chain([
      trigger("Bill received", { source: "webhook", example: { vendor: "Office Supply Co", amount: 1240.5, dueDate: "2026-12-01", poNumber: "PO-778", poTotal: 1240.5, text: "Invoice #A-1003 ..." } }),
      llm("extract", "Extract bill fields", "Extract vendor, total, due date, invoice number and line items from the bill text. Return JSON only.", "{{input.text}}"),
      n("shape", "transform", "Shape bill", { mapping: { vendor: "input.vendor", amount: "input.amount", dueDate: "input.dueDate", poTotal: "input.poTotal", extracted: "nodes.extract.text" } }),
      n("over_threshold", "condition", "Amount over $1,000?", { left: "nodes.shape.amount", op: "gt", right: 1000 }),
      approval("approve_bill", "Create vendor bill in QuickBooks for {{nodes.shape.vendor}} — ${{nodes.shape.amount}}", 3),
      http("create_bill", "Create bill in QuickBooks", { method: "POST", url: "https://quickbooks.api.intuit.com/v3/company/{{secret.realmId}}/bill?minorversion=73", auth: "bearer", tokenField: "accessToken", credentialProvider: "quickbooks", body: { VendorRef: { name: "{{nodes.shape.vendor}}" }, TotalAmt: "{{nodes.shape.amount}}", DueDate: "{{nodes.shape.dueDate}}", Line: [{ Amount: "{{nodes.shape.amount}}", DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }] } },
        { kind: "http", method: "POST", url: "https://quickbooks.api.intuit.com/v3/company/{{secret.realmId}}/bill?operation=void&minorversion=73", auth: "bearer", tokenField: "accessToken", credentialProvider: "quickbooks", body: { Id: "{{nodes.create_bill.body.Bill.Id}}", SyncToken: "{{nodes.create_bill.body.Bill.SyncToken}}" }, note: "void created bill" }),
      notify("notify", "Bill for {{nodes.shape.vendor}} (${{nodes.shape.amount}}) created in QuickBooks"),
      end(),
    ], [{ from: "over_threshold", to: "approve_bill", when: "true" }, { from: "over_threshold", to: "create_bill", when: "false" }]),
    n8nWorkflowJson: {
      name: "BridgeBox — Vendor bill intake",
      nodes: [
        n8nWebhook("Bill received", "bridgebox/ap-bill", [0, 0]),
        n8nAnthropic("Extract bill fields", "Extract vendor, total, due date, invoice number and line items. Return JSON only.", "$json.body.text", [220, 0]),
        n8nSet("Parse JSON", [{ name: "bill", value: "={{ JSON.parse($json.content[0].text) }}", type: "object" }], [440, 0]),
        n8nIf("Over threshold?", "={{ $json.bill.total }}", "gt", 1000, [660, 0]),
        n8nEmail("Request approval", "ap-approvals@yourcompany.example", "Bill needs approval", "={{ 'Vendor ' + $json.bill.vendor + ' total ' + $json.bill.total + '. Approve in BridgeBox.' }}", [880, -100]),
        n8nHttp("Create QuickBooks bill", "={{ 'https://quickbooks.api.intuit.com/v3/company/' + $env.QBO_REALM_ID + '/bill?minorversion=73' }}", "POST", { VendorRef: { name: "={{ $json.bill.vendor }}" }, TotalAmt: "={{ $json.bill.total }}", Line: [{ Amount: "={{ $json.bill.total }}", DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }] }, [880, 100], { authentication: "predefinedCredentialType", nodeCredentialType: "quickBooksOAuth2Api" }),
      ],
      connections: conn([["Bill received", "Extract bill fields"], ["Extract bill fields", "Parse JSON"], ["Parse JSON", "Over threshold?"], ["Over threshold?", "Request approval", 0], ["Over threshold?", "Create QuickBooks bill", 1]]),
      settings: N8N_SETTINGS,
    },
  },
  {
    key: "invoice_generation", category: "invoice", name: "Customer invoice generator",
    description: "Turns a completed job or order into a customer invoice: builds the line items, creates the invoice in QuickBooks and emails the PDF link to the customer after a person approves it. Needs: QuickBooks Online token and SMTP. Compensation: voids the created invoice if sending fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 10, expectedMinutesSavedPerRun: 8,
    requiredCredentials: [{ provider: "quickbooks", label: "QuickBooks Online", fields: ["realmId", "accessToken"] }, { provider: "smtp", label: "Outbound email", fields: ["host", "port", "user", "password", "from"] }],
    definition: chain([
      trigger("Job completed", { source: "webhook", example: { customerRef: "58", customerEmail: "ap@customer.example", items: [{ desc: "Service call", qty: 1, unitPrice: 250 }] } }),
      n("lines", "transform", "Build invoice lines", { mapping: { customerRef: "input.customerRef", items: "input.items", email: "input.customerEmail" } }),
      approval("approve", "Send invoice to {{nodes.lines.email}}", 2),
      http("create_invoice", "Create invoice in QuickBooks", { method: "POST", url: "https://quickbooks.api.intuit.com/v3/company/{{secret.realmId}}/invoice?minorversion=73", auth: "bearer", tokenField: "accessToken", credentialProvider: "quickbooks", body: { CustomerRef: { value: "{{nodes.lines.customerRef}}" }, Line: "{{nodes.lines.items}}" } },
        { kind: "http", method: "POST", url: "https://quickbooks.api.intuit.com/v3/company/{{secret.realmId}}/invoice?operation=void&minorversion=73", auth: "bearer", tokenField: "accessToken", credentialProvider: "quickbooks", body: { Id: "{{nodes.create_invoice.body.Invoice.Id}}", SyncToken: "{{nodes.create_invoice.body.Invoice.SyncToken}}" }, note: "void created invoice" }),
      http("send_invoice", "Email invoice via QuickBooks", { method: "POST", url: "https://quickbooks.api.intuit.com/v3/company/{{secret.realmId}}/invoice/{{nodes.create_invoice.body.Invoice.Id}}/send?sendTo={{nodes.lines.email}}&minorversion=73", auth: "bearer", tokenField: "accessToken", credentialProvider: "quickbooks" }),
      notify("notify", "Invoice {{nodes.create_invoice.body.Invoice.DocNumber}} sent to {{nodes.lines.email}}"),
      end(),
    ]),
  },
  {
    key: "reporting_weekly_digest", category: "reporting", name: "Weekly KPI digest",
    description: "Every Monday morning, pulls the numbers from your reporting API, writes a short plain-English summary and emails it to the leadership list. Needs: an HTTP bearer token for the data source and SMTP; Anthropic key optional (without it the digest is numbers only).",
    runtime: "n8n", monthlyCost: CONV, baselineMinutesPerRun: 45, expectedMinutesSavedPerRun: 40,
    requiredCredentials: [{ provider: "http_bearer", label: "Reporting API", fields: ["baseUrl", "token"] }, { provider: "smtp", label: "Outbound email", fields: ["host", "port", "user", "password", "from"] }],
    definition: chain([
      trigger("Monday 7:00", { source: "schedule", example: { week: "2026-W46" } }),
      n("fetch", "http", "Fetch KPIs", { method: "GET", url: "{{secret.baseUrl}}/kpis?period=last_week", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer" }),
      llm("summarize", "Write summary", "Summarize these KPIs for a non-technical owner in 5 bullets. Flag anything down more than 10%.", "{{nodes.fetch.body}}"),
      notify("send", "Weekly digest ready", { email: { to: "leadership@yourcompany.example", subject: "Weekly KPI digest" }, bodyPath: "nodes.summarize.text" }),
      end(),
    ], [], "0 7 * * 1"),
    n8nWorkflowJson: {
      name: "BridgeBox — Weekly KPI digest",
      nodes: [
        n8nSchedule("Every Monday 07:00", "0 7 * * 1", [0, 0]),
        n8nHttp("Fetch KPIs", "={{ $env.REPORTING_BASE_URL + '/kpis?period=last_week' }}", "GET", undefined, [220, 0], { authentication: "genericCredentialType", genericAuthType: "httpBearerAuth" }),
        n8nAnthropic("Summarize", "Summarize these KPIs for a non-technical owner in 5 bullets.", "JSON.stringify($json)", [440, 0]),
        n8nEmail("Email digest", "leadership@yourcompany.example", "Weekly KPI digest", "={{ $json.content[0].text }}", [660, 0]),
      ],
      connections: conn([["Every Monday 07:00", "Fetch KPIs"], ["Fetch KPIs", "Summarize"], ["Summarize", "Email digest"]]),
      settings: N8N_SETTINGS,
    },
  },
  {
    key: "inventory_reorder", category: "inventory", name: "Low-stock reorder",
    description: "Checks stock levels daily, finds SKUs under their reorder point, asks a person to approve the purchase order, then creates the PO with the supplier API. Needs: an HTTP bearer token for your inventory/supplier API. Compensation: cancels the PO if a later step fails.",
    runtime: "internal", monthlyCost: CONV, baselineMinutesPerRun: 25, expectedMinutesSavedPerRun: 20,
    requiredCredentials: [{ provider: "http_bearer", label: "Inventory / supplier API", fields: ["baseUrl", "token"] }],
    definition: chain([
      trigger("Daily 06:00", { source: "schedule" }),
      n("levels", "http", "Fetch stock levels", { method: "GET", url: "{{secret.baseUrl}}/stock?below=reorder_point", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer" }),
      n("any_low", "condition", "Any SKU below reorder point?", { left: "nodes.levels.body.items.0", op: "exists" }),
      approval("approve_po", "Create purchase order for low-stock SKUs", 5),
      http("create_po", "Create purchase order", { method: "POST", url: "{{secret.baseUrl}}/purchase-orders", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", body: { items: "{{nodes.levels.body.items}}" } },
        { kind: "http", method: "POST", url: "{{secret.baseUrl}}/purchase-orders/{{nodes.create_po.body.id}}/cancel", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", note: "cancel created PO" }),
      notify("notify", "PO {{nodes.create_po.body.id}} created"),
      end(),
    ], [{ from: "any_low", to: "approve_po", when: "true" }, { from: "any_low", to: "end", when: "false" }], "0 6 * * *"),
  },
  {
    key: "marketing_social_drafts", category: "marketing", name: "Social post drafter",
    description: "Turns a product update or blog link into three social post variants and a short email blurb, then queues them for a person to approve before posting via your scheduling tool API. Needs: HTTP bearer token for your scheduling tool and the Anthropic key on the server.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 35, expectedMinutesSavedPerRun: 25,
    requiredCredentials: [{ provider: "http_bearer", label: "Social scheduling API", fields: ["baseUrl", "token"] }],
    definition: chain([
      trigger("Content brief", { source: "manual", example: { topic: "New smart-film line", url: "https://example.com/blog/smart-film", tone: "friendly" } }),
      llm("variants", "Write 3 post variants", "You write concise social posts. Return JSON {\"linkedin\": string, \"x\": string, \"instagram\": string}.", "Topic: {{input.topic}}\nLink: {{input.url}}\nTone: {{input.tone}}"),
      approval("review", "Queue 3 social posts about {{input.topic}}", 4),
      http("queue", "Queue posts", { method: "POST", url: "{{secret.baseUrl}}/posts", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", body: { posts: "{{nodes.variants.text}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/posts/{{nodes.queue.body.batchId}}", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", note: "remove queued batch" }),
      notify("notify", "Posts queued for {{input.topic}}"),
      end(),
    ]),
  },
  {
    key: "onboarding_new_hire", category: "onboarding", name: "New-hire onboarding kickoff",
    description: "When HR adds a new hire, creates their accounts via your identity/HR API, sends the welcome email with first-week schedule and opens the IT equipment ticket. Needs: HTTP bearer token for the HR/identity API and SMTP. Compensation: deactivates the created account if a later step fails.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 40, expectedMinutesSavedPerRun: 30,
    requiredCredentials: [{ provider: "http_bearer", label: "HR / identity API", fields: ["baseUrl", "token"] }, { provider: "smtp", label: "Outbound email", fields: ["host", "port", "user", "password", "from"] }],
    definition: chain([
      trigger("New hire added", { source: "webhook", example: { name: "Sam Lee", email: "sam@yourcompany.example", startDate: "2026-12-01", role: "Sales rep", manager: "dana@yourcompany.example" } }),
      approval("approve", "Provision accounts for {{input.name}} starting {{input.startDate}}", 2),
      http("create_account", "Create user account", { method: "POST", url: "{{secret.baseUrl}}/users", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", body: { name: "{{input.name}}", email: "{{input.email}}", role: "{{input.role}}" } },
        { kind: "http", method: "POST", url: "{{secret.baseUrl}}/users/{{nodes.create_account.body.id}}/deactivate", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", note: "deactivate created account" }),
      llm("welcome", "Write welcome email", "Write a warm 120-word welcome email for a new hire with their first-week plan.", "Name {{input.name}}, role {{input.role}}, start {{input.startDate}}, manager {{input.manager}}"),
      http("it_ticket", "Open IT equipment ticket", { method: "POST", url: "{{secret.baseUrl}}/tickets", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", body: { title: "Laptop for {{input.name}}", due: "{{input.startDate}}" } }),
      notify("send", "Welcome email ready for {{input.email}}", { email: { to: "{{input.email}}", subject: "Welcome aboard" }, bodyPath: "nodes.welcome.text" }),
      end(),
    ]),
  },
  {
    key: "document_summarizer", category: "document", name: "Contract & document summarizer",
    description: "Reads an uploaded document (contract, policy, RFP), produces a one-page summary with key dates, obligations and risks, and files the summary back via your document API. Needs: HTTP bearer token for the document store and the Anthropic key on the server.",
    runtime: "internal", monthlyCost: AI, baselineMinutesPerRun: 30, expectedMinutesSavedPerRun: 22,
    requiredCredentials: [{ provider: "http_bearer", label: "Document store API", fields: ["baseUrl", "token"] }],
    definition: chain([
      trigger("Document uploaded", { source: "webhook", example: { documentId: "doc-1", title: "MSA — Acme", text: "This Master Services Agreement ..." } }),
      llm("summary", "Summarize document", "Summarize the document for a business owner: purpose, parties, key dates, payment terms, obligations, risks. Under 300 words.", "{{input.text}}"),
      http("file", "Save summary", { method: "POST", url: "{{secret.baseUrl}}/documents/{{input.documentId}}/summary", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", body: { summary: "{{nodes.summary.text}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/documents/{{input.documentId}}/summary", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", note: "remove saved summary" }),
      notify("notify", "Summary filed for {{input.title}}"),
      end(),
    ]),
  },
  {
    key: "data_entry_form_to_system", category: "data_entry", name: "Form-to-system data entry",
    description: "Takes a submitted form or spreadsheet row, maps the fields to your system's API format, validates required fields and creates the record — no retyping. Needs: an HTTP bearer token for the target system. Compensation: deletes the created record if a later step fails.",
    runtime: "internal", monthlyCost: CONV, baselineMinutesPerRun: 5, expectedMinutesSavedPerRun: 4,
    requiredCredentials: [{ provider: "http_bearer", label: "Target system API", fields: ["baseUrl", "token"] }],
    definition: chain([
      trigger("Form submitted", { source: "webhook", example: { firstName: "Dana", lastName: "Kim", phone: "225-555-0100", email: "dana@example.com", source: "web" } }),
      n("map", "transform", "Map fields", { mapping: { name: "input.firstName", surname: "input.lastName", phone: "input.phone", email: "input.email", channel: "input.source" } }),
      n("valid", "condition", "Has email?", { left: "nodes.map.email", op: "exists" }),
      http("create", "Create record", { method: "POST", url: "{{secret.baseUrl}}/records", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", body: { name: "{{nodes.map.name}}", surname: "{{nodes.map.surname}}", phone: "{{nodes.map.phone}}", email: "{{nodes.map.email}}", channel: "{{nodes.map.channel}}" } },
        { kind: "http", method: "DELETE", url: "{{secret.baseUrl}}/records/{{nodes.create.body.id}}", auth: "bearer", tokenField: "token", credentialProvider: "http_bearer", note: "delete created record" }),
      notify("notify", "Record created for {{nodes.map.email}}"),
      end(),
    ], [{ from: "valid", to: "create", when: "true" }, { from: "valid", to: "end", when: "false" }]),
  },
];

const BASE_META: Record<string, Pick<AgentTemplate, "fn" | "useCase" | "apps">> = {
  customer_service_reply_drafting: { fn: "customer_service", useCase: "Customer inquiries", apps: ["Zendesk", "Freshdesk", "Outlook"] },
  scheduling_appointment_coordinator: { fn: "operations", useCase: "Scheduling", apps: ["Outlook", "Google Calendar", "Calendly"] },
  sales_crm_lead_enrichment: { fn: "sales", useCase: "Lead qualification", apps: ["HubSpot", "Salesforce", "Outlook"] },
  email_admin_triage: { fn: "operations", useCase: "Workflow coordination", apps: ["Outlook", "Gmail"] },
  ap_ar_invoice_intake: { fn: "finance", useCase: "Accounts payable", apps: ["QuickBooks", "Adobe Acrobat", "Outlook", "NetSuite"] },
  invoice_generation: { fn: "finance", useCase: "Invoice processing", apps: ["QuickBooks", "Excel", "Word"] },
  reporting_weekly_digest: { fn: "finance", useCase: "Financial reporting", apps: ["Excel", "PowerPoint", "Power BI"] },
  inventory_reorder: { fn: "operations", useCase: "Inventory", apps: ["NetSuite", "Excel", "QuickBooks"] },
  marketing_social_drafts: { fn: "marketing", useCase: "Content generation", apps: ["Chrome", "Word", "Canva"] },
  onboarding_new_hire: { fn: "hr", useCase: "Onboarding", apps: ["Workday", "BambooHR", "Outlook"] },
  document_summarizer: { fn: "operations", useCase: "Document processing", apps: ["Adobe Acrobat", "Word", "DocuSign"] },
  data_entry_form_to_system: { fn: "operations", useCase: "Document processing", apps: ["Excel", "Chrome"] },
};

export const AGENT_TEMPLATES: AgentTemplate[] = [...BASE_TEMPLATES.map((t) => ({ ...t, ...BASE_META[t.key] })), ...LIBRARY_TEMPLATES];

/** Business function of an agent: its template's function, else the category fallback. */
export function agentFunction(a: { templateKey?: string | null; category: string }): BusinessFunction {
  const t = a.templateKey ? AGENT_TEMPLATES.find((x) => x.key === a.templateKey) : undefined;
  return t?.fn ?? CATEGORY_FUNCTION[a.category as AgentCategory] ?? "operations";
}

export function getTemplate(key: string): AgentTemplate | undefined { return AGENT_TEMPLATES.find((t) => t.key === key); }
export function templateForCategory(category: string): AgentTemplate | undefined { return AGENT_TEMPLATES.find((t) => t.category === category); }

/** Pick the best template for an opportunity: explicit recommendedAgentCategory first, then the apps seen in the workflow. */
export function recommendTemplate(
  opportunity: { recommendedAgentCategory?: string | null; title?: string; type?: string } | null | undefined,
  workflow: { steps?: { app: string; category?: string }[] | null; name?: string } | null | undefined,
): AgentTemplate {
  const cat = opportunity?.recommendedAgentCategory;
  if (cat) { const t = templateForCategory(cat); if (t) return t; }
  const apps = (workflow?.steps ?? []).map((s) => `${s.app} ${s.category ?? ""}`.toLowerCase()).join(" ");
  const text = `${opportunity?.title ?? ""} ${workflow?.name ?? ""}`.toLowerCase() + " " + apps;
  const rules: [RegExp, AgentCategory][] = [
    [/quickbooks|xero|bill\.com|accounts payable|\bap\b|vendor bill|erp/, "ap_ar"],
    [/invoice/, "invoice"],
    [/zendesk|freshdesk|helpdesk|ticket|support/, "customer_service"],
    [/calendar|schedul|booking|appointment/, "scheduling"],
    [/hubspot|salesforce|crm|lead/, "sales_crm"],
    [/outlook|gmail|email|inbox/, "email_admin"],
    [/report|dashboard|power bi|tableau|excel/, "reporting"],
    [/inventory|stock|sku|warehouse/, "inventory"],
    [/marketing|social|campaign|mailchimp/, "marketing"],
    [/onboard|new hire|hr|bamboo/, "onboarding"],
    [/contract|document|pdf|docusign|word/, "document"],
    [/data entry|form|spreadsheet|copy|paste/, "data_entry"],
  ];
  for (const [re, c] of rules) if (re.test(text)) return templateForCategory(c)!;
  return templateForCategory("data_entry")!;
}
