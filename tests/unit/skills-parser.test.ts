/** Pure invoice-intelligence tests (no DB): parser accuracy on the 3 shipped samples + 3 messy variants, PDF text extraction,
 *  validation, PO matching and accounting entries. */
import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";
import { INVOICE_SAMPLES, parseInvoiceText, validateInvoice, matchPurchaseOrder, buildAccountingEntry, DEFAULT_GL, glMapFromStatements, parsePoRegister, fromStructured, parseMoney, parseDate, termsDays, SYNTHETIC_PO_REGISTER } from "@/engine/skills/invoice";
import { extractPdfText } from "@/engine/skills/pdf-text";
import { parseApprovalPolicy, parseTolerancePct, parsePricing } from "@/engine/skills/knowledge";

const vals = (t: string) => { const p = parseInvoiceText(t); return { p, v: Object.fromEntries(Object.entries(p.fields).map(([k, f]) => [k, f.value])) as Record<string, unknown> }; };

const MESSY = {
  lowercase_pipes: `acme marine supply co
invoice no. am-2026-118 | date: oct 3, 2026
due date: nov 2, 2026   terms: net 30
po number: po-7781
item | qty | unit price | amount
nylon dock line 50ft | 4 | $64.00 | $256.00
stainless cleat 8in | 10 | $18.25 | $182.50
subtotal | $438.50
tax | $35.08
total due | $473.58`,
  times_at_equals: `BILL FROM: Gulfline Electrical Services, LLC
Invoice #  GES-0912
Issued on 10/15/2026      Payment due 10/30/2026
P.O. # PO-5520            Terms: Net 15

3 x Breaker panel inspection @ $120.00 = $360.00
2 x Surge protector install @ $85.50 = $171.00
1 x Service call @ $95.00 = $95.00

Subtotal $626.00
Discount -$26.00
Sales tax $48.00
Amount Due $648.00`,
  crlf_tabs_usd: "Page 1 of 1\r\nRemit To: Bayou Paper & Packaging Inc.\r\nInv No.: BPP/44817\r\nInvoice Date: 2026-09-30\tDue: 2026-10-30\r\nCustomer PO: 88123\r\nTerms: 2/10 Net 30\r\n\r\nDescription\tQty\tPrice\tTotal\r\nKraft mailer boxes 12x9\t500\t0.84\t420.00\r\nPacking tape 3in roll\t36\t3.10\t111.60\r\n\r\nSubtotal\tUSD 531.60\r\nSales Tax (8.25%)\tUSD 43.86\r\nInvoice Total\tUSD 575.46\r\n",
};

describe("invoice parser — shipped synthetic samples", () => {
  it("clean sample: every field and line exact", () => {
    const { p, v } = vals(INVOICE_SAMPLES[0].text);
    expect(v).toMatchObject({ vendor: "Northwind Industrial Supply LLC", invoiceNumber: "NW-50412", invoiceDate: "2026-10-20", dueDate: "2026-11-19", poNumber: "PO-24017", terms: "Net 30", subtotal: 1280, tax: 102.4, total: 1382.4 });
    expect(p.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.amount])).toEqual([["Brass gate valve 2in", 20, 38.5, 770], ["Stainless pipe fitting kit", 12, 35, 420], ["Freight", 1, 90, 90]]);
    expect(p.lines[2].category).toBe("freight");
    expect(p.overallConfidence).toBeGreaterThan(0.85);
    // spans point at the real text
    const f = p.fields.invoiceNumber; expect(p.text.slice(f.span![0], f.span![1])).toBe("NW-50412");
    expect(validateInvoice(p).errors).toBe(0);
  });
  it("duplicate sample", () => { const { v, p } = vals(INVOICE_SAMPLES[1].text); expect(v).toMatchObject({ vendor: "BLUEBIRD FREIGHT CO.", invoiceNumber: "BF-88310", invoiceDate: "2026-10-01", dueDate: "2026-10-16", poNumber: "PO-24030", subtotal: 640, tax: 15.2, total: 655.2 }); expect(p.lines).toHaveLength(2); });
  it("over-threshold sample + PO mismatch vs synthetic register", () => {
    const { v, p } = vals(INVOICE_SAMPLES[2].text);
    expect(v).toMatchObject({ vendor: "Summit Office Products Inc.", invoiceNumber: "SOP-7781", invoiceDate: "2026-10-28", dueDate: "2026-12-12", poNumber: "PO-24022", terms: "Net 45", subtotal: 6950, total: 7523.38 });
    const m = matchPurchaseOrder(p, SYNTHETIC_PO_REGISTER, 2);
    expect(m.status).toBe("mismatch"); expect(m.differences[0]).toMatch(/\$6950\.00 vs PO amount \$6200\.00/);
    expect(matchPurchaseOrder(vals(INVOICE_SAMPLES[0].text).p, SYNTHETIC_PO_REGISTER, 2).status).toBe("matched");
  });
});

describe("invoice parser — messy variants", () => {
  it("lowercase labels, pipe table, month-name dates", () => {
    const { v, p } = vals(MESSY.lowercase_pipes);
    expect(v).toMatchObject({ vendor: "acme marine supply co", invoiceNumber: "am-2026-118", invoiceDate: "2026-10-03", dueDate: "2026-11-02", poNumber: "po-7781", subtotal: 438.5, tax: 35.08, total: 473.58 });
    expect(p.lines.map((l) => l.amount)).toEqual([256, 182.5]);
    expect(validateInvoice(p).errors).toBe(0);
  });
  it("qty x item @ price = amount, labelled vendor, discount, Amount Due", () => {
    const { v, p } = vals(MESSY.times_at_equals);
    expect(v).toMatchObject({ vendor: "Gulfline Electrical Services, LLC", invoiceNumber: "GES-0912", invoiceDate: "2026-10-15", dueDate: "2026-10-30", poNumber: "PO-5520", terms: "Net 15", subtotal: 626, discount: -26, tax: 48, total: 648 });
    expect(p.lines.map((l) => [l.quantity, l.unitPrice, l.amount])).toEqual([[3, 120, 360], [2, 85.5, 171], [1, 95, 95]]);
    const val = validateInvoice(p); expect(val.errors).toBe(0); expect(val.checks.find((c) => c.key === "total_math")?.status).toBe("pass");
  });
  it("CRLF + tabs + USD amounts, 2/10 Net 30, slash invoice number, page noise", () => {
    const { v, p } = vals(MESSY.crlf_tabs_usd);
    expect(v).toMatchObject({ vendor: "Bayou Paper & Packaging Inc.", invoiceNumber: "BPP/44817", invoiceDate: "2026-09-30", dueDate: "2026-10-30", poNumber: "88123", subtotal: 531.6, tax: 43.86, total: 575.46 });
    expect(String(v.terms)).toMatch(/Net 30/); expect(termsDays(String(v.terms))).toBe(30);
    expect(p.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.amount])).toEqual([["Kraft mailer boxes 12x9", 500, 0.84, 420], ["Packing tape 3in roll", 36, 3.1, 111.6]]);
    expect(validateInvoice(p).errors).toBe(0);
  });
  it("never throws on garbage and reports missing required fields", () => {
    const p = parseInvoiceText("hello there, this is not really an invoice at all");
    const v = validateInvoice(p); expect(v.checks.find((c) => c.key === "required")?.status).toBe("fail");
  });
});

describe("validation", () => {
  it("catches line, subtotal and total math errors", () => {
    const bad = INVOICE_SAMPLES[0].text.replace("$770.00", "$780.00").replace("Total Due                                              $1,382.40", "Total Due $1,482.40");
    const p = parseInvoiceText(bad); const v = validateInvoice(p);
    expect(v.checks.find((c) => c.key === "line_math")?.status).toBe("fail");
    expect(v.checks.find((c) => c.key === "lines_subtotal")?.status).toBe("fail");
    expect(v.checks.find((c) => c.key === "total_math")?.status).toBe("fail");
    expect(v.errors).toBeGreaterThanOrEqual(3);
  });
  it("due date vs terms and approved vendor list", () => {
    const p = parseInvoiceText(INVOICE_SAMPLES[0].text.replace("Due Date: 2026-11-19", "Due Date: 2026-11-05"));
    const v = validateInvoice(p, { approvedVendors: [{ name: "Someone Else Ltd", source: "test" }] });
    expect(v.checks.find((c) => c.key === "due_terms")?.status).toBe("warn");
    expect(v.checks.find((c) => c.key === "approved_vendor")?.status).toBe("warn");
    expect(validateInvoice(p, { approvedVendors: [{ name: "Northwind Industrial Supply", source: "test" }] }).checks.find((c) => c.key === "approved_vendor")?.status).toBe("pass");
  });
  it("structured input is validated the same way", () => {
    const p = fromStructured({ vendor: "X Co", invoiceNumber: "1", invoiceDate: "2026-10-01", lines: [{ description: "Widget", quantity: 2, unitPrice: 10 }], tax: 1, total: 22 });
    expect(validateInvoice(p).checks.find((c) => c.key === "total_math")?.status).toBe("fail");
  });
});

describe("accounting entry + knowledge parsers", () => {
  it("balanced entry by category with Brain GL overrides", () => {
    const p = parseInvoiceText(INVOICE_SAMPLES[0].text);
    const gl = glMapFromStatements([{ text: "Freight is coded to GL 5150. Accounts payable is GL account 2010.", source: "AI Brain fact" }]);
    expect(gl.map.freight.code).toBe("5150"); expect(gl.map.ap.code).toBe("2010"); expect(gl.map.inventory.code).toBe(DEFAULT_GL.inventory.code);
    const e = buildAccountingEntry(p, gl.map);
    expect(e.balanced).toBe(true); expect(e.totalCredit).toBe(1382.4);
    expect(e.lines.find((l) => l.account === "5150")?.debit).toBe(90); expect(e.lines.find((l) => l.account === "1400")?.debit).toBe(1190);
  });
  it("policy, tolerance, pricing and PO register parsing", () => {
    expect(parseApprovalPolicy([{ text: "Invoices over $5,000 require controller approval before payment.", source: "s" }])).toMatchObject({ threshold: 5000, approverRole: "controller" });
    expect(parseApprovalPolicy([{ text: "Lunch is at noon.", source: "s" }])).toBeNull();
    expect(parseTolerancePct([{ text: "PO match tolerance is 3%.", source: "s" }])?.pct).toBe(3);
    expect(parsePricing([{ text: "Standard labor rate is $85/hour.", source: "s" }])[0]).toMatchObject({ item: "Standard labor rate", price: 85, unit: "hour" });
    expect(parsePoRegister("PO-24017 | Northwind Industrial Supply LLC | $1,280.00 | open", "doc")[0]).toMatchObject({ poNumber: "PO-24017", vendor: "Northwind Industrial Supply LLC", amount: 1280, status: "open" });
    // year-prefixed numbers as in the AI Brain demo PO register (regression: "PO-24-1194" was not recognised → "no PO source")
    expect(parsePoRegister("Row 4: PO number: PO-24-1194; Vendor: Gulfline Electrical; Amount: $7,640.00; Branch: Houston; Status: Open.", "doc")[0]).toMatchObject({ poNumber: "PO-24-1194", vendor: "Gulfline Electrical", amount: 7640, status: "Open" });
    expect(parsePoRegister("PO 12 for $40.00", "doc")).toEqual([]); // fewer than 3 digits is not a PO number
  });
  it("money and date helpers", () => {
    expect(parseMoney("(12.50)")).toBe(-12.5); expect(parseMoney("USD 1,234.56")).toBe(1234.56); expect(parseMoney("1.234,56")).toBe(1234.56); expect(parseMoney("-$26.00")).toBe(-26);
    expect(parseDate("10/14/2026")).toBe("2026-10-14"); expect(parseDate("14 Oct 2026")).toBe("2026-10-14"); expect(parseDate("2026-02-30")).toBeNull();
  });
});

describe("PDF text extraction (pure JS)", () => {
  it("extracts a PDFKit-generated invoice and the parser reads it", async () => {
    const buf = await new Promise<Buffer>((resolve) => { const doc = new PDFDocument(); const ch: Buffer[] = []; doc.on("data", (c: Buffer) => ch.push(c)); doc.on("end", () => resolve(Buffer.concat(ch))); doc.font("Courier").fontSize(9); for (const l of INVOICE_SAMPLES[2].text.split("\n")) doc.text(l); doc.end(); });
    const r = extractPdfText(buf);
    expect(r.pages).toBe(1); expect(r.text).toContain("SOP-7781");
    const p = parseInvoiceText(r.text, "pdf");
    expect(p.fields.total.value).toBe(7523.38); expect(p.fields.invoiceNumber.value).toBe("SOP-7781"); expect(p.lines).toHaveLength(2);
  });
  it("rejects non-PDF bytes honestly", () => { expect(extractPdfText(Buffer.from("hello")).warnings[0]).toMatch(/Not a PDF/); });
});
