/** Finance skills: prepare_invoice (AR), reconcile_transactions, analyze_financials. Deterministic calculators. */
import { z } from "zod";
import { computeOrgFinancials } from "@/engine/finance";
import { addDays, parseDate, parseMoney, termsDays, vendorSimilarity } from "./invoice";
import { docsToSrc, factsToSrc, findPrice, parsePricing, type PriceRef } from "./knowledge";
import { money, plural, type SkillImpl } from "./runtime";

const r2 = (n: number) => Math.round(n * 100) / 100;
const SampleKey = z.string().max(40).optional();

// ============================================================================================ prepare_invoice
const PrepareInvoiceInput = z.object({
  sampleKey: SampleKey,
  customer: z.object({ name: z.string().trim().min(2, "Customer name is required").max(200), email: z.string().email().optional() }),
  items: z.array(z.object({ description: z.string().trim().min(1).max(300), quantity: z.number().positive().max(1e6), unitPrice: z.number().nonnegative().max(1e8).optional() })).min(1, "Add at least one line item").max(200),
  taxRatePct: z.number().min(0).max(25).optional(), terms: z.string().max(40).optional(), invoiceDate: z.string().max(40).optional(), poNumber: z.string().max(60).optional(), notes: z.string().max(2000).optional(),
});
type PrepareInvoiceT = z.infer<typeof PrepareInvoiceInput>;
export const SYNTHETIC_PRICES: PriceRef[] = [
  { item: "Standard labor rate", price: 85, unit: "hour", source: "Synthetic sample price list" },
  { item: "Brass gate valve 2in", price: 52, unit: "each", source: "Synthetic sample price list" },
  { item: "Site visit", price: 150, unit: "visit", source: "Synthetic sample price list" },
  { item: "Annual maintenance plan", price: 1200, unit: "year", source: "Synthetic sample price list" },
];

export const prepareInvoice: SkillImpl<PrepareInvoiceT> = {
  key: "prepare_invoice", name: "Prepare customer invoice", category: "finance", access: "draft",
  description: "Builds a customer invoice from line items using your approved pricing and payment terms, computes tax and due date, flags any price that differs from the approved price list, and stores the invoice as a draft for a person to send. Manual baseline 10 min is a BridgeBox assumption (look up prices 3 + key lines 3 + tax/terms 2 + format/proofread 2).",
  outputDescription: "Priced lines (with price source), totals, due date, price exceptions and the draft invoice text.",
  manualBaselineMinutes: 10, reviewMinutes: 2, baselineBasis: "Assumption: manual invoice preparation estimate (10 min).",
  inputSchema: PrepareInvoiceInput,
  sampleInput: () => prepareInvoice.samples()[0].input,
  samples: () => [{ key: "service_call", label: "Service call invoice", description: "Synthetic sample — labor, parts and a site visit.", input: { sampleKey: "service_call", customer: { name: "Harbor Point Marine (Synthetic)", email: "ap@harborpoint.example" }, items: [{ description: "Standard labor rate", quantity: 3.5 }, { description: "Brass gate valve 2in", quantity: 2, unitPrice: 52 }, { description: "Site visit", quantity: 1 }], taxRatePct: 8, poNumber: "HPM-2291" } }],
  async execute(ctx, input) {
    const [facts, docs] = await Promise.all([ctx.facts(["pricing", "customer", "policy", "product"]), ctx.docs(["pricing", "policy", "product"])]);
    const srcs = [...factsToSrc(facts), ...docsToSrc(docs)];
    const prices = [...parsePricing(srcs), ...(ctx.synthetic ? SYNTHETIC_PRICES : [])];
    const priced = await ctx.step("price_lines", "Price line items from approved pricing", () => {
      const lines = input.items.map((it) => {
        const ref = findPrice(it.description, prices); if (ref?.citation) ctx.cite(ref.citation);
        const unitPrice = it.unitPrice ?? ref?.price ?? null;
        const exception = unitPrice == null ? "No price given and no approved price found — a person must set it." : ref && it.unitPrice != null && Math.abs(ref.price - it.unitPrice) > 0.005 ? `Entered ${money(it.unitPrice)} differs from approved ${money(ref.price)}/${ref.unit} (${ref.source}).` : null;
        return { description: it.description, quantity: it.quantity, unitPrice, amount: unitPrice == null ? null : r2(unitPrice * it.quantity), priceSource: it.unitPrice != null ? "entered" : ref ? ref.source : "missing", exception };
      });
      const ex = lines.filter((l) => l.exception).length;
      return { value: lines, detail: `${plural(lines.length, "line")} priced${ex ? `, ${plural(ex, "price exception")}` : ""}. ${prices.length ? `${plural(prices.length, "approved price")} available.` : "No approved pricing in the AI Brain."}`, data: { lines } };
    });
    const terms = await ctx.step("terms", "Apply payment terms", () => {
      const cf = facts.find((f) => (f.category === "customer" || f.category === "policy") && vendorSimilarity(f.subject, input.customer.name) >= 0.5 && termsDays(f.statement) != null);
      const pf = facts.find((f) => f.category === "policy" && /payment terms|net \d+/i.test(f.statement) && termsDays(f.statement) != null);
      const src = cf ?? pf; if (src) ctx.cite(src.citation);
      const t = input.terms ?? (src ? `Net ${termsDays(src.statement)}` : "Net 30");
      const basis = input.terms ? "entered" : src ? `AI Brain fact “${src.subject}”` : "BridgeBox default (Net 30) — add your terms to the AI Brain";
      const invoiceDate = parseDate(input.invoiceDate ?? "") ?? ctx.today();
      const due = addDays(invoiceDate, termsDays(t) ?? 30);
      return { value: { terms: t, basis, invoiceDate, dueDate: due }, detail: `${t} (${basis}); due ${due}.` };
    });
    const totals = await ctx.step("totals", "Compute totals", () => {
      const subtotal = r2(priced.reduce((s, l) => s + (l.amount ?? 0), 0));
      const rate = input.taxRatePct ?? 0; const tax = r2(subtotal * rate / 100); const total = r2(subtotal + tax);
      return { value: { subtotal, taxRatePct: rate, tax, total }, detail: `Subtotal ${money(subtotal)} + tax ${money(tax)} (${rate}%${input.taxRatePct == null ? ", none entered" : ""}) = ${money(total)}.` };
    });
    const number = `DRAFT-${terms.invoiceDate.replace(/-/g, "")}-${Math.abs(hash(input.customer.name + JSON.stringify(input.items))).toString(36).slice(0, 4).toUpperCase()}`;
    const text = [`INVOICE ${number}${ctx.synthetic ? " (Synthetic sample)" : ""}`, `Bill to: ${input.customer.name}`, `Invoice date: ${terms.invoiceDate}   Terms: ${terms.terms}   Due: ${terms.dueDate}`, input.poNumber ? `Customer PO: ${input.poNumber}` : "", "",
      ...priced.map((l) => `${l.description.padEnd(32)} ${String(l.quantity).padStart(6)}  ${money(l.unitPrice).padStart(10)}  ${money(l.amount).padStart(11)}${l.exception ? "  ⚠" : ""}`), "",
      `Subtotal ${money(totals.subtotal)}`, `Tax ${money(totals.tax)}`, `Total due ${money(totals.total)}`, input.notes ? `\n${input.notes}` : ""].filter((x) => x !== null).join("\n");
    const exceptions = priced.filter((l) => l.exception).map((l) => `${l.description}: ${l.exception}`);
    let draft: string | null = null;
    if (ctx.canDraft()) draft = await ctx.step("draft", "Store draft invoice", () => ({ value: text, detail: `Draft ${number} stored in BridgeBox for a person to review and send${exceptions.length ? ` — resolve ${plural(exceptions.length, "exception")} first` : ""}. No email or accounting system is used.` }));
    else ctx.skip("draft", "Store draft invoice", "Not stored: this AI employee is read-only.");
    return { output: { invoiceNumber: number, customer: input.customer, lines: priced, ...terms, ...totals, exceptions, draft }, summary: `Prepared ${draft ? "a draft " : ""}invoice for ${input.customer.name}: ${plural(priced.length, "line")}, total ${money(totals.total)}, ${terms.terms} (due ${terms.dueDate}).${exceptions.length ? ` ${plural(exceptions.length, "price exception")} need a person's decision.` : " All prices match approved pricing."}${draft ? "" : " Nothing was stored (read-only)."}`, humanReviewMinutes: 2 + exceptions.length };
  },
};
function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// ============================================================================================ reconcile_transactions
const Txn = z.object({ date: z.string().min(6).max(40), description: z.string().max(300).default(""), amount: z.number().finite(), ref: z.string().max(60).optional() });
const TxnList = z.union([z.array(Txn).min(1, "Add at least one transaction").max(5000), z.string().min(10).max(500_000)]);
const ReconcileInput = z.object({ sampleKey: SampleKey, bank: TxnList, ledger: TxnList, dateToleranceDays: z.number().int().min(0).max(15).default(3) });
type ReconcileT = z.infer<typeof ReconcileInput>;
type T = { i: number; date: string; description: string; amount: number; ref?: string };

/** CSV → transactions. Detects date/description/amount (or debit/credit) columns from the header. */
export function parseTxnCsv(csv: string): { rows: T[]; errors: string[] } {
  const lines = csv.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  const split = (l: string) => { const out: string[] = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if ((ch === "," || ch === ";" || ch === "\t") && !q) { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out; };
  const head = split(lines[0] ?? "").map((h) => h.toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const di = col(/date/), de = col(/desc|memo|payee|narrative|details|name/), am = col(/^amount|amt|value/), dr = col(/debit|withdraw|out/), cr = col(/credit|deposit|in$/), rf = col(/ref|check|cheque|id/);
  const errors: string[] = []; const rows: T[] = [];
  if (di < 0 || (am < 0 && dr < 0 && cr < 0)) return { rows, errors: ["CSV needs a header with a date column and an amount (or debit/credit) column."] };
  lines.slice(1).forEach((l, k) => {
    const c = split(l); const date = parseDate(c[di] ?? "");
    const amount = am >= 0 ? parseMoney(c[am]) : r2((parseMoney(c[cr]) ?? 0) - Math.abs(parseMoney(c[dr]) ?? 0));
    if (!date || amount == null) { errors.push(`Row ${k + 2}: unreadable date or amount`); return; }
    rows.push({ i: rows.length, date, description: de >= 0 ? c[de] ?? "" : "", amount, ref: rf >= 0 ? c[rf] || undefined : undefined });
  });
  return { rows, errors };
}
const descSim = (a: string, b: string) => { const t = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2)); const A = t(a), B = t(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / Math.max(A.size, B.size); };
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

export function reconcile(bank: T[], ledger: T[], tol: number) {
  const matched: { bank: T; ledger: T[]; kind: "exact" | "date_shift" | "combined"; score: number }[] = [];
  const usedB = new Set<number>(), usedL = new Set<number>();
  const cands: { b: T; l: T; score: number }[] = [];
  for (const b of bank) for (const l of ledger) if (Math.abs(b.amount - l.amount) < 0.005) { const dd = dayDiff(b.date, l.date); if (dd <= tol) cands.push({ b, l, score: dd - descSim(b.description, l.description) * 2 - (b.ref && l.ref && b.ref === l.ref ? 5 : 0) }); }
  for (const c of cands.sort((x, y) => x.score - y.score)) { if (usedB.has(c.b.i) || usedL.has(c.l.i)) continue; usedB.add(c.b.i); usedL.add(c.l.i); matched.push({ bank: c.b, ledger: [c.l], kind: dayDiff(c.b.date, c.l.date) === 0 ? "exact" : "date_shift", score: c.score }); }
  // batch deposits: one bank line = two ledger lines
  for (const b of bank) {
    if (usedB.has(b.i)) continue;
    const pool = ledger.filter((l) => !usedL.has(l.i) && dayDiff(b.date, l.date) <= tol && Math.sign(l.amount) === Math.sign(b.amount)).slice(0, 200);
    outer: for (let x = 0; x < pool.length; x++) for (let y = x + 1; y < pool.length; y++) if (Math.abs(pool[x].amount + pool[y].amount - b.amount) < 0.005) { usedB.add(b.i); usedL.add(pool[x].i); usedL.add(pool[y].i); matched.push({ bank: b, ledger: [pool[x], pool[y]], kind: "combined", score: 0 }); break outer; }
  }
  const unmatchedBank = bank.filter((b) => !usedB.has(b.i)).map((b) => {
    const d = b.description.toLowerCase();
    const suggestion = /\b(fee|charge|service chg|maintenance)\b/.test(d) ? "Record bank fee (Dr Bank fees / Cr Cash)" : /\binterest\b/.test(d) ? "Record interest income (Dr Cash / Cr Interest income)" : /\b(nsf|returned)\b/.test(d) ? "Returned item — reverse the deposit and contact the customer" : b.amount > 0 ? "Unrecorded deposit — find the source document" : "Unrecorded payment — find the bill or receipt";
    return { ...b, suggestion };
  });
  const unmatchedLedger = ledger.filter((l) => !usedL.has(l.i)).map((l) => ({ ...l, suggestion: l.amount < 0 ? "Outstanding payment (not yet cleared)" : "Deposit in transit" }));
  const sum = (xs: { amount: number }[]) => r2(xs.reduce((s, x) => s + x.amount, 0));
  return { matched, unmatchedBank, unmatchedLedger, bankTotal: sum(bank), ledgerTotal: sum(ledger), difference: r2(sum(bank) - sum(ledger)), unexplained: r2(sum(bank) - sum(ledger) - (sum(unmatchedBank) - sum(unmatchedLedger))) };
}

export const reconcileTransactions: SkillImpl<ReconcileT> = {
  key: "reconcile_transactions", name: "Reconcile bank transactions", category: "finance", access: "read",
  description: "Matches bank transactions to ledger entries (exact amount within a date tolerance, description similarity, batched deposits), lists what doesn't match with a suggested next step, and proves the difference. Accepts arrays or CSV exports. Manual baseline 30 min is a BridgeBox assumption for a ~25-line monthly account (≈1 min per line + 5 min wrap-up).",
  outputDescription: "Matched pairs, unmatched bank and ledger items with suggestions, totals and unexplained difference.",
  manualBaselineMinutes: 30, reviewMinutes: 3, baselineBasis: "Assumption: ~25-line monthly reconciliation (30 min).",
  inputSchema: ReconcileInput as unknown as z.ZodType<ReconcileT>,
  sampleInput: () => reconcileTransactions.samples()[0].input,
  samples: () => [{ key: "october", label: "October operating account", description: "Synthetic sample — 9 bank lines vs 9 ledger lines.", input: { sampleKey: "october", dateToleranceDays: 3,
    bank: [{ date: "2026-10-01", description: "DEPOSIT HARBOR POINT MARINE", amount: 4200 }, { date: "2026-10-03", description: "ACH NORTHWIND IND SUPPLY", amount: -1382.4 }, { date: "2026-10-06", description: "CHECK 1043", amount: -640, ref: "1043" }, { date: "2026-10-09", description: "DEPOSIT BATCH", amount: 3150 }, { date: "2026-10-15", description: "PAYROLL ACH", amount: -9800 }, { date: "2026-10-20", description: "CARD SUMMIT OFFICE", amount: -219 }, { date: "2026-10-31", description: "MONTHLY SERVICE CHARGE", amount: -25 }, { date: "2026-10-31", description: "INTEREST PAID", amount: 3.12 }, { date: "2026-10-28", description: "DEPOSIT GULF MARINE", amount: 980 }],
    ledger: [{ date: "2026-10-01", description: "Harbor Point Marine payment", amount: 4200 }, { date: "2026-10-02", description: "Northwind Industrial Supply NW-50412", amount: -1382.4 }, { date: "2026-10-05", description: "Bluebird Freight check 1043", amount: -640, ref: "1043" }, { date: "2026-10-08", description: "Customer payment — Delta Docks", amount: 1900 }, { date: "2026-10-09", description: "Customer payment — Bayview Boats", amount: 1250 }, { date: "2026-10-15", description: "Payroll", amount: -9800 }, { date: "2026-10-20", description: "Summit Office Products chair", amount: -219 }, { date: "2026-10-30", description: "Check 1051 — Coastal Electric", amount: -415 }, { date: "2026-10-31", description: "Deposit — Pelican Charters", amount: 760 }] } }],
  async execute(ctx, input) {
    const load = (v: ReconcileT["bank"], label: string) => { if (typeof v === "string") { const r = parseTxnCsv(v); if (!r.rows.length) throw new Error(`${label}: ${r.errors[0] ?? "no rows"}`); return r; } return { rows: v.map((t, i) => ({ i, date: parseDate(t.date) ?? t.date, description: t.description, amount: t.amount, ref: t.ref })), errors: [] as string[] }; };
    const data = await ctx.step("load", "Load bank and ledger transactions", () => {
      const b = load(input.bank, "Bank"), l = load(input.ledger, "Ledger");
      const bad = [...b.rows, ...l.rows].filter((t) => !parseDate(t.date)).length;
      if (bad) throw new Error(`${plural(bad, "transaction")} have an unreadable date.`);
      return { value: { bank: b.rows, ledger: l.rows }, detail: `${plural(b.rows.length, "bank line")} and ${plural(l.rows.length, "ledger line")} loaded${b.errors.length + l.errors.length ? ` (${b.errors.length + l.errors.length} unreadable rows skipped)` : ""}.`, data: { skipped: [...b.errors, ...l.errors].slice(0, 20) } };
    });
    const r = await ctx.step("match", "Match transactions", () => { const x = reconcile(data.bank, data.ledger, input.dateToleranceDays); return { value: x, detail: `${plural(x.matched.length, "match", )} (${x.matched.filter((m) => m.kind === "combined").length} batched deposit${x.matched.filter((m) => m.kind === "combined").length === 1 ? "" : "s"}), ${x.unmatchedBank.length} unmatched bank, ${x.unmatchedLedger.length} unmatched ledger; ±${input.dateToleranceDays} day tolerance.` }; });
    await ctx.step("explain", "Explain the difference", () => ({ value: null, status: Math.abs(r.unexplained) < 0.01 ? "done" : "done", detail: `Bank ${money(r.bankTotal)} − ledger ${money(r.ledgerTotal)} = ${money(r.difference)}; ${Math.abs(r.unexplained) < 0.01 ? "fully explained by the unmatched items listed" : `${money(r.unexplained)} unexplained — investigate`}.`, data: { suggestions: [...r.unmatchedBank, ...r.unmatchedLedger].map((u) => ({ date: u.date, description: u.description, amount: u.amount, suggestion: u.suggestion })) } }));
    const pass = await ctx.passages("bank reconciliation procedure month end close", 3); ctx.cite(...pass.map((p) => p.citation));
    return { output: { matched: r.matched.map((m) => ({ bank: m.bank, ledger: m.ledger, kind: m.kind })), unmatchedBank: r.unmatchedBank, unmatchedLedger: r.unmatchedLedger, bankTotal: r.bankTotal, ledgerTotal: r.ledgerTotal, difference: r.difference, unexplained: r.unexplained, procedureReferences: pass.map((p) => p.citation.label) },
      summary: `Matched ${r.matched.length} of ${data.bank.length} bank transactions. ${r.unmatchedBank.length + r.unmatchedLedger.length ? `${plural(r.unmatchedBank.length + r.unmatchedLedger.length, "item")} need attention (e.g. ${[...r.unmatchedBank, ...r.unmatchedLedger][0].description}: ${[...r.unmatchedBank, ...r.unmatchedLedger][0].suggestion.toLowerCase()}).` : "Everything matched."} The ${money(r.difference)} difference is ${Math.abs(r.unexplained) < 0.01 ? "fully explained" : `not fully explained (${money(r.unexplained)} open)`}.`,
      humanReviewMinutes: 3 + Math.min(10, r.unmatchedBank.length + r.unmatchedLedger.length) };
  },
};

// ============================================================================================ analyze_financials
const Period = z.object({ label: z.string().min(1).max(40), revenue: z.number().finite(), cogs: z.number().finite().default(0), opex: z.record(z.string(), z.number().finite()).default({}), otherIncome: z.number().finite().optional() });
const AnalyzeFinInput = z.object({ sampleKey: SampleKey, statements: z.object({ periods: z.array(Period).min(1).max(24) }).optional(), varianceThresholdPct: z.number().min(1).max(100).default(10) });
type AnalyzeFinT = z.infer<typeof AnalyzeFinInput>;

export function analyzePnl(periods: z.infer<typeof Period>[], threshold: number) {
  const rows = periods.map((p) => { const opexTotal = r2(Object.values(p.opex).reduce((a, b) => a + b, 0)); const gross = r2(p.revenue - p.cogs); const op = r2(gross - opexTotal + (p.otherIncome ?? 0)); return { label: p.label, revenue: p.revenue, cogs: p.cogs, grossProfit: gross, grossMarginPct: p.revenue ? r2(gross / p.revenue * 100) : 0, opex: p.opex, opexTotal, operatingIncome: op, operatingMarginPct: p.revenue ? r2(op / p.revenue * 100) : 0 }; });
  const flags: { line: string; from: number; to: number; changePct: number; note: string }[] = [];
  if (rows.length >= 2) {
    const a = rows[rows.length - 2], b = rows[rows.length - 1];
    const cmp = (line: string, x: number, y: number, goodUp: boolean) => { if (!x) return; const ch = r2((y - x) / Math.abs(x) * 100); if (Math.abs(ch) >= threshold) flags.push({ line, from: x, to: y, changePct: ch, note: `${line} ${ch > 0 ? "rose" : "fell"} ${Math.abs(ch)}% (${money(x)} → ${money(y)})${(ch > 0) === goodUp ? "" : " — unfavorable"}` }); };
    cmp("Revenue", a.revenue, b.revenue, true); cmp("Cost of goods sold", a.cogs, b.cogs, false);
    for (const k of new Set([...Object.keys(a.opex), ...Object.keys(b.opex)])) cmp(k, a.opex[k] ?? 0, b.opex[k] ?? 0, false);
    if (Math.abs(b.grossMarginPct - a.grossMarginPct) >= 2) flags.push({ line: "Gross margin", from: a.grossMarginPct, to: b.grossMarginPct, changePct: r2(b.grossMarginPct - a.grossMarginPct), note: `Gross margin moved ${r2(b.grossMarginPct - a.grossMarginPct)} points (${a.grossMarginPct}% → ${b.grossMarginPct}%)` });
  }
  return { rows, flags };
}

export const analyzeFinancials: SkillImpl<AnalyzeFinT> = {
  key: "analyze_financials", name: "Analyze financials", category: "finance", access: "read",
  description: "Explains financial performance in plain English. With statements: margins, period-over-period variances above your threshold, and unfavorable movements. In live mode without statements it reads BridgeBox's own financial model (labor analyzed, realizable vs verified savings, ROI, payback) from the finance engine. Manual baseline 45 min is a BridgeBox assumption for a monthly variance commentary.",
  outputDescription: "Ratios per period, variance flags, and (live) the BridgeBox financial model headline numbers.",
  manualBaselineMinutes: 45, reviewMinutes: 5, baselineBasis: "Assumption: monthly variance commentary by an analyst (45 min).",
  inputSchema: AnalyzeFinInput as unknown as z.ZodType<AnalyzeFinT>,
  sampleInput: () => analyzeFinancials.samples()[0].input,
  samples: () => [{ key: "q2_q3", label: "Q2 vs Q3 P&L", description: "Synthetic sample — two quarters of a distributor's P&L.", input: { sampleKey: "q2_q3", varianceThresholdPct: 10, statements: { periods: [
    { label: "Q2 2026", revenue: 1_240_000, cogs: 868_000, opex: { Payroll: 196_000, Freight: 41_000, Software: 12_500, Rent: 36_000 } },
    { label: "Q3 2026", revenue: 1_318_000, cogs: 949_000, opex: { Payroll: 201_000, Freight: 52_400, Software: 12_900, Rent: 36_000 } }] } } }],
  async execute(ctx, input) {
    const out: Record<string, unknown> = {};
    const lines: string[] = [];
    if (input.statements) {
      const a = await ctx.step("ratios", "Compute margins and variances", () => { const r = analyzePnl(input.statements!.periods, input.varianceThresholdPct); return { value: r, detail: `${plural(r.rows.length, "period")} analyzed; ${plural(r.flags.length, "variance")} at or above ${input.varianceThresholdPct}%.`, data: { rows: r.rows, flags: r.flags } }; });
      out.statements = a;
      const last = a.rows[a.rows.length - 1];
      lines.push(`${last.label}: revenue ${money(last.revenue)}, gross margin ${last.grossMarginPct}%, operating margin ${last.operatingMarginPct}%.`);
      if (a.flags.length) lines.push(`Biggest movements: ${a.flags.sort((x, y) => Math.abs(y.changePct) - Math.abs(x.changePct)).slice(0, 3).map((f) => f.note).join("; ")}.`);
    } else if (ctx.synthetic) throw new Error("Provide statements (sandbox runs use the synthetic sample).");
    else ctx.skip("ratios", "Compute margins and variances", "No statements supplied — analyzing the BridgeBox financial model only.");
    if (!ctx.synthetic) {
      const f = await ctx.step("model", "Read BridgeBox financial model", async () => {
        const fin = await computeOrgFinancials(ctx.orgId);
        return { value: fin, detail: `Labor analyzed ${money(fin.totalAnnualLaborAnalyzed)}/yr across ${plural(fin.employeesAnalyzed, "employee")}; realizable savings ${money(fin.realizableAnnualSavings)}/yr (projected); verified ${money(fin.verifiedAnnualizedSavings)}/yr (measured).`, data: { totalAnnualLaborAnalyzed: fin.totalAnnualLaborAnalyzed, realizableAnnualSavings: fin.realizableAnnualSavings, verifiedAnnualizedSavings: fin.verifiedAnnualizedSavings, roi1y: fin.roi1y, paybackMonths: fin.paybackMonths, basisSummary: fin.basisSummary } };
      });
      ctx.cite({ type: "savings", id: "org-financials", label: "BridgeBox financial model", href: "/app/finance" });
      for (const d of [...f.byDepartment].sort((a, b) => b.realizableAnnual - a.realizableAnnual).slice(0, 3)) if (d.departmentId) ctx.cite({ type: "department", id: d.departmentId, label: d.name, href: `/app/departments/${d.departmentId}` });
      out.model = { totalAnnualLaborAnalyzed: f.totalAnnualLaborAnalyzed, realizableAnnualSavings: f.realizableAnnualSavings, verifiedAnnualizedSavings: f.verifiedAnnualizedSavings, netAnnualSavings: f.netAnnualSavings, roi1y: f.roi1y, paybackMonths: f.paybackMonths, topDepartments: [...f.byDepartment].sort((a, b) => b.realizableAnnual - a.realizableAnnual).slice(0, 3).map((d) => ({ name: d.name, realizableAnnual: d.realizableAnnual })) };
      lines.push(f.employeesAnalyzed ? `BridgeBox model: ${money(f.realizableAnnualSavings)}/yr realizable (projected, not yet realized) vs ${money(f.verifiedAnnualizedSavings)}/yr verified by measurement; payback ${f.paybackMonths == null ? "not reached" : `${Math.round(f.paybackMonths)} months`}.` : "BridgeBox has no costed employees yet, so the financial model is empty.");
    }
    const pass = await ctx.passages("financial goals budget targets margin", 3); ctx.cite(...pass.map((p) => p.citation));
    if (pass.length) out.goalsReferenced = pass.map((p) => ({ title: p.citation.label, text: p.text.slice(0, 300) }));
    await ctx.step("narrative", "Write plain-English commentary", () => ({ value: null, detail: lines.join(" ") }));
    out.commentary = lines;
    return { output: out, summary: lines.join(" ") };
  },
};
