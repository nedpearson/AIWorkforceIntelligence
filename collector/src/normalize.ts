/**
 * Normalisation: raw process/app names -> friendly app + category; raw window title -> coarse
 * category + salted hash. The raw title never leaves this module: callers only receive
 * { titleCategory, titleHash }. Nothing here touches keystrokes, clipboard, URLs or screen pixels.
 */
import { createHmac, randomBytes } from "node:crypto";

export type AppInfo = { app: string; appCategory: string };

/** process / bundle / owner name fragments -> friendly name + category. Lower-case keys, matched as substrings. */
const APP_MAP: [string, string, string][] = [
  ["excel", "Excel", "spreadsheet"], ["winword", "Word", "document"], ["microsoft word", "Word", "document"],
  ["powerpnt", "PowerPoint", "presentation"], ["microsoft powerpoint", "PowerPoint", "presentation"],
  ["outlook", "Outlook", "email"], ["olk", "Outlook", "email"], ["mail", "Mail", "email"], ["thunderbird", "Thunderbird", "email"],
  ["onenote", "OneNote", "notes"], ["notion", "Notion", "notes"], ["obsidian", "Obsidian", "notes"], ["evernote", "Evernote", "notes"],
  ["teams", "Teams", "meeting"], ["zoom", "Zoom", "meeting"], ["webex", "Webex", "meeting"], ["slack", "Slack", "chat"], ["discord", "Discord", "chat"],
  ["chrome", "Chrome", "browser"], ["msedge", "Edge", "browser"], ["microsoft edge", "Edge", "browser"], ["firefox", "Firefox", "browser"], ["safari", "Safari", "browser"], ["brave", "Brave", "browser"], ["arc", "Arc", "browser"], ["opera", "Opera", "browser"],
  ["acrobat", "Adobe Acrobat", "document"], ["acrord32", "Adobe Acrobat", "document"], ["preview", "Preview", "document"], ["foxit", "Foxit Reader", "document"],
  ["qbw", "QuickBooks", "accounting"], ["quickbooks", "QuickBooks", "accounting"], ["sage", "Sage", "accounting"], ["xero", "Xero", "accounting"],
  ["netsuite", "NetSuite", "erp"], ["sap", "SAP", "erp"], ["dynamics", "Dynamics 365", "erp"], ["oracle", "Oracle", "erp"],
  ["salesforce", "Salesforce", "crm"], ["hubspot", "HubSpot", "crm"], ["zendesk", "Zendesk", "helpdesk"], ["freshdesk", "Freshdesk", "helpdesk"], ["servicenow", "ServiceNow", "helpdesk"], ["jira", "Jira", "helpdesk"],
  ["explorer", "File Explorer", "files"], ["finder", "Finder", "files"], ["onedrive", "OneDrive", "files"], ["dropbox", "Dropbox", "files"],
  ["code", "VS Code", "dev"], ["terminal", "Terminal", "dev"], ["iterm", "Terminal", "dev"], ["windowsterminal", "Terminal", "dev"], ["powershell", "Terminal", "dev"], ["cmd", "Terminal", "dev"],
  ["notepad", "Notepad", "text"], ["textedit", "TextEdit", "text"], ["wordpad", "WordPad", "text"],
  ["calculator", "Calculator", "utility"], ["snipping", "Snipping Tool", "utility"], ["photos", "Photos", "media"], ["spotify", "Spotify", "media"], ["itunes", "Music", "media"], ["music", "Music", "media"],
  ["adp", "ADP", "hr"], ["workday", "Workday", "hr"], ["bamboohr", "BambooHR", "hr"], ["gusto", "Gusto", "hr"],
  ["docusign", "DocuSign", "esign"], ["adobe sign", "Adobe Sign", "esign"],
  ["figma", "Figma", "design"], ["photoshop", "Photoshop", "design"], ["illustrator", "Illustrator", "design"], ["canva", "Canva", "design"],
];

export function normalizeApp(raw: { processName?: string; appName?: string; bundleId?: string; path?: string }): AppInfo {
  const candidates = [raw.appName, raw.processName, raw.bundleId, raw.path?.split(/[\\/]/).pop()].filter(Boolean).map((s) => String(s).toLowerCase());
  for (const c of candidates) {
    const stripped = c.replace(/\.(exe|app)$/i, "");
    for (const [frag, name, cat] of APP_MAP) if (stripped === frag || stripped.includes(frag)) return { app: name, appCategory: cat };
  }
  // Unknown: keep a cleaned-up process name (no path, no extension), capped length.
  const base = (raw.appName || raw.processName || raw.bundleId || "Unknown").replace(/\.(exe|app)$/i, "").slice(0, 40);
  return { app: base.charAt(0).toUpperCase() + base.slice(1), appCategory: "other" };
}

/** Apps where a title-category change is a meaningful "document_open". */
export const DOC_APP_CATEGORIES = new Set(["spreadsheet", "document", "presentation", "accounting", "erp", "crm", "helpdesk", "email", "browser", "notes", "esign", "hr"]);

/**
 * Coarse title categories. Order matters: first match wins. Keywords are matched case-insensitively
 * against the raw title INSIDE this process only; the category string is all that is emitted.
 */
const TITLE_MAP: [string, RegExp][] = [
  ["invoice", /\binvoice|\bbills?\b|\bbilling\b|\bar\b|\bap\b|payable|receivable/i],
  ["purchase order", /purchase order|\bpo[-_ #]?\d|\bpo\b/i],
  ["order", /\border(s)?\b|sales order|quote|quotation/i],
  ["customer record", /customer|account\b|contact|client|lead\b|opportunit/i],
  ["ticket", /ticket|case\s?#|incident|support request|\bsr-?\d/i],
  ["contract", /contract|agreement|nda\b|msa\b|terms/i],
  ["report", /report|dashboard|analytics|kpi|summary|statement/i],
  ["reconcile", /reconcil|bank feed|ledger|journal/i],
  ["payroll", /payroll|timesheet|time card/i],
  ["onboarding form", /onboard|new hire|i-9|w-4|w-9/i],
  ["calendar", /calendar|meeting|appointment|schedule/i],
  ["inbox", /inbox|mail\b|message|sent items|drafts/i],
  ["spreadsheet", /\.xlsx?|\.csv|sheet|workbook/i],
  ["presentation", /\.pptx?|slide|deck/i],
  ["document", /\.docx?|\.pdf|memo|letter|policy|proposal/i],
  ["form", /\bform\b|application|submission/i],
  ["inventory", /inventory|stock|warehouse|shipment|tracking/i],
  ["search", /search|google|bing|results/i],
  ["knowledge base", /help center|knowledge|docs\b|wiki|how to/i],
  ["chat", /chat|channel|thread|direct message/i],
  ["settings", /settings|preferences|options/i],
];

export function categorizeTitle(rawTitle: string | undefined | null): string {
  if (!rawTitle) return "";
  for (const [cat, re] of TITLE_MAP) if (re.test(rawTitle)) return cat;
  return "general";
}

/** Strip the obvious volatile bits (counts, times, app suffix) so the same document hashes stably, then HMAC with a per-machine salt. */
export function hashTitle(rawTitle: string | undefined | null, salt: string): string {
  if (!rawTitle) return "";
  const stable = rawTitle.replace(/\(\d+\)/g, "").replace(/\s+-\s+[^-]+$/, "").replace(/\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
  return createHmac("sha256", salt).update(stable).digest("hex").slice(0, 24);
}

export function newSalt(): string { return randomBytes(16).toString("hex"); }

/** True when the app (or raw name) matches the blocked list. Matched as case-insensitive substrings. */
export function isBlocked(blocked: string[], ...names: (string | undefined)[]): boolean {
  const l = blocked.map((b) => b.toLowerCase());
  return names.some((n) => { const s = (n ?? "").toLowerCase(); return !!s && l.some((b) => s.includes(b)); });
}
