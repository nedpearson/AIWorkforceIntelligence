/**
 * process_invoice — flagship AP skill. Ten real, timed steps (the last two are added by the runtime):
 *  1 receive → 2 extract → 3 validate → 4 duplicate check → 5 PO match → 6 accounting entry → 7 approval →
 *  8 update accounting system → 9 record processing time → 10 calculate savings.
 */
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { catalogEntry } from "@/engine/connectors/catalog";
import {
  buildAccountingEntry, findVendor, fromStructured, glMapFromStatements, INVOICE_SAMPLES, matchPurchaseOrder, parseInvoiceText, parsePoRegister,
  SYNTHETIC_AP_HISTORY, SYNTHETIC_PO_REGISTER, SYNTHETIC_POLICY, SYNTHETIC_VENDORS, validateInvoice, vendorSimilarity, FIELD_LABELS,
  type ParsedInvoice, type PurchaseOrder, type StructuredInvoice, type VendorRef,
} from "./invoice";
import { extractPdfText } from "./pdf-text";
import { docsToSrc, factsToSrc, parseApprovalPolicy, parseTolerancePct, vendorsFromFacts } from "./knowledge";
import { money, plural, type SkillImpl } from "./runtime";

const StructuredSchema = z.object({
  vendor: z.string().trim().min(1).max(200), invoiceNumber: z.string().trim().min(1).max(60),
  invoiceDate: z.string().max(40).optional(), dueDate: z.string().max(40).optional(), poNumber: z.string().max(60).optional(), terms: z.string().max(60).optional(), currency: z.string().max(8).optional(),
  lines: z.array(z.object({ description: z.string().trim().min(1).max(300), quantity: z.number().finite(), unitPrice: z.number().finite(), amount: z.number().finite().optional() })).max(500),
  subtotal: z.number().finite().optional(), tax: z.number().finite().optional(), shipping: z.number().finite().optional(), discount: z.number().finite().optional(), total: z.number().finite(),
});
export const ProcessInvoiceInput = z.object({
  sampleKey: z.string().max(40).optional(),
  text: z.string().min(20, "Invoice text is too short").max(200_000).optional(),
  invoice: StructuredSchema.optional(),
  file: z.object({ name: z.string().max(200), mimeType: z.string().max(100), dataBase64: z.string().min(8).max(7_000_000, "File too large (5 MB max)") }).optional(),
}).refine((v) => [v.text, v.invoice, v.file].filter((x) => x != null).length === 1, { message: "Provide exactly one of: text (pasted invoice), invoice (structured object) or file (text/PDF upload)" });
export type ProcessInvoiceInputT = z.infer<typeof ProcessInvoiceInput>;

const REVIEW_BASE_MIN = 2;
const DEFAULT_TOLERANCE_PCT = 2;

async function priorInvoices(orgId: string, mode: string, aiSkillRunExclude: boolean) {
  const rows = await withTenant(orgId, (tx) => tx.select({ id: schema.skillRuns.id, input: schema.skillRuns.input, output: schema.skillRuns.output, createdAt: schema.skillRuns.createdAt })
    .from(schema.skillRuns).where(and(eq(schema.skillRuns.orgId, orgId), eq(schema.skillRuns.skillKey, "process_invoice"), eq(schema.skillRuns.mode, mode), inArray(schema.skillRuns.status, ["succeeded", "awaiting_approval"]))).limit(2000));
  return rows.filter((r) => !(aiSkillRunExclude && (r.input as { sampleKey?: string })?.sampleKey)).map((r) => ({ id: r.id, createdAt: r.createdAt, inv: (r.output as { invoice?: { vendor?: string; invoiceNumber?: string; total?: number } }).invoice })).filter((r) => r.inv?.invoiceNumber);
}

export const processInvoice: SkillImpl<ProcessInvoiceInputT> = {
  key: "process_invoice", name: "Process vendor invoice", category: "finance", access: "act",
  description: "Reads a vendor invoice (pasted text, structured data or a text/PDF upload), extracts every field with a confidence score, checks the math, terms, vendor, duplicates and purchase order, prepares a balanced accounts-payable entry and routes it for approval before anything is posted. Manual baseline 12 min/invoice is a BridgeBox time-and-motion assumption (open/read 1.5 + key header 2 + key ~3 lines 3 + check math 1 + duplicate search 1.5 + find/compare PO 2 + code GL 1); when the AI employee is linked to an agent or an observed workflow, that measured baseline is used instead.",
  outputDescription: "Extracted fields with confidence + spans, validation checks, duplicate result, PO match, draft journal entry, approval request and posting status.",
  manualBaselineMinutes: 12, reviewMinutes: REVIEW_BASE_MIN,
  baselineBasis: "Assumption: step-by-step manual AP handling estimate (12 min). Replaced by the linked agent's baseline or observed workflow duration when available.",
  inputSchema: ProcessInvoiceInput as unknown as z.ZodType<ProcessInvoiceInputT>,
  sampleInput: () => ({ sampleKey: "clean", text: INVOICE_SAMPLES[0].text }),
  samples: () => INVOICE_SAMPLES.map((s) => ({ key: s.key, label: s.label, description: s.description, input: { sampleKey: s.key, text: s.text } })),
  requiresProviders: ["quickbooks", "netsuite"],

  async execute(ctx, input) {
    // 1 — receive
    const received = await ctx.step<{ kind: "structured" | "text" | "pdf"; text: string }>("receive", "Receive invoice", () => {
      if (input.invoice) return { value: { kind: "structured" as const, text: "" }, detail: "Structured invoice object received.", data: { source: "structured" } };
      if (input.text) return { value: { kind: "text" as const, text: input.text }, detail: `Pasted text received (${input.text.length.toLocaleString()} characters).`, data: { source: "text", chars: input.text.length } };
      const f = input.file!; const buf = Buffer.from(f.dataBase64, "base64");
      if (/pdf/i.test(f.mimeType) || /\.pdf$/i.test(f.name)) {
        const r = extractPdfText(buf);
        if (!r.text) throw new Error(r.warnings.join(" ") || "No text could be extracted from the PDF.");
        return { value: { kind: "pdf" as const, text: r.text }, detail: `PDF “${f.name}” received: ${plural(r.pages, "page")}, ${r.text.length.toLocaleString()} characters extracted (pure-JS text extraction, no OCR).`, data: { source: "pdf", pages: r.pages, chars: r.text.length, warnings: r.warnings } };
      }
      if (/^text\//i.test(f.mimeType) || /\.(txt|csv|md|eml)$/i.test(f.name)) { const t = buf.toString("utf8"); return { value: { kind: "text" as const, text: t }, detail: `Text file “${f.name}” received (${t.length.toLocaleString()} characters).`, data: { source: "file", chars: t.length } }; }
      throw new Error(`Unsupported file type ${f.mimeType}. Upload a text-based PDF or a .txt file, or paste the invoice text.`);
    });

    // 2 — extract
    const parsed: ParsedInvoice = await ctx.step("extract", "Extract invoice fields", () => {
      const p = received.kind === "structured" ? fromStructured(input.invoice as StructuredInvoice) : parseInvoiceText(received.text, received.kind === "pdf" ? "pdf" : "text");
      const found = (Object.keys(p.fields) as (keyof typeof p.fields)[]).filter((k) => p.fields[k].method !== "missing" && p.fields[k].method !== "computed");
      return { value: p, detail: `${found.length} fields and ${plural(p.lines.length, "line item")} extracted; overall confidence ${Math.round(p.overallConfidence * 100)}%.${p.warnings.length ? " " + p.warnings.join(" ") : ""}`,
        data: { fields: Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, { label: FIELD_LABELS[k as keyof typeof FIELD_LABELS], value: v.value, confidence: v.confidence, method: v.method, span: v.span }])), lines: p.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, category: l.category, confidence: l.confidence, span: l.span })), overallConfidence: p.overallConfidence } };
    });
    const vendor = String(parsed.fields.vendor.value ?? ""); const invNo = String(parsed.fields.invoiceNumber.value ?? ""); const total = Number(parsed.fields.total.value ?? 0);

    // knowledge used by later steps (approved + scoped)
    const [facts, docs] = await Promise.all([ctx.facts(["vendor", "policy", "procedure", "system", "general"]), ctx.docs(["vendor", "policy", "procedure", "system"])]);
    const srcs = [...factsToSrc(facts), ...docsToSrc(docs)];

    // 3 — validate
    const { approved: brainVendors, blocked } = vendorsFromFacts(facts);
    const vendorList: VendorRef[] | null = ctx.synthetic ? [...SYNTHETIC_VENDORS, ...brainVendors] : brainVendors.length ? brainVendors : null;
    const validation = await ctx.step("validate", "Validate math, terms and vendor", () => {
      const v = validateInvoice(parsed, { approvedVendors: vendorList, today: ctx.today() });
      const bl = vendor ? blocked.find((b) => vendorSimilarity(b.name, vendor) >= 0.5) : undefined;
      if (bl) { v.checks.push({ key: "blocked_vendor", label: "Vendor not blocked", status: "fail", detail: `${vendor} is marked as not approved/blocked (${bl.source}).` }); v.errors++; }
      const vm = vendor && vendorList ? findVendor(vendor, vendorList) : null;
      if (vm?.vendor.citationId) ctx.cite(facts.find((f) => f.id === vm.vendor.citationId)?.citation);
      if (bl?.citationId) ctx.cite(facts.find((f) => f.id === bl.citationId)?.citation);
      return { value: v, detail: v.errors ? `${plural(v.errors, "problem")} found${v.warnings ? ` and ${plural(v.warnings, "warning")}` : ""}.` : v.warnings ? `Passed with ${plural(v.warnings, "warning")}.` : `All ${v.checks.filter((c) => c.status === "pass").length} checks passed.`, data: { checks: v.checks } };
    });

    // 4 — duplicate check
    const dup = await ctx.step<{ duplicate: boolean; of: string | null; runId: string | null }>("duplicate_check", "Check for duplicates", async () => {
      const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const prior = await priorInvoices(ctx.orgId, ctx.mode, ctx.synthetic);
      const pool = [
        ...(ctx.synthetic ? SYNTHETIC_AP_HISTORY.map((h) => ({ ref: `synthetic AP ledger (${h.processedOn})`, runId: null as string | null, ...h })) : []),
        ...prior.map((p) => ({ ref: `skill run ${p.id.slice(0, 8)} (${p.createdAt.toISOString().slice(0, 10)})`, runId: p.id, vendor: p.inv!.vendor ?? "", invoiceNumber: p.inv!.invoiceNumber ?? "", total: Number(p.inv!.total ?? 0) })),
      ];
      const hit = invNo ? pool.find((p) => norm(p.invoiceNumber) === norm(invNo) && vendorSimilarity(p.vendor, vendor) >= 0.5 && Math.abs(p.total - total) < 0.01) : undefined;
      const near = !hit && invNo ? pool.find((p) => norm(p.invoiceNumber) === norm(invNo) && vendorSimilarity(p.vendor, vendor) >= 0.5) : undefined;
      if (hit) return { value: { duplicate: true, of: hit.ref, runId: hit.runId }, detail: `Likely duplicate: same vendor, invoice # ${invNo} and amount ${money(total)} as ${hit.ref}.`, data: { checked: pool.length, match: hit } };
      return { value: { duplicate: false, of: null, runId: null }, detail: near ? `Same vendor + invoice # as ${near.ref} but a different amount (${money(near.total)}) — flagged for review, not treated as a duplicate.` : `No duplicate among ${plural(pool.length, "previously processed invoice")} (${ctx.synthetic ? "synthetic ledger + sandbox history" : "this organization's live history"}).`, data: { checked: pool.length, nearMatch: near ?? null } };
    });

    // 5 — PO match
    const tolerance = parseTolerancePct(srcs);
    if (tolerance?.citation) ctx.cite(tolerance.citation);
    const po = await ctx.step("po_match", "Match purchase order", () => {
      let register: PurchaseOrder[] | null;
      if (ctx.synthetic) register = SYNTHETIC_PO_REGISTER;
      else {
        const regs = [...facts.filter((f) => ["vendor", "procedure"].includes(f.category)).flatMap((f) => parsePoRegister(`${f.subject} ${f.statement}`, `AI Brain fact “${f.subject}”`, f.id)),
          ...docs.filter((d) => ["vendor", "procedure"].includes(d.category)).flatMap((d) => parsePoRegister(d.content, `AI Brain document “${d.title}”`, d.id))];
        register = regs.length ? regs : null;
      }
      const r = matchPurchaseOrder(parsed, register, tolerance?.pct ?? DEFAULT_TOLERANCE_PCT);
      if (r.po?.citationId) ctx.cite([...facts.map((f) => f.citation), ...docs.map((d) => d.citation)].find((c) => c.id === r.po!.citationId));
      const tolNote = tolerance ? `tolerance ${tolerance.pct}% from ${tolerance.source}` : `default ${DEFAULT_TOLERANCE_PCT}% tolerance (BridgeBox default — set yours in the AI Brain)`;
      return { value: r, detail: `${r.detail}${r.status === "matched" || r.status === "mismatch" ? ` (${tolNote})` : ""}${r.status === "no_source" ? " Connect an ERP/accounting system or add your open POs to the AI Brain (category vendor/procedure)." : ""}`, data: { status: r.status, po: r.po ?? null, differences: r.differences, tolerancePct: r.tolerancePct, registerSource: ctx.synthetic ? "Synthetic sample PO register" : register ? "Approved AI Brain knowledge" : "none" } };
    });

    // 6 — accounting entry (draft)
    const gl = glMapFromStatements(srcs.filter((s) => /\b(GL|G\/L|account)\b/i.test(s.text)).map((s) => ({ text: s.text, source: s.source })));
    for (const k of gl.fromBrain) { const src = srcs.find((s) => s.source === gl.map[k].source); ctx.cite(src?.citation); }
    let entry: ReturnType<typeof buildAccountingEntry> | null = null;
    if (!ctx.canDraft()) ctx.skip("prepare_entry", "Prepare accounting entry", "Not prepared: this AI employee is read-only (it may read and analyze, not create drafts).");
    else entry = await ctx.step("prepare_entry", "Prepare accounting entry", () => {
      const e = buildAccountingEntry(parsed, gl.map);
      const labelled = gl.fromBrain.length ? `GL accounts from your AI Brain for ${gl.fromBrain.join(", ")}; others use the BridgeBox default chart (labelled).` : "GL accounts are BridgeBox defaults (labelled) — add your GL mapping to the AI Brain to use your chart of accounts.";
      return { value: e, detail: `${e.balanced ? "Balanced" : "UNBALANCED"} draft entry: ${plural(e.lines.filter((l) => l.debit).length, "debit line")}, credit Accounts Payable ${money(e.totalCredit)}. ${labelled}`, data: { lines: e.lines, balanced: e.balanced, totalDebit: e.totalDebit, totalCredit: e.totalCredit } };
    });

    // exceptions → approval reasons
    const policy = parseApprovalPolicy(srcs) ?? (ctx.synthetic ? { threshold: SYNTHETIC_POLICY.approvalThreshold, approverRole: SYNTHETIC_POLICY.approverRole, source: SYNTHETIC_POLICY.source, citation: undefined, sentence: SYNTHETIC_POLICY.source } : null);
    if (policy?.citation) ctx.cite(policy.citation);
    const overThreshold = !!policy && total > policy.threshold;
    const exceptions = [
      ...validation.checks.filter((c) => c.status === "fail").map((c) => `${c.label}: ${c.detail}`),
      ...validation.checks.filter((c) => c.status === "warn" && ["approved_vendor", "due_terms", "confidence"].includes(c.key)).map((c) => `${c.label}: ${c.detail}`),
      ...(po.status === "mismatch" || po.status === "not_found" ? [`PO: ${po.detail}`] : []),
    ];
    const reasons = [...(overThreshold ? [`Total ${money(total)} is over the ${money(policy!.threshold)} approval threshold (${policy!.source})`] : []), ...exceptions];
    const approverRole = overThreshold ? policy!.approverRole : "manager";
    const invoiceSummary = { vendor, invoiceNumber: invNo, total, invoiceDate: parsed.fields.invoiceDate.value, dueDate: parsed.fields.dueDate.value, poNumber: parsed.fields.poNumber.value };
    const output: Record<string, unknown> = {
      invoice: invoiceSummary,
      extraction: { text: parsed.text.slice(0, 20000), fields: Object.fromEntries(Object.entries(parsed.fields).map(([k, v]) => [k, { label: FIELD_LABELS[k as keyof typeof FIELD_LABELS], ...v }])), lines: parsed.lines, overallConfidence: parsed.overallConfidence, source: parsed.source },
      validation: validation.checks, duplicate: dup, poMatch: { status: po.status, detail: po.detail, po: po.po ?? null, differences: po.differences },
      policy: policy ? { threshold: policy.threshold, approverRole: policy.approverRole, source: policy.source } : null,
      exceptions, draftEntry: entry ? { ...entry, status: "draft", storedIn: "BridgeBox (this run)" } : null,
    };

    // 7 + 8 — approval and posting
    let pending = null as import("./runtime").PendingAction | null;
    let disposition = "prepared";
    if (dup.duplicate) {
      disposition = "held_duplicate";
      ctx.skip("request_approval", "Request approval", `Held: likely duplicate of ${dup.of}. Not routed for posting — a person should confirm and void it.`);
      ctx.skip("update_accounting", "Update accounting system", "Not posted (duplicate hold).");
    } else if (!entry) {
      disposition = "analysis_only";
      ctx.skip("request_approval", "Request approval", "Not requested: read-only AI employee.");
      ctx.skip("update_accounting", "Update accounting system", "Not posted: read-only AI employee.");
    } else {
      const decision = ctx.gate("update_accounting", overThreshold || exceptions.length > 0);
      if (decision === "simulated") {
        await ctx.step("request_approval", "Request approval", () => ({ value: null, detail: reasons.length ? `Synthetic sample — would request ${approverRole} approval: ${reasons.join("; ")}.` : `Synthetic sample — within policy${policy ? ` (≤ ${money(policy.threshold)})` : ""} and no exceptions, so it would go to the standard approver queue.`, data: { simulated: true, reasons, approverRole } }));
        await ctx.step("update_accounting", "Update accounting system", () => ({ value: null, detail: "Synthetic sample — simulated post to the BridgeBox AP queue. Nothing was sent to any accounting system.", data: { simulated: true } }));
        disposition = "simulated";
      } else if (decision === "blocked") {
        disposition = "draft_stored";
        ctx.skip("request_approval", "Request approval", ctx.gateDetail(decision, "request approval"));
        ctx.skip("update_accounting", "Update accounting system", "Not posted: the draft entry is stored in BridgeBox for a person to post.");
      } else if (decision === "pending") {
        disposition = "awaiting_approval";
        pending = { stepKey: "update_accounting", label: "Post entry to AP queue", requestedAction: `Post ${vendor} invoice ${invNo} (${money(total)}) to accounts payable`, reasons: reasons.length ? reasons : ["Act-with-approval: every posting needs a person's approval"], approverRole, elevated: overThreshold, payload: { invoice: invoiceSummary, entry }, requestedAt: new Date().toISOString() };
        await ctx.step("request_approval", "Request approval", () => ({ value: null, status: "awaiting_approval", detail: `Approval requested from a ${approverRole}${overThreshold ? " (over-threshold: owner/admin only)" : ""}: ${pending!.reasons.join("; ")}.`, data: { reasons: pending!.reasons, approverRole, elevated: overThreshold } }));
        ctx.steps.push({ key: "update_accounting", label: "Update accounting system", status: "awaiting_approval", ms: 0, detail: "Runs only after approval." });
      } else {
        await ctx.step("request_approval", "Request approval", () => ({ value: null, detail: `No approval required: within policy${policy ? ` (≤ ${money(policy.threshold)})` : ""} and no exceptions (autonomous permission).` }));
        const act = await ctx.step("update_accounting", "Update accounting system", async () => { const r = await processInvoice.performAction!(ctx, { stepKey: "update_accounting", label: "", requestedAction: "", reasons: [], approverRole: "", elevated: false, payload: { invoice: invoiceSummary, entry }, requestedAt: new Date().toISOString() }, output); return { value: r, detail: r.detail, data: r.data }; });
        Object.assign(output, act.outputPatch ?? {});
        disposition = "posted_to_bridgebox_queue";
      }
    }
    output.disposition = disposition;

    const statusLine = {
      held_duplicate: `It looks like a duplicate of ${dup.of}, so it was held and not routed for posting.`,
      analysis_only: "This AI employee is read-only, so no entry was prepared.",
      simulated: "Synthetic sample: nothing was posted anywhere.",
      draft_stored: "The draft entry is stored in BridgeBox for a person to post (draft-only permission).",
      awaiting_approval: `It is waiting for ${approverRole} approval before posting.`,
      posted_to_bridgebox_queue: "It was posted to the BridgeBox AP queue (no accounting system is connected).",
      prepared: "",
    }[disposition];
    const checksLine = validation.errors ? `${plural(validation.errors, "problem")} found (${validation.checks.filter((c) => c.status === "fail").map((c) => c.label.toLowerCase()).join(", ")})` : validation.warnings ? `validation passed with ${plural(validation.warnings, "warning")}` : "validation passed";
    const poLine = po.status === "matched" ? `PO ${po.po?.poNumber} matched` : po.status === "mismatch" ? `PO mismatch (${po.differences[0]})` : po.status === "no_source" ? "no PO source connected" : po.status === "not_found" ? `PO not found` : "no PO on the invoice";
    const summary = `Processed invoice ${invNo || "(no number)"} from ${vendor || "an unknown vendor"} for ${money(total)}: ${checksLine}; ${poLine}. ${statusLine}`.trim();
    return { output, summary, humanReviewMinutes: Math.min(REVIEW_BASE_MIN + exceptions.length + (overThreshold ? 1 : 0), 8), pending };
  },

  async performAction(_ctx, pending, _output) {
    const acct = ["quickbooks", "netsuite"].map((k) => catalogEntry(k)).filter(Boolean);
    const built = acct.filter((c) => c!.implemented !== "none");
    const entry = pending.payload.entry;
    const detail = built.length
      ? `Draft posted to the BridgeBox AP queue. ${built.map((c) => c!.name).join(" / ")} connector exists but skill posting is not wired yet — nothing was sent to it.`
      : `Draft posted to BridgeBox AP queue — no accounting system connected (${acct.map((c) => c!.name).join(" and ")} connectors are not built). Export or key the entry into your accounting system.`;
    return { detail, data: { externalSystem: null }, outputPatch: { apQueue: { status: "approved_for_posting", queuedAt: new Date().toISOString(), externalSystem: null, entry } } };
  },
};
