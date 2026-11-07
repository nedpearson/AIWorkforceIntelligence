/**
 * Invoice intelligence — pure, deterministic code (no DB, no network). Used by the `process_invoice` and
 * `prepare_invoice` skills.
 *
 *  - parseInvoiceText(): regex/heuristic extraction of header fields, totals and line items from pasted or
 *    PDF-extracted text, with a confidence score, the extraction method and the character span of every field
 *    (spans index into the normalized text that is returned alongside, so the UI can highlight them).
 *  - validateInvoice(): required fields, line math, subtotal + tax (+ shipping − discount) = total, due date vs terms,
 *    approved-vendor check.
 *  - matchPurchaseOrder(): vendor + amount tolerance against a PO register.
 *  - buildAccountingEntry(): balanced journal entry (Dr expense/inventory by line category, Cr Accounts Payable).
 *
 * Invoice text is untrusted data: nothing in it is ever executed or treated as an instruction.
 */

export type FieldKey = "vendor" | "invoiceNumber" | "invoiceDate" | "dueDate" | "poNumber" | "terms" | "currency" | "subtotal" | "tax" | "shipping" | "discount" | "total";
export type FieldMethod = "labelled" | "heuristic" | "computed" | "structured" | "missing";
export type ExtractedField = { value: string | number | null; confidence: number; method: FieldMethod; raw?: string; span?: [number, number] };
export type LineCategory = "inventory" | "freight" | "services" | "software" | "office" | "repairs" | "other";
export type InvoiceLine = { description: string; quantity: number; unitPrice: number; amount: number; category: LineCategory; confidence: number; span?: [number, number]; mathOk: boolean };
export type ParsedInvoice = { text: string; fields: Record<FieldKey, ExtractedField>; lines: InvoiceLine[]; overallConfidence: number; warnings: string[]; source: "text" | "structured" | "pdf" };

export const FIELD_LABELS: Record<FieldKey, string> = {
  vendor: "Vendor", invoiceNumber: "Invoice #", invoiceDate: "Invoice date", dueDate: "Due date", poNumber: "PO #", terms: "Terms", currency: "Currency",
  subtotal: "Subtotal", tax: "Tax", shipping: "Shipping", discount: "Discount", total: "Total",
};
export const REQUIRED_FIELDS: FieldKey[] = ["vendor", "invoiceNumber", "invoiceDate", "total"];

const r2 = (n: number) => Math.round(n * 100) / 100;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_SRC = `(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|\\d{1,2}-\\d{1,2}-\\d{4}|${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_RE},?\\s+\\d{4})`;
const MONEY_TOKEN = /(?:USD|US\$|CAD|EUR|GBP|[$€£])?\s?\(?-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\)?|(?:USD|US\$|CAD|EUR|GBP|[$€£])?\s?\(?-?\d+(?:\.\d{1,2})?\)?/g;

/** "$1,234.56" | "USD 1234.56" | "(12.00)" | "1.234,56" → number (parentheses / leading minus = negative). */
export function parseMoney(s: string | null | undefined): number | null {
  if (s == null) return null;
  let t = String(s).trim();
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t.replace(/(USD|US\$|CAD|EUR|GBP|[$€£])/gi, "").trim()) || /^-|^\(?\s*-|-\s*(USD|\$)/.test(t);
  t = t.replace(/(USD|US\$|CAD|EUR|GBP|[$€£()\s-])/gi, "");
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? r2(neg ? -v : v) : null;
}

/** Many date spellings → ISO yyyy-mm-dd (US month/day order for slashes). Returns null when not a valid date. */
export function parseDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  let y = 0, m = 0, d = 0, x: RegExpMatchArray | null;
  if ((x = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/))) { m = +x[1]; d = +x[2]; y = +x[3]; if (y < 100) y += 2000; }
  else if ((x = t.match(new RegExp(`^${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`)))) { m = MONTHS.indexOf(x[1].slice(0, 3)) + 1; d = +x[2]; y = +x[3]; }
  else if ((x = t.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE},?\\s+(\\d{4})`)))) { d = +x[1]; m = MONTHS.indexOf(x[2].slice(0, 3)) + 1; y = +x[3]; }
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
export const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

/** "Net 30" → 30, "2/10 Net 30" → 30, "Due on receipt" → 0. */
export function termsDays(terms: string | null | undefined): number | null {
  if (!terms) return null;
  const t = terms.toLowerCase();
  if (/due\s+(on|upon)\s+receipt|cod\b|cash on delivery/.test(t)) return 0;
  const m = t.match(/net\s*(\d{1,3})/);
  return m ? +m[1] : null;
}

export function normalizeInvoiceText(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/ /g, " ").replace(/[–—]/g, "-").replace(/\n{4,}/g, "\n\n\n");
}

const COMPANY_SUFFIX = /\b(inc|llc|l\.l\.c|co|corp|corporation|company|ltd|limited|lp|llp|group|supply|supplies|services|partners|industries|distributors?|wholesale)\b\.?/i;
const HEADER_LABELS = /\b(invoice|inv\.?\s*(no|#|date)|date|due|p\.?\s?o\.?\b|purchase\s+order|terms|bill\s+to|ship\s+to|sold\s+to|remit|customer|account|page\s+\d|phone|tel|fax|email|e-mail|www\.|https?:)/i;
const TOTAL_LABELS = /\b(sub[\s-]?total|total|tax|vat|gst|shipping|freight\s+charge|amount\s+due|balance\s+due|discount|credit|paid|payment)\b/i;
const ITEM_HEADER = /\b(description|item|product|service|details)\b.*\b(qty|quantity|units?|hrs|hours)\b|\b(qty|quantity)\b.*\b(amount|total|price|rate)\b/i;

export function categorizeLine(description: string): LineCategory {
  const d = description.toLowerCase();
  if (/\b(freight|shipping|delivery|courier|postage|handling|ltl)\b/.test(d)) return "freight";
  if (/\b(software|subscription|license|licence|saas|seat|hosting|cloud)\b/.test(d)) return "software";
  if (/\b(repair|maintenance|service call|parts? replacement|calibration)\b/.test(d)) return "repairs";
  if (/\b(consult|labor|labour|installation|install|hours?|hrs|professional|training|design|audit|cleaning|janitorial)\b/.test(d)) return "services";
  if (/\b(paper|toner|ink|office|pens?|binders?|stationery|folders?|chairs?|desks?|furniture)\b/.test(d)) return "office";
  if (/\b(pallet|case|cases|box|boxes|units?|pcs|each|sku|stock|valve|pipe|fitting|bolt|widget|material|lumber|sheet|roll|gasket|filter|cable|wire|bracket)\b/.test(d)) return "inventory";
  return "other";
}

type Line = { text: string; start: number };
function splitLines(text: string): Line[] {
  const out: Line[] = []; let pos = 0;
  for (const t of text.split("\n")) { out.push({ text: t, start: pos }); pos += t.length + 1; }
  return out;
}

function field(value: string | number | null, confidence: number, method: FieldMethod, raw?: string, span?: [number, number]): ExtractedField {
  return { value, confidence: value == null ? 0 : Math.round(confidence * 100) / 100, method: value == null ? "missing" : method, ...(raw ? { raw } : {}), ...(span ? { span } : {}) };
}
const missing = (): ExtractedField => ({ value: null, confidence: 0, method: "missing" });

/** Find the first regex match whose group 1 passes `ok`; returns value + absolute span of group 1. */
function findLabelled(text: string, re: RegExp, ok: (v: string) => boolean = () => true): { value: string; span: [number, number] } | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of text.matchAll(g)) {
    const v = (m[1] ?? "").trim();
    if (!v || !ok(v)) continue;
    const at = (m.index ?? 0) + m[0].indexOf(m[1]);
    return { value: v, span: [at, at + m[1].trimEnd().length] };
  }
  return null;
}

/** Trailing numeric group of a line: returns numbers (with spans) and the description before them. */
function trailingNumbers(line: string): { description: string; nums: { v: number; raw: string; money: boolean }[]; descEnd: number } {
  const nums: { v: number; raw: string; money: boolean }[] = [];
  let rest = line.replace(/\|/g, " ");
  const re = /(?:^|\s)(?:@\s*)?((?:USD|US\$|CAD|EUR|GBP|[$€£])?\s?\(?-?\d[\d,]*(?:\.\d+)?\)?)(?:\s*(?:ea|each|\/hr|\/ea|hrs?|units?|pcs?|x))?\s*$/i;
  for (let i = 0; i < 5; i++) {
    const m = rest.match(re); if (!m) break;
    const raw = m[1].trim(); const v = parseMoney(raw); if (v == null) break;
    nums.unshift({ v, raw, money: /[$€£]|USD|\.\d{2}\b/i.test(raw) || /,\d{3}/.test(raw) });
    rest = rest.slice(0, m.index ?? 0).replace(/\s+(x|@|=)\s*$/i, "");
  }
  const description = rest.replace(/^[\s\-•*#]+/, "").replace(/\s{2,}/g, " ").trim();
  return { description, nums, descEnd: rest.length };
}

/** Parse one candidate line-item line. */
function parseItemLine(text: string, inItemRegion: boolean): Omit<InvoiceLine, "category" | "span"> | null {
  const t = text.trim();
  if (!t || t.length < 3) return null;
  // "10 x Widget @ $12.50 = $125.00" / "10 × Widget @ 12.50"
  const x = t.match(/^(\d+(?:\.\d+)?)\s*(?:x|×|pcs?|units?)\s+(.+?)\s*@\s*((?:USD|\$)?\s?[\d,]+(?:\.\d+)?)(?:\s*(?:ea|each))?(?:\s*=\s*((?:USD|\$)?\s?[\d,]+(?:\.\d+)?))?\s*$/i);
  if (x) {
    const q = Number(x[1]); const u = parseMoney(x[3]) ?? 0; const a = x[4] ? (parseMoney(x[4]) ?? r2(q * u)) : r2(q * u);
    return { description: x[2].trim(), quantity: q, unitPrice: u, amount: a, confidence: x[4] ? 0.9 : 0.75, mathOk: Math.abs(q * u - a) <= Math.max(0.02, a * 0.005) };
  }
  const { description, nums } = trailingNumbers(t);
  if (!/[a-z]{2,}/i.test(description) || parseDate(description) || /^(page|tel|phone|fax)\b/i.test(description)) return null;
  if (nums.length >= 3) {
    const [q, u, a] = nums.slice(-3).map((n) => n.v);
    const ok = (qq: number, uu: number) => Math.abs(qq * uu - a) <= Math.max(0.02, Math.abs(a) * 0.005);
    if (ok(q, u)) return { description, quantity: q, unitPrice: u, amount: a, confidence: 0.92, mathOk: true };
    return { description, quantity: q, unitPrice: u, amount: a, confidence: 0.55, mathOk: false };
  }
  if (nums.length === 2) {
    const [first, a] = nums; const amount = a.v;
    if (Number.isInteger(first.v) && first.v > 0 && first.v < 10000 && !first.money) return { description, quantity: first.v, unitPrice: r2(amount / first.v), amount, confidence: 0.7, mathOk: true };
    return { description, quantity: 1, unitPrice: amount, amount, confidence: 0.6, mathOk: true };
  }
  if (nums.length === 1 && (nums[0].money || inItemRegion) && Math.abs(nums[0].v) >= 0.01) return { description, quantity: 1, unitPrice: nums[0].v, amount: nums[0].v, confidence: inItemRegion ? 0.7 : 0.6, mathOk: true };
  return null;
}

/** Extract an invoice from free text (pasted, emailed or PDF-extracted). Never throws on messy input. */
export function parseInvoiceText(input: string, source: "text" | "pdf" = "text"): ParsedInvoice {
  const text = normalizeInvoiceText(input);
  const lines = splitLines(text);
  const warnings: string[] = [];
  const fields = {} as Record<FieldKey, ExtractedField>;

  // ---- header fields
  const hasDigit = (v: string) => /\d/.test(v);
  const inv = findLabelled(text, /\b(?:invoice|inv)\.?\s*(?:no\.?|number|num\.?|#|id)\s*[:#.]?\s*#?\s*([A-Z0-9][A-Z0-9\-\/_.]{1,30}[A-Z0-9])/i, hasDigit)
    ?? findLabelled(text, /\binvoice\s*[:#]\s*([A-Z0-9][A-Z0-9\-\/_]{2,30})/i, hasDigit);
  fields.invoiceNumber = inv ? field(inv.value.replace(/[.,]$/, ""), 0.95, "labelled", inv.value, inv.span) : missing();

  const po = findLabelled(text, /\b(?:p\.?\s?o\.?|purchase\s+order)\s*(?:no\.?|number|num\.?|#|ref(?:erence)?)?\s*[:#.]?\s*#?\s*([A-Z0-9][A-Z0-9\-\/_]{1,30})/i, (v) => hasDigit(v) && !/^box$/i.test(v));
  fields.poNumber = po ? field(po.value, 0.93, "labelled", po.value, po.span) : missing();

  const dateLabel = (labels: string) => new RegExp(`\\b(?:${labels})\\s*[:\\-]?\\s*${DATE_SRC}`, "i");
  const invDate = findLabelled(text, dateLabel("invoice\\s+date|date\\s+of\\s+issue|issue\\s+date|issued(?:\\s+on)?|inv\\.?\\s*date|bill\\s+date"), (v) => !!parseDate(v))
    ?? findLabelled(text, new RegExp(`(?<!due\\s)(?<!ship\\s)(?<!order\\s)(?<!delivery\\s)\\bdate\\s*[:\\-]?\\s*${DATE_SRC}`, "i"), (v) => !!parseDate(v));
  fields.invoiceDate = invDate ? field(parseDate(invDate.value), 0.93, "labelled", invDate.value, invDate.span) : missing();
  if (!invDate) {
    // heuristic: first date anywhere that is not labelled due
    const any = findLabelled(text, new RegExp(DATE_SRC, "i"), (v) => !!parseDate(v));
    if (any) {
      const before = text.slice(Math.max(0, any.span[0] - 12), any.span[0]).toLowerCase();
      if (!/due|ship|deliver/.test(before)) fields.invoiceDate = field(parseDate(any.value), 0.55, "heuristic", any.value, any.span);
    }
  }
  const due = findLabelled(text, dateLabel("due\\s+date|payment\\s+due(?:\\s+date)?|due\\s+by|due\\s+on|pay\\s+by|date\\s+due|due(?=\\s*:)"), (v) => !!parseDate(v));
  fields.dueDate = due ? field(parseDate(due.value), 0.93, "labelled", due.value, due.span) : missing();

  const termsL = findLabelled(text, /\b(?:payment\s+)?terms\s*[:\-]?\s*((?:\d{1,2}\s*\/\s*\d{1,2}\s+)?net\s*\d{1,3}(?:\s+days)?|due\s+(?:on|upon)\s+receipt|cod)\b/i);
  const termsH = termsL ? null : findLabelled(text, /\b((?:\d{1,2}\s*\/\s*\d{1,2}\s+)?net\s*\d{1,3}|due\s+(?:on|upon)\s+receipt)\b/i);
  const tm = termsL ?? termsH;
  fields.terms = tm ? field(tm.value.replace(/\s+/g, " ").replace(/^net/i, "Net").replace(/net(\d)/i, "Net $1"), termsL ? 0.95 : 0.7, termsL ? "labelled" : "heuristic", tm.value, tm.span) : missing();

  const vendL = findLabelled(text, /\b(?:from|vendor|supplier|bill(?:ed)?\s+from|remit\s+(?:payment\s+)?to|sold\s+by|seller|payee)\s*[:\-]\s*([^\n|]{2,80}?)(?=\s{2,}|\n|$)/i, (v) => /[a-z]{2,}/i.test(v) && !parseDate(v));
  if (vendL) fields.vendor = field(vendL.value.replace(/[,;]+$/, ""), 0.95, "labelled", vendL.value, vendL.span);
  else {
    let found: ExtractedField = missing();
    for (const l of lines.slice(0, 8)) {
      const raw = l.text.replace(/\b(tax\s+)?invoice\b|\bbill\b|\bstatement\b/ig, " ").replace(/[#:|]/g, " ").trim();
      if (!raw || !/[a-z]{3,}/i.test(raw) || /\d{3,}/.test(raw) || /@|www\.|https?:/i.test(raw) || HEADER_LABELS.test(l.text.replace(/\binvoice\b/i, ""))) continue;
      const name = raw.split(/\s{2,}/)[0].trim();
      const at = l.start + l.text.indexOf(name);
      found = field(name, COMPANY_SUFFIX.test(name) ? 0.75 : 0.55, "heuristic", name, [at, at + name.length]);
      break;
    }
    fields.vendor = found;
  }

  const cur = text.match(/\b(USD|CAD|EUR|GBP)\b|([$€£])/);
  fields.currency = cur ? field(cur[1] ?? ({ "$": "USD", "€": "EUR", "£": "GBP" } as Record<string, string>)[cur[2]], cur[1] ? 0.95 : 0.8, "labelled") : field("USD", 0.4, "heuristic");

  // ---- totals block
  let subtotalIdx = -1; let totalsStart = -1;
  const lastMoney = (l: Line): { v: number; span: [number, number]; raw: string } | null => {
    const ms = [...l.text.replace(/\|/g, " ").matchAll(MONEY_TOKEN)].filter((m) => /\d/.test(m[0]));
    const m = ms[ms.length - 1]; if (!m) return null;
    const raw = m[0].trim(); const v = parseMoney(raw); if (v == null) return null;
    const at = l.start + (m.index ?? 0) + m[0].indexOf(raw);
    return { v, span: [at, at + raw.length], raw };
  };
  const totalsFound: Partial<Record<"subtotal" | "tax" | "shipping" | "discount" | "total", { v: number; span: [number, number]; raw: string; pri: number }>> = {};
  lines.forEach((l, i) => {
    const lab = l.text.toLowerCase();
    if (!TOTAL_LABELS.test(lab)) return;
    const mny = lastMoney(l); if (!mny) return;
    const label = lab.replace(MONEY_TOKEN, " ");
    if (/sub[\s-]?total/.test(label)) { if (!totalsFound.subtotal) { totalsFound.subtotal = { ...mny, pri: 1 }; subtotalIdx = i; if (totalsStart < 0) totalsStart = i; } return; }
    if (/\b(sales\s+)?tax\b|\bvat\b|\bgst\b|\bhst\b/.test(label) && !/tax\s*(id|exempt|number|no)\b|ein\b/.test(label)) { if (/%/.test(label) && /\d+(\.\d+)?\s*%/.test(label) && Math.abs(mny.v) < 100 && /%\s*$/.test(l.text.trim())) return; totalsFound.tax = { v: r2((totalsFound.tax?.v ?? 0) + mny.v), span: mny.span, raw: mny.raw, pri: 1 }; if (totalsStart < 0) totalsStart = i; return; }
    if (/\b(discount|credit)\b/.test(label) && !/credit\s+card/.test(label)) { if (subtotalIdx >= 0 || /total/.test(lab)) { totalsFound.discount = { v: -Math.abs(mny.v), span: mny.span, raw: mny.raw, pri: 1 }; } return; }
    if (/\b(shipping|freight|delivery|s&h|handling)\b/.test(label) && subtotalIdx >= 0 && i > subtotalIdx) { totalsFound.shipping = { ...mny, pri: 1 }; return; }
    if (/\b(paid|payment)\b/.test(label) && !/\b(amount|balance|total)\b/.test(label)) return;
    if (new RegExp(DATE_SRC, "i").test(l.text)) return; // date lines are header fields, not totals
    const pri = /\b(amount\s+due|balance\s+due|total\s+due|grand\s+total|invoice\s+total|total\s+amount|amount\s+payable|please\s+pay)\b/.test(label) ? 3 : /\btotal\b/.test(label) ? 2 : /\bdue\b/.test(label) ? 1 : 0;
    if (pri && (!totalsFound.total || pri >= totalsFound.total.pri)) { totalsFound.total = { ...mny, pri }; if (totalsStart < 0) totalsStart = i; }
  });

  // ---- line items: region after an item header (if any) and before the totals block
  const headerIdx = lines.findIndex((l) => ITEM_HEADER.test(l.text));
  const endIdx = totalsStart >= 0 ? totalsStart : lines.length;
  const items: InvoiceLine[] = [];
  for (let i = headerIdx >= 0 ? headerIdx + 1 : 0; i < endIdx; i++) {
    const l = lines[i];
    if (headerIdx < 0 && HEADER_LABELS.test(l.text)) continue;
    if (TOTAL_LABELS.test(l.text) && /\b(sub[\s-]?total|total|amount due|balance due)\b/i.test(l.text)) continue;
    if (/^\s*(bill|ship|sold)\s+to\b|^\s*(attn|attention)\b/i.test(l.text)) continue;
    const it = parseItemLine(l.text, headerIdx >= 0);
    if (!it) continue;
    const lead = l.text.length - l.text.trimStart().length;
    items.push({ ...it, category: categorizeLine(it.description), span: [l.start + lead, l.start + l.text.trimEnd().length] });
  }
  const linesSum = r2(items.reduce((s, x) => s + x.amount, 0));

  fields.subtotal = totalsFound.subtotal ? field(totalsFound.subtotal.v, 0.95, "labelled", totalsFound.subtotal.raw, totalsFound.subtotal.span)
    : items.length ? field(linesSum, 0.65, "computed") : missing();
  fields.tax = totalsFound.tax ? field(totalsFound.tax.v, 0.92, "labelled", totalsFound.tax.raw, totalsFound.tax.span) : field(0, 0.5, "computed");
  fields.shipping = totalsFound.shipping ? field(totalsFound.shipping.v, 0.9, "labelled", totalsFound.shipping.raw, totalsFound.shipping.span) : field(0, 0.5, "computed");
  fields.discount = totalsFound.discount ? field(totalsFound.discount.v, 0.9, "labelled", totalsFound.discount.raw, totalsFound.discount.span) : field(0, 0.5, "computed");
  if (totalsFound.total) fields.total = field(totalsFound.total.v, totalsFound.total.pri >= 2 ? 0.95 : 0.75, "labelled", totalsFound.total.raw, totalsFound.total.span);
  else fields.total = missing();

  // confidence boost when the math reconciles
  const st = num(fields.subtotal.value), tot = num(fields.total.value);
  if (fields.total.value != null && Math.abs(st + num(fields.tax.value) + num(fields.shipping.value) + num(fields.discount.value) - tot) <= 0.02) {
    for (const k of ["subtotal", "tax", "total"] as const) if (fields[k].method !== "missing") fields[k].confidence = Math.round(Math.min(0.99, fields[k].confidence + 0.04) * 100) / 100;
  }
  if (!items.length) warnings.push("No line items could be identified — review the invoice manually.");
  if (source === "pdf" && text.trim().length < 40) warnings.push("Very little text was extracted from the PDF — it may be a scanned image (OCR is not available).");

  const keyFields: FieldKey[] = ["vendor", "invoiceNumber", "invoiceDate", "dueDate", "poNumber", "terms", "subtotal", "tax", "total"];
  const overall = keyFields.reduce((s, k) => s + fields[k].confidence, 0) / keyFields.length;
  return { text, fields, lines: items, overallConfidence: Math.round(overall * 100) / 100, warnings, source };
}

const num = (v: unknown) => (typeof v === "number" ? v : v == null || v === "" ? 0 : Number(v) || 0);

// ------------------------------------------------------------------------------------- structured input
export type StructuredInvoice = { vendor: string; invoiceNumber: string; invoiceDate?: string; dueDate?: string; poNumber?: string; terms?: string; currency?: string; lines: { description: string; quantity: number; unitPrice: number; amount?: number }[]; subtotal?: number; tax?: number; shipping?: number; discount?: number; total: number };

export function fromStructured(s: StructuredInvoice): ParsedInvoice {
  const lines: InvoiceLine[] = s.lines.map((l) => { const amount = l.amount ?? r2(l.quantity * l.unitPrice); return { description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount, category: categorizeLine(l.description), confidence: 1, mathOk: Math.abs(l.quantity * l.unitPrice - amount) <= Math.max(0.02, Math.abs(amount) * 0.005) }; });
  const f = (v: string | number | null | undefined): ExtractedField => (v == null || v === "" ? missing() : field(v, 1, "structured"));
  const subtotal = s.subtotal ?? r2(lines.reduce((a, l) => a + l.amount, 0));
  const fields: Record<FieldKey, ExtractedField> = {
    vendor: f(s.vendor), invoiceNumber: f(s.invoiceNumber), invoiceDate: f(parseDate(s.invoiceDate ?? "") ?? s.invoiceDate ?? null), dueDate: f(parseDate(s.dueDate ?? "") ?? s.dueDate ?? null),
    poNumber: f(s.poNumber), terms: f(s.terms), currency: f(s.currency ?? "USD"), subtotal: s.subtotal != null ? f(s.subtotal) : field(subtotal, 0.9, "computed"),
    tax: f(s.tax ?? 0), shipping: f(s.shipping ?? 0), discount: f(s.discount != null ? -Math.abs(s.discount) : 0), total: f(s.total),
  };
  return { text: renderInvoiceText(s), fields, lines, overallConfidence: 1, warnings: [], source: "structured" };
}

export function renderInvoiceText(s: StructuredInvoice): string {
  const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rows = s.lines.map((l) => `${l.description.padEnd(34)} ${String(l.quantity).padStart(5)}  ${money(l.unitPrice).padStart(11)}  ${money(l.amount ?? r2(l.quantity * l.unitPrice)).padStart(12)}`);
  return [
    s.vendor, "INVOICE", "",
    `Invoice #: ${s.invoiceNumber}`, s.invoiceDate ? `Invoice Date: ${s.invoiceDate}` : "", s.dueDate ? `Due Date: ${s.dueDate}` : "", s.poNumber ? `PO #: ${s.poNumber}` : "", s.terms ? `Terms: ${s.terms}` : "", "",
    `${"Description".padEnd(34)} ${"Qty".padStart(5)}  ${"Unit Price".padStart(11)}  ${"Amount".padStart(12)}`, ...rows, "",
    `Subtotal: ${money(s.subtotal ?? r2(s.lines.reduce((a, l) => a + (l.amount ?? l.quantity * l.unitPrice), 0)))}`,
    s.tax ? `Tax: ${money(s.tax)}` : "", s.shipping ? `Shipping: ${money(s.shipping)}` : "", s.discount ? `Discount: -${money(Math.abs(s.discount))}` : "",
    `Total Due: ${money(s.total)}`,
  ].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
}

// ------------------------------------------------------------------------------------- validation
export type Check = { key: string; label: string; status: "pass" | "warn" | "fail" | "skipped"; detail: string };
export type VendorRef = { name: string; source: string; citationId?: string };

/** Token-Jaccard vendor name similarity (ignores Inc/LLC/Co. and punctuation). */
export function vendorSimilarity(a: string, b: string): number {
  const toks = (s: string) => new Set(s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !/^(inc|llc|co|corp|corporation|company|ltd|the|lp|llp|and)$/.test(w)));
  const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
export function findVendor(name: string, vendors: VendorRef[]): { vendor: VendorRef; similarity: number } | null {
  let best: { vendor: VendorRef; similarity: number } | null = null;
  for (const v of vendors) { const s = vendorSimilarity(name, v.name); if (!best || s > best.similarity) best = { vendor: v, similarity: s }; }
  return best && best.similarity >= 0.5 ? best : null;
}

export function validateInvoice(p: ParsedInvoice, opts: { approvedVendors?: VendorRef[] | null; today?: string } = {}): { checks: Check[]; errors: number; warnings: number } {
  const checks: Check[] = [];
  const f = p.fields;
  const missingReq = REQUIRED_FIELDS.filter((k) => f[k].value == null || f[k].value === "");
  checks.push(missingReq.length ? { key: "required", label: "Required fields present", status: "fail", detail: `Missing: ${missingReq.map((k) => FIELD_LABELS[k]).join(", ")}` }
    : { key: "required", label: "Required fields present", status: "pass", detail: "Vendor, invoice number, invoice date and total were found." });
  const lowConf = (Object.keys(f) as FieldKey[]).filter((k) => f[k].method !== "missing" && f[k].method !== "computed" && f[k].confidence < 0.7);
  if (lowConf.length) checks.push({ key: "confidence", label: "Extraction confidence", status: "warn", detail: `Low-confidence fields need a human look: ${lowConf.map((k) => FIELD_LABELS[k]).join(", ")}` });

  const badLines = p.lines.filter((l) => !l.mathOk);
  checks.push(badLines.length ? { key: "line_math", label: "Line math (qty × unit price = amount)", status: "fail", detail: `${badLines.length} line(s) don't multiply out: ${badLines.map((l) => `"${l.description}" ${l.quantity} × ${l.unitPrice} ≠ ${l.amount}`).join("; ")}` }
    : { key: "line_math", label: "Line math (qty × unit price = amount)", status: p.lines.length ? "pass" : "skipped", detail: p.lines.length ? `All ${p.lines.length} line(s) multiply out.` : "No line items to check." });

  const linesSum = r2(p.lines.reduce((s, l) => s + l.amount, 0));
  const subtotal = f.subtotal.value == null ? null : num(f.subtotal.value);
  if (p.lines.length && subtotal != null && f.subtotal.method !== "computed") {
    const d = r2(linesSum - subtotal);
    checks.push(Math.abs(d) <= 0.02 ? { key: "lines_subtotal", label: "Lines add up to subtotal", status: "pass", detail: `Σ lines $${linesSum.toFixed(2)} = subtotal $${subtotal.toFixed(2)}` }
      : { key: "lines_subtotal", label: "Lines add up to subtotal", status: "fail", detail: `Σ lines $${linesSum.toFixed(2)} vs stated subtotal $${subtotal.toFixed(2)} (difference $${d.toFixed(2)})` });
  }
  if (subtotal != null && f.total.value != null) {
    const expect = r2(subtotal + num(f.tax.value) + num(f.shipping.value) + num(f.discount.value));
    const total = num(f.total.value); const d = r2(total - expect);
    const parts = [`subtotal $${subtotal.toFixed(2)}`, `tax $${num(f.tax.value).toFixed(2)}`, num(f.shipping.value) ? `shipping $${num(f.shipping.value).toFixed(2)}` : "", num(f.discount.value) ? `discount $${num(f.discount.value).toFixed(2)}` : ""].filter(Boolean).join(" + ");
    checks.push(Math.abs(d) <= 0.02 ? { key: "total_math", label: "Subtotal + tax = total", status: "pass", detail: `${parts} = $${total.toFixed(2)}` }
      : { key: "total_math", label: "Subtotal + tax = total", status: "fail", detail: `${parts} = $${expect.toFixed(2)}, but the invoice total is $${total.toFixed(2)} (difference $${d.toFixed(2)})` });
  }
  if (f.total.value != null && num(f.total.value) <= 0) checks.push({ key: "total_positive", label: "Total is positive", status: "warn", detail: "Total is zero or negative — this may be a credit memo." });

  const inv = f.invoiceDate.value as string | null; const due = f.dueDate.value as string | null; const td = termsDays(f.terms.value as string | null);
  if (inv && due) {
    const gap = daysBetween(inv, due);
    if (gap < 0) checks.push({ key: "due_terms", label: "Due date vs terms", status: "fail", detail: `Due date ${due} is before the invoice date ${inv}.` });
    else if (td != null && Math.abs(gap - td) > 1) checks.push({ key: "due_terms", label: "Due date vs terms", status: "warn", detail: `Terms say ${f.terms.value} (${td} days) but the due date is ${gap} days after the invoice date.` });
    else checks.push({ key: "due_terms", label: "Due date vs terms", status: "pass", detail: td != null ? `Due ${gap} days after invoice date, consistent with ${f.terms.value}.` : `Due ${gap} days after invoice date (no terms stated).` });
  } else if (inv && td != null) checks.push({ key: "due_terms", label: "Due date vs terms", status: "pass", detail: `No due date printed; computed ${addDays(inv, td)} from ${f.terms.value}.` });
  else checks.push({ key: "due_terms", label: "Due date vs terms", status: "skipped", detail: "Invoice date, due date or terms missing." });
  if (inv && opts.today && daysBetween(opts.today, inv) > 1) checks.push({ key: "future_date", label: "Invoice date not in the future", status: "warn", detail: `Invoice is dated ${inv}, after today (${opts.today}).` });

  const vendorName = f.vendor.value as string | null;
  if (!opts.approvedVendors || !opts.approvedVendors.length) checks.push({ key: "approved_vendor", label: "Approved vendor", status: "skipped", detail: "No approved vendor list in the AI Brain (add facts in category “vendor”)." });
  else if (vendorName) {
    const m = findVendor(vendorName, opts.approvedVendors);
    checks.push(m ? { key: "approved_vendor", label: "Approved vendor", status: "pass", detail: `${vendorName} matches approved vendor “${m.vendor.name}” (${m.vendor.source}).` }
      : { key: "approved_vendor", label: "Approved vendor", status: "warn", detail: `${vendorName} is not on the approved vendor list (${opts.approvedVendors.length} vendor(s) known).` });
  }
  return { checks, errors: checks.filter((c) => c.status === "fail").length, warnings: checks.filter((c) => c.status === "warn").length };
}

// ------------------------------------------------------------------------------------- PO match
export type PurchaseOrder = { poNumber: string; vendor: string; amount: number; status?: string; source: string; citationId?: string };
export type PoMatch = { status: "matched" | "mismatch" | "not_found" | "no_po_on_invoice" | "no_source"; detail: string; po?: PurchaseOrder; differences: string[]; tolerancePct: number };

export function matchPurchaseOrder(p: ParsedInvoice, register: PurchaseOrder[] | null, tolerancePct = 2): PoMatch {
  if (register == null) return { status: "no_source", detail: "No purchase-order source is connected, so the PO could not be verified.", differences: [], tolerancePct };
  const poNum = (p.fields.poNumber.value as string | null)?.toUpperCase().replace(/\s+/g, "");
  if (!poNum) return { status: "no_po_on_invoice", detail: "The invoice does not reference a PO number.", differences: ["No PO number on invoice"], tolerancePct };
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const po = register.find((r) => norm(r.poNumber) === norm(poNum));
  if (!po) return { status: "not_found", detail: `PO ${poNum} was not found in the PO register (${register.length} PO(s)).`, differences: [`PO ${poNum} not found`], tolerancePct };
  const differences: string[] = [];
  const vendor = (p.fields.vendor.value as string | null) ?? "";
  if (vendorSimilarity(vendor, po.vendor) < 0.5) differences.push(`Vendor “${vendor}” ≠ PO vendor “${po.vendor}”`);
  const total = num(p.fields.total.value); const base = num(p.fields.subtotal.value) || total;
  const diff = r2(base - po.amount); const pct = po.amount ? Math.abs(diff) / po.amount * 100 : 100;
  if (pct > tolerancePct) differences.push(`Invoice subtotal $${base.toFixed(2)} vs PO amount $${po.amount.toFixed(2)} (${diff > 0 ? "+" : ""}$${diff.toFixed(2)}, ${pct.toFixed(1)}% > ${tolerancePct}% tolerance)`);
  if (po.status && /closed|cancel/i.test(po.status)) differences.push(`PO status is ${po.status}`);
  return differences.length ? { status: "mismatch", detail: differences.join("; "), po, differences, tolerancePct }
    : { status: "matched", detail: `Matched PO ${po.poNumber} (${po.vendor}, $${po.amount.toFixed(2)}) within ${tolerancePct}% tolerance.`, po, differences, tolerancePct };
}

/** Parse PO register lines from free text: any line with a PO number and an amount (vendor = text between). */
export function parsePoRegister(text: string, source: string, citationId?: string): PurchaseOrder[] {
  const out: PurchaseOrder[] = [];
  for (const line of normalizeInvoiceText(text).split("\n")) {
    // "PO-24022", "PO 1187" and year-prefixed "PO-24-1182" (≥ 3 digits in total)
    const m = line.match(/\b(PO[-\s#]?\d+(?:-\d+)*[A-Z0-9]*)\b/i); if (!m || m[1].replace(/\D/g, "").length < 3) continue;
    const poEnd = (m.index ?? 0) + m[0].length;
    const after = line.slice(poEnd).replace(/\|/g, "  ");
    const money = [...after.matchAll(/(?:USD|\$)\s?[\d,]+(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b|\b\d+\.\d{2}\b/g)];
    if (!money.length) continue;
    const amount = parseMoney(money[0][0]); if (amount == null) continue;
    const status = after.match(/\b(open|closed|cancelled|canceled|received|partially received|approved)\b/i)?.[1];
    const clean = (x: string) => x.replace(/\b(vendor|supplier|amount|status|for|from|open\s+po|po)\s*[:=]?/gi, " ").replace(/[,;:\-–]+/g, " ").replace(/\s{2,}/g, " ").trim();
    const between = clean(after.slice(0, money[0].index));
    const vendor = /[a-z]{2,}/i.test(between) ? between : clean(line.slice(0, m.index ?? 0).split(/[.;]\s/).pop() ?? "");
    if (!/[a-z]{2,}/i.test(vendor)) continue;
    out.push({ poNumber: m[1].toUpperCase().replace(/\s+/g, "-").replace(/#/, "-"), vendor, amount, status, source, citationId });
  }
  return out;
}

// ------------------------------------------------------------------------------------- accounting entry
export type GlAccount = { code: string; name: string };
export type GlMap = Record<LineCategory | "ap" | "tax" , GlAccount & { source: string }>;
export const DEFAULT_GL: GlMap = {
  inventory: { code: "1400", name: "Inventory", source: "BridgeBox default chart" },
  freight: { code: "5100", name: "Freight-in", source: "BridgeBox default chart" },
  services: { code: "6200", name: "Professional services", source: "BridgeBox default chart" },
  software: { code: "6300", name: "Software subscriptions", source: "BridgeBox default chart" },
  office: { code: "6100", name: "Office supplies", source: "BridgeBox default chart" },
  repairs: { code: "6400", name: "Repairs & maintenance", source: "BridgeBox default chart" },
  other: { code: "6900", name: "Other operating expense", source: "BridgeBox default chart" },
  tax: { code: "6950", name: "Sales tax paid", source: "BridgeBox default chart" },
  ap: { code: "2000", name: "Accounts Payable", source: "BridgeBox default chart" },
};
const GL_KEYWORDS: [keyof GlMap, RegExp][] = [
  ["freight", /freight|shipping/i], ["inventory", /inventory|materials?|stock/i], ["services", /professional services|services|labor|consult/i],
  ["software", /software|subscriptions?/i], ["office", /office supplies|office/i], ["repairs", /repairs?|maintenance/i], ["tax", /sales tax|use tax/i],
  ["ap", /accounts payable|\bap\b/i], ["other", /other (operating )?expense|miscellaneous/i],
];
/** Reads GL codes from approved knowledge statements like "Freight is coded to GL 5150 Freight-In" or "GL 2010 — Accounts Payable". */
export function glMapFromStatements(statements: { text: string; source: string }[]): { map: GlMap; fromBrain: (keyof GlMap)[] } {
  const map: GlMap = JSON.parse(JSON.stringify(DEFAULT_GL)); const fromBrain: (keyof GlMap)[] = [];
  for (const s of statements) {
    for (const sentence of s.text.split(/(?<=[.;\n])\s*/)) {
      const code = sentence.match(/\b(?:GL|G\/L|account)\s*(?:code|#|no\.?)?\s*[:#]?\s*(\d{3,6}(?:[-.]\d{1,4})?)/i); if (!code) continue;
      for (const [k, re] of GL_KEYWORDS) if (re.test(sentence) && !fromBrain.includes(k)) { map[k] = { code: code[1], name: map[k].name, source: s.source }; fromBrain.push(k); break; }
    }
  }
  return { map, fromBrain };
}

export type JournalLine = { account: string; accountName: string; debit: number; credit: number; memo: string; source: string };
export function buildAccountingEntry(p: ParsedInvoice, gl: GlMap): { lines: JournalLine[]; balanced: boolean; totalDebit: number; totalCredit: number } {
  const byCat = new Map<LineCategory, number>();
  for (const l of p.lines) byCat.set(l.category, r2((byCat.get(l.category) ?? 0) + l.amount));
  const total = num(p.fields.total.value);
  const lines: JournalLine[] = [];
  const vendor = String(p.fields.vendor.value ?? "Unknown vendor"); const invNo = String(p.fields.invoiceNumber.value ?? "?");
  // distribute discount proportionally; shipping → freight; tax → tax account
  const linesSum = r2([...byCat.values()].reduce((a, b) => a + b, 0));
  const discount = num(p.fields.discount.value);
  for (const [cat, amt] of byCat) { const share = linesSum ? amt / linesSum : 0; const a = r2(amt + discount * share); if (a) lines.push({ account: gl[cat].code, accountName: gl[cat].name, debit: a, credit: 0, memo: `${vendor} ${invNo} — ${cat}`, source: gl[cat].source }); }
  if (!p.lines.length && num(p.fields.subtotal.value)) lines.push({ account: gl.other.code, accountName: gl.other.name, debit: r2(num(p.fields.subtotal.value) + discount), credit: 0, memo: `${vendor} ${invNo} — uncategorized`, source: gl.other.source });
  if (num(p.fields.shipping.value)) lines.push({ account: gl.freight.code, accountName: gl.freight.name, debit: num(p.fields.shipping.value), credit: 0, memo: `${vendor} ${invNo} — shipping`, source: gl.freight.source });
  if (num(p.fields.tax.value)) lines.push({ account: gl.tax.code, accountName: gl.tax.name, debit: num(p.fields.tax.value), credit: 0, memo: `${vendor} ${invNo} — tax`, source: gl.tax.source });
  const totalDebit = r2(lines.reduce((s, l) => s + l.debit, 0));
  // any rounding/math difference goes to a visible suspense line instead of silently balancing
  if (Math.abs(totalDebit - total) > 0.009 && total) lines.push({ account: "9999", accountName: "Suspense — invoice math difference (review)", debit: r2(total - totalDebit) > 0 ? r2(total - totalDebit) : 0, credit: r2(total - totalDebit) < 0 ? r2(totalDebit - total) : 0, memo: "Difference between line detail and invoice total", source: "BridgeBox validation" });
  lines.push({ account: gl.ap.code, accountName: gl.ap.name, debit: 0, credit: total, memo: `${vendor} ${invNo}`, source: gl.ap.source });
  const td = r2(lines.reduce((s, l) => s + l.debit, 0)), tc = r2(lines.reduce((s, l) => s + l.credit, 0));
  return { lines, balanced: Math.abs(td - tc) < 0.01, totalDebit: td, totalCredit: tc };
}

// ------------------------------------------------------------------------------------- synthetic samples
/** SYNTHETIC SAMPLE DATA — fictional vendors, invoices and POs used only in sandbox demos. */
export const SYNTHETIC_VENDORS: VendorRef[] = [
  { name: "Northwind Industrial Supply LLC", source: "Synthetic sample vendor master" },
  { name: "Bluebird Freight Co.", source: "Synthetic sample vendor master" },
  { name: "Summit Office Products Inc.", source: "Synthetic sample vendor master" },
];
export const SYNTHETIC_PO_REGISTER: PurchaseOrder[] = [
  { poNumber: "PO-24017", vendor: "Northwind Industrial Supply LLC", amount: 1280.0, status: "open", source: "Synthetic sample PO register" },
  { poNumber: "PO-24022", vendor: "Summit Office Products Inc.", amount: 6200.0, status: "open", source: "Synthetic sample PO register" },
  { poNumber: "PO-24030", vendor: "Bluebird Freight Co.", amount: 640.0, status: "open", source: "Synthetic sample PO register" },
];
/** Previously processed invoices in the synthetic AP ledger (so the duplicate demo is self-contained). */
export const SYNTHETIC_AP_HISTORY = [{ vendor: "Bluebird Freight Co.", invoiceNumber: "BF-88310", total: 655.2, processedOn: "2026-10-02" }];
export const SYNTHETIC_POLICY = { approvalThreshold: 5000, approverRole: "controller", source: "Synthetic sample AP policy: invoices over $5,000 require controller approval" };

export const INVOICE_SAMPLES: { key: string; label: string; description: string; text: string }[] = [
  { key: "clean", label: "Clean invoice (matches PO)", description: "Synthetic sample — all checks pass, PO matches.", text:
`Northwind Industrial Supply LLC
1200 Harbor Way, Suite 4, Mobile, AL 36602
INVOICE

Invoice #: NW-50412          Invoice Date: 2026-10-20
PO #: PO-24017               Terms: Net 30
Due Date: 2026-11-19

Bill To: Example Customer (Synthetic)

Description                         Qty   Unit Price      Amount
Brass gate valve 2in                 20       $38.50     $770.00
Stainless pipe fitting kit           12       $35.00     $420.00
Freight                               1       $90.00      $90.00

Subtotal                                               $1,280.00
Sales Tax (8%)                                           $102.40
Total Due                                              $1,382.40
` },
  { key: "duplicate", label: "Duplicate invoice", description: "Synthetic sample — same vendor, invoice # and amount were already processed.", text:
`BLUEBIRD FREIGHT CO.
Invoice
Invoice No: BF-88310
Date: 10/01/2026
P.O. # PO-24030
Payment terms: Net 15
Due Date: 10/16/2026

Item                                Qty     Rate      Total
LTL freight Mobile to Houston         1   $590.00   $590.00
Liftgate handling                     1    $50.00    $50.00
Subtotal: $640.00
Tax: $15.20
Amount Due: $655.20
` },
  { key: "over_threshold", label: "Over threshold + PO mismatch", description: "Synthetic sample — over the $5,000 approval threshold and $750 above its PO.", text:
`Summit Office Products Inc.
INVOICE
Invoice Number: SOP-7781     Invoice Date: Oct 28, 2026
Purchase Order: PO-24022     Terms: Net 45     Due Date: Dec 12, 2026

Description                         Qty   Unit Price      Amount
Ergonomic task chair                 25      $219.00   $5,475.00
Sit-stand desk frame                  5      $295.00   $1,475.00

Subtotal                                               $6,950.00
Tax                                                      $573.38
Total                                                  $7,523.38
` },
];
