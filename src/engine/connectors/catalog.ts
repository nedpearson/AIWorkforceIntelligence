/**
 * Integrations Marketplace catalog. Static facts only (what the vendor API is, how it authenticates, what we would
 * read and which scopes we would request) plus the HONEST build state of our connector:
 *
 *   implemented: "full"     connector code exists here and can be configured on the marketplace (HubSpot, n8n)
 *                "env"      implemented, configured only through server environment variables (Stripe, Anthropic, OIDC)
 *                "adapter"  documented-export mapper exists, live API is license-gated (Power Automate, UiPath, Mimica)
 *                "none"     catalog entry only — no connector code exists yet
 *
 * Live per-org status (connected / configured / available / not_built / license_required) is resolved in service.ts.
 * Pure: no DB, no env reads.
 */
export type ConnectorCategory = "ERP" | "CRM" | "Accounting" | "Payroll" | "Productivity" | "Collaboration" | "ITSM" | "Process mining" | "Platform";
export type AuthMethod = "OAuth 2.0 authorization code" | "OAuth 2.0 client credentials" | "API key" | "Private app token" | "Token-based auth (TBA)" | "OpenID Connect" | "Bearer token" | "Server environment variable";
export type ConnectorStatus = "connected" | "configured" | "available" | "not_built" | "license_required";
export type CatalogEntry = {
  key: string; name: string; vendor: string; category: ConnectorCategory;
  api: string; docsUrl: string; auth: AuthMethod[]; dataAvailable: string[]; scopes: string[];
  implemented: "full" | "env" | "adapter" | "none";
  /** Integration provider enum value in the DB, when one exists. */
  provider?: string;
  envVars?: string[];
  /** What the connector does / will do in BridgeBox, in plain English. */
  purpose: string;
  /** Honest note shown in the drawer (license, partner programme, how agents can already use the API). */
  note?: string;
};

export const CATEGORY_ACCENT: Record<ConnectorCategory, "royal" | "purple" | "cyan" | "emerald" | "gold" | "coral" | "indigo" | "midnight"> = {
  ERP: "indigo", CRM: "royal", Accounting: "emerald", Payroll: "gold", Productivity: "cyan", Collaboration: "purple", ITSM: "coral", "Process mining": "purple", Platform: "midnight",
};
export const CONNECTOR_CATEGORIES: ConnectorCategory[] = ["ERP", "CRM", "Accounting", "Payroll", "Productivity", "Collaboration", "ITSM", "Process mining", "Platform"];

const VAULT_NOTE = "Agents can already call this API today through an HTTP step with a credential from the vault; what is not built is the marketplace connector (connection test, scheduled sync, health).";

export const CONNECTOR_CATALOG: CatalogEntry[] = [
  { key: "microsoft_365", provider: "microsoft_365", name: "Microsoft 365", vendor: "Microsoft", category: "Productivity", implemented: "none",
    api: "Microsoft Graph REST API v1.0", docsUrl: "https://learn.microsoft.com/en-us/graph/overview", auth: ["OAuth 2.0 authorization code", "OAuth 2.0 client credentials"],
    dataAvailable: ["Users, managers and departments (org chart)", "Calendar event metadata (meeting load per person)", "Microsoft 365 usage reports (mail / Teams activity counts)"],
    scopes: ["User.Read.All", "Calendars.Read", "Reports.Read.All"],
    purpose: "Would import the org chart and meeting-load metadata so Workforce Intelligence can separate meeting time from process time — counts and durations only, never message or event content.", note: VAULT_NOTE },
  { key: "google_workspace", provider: "google_workspace", name: "Google Workspace", vendor: "Google", category: "Productivity", implemented: "none",
    api: "Admin SDK Directory & Reports APIs, Google Calendar API", docsUrl: "https://developers.google.com/workspace/admin/directory/v1/guides", auth: ["OAuth 2.0 client credentials", "OAuth 2.0 authorization code"],
    dataAvailable: ["Users, org units and managers", "Calendar event metadata", "Usage reports (Gmail / Drive activity counts)"],
    scopes: ["https://www.googleapis.com/auth/admin.directory.user.readonly", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/admin.reports.usage.readonly"],
    purpose: "Would import the directory and meeting-load metadata via a service account with domain-wide delegation; metadata only.", note: "Client credentials here means a service account with domain-wide delegation granted by a Workspace super admin." },
  { key: "salesforce", provider: "salesforce", name: "Salesforce", vendor: "Salesforce", category: "CRM", implemented: "none",
    api: "Salesforce REST API", docsUrl: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_rest.htm", auth: ["OAuth 2.0 authorization code"],
    dataAvailable: ["Opportunity pipeline by stage (counts, amounts)", "Lead and Case volumes", "Task / activity counts per owner"],
    scopes: ["api", "refresh_token"],
    purpose: "Would sync pipeline and case volumes (counts and amounts, no contact data) to size sales and service workflows.", note: "Requires a Connected App in your Salesforce org. " + VAULT_NOTE },
  { key: "hubspot", provider: "hubspot", name: "HubSpot", vendor: "HubSpot", category: "CRM", implemented: "full",
    api: "HubSpot CRM API v3", docsUrl: "https://developers.hubspot.com/docs/api/private-apps", auth: ["Private app token"],
    dataAvailable: ["Owner (user) count", "Contact count", "Deal pipelines: deals and amount per stage"],
    scopes: ["crm.objects.contacts.read", "crm.objects.deals.read", "crm.objects.owners.read"],
    purpose: "Tests the token, then syncs owner and contact counts and a deal-pipeline summary (count and amount per stage). Only counts and amounts are stored — no names, emails or other contact data. The same token can be attached to HubSpot agents.",
    note: "Verified against HubSpot's published API documentation; not yet tested with a live HubSpot account." },
  { key: "sap", provider: "sap", name: "SAP S/4HANA", vendor: "SAP", category: "ERP", implemented: "none",
    api: "SAP S/4HANA Cloud OData APIs (API_PURCHASEORDER_PROCESS_SRV, API_SUPPLIERINVOICE_PROCESS_SRV)", docsUrl: "https://api.sap.com/products/SAPS4HANACloud/apis/ODATA", auth: ["OAuth 2.0 client credentials"],
    dataAvailable: ["Purchase order volumes and cycle times", "Supplier invoice volumes, blocked invoices", "Journal entry counts by type"],
    scopes: ["Communication arrangement for the purchase-order and supplier-invoice OData services (read)"],
    purpose: "Would measure procure-to-pay and record-to-report volumes and cycle times as observed process data." },
  { key: "oracle", provider: "oracle", name: "Oracle Fusion Cloud", vendor: "Oracle", category: "ERP", implemented: "none",
    api: "Oracle Fusion Cloud Financials / Procurement REST API", docsUrl: "https://docs.oracle.com/en/cloud/saas/financials/", auth: ["OAuth 2.0 client credentials"],
    dataAvailable: ["Payables invoice volumes and holds", "Purchase orders", "Receivables transactions"],
    scopes: ["Read-only integration user with Payables and Procurement inquiry duties"],
    purpose: "Would measure payables and procurement throughput for Finance and Operations workflows." },
  { key: "netsuite", provider: "netsuite", name: "NetSuite", vendor: "Oracle NetSuite", category: "ERP", implemented: "none",
    api: "SuiteTalk REST Web Services (record service + SuiteQL)", docsUrl: "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1540391670.html", auth: ["Token-based auth (TBA)", "OAuth 2.0 client credentials"],
    dataAvailable: ["Transaction counts by type (sales orders, bills, invoices)", "Approval queue sizes", "Item and inventory levels"],
    scopes: ["REST Web Services permission", "Read-only role on transactions"],
    purpose: "Would size order-to-cash and procure-to-pay workflows observed in NetSuite.", note: VAULT_NOTE },
  { key: "workday", provider: "workday", name: "Workday", vendor: "Workday", category: "Payroll", implemented: "none",
    api: "Workday REST API (Staffing, Human Resources)", docsUrl: "https://community.workday.com/sites/default/files/file-hosting/restapi/index.html", auth: ["OAuth 2.0 authorization code"],
    dataAvailable: ["Workers, positions and supervisory organizations", "Job profiles", "Cost centers"],
    scopes: ["Staffing (view)", "Organizations and Roles (view)"],
    purpose: "Would keep employees, departments and reporting lines in sync so workforce analysis uses your system of record.", note: "Requires an API client registered in your Workday tenant." },
  { key: "adp", provider: "adp", name: "ADP", vendor: "ADP", category: "Payroll", implemented: "none",
    api: "ADP Workforce Now APIs (Workers v2)", docsUrl: "https://developers.adp.com/", auth: ["OAuth 2.0 client credentials"],
    dataAvailable: ["Workers and assignments", "Pay rates (for loaded-cost calculation)", "Departments"],
    scopes: ["Workers read"],
    purpose: "Would import pay rates so loaded hourly cost is observed instead of assumed.", note: "ADP requires mutual-TLS certificates and onboarding through the ADP Marketplace partner programme before any API call is possible." },
  { key: "quickbooks", provider: "quickbooks", name: "QuickBooks Online", vendor: "Intuit", category: "Accounting", implemented: "none",
    api: "QuickBooks Online Accounting API v3", docsUrl: "https://developer.intuit.com/app/developer/qbo/docs/get-started", auth: ["OAuth 2.0 authorization code"],
    dataAvailable: ["Bills, invoices and payments (counts, ageing)", "Profit & Loss and Balance Sheet reports", "Vendors and customers counts"],
    scopes: ["com.intuit.quickbooks.accounting"],
    purpose: "Would sync AP/AR volumes and ageing to size finance workflows and verify savings against real expense lines.", note: VAULT_NOTE + " Finance templates (AP intake, collections, reconciliation, month-end pack) use QuickBooks this way." },
  { key: "servicenow", provider: "servicenow", name: "ServiceNow", vendor: "ServiceNow", category: "ITSM", implemented: "none",
    api: "ServiceNow Table API", docsUrl: "https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI", auth: ["OAuth 2.0 authorization code", "OAuth 2.0 client credentials"],
    dataAvailable: ["Incident and request volumes by category", "Resolution times and reassignment counts", "SLA breaches"],
    scopes: ["Read ACLs on incident, sc_request, task_sla"],
    purpose: "Would measure IT and HR service-desk workload and handoffs as observed process data." },
  { key: "slack", provider: "slack", name: "Slack", vendor: "Salesforce", category: "Collaboration", implemented: "none",
    api: "Slack Web API", docsUrl: "https://api.slack.com/web", auth: ["OAuth 2.0 authorization code"],
    dataAvailable: ["Channel list", "Post messages from agents"],
    scopes: ["channels:read", "chat:write"],
    purpose: "Would let agents post handoffs and approvals into Slack with a managed bot install.", note: VAULT_NOTE + " The workflow-handoff and HR policy templates post to Slack this way." },
  { key: "teams", provider: "teams", name: "Microsoft Teams", vendor: "Microsoft", category: "Collaboration", implemented: "none",
    api: "Microsoft Graph Teams API", docsUrl: "https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview", auth: ["OAuth 2.0 authorization code"],
    dataAvailable: ["Teams and channels", "Post channel messages from agents"],
    scopes: ["Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Send"],
    purpose: "Would let agents post approvals and notifications into Teams channels.", note: VAULT_NOTE },
  { key: "sharepoint", provider: "sharepoint", name: "SharePoint", vendor: "Microsoft", category: "Productivity", implemented: "none",
    api: "Microsoft Graph SharePoint & Drive API", docsUrl: "https://learn.microsoft.com/en-us/graph/api/resources/sharepoint", auth: ["OAuth 2.0 authorization code", "OAuth 2.0 client credentials"],
    dataAvailable: ["Sites and document libraries", "Read documents for summarization agents", "Write generated reports"],
    scopes: ["Sites.Read.All", "Files.ReadWrite.All"],
    purpose: "Would give document agents a managed document store (read policies, file generated packs).", note: VAULT_NOTE },
  { key: "zendesk", provider: "zendesk", name: "Zendesk", vendor: "Zendesk", category: "ITSM", implemented: "none",
    api: "Zendesk Support API v2", docsUrl: "https://developer.zendesk.com/api-reference/", auth: ["API key", "OAuth 2.0 authorization code"],
    dataAvailable: ["Ticket volumes by tag and channel", "First-reply and resolution times", "Satisfaction ratings (aggregated)"],
    scopes: ["read", "tickets:write"],
    purpose: "Would sync ticket volumes and handling times to size customer-service workflows.", note: VAULT_NOTE + " The customer-service templates use Zendesk this way (email + API token)." },
  { key: "n8n", provider: "n8n", name: "n8n", vendor: "n8n", category: "Platform", implemented: "full",
    api: "n8n public REST API v1", docsUrl: "https://docs.n8n.io/api/", auth: ["API key"],
    dataAvailable: ["Push agent workflows", "Import executions into the run ledger"],
    scopes: ["n8n API key (instance-wide)"],
    purpose: "Optional agent runtime: pushes agent workflows to your n8n instance and imports their executions as run-ledger entries.", envVars: ["N8N_BASE_URL", "N8N_API_KEY"] },
  { key: "stripe", provider: "stripe", name: "Stripe", vendor: "Stripe", category: "Platform", implemented: "env",
    api: "Stripe API", docsUrl: "https://docs.stripe.com/api", auth: ["Server environment variable"],
    dataAvailable: ["Subscription status", "Invoices"],
    scopes: ["Secret key (server only)", "Webhook signing secret"],
    purpose: "Bills this organization's BridgeBox subscription. Keys live in the server environment only.", envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] },
  { key: "anthropic", provider: "anthropic", name: "Anthropic", vendor: "Anthropic", category: "Platform", implemented: "env",
    api: "Anthropic Messages API", docsUrl: "https://docs.anthropic.com/en/api/messages", auth: ["Server environment variable"],
    dataAvailable: ["LLM steps inside agents", "AI Strategy Advisor answers"],
    scopes: ["API key (server only)"],
    purpose: "Powers agent LLM steps and the AI Strategy Advisor. Without the key, LLM steps are skipped and recorded as skipped — never faked.", envVars: ["ANTHROPIC_API_KEY"] },
  { key: "oidc", provider: "oidc", name: "OIDC single sign-on", vendor: "Any OpenID Connect provider", category: "Platform", implemented: "env",
    api: "OpenID Connect Core 1.0", docsUrl: "https://openid.net/specs/openid-connect-core-1_0.html", auth: ["OpenID Connect"],
    dataAvailable: ["Sign-in identity (subject, email, name)"],
    scopes: ["openid", "email", "profile"],
    purpose: "Single sign-on through Entra ID, Okta, Google Workspace or any OIDC provider.", envVars: ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] },
  { key: "scim", provider: "scim", name: "SCIM provisioning", vendor: "IETF standard", category: "Platform", implemented: "none",
    api: "SCIM 2.0 (RFC 7643 / 7644)", docsUrl: "https://datatracker.ietf.org/doc/html/rfc7644", auth: ["Bearer token"],
    dataAvailable: ["Create / update / deactivate users from your identity provider", "Group → role mapping"],
    scopes: ["Bearer token issued by BridgeBox to your IdP"],
    purpose: "Would let Entra ID / Okta provision and deprovision BridgeBox users automatically. BridgeBox does not expose a SCIM endpoint yet." },
  { key: "power_automate", provider: "power_automate", name: "Power Automate Process Mining", vendor: "Microsoft", category: "Process mining", implemented: "adapter",
    api: "Dataverse Web API (process mining entities)", docsUrl: "https://learn.microsoft.com/en-us/power-automate/process-mining-overview", auth: ["OAuth 2.0 client credentials"],
    dataAvailable: ["Discovered processes, activities and case counts"], scopes: ["Dataverse application user with read on process mining tables"],
    purpose: "Imports discovered processes into Workflows as observed data.", envVars: ["POWER_AUTOMATE_TENANT_ID", "POWER_AUTOMATE_CLIENT_ID", "POWER_AUTOMATE_CLIENT_SECRET"] },
  { key: "uipath", provider: "uipath", name: "UiPath Task & Process Mining", vendor: "UiPath", category: "Process mining", implemented: "adapter",
    api: "UiPath Automation Cloud APIs (Task Mining analysis export)", docsUrl: "https://docs.uipath.com/task-mining/automation-cloud/latest", auth: ["OAuth 2.0 client credentials"],
    dataAvailable: ["Task Mining analyses: tasks, steps, applications, durations"], scopes: ["External application with Task Mining read scope"],
    purpose: "Imports task-mining analyses into Workflows as observed data.", envVars: ["UIPATH_ORG", "UIPATH_TENANT", "UIPATH_CLIENT_ID", "UIPATH_CLIENT_SECRET"] },
  { key: "mimica", provider: "mimica", name: "Mimica", vendor: "Mimica", category: "Process mining", implemented: "adapter",
    api: "Mimica Mapper export API", docsUrl: "https://www.mimica.ai/", auth: ["API key"],
    dataAvailable: ["Mapped processes and step frequencies"], scopes: ["Mimica API key"],
    purpose: "Imports Mimica process maps into Workflows as observed data.", envVars: ["MIMICA_API_KEY"] },
  { key: "celonis", provider: "celonis", name: "Celonis", vendor: "Celonis", category: "Process mining", implemented: "none",
    api: "Celonis Intelligence API / Data Integration API", docsUrl: "https://docs.celonis.com/en/celonis-apis.html", auth: ["API key", "OAuth 2.0 client credentials"],
    dataAvailable: ["Knowledge-model KPIs", "Process event logs"], scopes: ["Application key with access to the data pool / knowledge model"],
    purpose: "Would import Celonis process KPIs alongside BridgeBox's own observations.", envVars: ["CELONIS_TEAM_URL", "CELONIS_API_KEY"], note: "Requires a Celonis EMS license; no BridgeBox connector has been built yet." },
];

export function catalogEntry(key: string): CatalogEntry | undefined { return CONNECTOR_CATALOG.find((c) => c.key === key); }
