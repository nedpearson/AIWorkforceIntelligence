/** Sales & marketing skills: draft_customer_email, generate_proposal, follow_up_lead, update_crm, generate_marketing. */
import { z } from "zod";
import type { Passage } from "@/engine/brain";
import { addDays, daysBetween, parseDate, termsDays } from "./invoice";
import { docsToSrc, factsToSrc, findPrice, parsePricing, type KFact } from "./knowledge";
import { SYNTHETIC_PRICES } from "./finance-skills";
import { money, plural, type SkillCtx, type SkillImpl } from "./runtime";

const r2 = (n: number) => Math.round(n * 100) / 100;
const SampleKey = z.string().max(40).optional();

/** Numbers, money, percentages and dates stated in `text` that appear nowhere in the approved knowledge. */
export function unsupportedClaims(text: string, knowledge: string[]): string[] {
  const kb = knowledge.join("\n").toLowerCase().replace(/,/g, "");
  const out = new Set<string>();
  for (const m of text.matchAll(/\$\s?[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%|\b\d+\s?(?:day|week|month|year)s?\b/gi)) {
    const v = m[0].toLowerCase().replace(/,/g, "").replace(/\s/g, "");
    const core = v.replace(/[$%]/g, "").replace(/(day|week|month|year)s?$/, "");
    if (!kb.replace(/\s/g, "").includes(v) && !new RegExp(`(^|[^\\d.])${core.replace(/\./g, "\\.")}([^\\d]|$)`).test(kb)) out.add(m[0].trim());
  }
  for (const m of text.matchAll(/\b(guarantee[ds]?|risk[- ]free|best in (the )?(industry|class)|#1|number one|lowest price|never fails?|100% (uptime|satisfaction))\b/gi)) out.add(m[0]);
  return [...out];
}
const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? s;
const sentences = (s: string) => s.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
const knowledgeTexts = (ps: Passage[], facts: KFact[]) => [...ps.map((p) => p.text), ...facts.map((f) => `${f.subject} ${f.statement}`)];
async function draftOrSkip(ctx: SkillCtx, label: string, text: string, what: string) {
  if (!ctx.canDraft()) { ctx.skip("draft", label, "Not stored: this AI employee is read-only (it may read and analyze, not create drafts)."); return null; }
  return ctx.step("draft", label, () => ({ value: text, detail: `${what} stored in BridgeBox as a draft for a person to review and send — nothing was sent.${ctx.synthetic ? " Synthetic sample." : ""}` }));
}

// ============================================================================================ draft_customer_email
const Purpose = z.enum(["follow_up", "quote", "apology", "payment_reminder", "thank_you", "general"]);
const EmailInput = z.object({ sampleKey: SampleKey, customerName: z.string().trim().min(2, "Customer name is required").max(120), customerEmail: z.string().email().optional(), purpose: Purpose, context: z.string().trim().min(10, "Describe what the email is about (10+ characters)").max(4000), tone: z.enum(["friendly", "formal", "concise"]).default("friendly"), senderName: z.string().max(80).optional() });
type EmailT = z.infer<typeof EmailInput>;
const SUBJECT: Record<z.infer<typeof Purpose>, (c: string) => string> = { follow_up: () => "Following up", quote: () => "Your quote", apology: () => "Our apologies — and what we're doing about it", payment_reminder: () => "Friendly payment reminder", thank_you: () => "Thank you", general: () => "A quick note" };
const OPEN: Record<z.infer<typeof Purpose>, string> = { follow_up: "I wanted to follow up on our recent conversation.", quote: "As promised, here are the details of your quote.", apology: "I'm sorry for the trouble you experienced.", payment_reminder: "This is a friendly reminder about an open balance on your account.", thank_you: "Thank you for your business — we really appreciate it.", general: "I hope you're doing well." };
const CLOSE: Record<z.infer<typeof Purpose>, string> = { follow_up: "Is there a good time this week to continue the conversation?", quote: "Let me know if you have any questions or would like to move forward.", apology: "Please reply if there's anything else we can do.", payment_reminder: "If you've already sent payment, please disregard this note — and thank you.", thank_you: "We look forward to working with you again.", general: "Please let me know if you have any questions." };

export const draftCustomerEmail: SkillImpl<EmailT> = {
  key: "draft_customer_email", name: "Draft customer email", category: "customer_service", access: "draft", generative: true,
  description: "Drafts a customer email for a stated purpose using your approved knowledge (policies, products, terms, brand preferences), and flags any price, percentage, date or promise in it that your approved knowledge does not support. Stores a draft — never sends. Manual baseline 8 min is a BridgeBox assumption (look up account/policy 3 + write 4 + proofread 1).",
  outputDescription: "Subject, body, supporting knowledge, unsupported-claim warnings, mode (deterministic or model-polished).",
  manualBaselineMinutes: 8, reviewMinutes: 1.5, baselineBasis: "Assumption: manual customer email (8 min).",
  inputSchema: EmailInput as unknown as z.ZodType<EmailT>,
  sampleInput: () => draftCustomerEmail.samples()[0].input,
  samples: () => [{ key: "late_delivery", label: "Late delivery apology", description: "Synthetic sample — a delayed order.", input: { sampleKey: "late_delivery", customerName: "Dana Whitfield (Synthetic)", customerEmail: "dana@harborpoint.example", purpose: "apology", tone: "friendly", context: "Order 5521 for 20 brass gate valves shipped 2 days late because of a carrier delay. The new delivery date is Thursday. We will waive the freight charge on this order.", senderName: "Customer Care Team" } }],
  async execute(ctx, input) {
    const [ps, facts] = await Promise.all([ctx.passages(`${input.purpose.replace("_", " ")} ${input.context} ${input.customerName}`, 5), ctx.facts(["customer", "policy", "preference", "product", "pricing"])]);
    const kn = await ctx.step("knowledge", "Gather approved knowledge", () => { ctx.cite(...ps.map((p) => p.citation)); return { value: ps, detail: ps.length ? `${plural(ps.length, "approved passage")} used: ${ps.slice(0, 3).map((p) => p.citation.label).join("; ")}.` : "No matching approved knowledge — the draft relies only on the context you provided.", data: { passages: ps.map((p) => ({ label: p.citation.label, text: p.text.slice(0, 240) })) } }; });
    const claims = await ctx.step("claims", "Check promises against approved knowledge", () => { const u = unsupportedClaims(input.context, knowledgeTexts(kn, facts)); return { value: u, detail: u.length ? `${plural(u.length, "statement")} not backed by approved knowledge — confirm before sending: ${u.join(", ")}.` : "Every figure and promise is backed by approved knowledge (or none were made)." }; });
    const greet = input.tone === "formal" ? `Dear ${input.customerName},` : `Hi ${firstName(input.customerName)},`;
    const body = [greet, "", OPEN[input.purpose], "", ...sentences(input.context).map((s) => s.replace(/^we\b/i, "We")), "", CLOSE[input.purpose], "", input.tone === "formal" ? "Sincerely," : "Best regards,", input.senderName ?? "[Your name]"].join("\n").replace(/\n{3,}/g, "\n\n");
    const polished = await ctx.polish("customer email", body, kn, input.context);
    const text = `Subject: ${SUBJECT[input.purpose](input.customerName)}\n\n${polished.text}`;
    const draft = await draftOrSkip(ctx, "Store email draft", text, "Email");
    return { output: { subject: SUBJECT[input.purpose](input.customerName), to: input.customerEmail ?? null, body: draft ? polished.text : null, draft, unsupportedClaims: claims, supportingKnowledge: kn.map((p) => p.citation.label), mode: polished.mode, modeNote: polished.note ?? null },
      summary: `${draft ? "Drafted" : "Analyzed"} a ${input.purpose.replace("_", " ")} email to ${input.customerName}${kn.length ? ` using ${plural(kn.length, "approved source")}` : ""}.${claims.length ? ` ${plural(claims.length, "statement")} need confirmation (${claims.join(", ")}).` : ""}${draft ? " Nothing was sent." : " Read-only: no draft stored."}`, humanReviewMinutes: 1.5 + claims.length * 0.5 };
  },
};

// ============================================================================================ generate_proposal
const ProposalInput = z.object({ sampleKey: SampleKey, client: z.string().trim().min(2).max(160), title: z.string().max(160).optional(), scope: z.array(z.string().trim().min(3).max(500)).min(1, "Describe at least one scope item").max(30), items: z.array(z.object({ name: z.string().trim().min(1).max(200), quantity: z.number().positive().max(1e6).default(1), unitPrice: z.number().nonnegative().optional() })).max(60).default([]), timelineWeeks: z.number().int().min(1).max(260).optional(), validDays: z.number().int().min(1).max(365).default(30) });
type ProposalT = z.infer<typeof ProposalInput>;
export const generateProposal: SkillImpl<ProposalT> = {
  key: "generate_proposal", name: "Generate proposal", category: "sales", access: "draft", generative: true,
  description: "Assembles a client proposal (overview, scope, pricing, timeline, terms, assumptions) from your approved pricing, products and terms. Items without an approved or entered price are listed as “price required” and excluded from the total — prices are never invented. Manual baseline 60 min is a BridgeBox assumption for a standard proposal from a template.",
  outputDescription: "Proposal markdown, priced items with sources, total, unpriced items, terms source.",
  manualBaselineMinutes: 60, reviewMinutes: 10, baselineBasis: "Assumption: templated proposal by a sales rep (60 min).",
  inputSchema: ProposalInput as unknown as z.ZodType<ProposalT>,
  sampleInput: () => generateProposal.samples()[0].input,
  samples: () => [{ key: "maintenance", label: "Maintenance program proposal", description: "Synthetic sample — annual plan plus labor.", input: { sampleKey: "maintenance", client: "Pelican Charters (Synthetic)", title: "Fleet valve maintenance program", scope: ["Quarterly inspection of all deck valves on 6 vessels", "Replacement of failed valves with brass gate valves", "Written condition report after each visit"], items: [{ name: "Annual maintenance plan", quantity: 1 }, { name: "Standard labor rate", quantity: 24 }, { name: "Emergency call-out", quantity: 2 }], timelineWeeks: 52, validDays: 30 } }],
  async execute(ctx, input) {
    const [facts, docs] = await Promise.all([ctx.facts(["pricing", "product", "policy", "company"]), ctx.docs(["pricing", "product", "policy"])]);
    const prices = [...parsePricing([...factsToSrc(facts), ...docsToSrc(docs)]), ...(ctx.synthetic ? SYNTHETIC_PRICES : [])];
    const items = await ctx.step("pricing", "Price items from approved pricing", () => {
      const out = input.items.map((it) => { const ref = it.unitPrice == null ? findPrice(it.name, prices) : null; if (ref?.citation) ctx.cite(ref.citation); const unit = it.unitPrice ?? ref?.price ?? null; return { name: it.name, quantity: it.quantity, unitPrice: unit, unit: ref?.unit ?? "each", amount: unit == null ? null : r2(unit * it.quantity), source: it.unitPrice != null ? "entered" : ref ? ref.source : "price required" }; });
      const missing = out.filter((o) => o.amount == null);
      return { value: out, detail: `${plural(out.length - missing.length, "item")} priced${missing.length ? `; ${plural(missing.length, "item")} need a price (no approved price): ${missing.map((m) => m.name).join(", ")}` : ""}.` };
    });
    const terms = facts.find((f) => f.category === "policy" && termsDays(f.statement) != null);
    if (terms) ctx.cite(terms.citation);
    const company = facts.find((f) => f.category === "company"); if (company) ctx.cite(company.citation);
    const ps = await ctx.passages(`${input.title ?? ""} ${input.scope.join(" ")}`, 4); ctx.cite(...ps.map((p) => p.citation));
    const total = r2(items.reduce((s, i) => s + (i.amount ?? 0), 0));
    const md = await ctx.step("compose", "Compose proposal", () => {
      const t = [`# ${input.title ?? `Proposal for ${input.client}`}${ctx.synthetic ? " (Synthetic sample)" : ""}`, `Prepared for **${input.client}** · valid ${input.validDays} days`, "", "## Overview", company ? `${company.statement}` : `This proposal outlines the work requested by ${input.client}.`, "",
        "## Scope", ...input.scope.map((s) => `- ${s}`), "", "## Pricing", "| Item | Qty | Unit price | Amount |", "|---|---:|---:|---:|", ...items.map((i) => `| ${i.name} | ${i.quantity} | ${i.unitPrice == null ? "price required" : `${money(i.unitPrice)}/${i.unit}`} | ${i.amount == null ? "—" : money(i.amount)} |`), `| **Total (priced items)** | | | **${money(total)}** |`, "",
        input.timelineWeeks ? `## Timeline\nAbout ${plural(input.timelineWeeks, "week")} from acceptance.\n` : "", "## Terms", terms ? `Payment terms: Net ${termsDays(terms.statement)} (per approved policy).` : "Payment terms: to be confirmed (no approved payment-terms policy in the AI Brain).", "", "## Assumptions",
        "- Prices are taken from approved pricing or entered by the requester; items marked “price required” are not included in the total.", ps.length ? `- Based on: ${ps.map((p) => p.citation.label).join("; ")}.` : "- No additional approved reference material matched this scope."].filter((x) => x !== "").join("\n");
      return { value: t, detail: `Proposal composed: ${plural(input.scope.length, "scope item")}, total ${money(total)}.` };
    });
    const polished = await ctx.polish("sales proposal (markdown; keep the pricing table exactly)", md, ps);
    const draft = await draftOrSkip(ctx, "Store proposal draft", polished.text, "Proposal");
    const missing = items.filter((i) => i.amount == null).map((i) => i.name);
    return { output: { proposal: draft, items, total, missingPrices: missing, termsSource: terms ? terms.subject : null, mode: polished.mode },
      summary: `${draft ? "Drafted" : "Prepared (not stored)"} a proposal for ${input.client} totaling ${money(total)} for priced items.${missing.length ? ` ${plural(missing.length, "item")} still need a price: ${missing.join(", ")}.` : ""}`, humanReviewMinutes: 10 + missing.length * 2 };
  },
};

// ============================================================================================ follow_up_lead
const LeadInput = z.object({ sampleKey: SampleKey, lead: z.object({ name: z.string().trim().min(2).max(120), company: z.string().max(160).optional(), email: z.string().email().optional(), source: z.string().max(80).optional(), lastContactDate: z.string().max(40).optional(), interest: z.string().max(500).optional(), notes: z.string().max(4000).optional(), stage: z.string().max(60).optional() }), senderName: z.string().max(80).optional() });
type LeadT = z.infer<typeof LeadInput>;
export function scoreLead(lead: LeadT["lead"], today: string, productTerms: string[]) {
  const text = `${lead.interest ?? ""} ${lead.notes ?? ""}`.toLowerCase();
  const signals: { label: string; points: number }[] = [];
  const add = (label: string, points: number) => signals.push({ label, points });
  if (/pric|quote|cost|budget/.test(text)) add("Asked about pricing/budget", 20);
  if (/demo|trial|meeting|call/.test(text)) add("Requested a demo/meeting", 15);
  if (/(this|next) (month|quarter)|asap|urgent|timeline|deadline/.test(text)) add("Has a timeline", 10);
  if (/decision|owner|director|vp|manager|cfo|ceo/.test(text)) add("Decision-maker involved", 5);
  const fit = productTerms.filter((t) => t.length > 3 && text.includes(t.toLowerCase())).slice(0, 3);
  if (fit.length) add(`Interest matches approved products (${fit.join(", ")})`, 10 * fit.length);
  if (/referral|referred/i.test(lead.source ?? "")) add("Referral source", 10);
  const last = parseDate(lead.lastContactDate ?? "");
  const days = last ? daysBetween(last, today) : null;
  if (days != null) add(days <= 3 ? "Contacted in the last 3 days" : days <= 14 ? "Contacted in the last 2 weeks" : `No contact for ${days} days`, days <= 3 ? 15 : days <= 14 ? 8 : 0);
  if (/not interested|unsubscribe|no budget|went with/.test(text)) add("Negative signal", -40);
  const score = Math.max(0, Math.min(100, signals.reduce((s, x) => s + x.points, 0)));
  const priority = score >= 50 ? "hot" : score >= 25 ? "warm" : "cold";
  return { score, priority, signals, daysSinceContact: days, nextActionDate: addDays(today, priority === "hot" ? 1 : priority === "warm" ? 3 : 7) } as const;
}
export const followUpLead: SkillImpl<LeadT> = {
  key: "follow_up_lead", name: "Follow up with lead", category: "sales", access: "draft", generative: true,
  description: "Scores a lead from transparent signals (pricing questions, demo requests, timeline, fit with your approved products, recency), sets the next follow-up date, and drafts a personalized follow-up email for a person to send. Manual baseline 10 min is a BridgeBox assumption (review history 4 + decide next step 2 + write 4).",
  outputDescription: "Score with signal breakdown, priority, next action date and the draft email.",
  manualBaselineMinutes: 10, reviewMinutes: 1.5, baselineBasis: "Assumption: manual lead follow-up (10 min).",
  inputSchema: LeadInput as unknown as z.ZodType<LeadT>,
  sampleInput: () => followUpLead.samples()[0].input,
  samples: () => [{ key: "inbound", label: "Inbound pricing request", description: "Synthetic sample — a warm inbound lead.", input: { sampleKey: "inbound", lead: { name: "Morgan Ellis (Synthetic)", company: "Delta Docks Co.", email: "morgan@deltadocks.example", source: "Website form", lastContactDate: "2026-11-04", interest: "Annual maintenance plan for 4 vessels", notes: "Asked for pricing and wants a call next week; operations manager." }, senderName: "Sales Team" } }],
  async execute(ctx, input) {
    const facts = await ctx.facts(["product", "pricing", "customer"]);
    const productTerms = [...facts.filter((f) => f.category !== "customer").map((f) => f.subject), ...(ctx.synthetic ? SYNTHETIC_PRICES.map((p) => p.item) : [])];
    const s = await ctx.step("score", "Score the lead", () => { const r = scoreLead(input.lead, ctx.today(), productTerms); return { value: r, detail: `Score ${r.score}/100 (${r.priority}): ${r.signals.map((x) => `${x.label} ${x.points >= 0 ? "+" : ""}${x.points}`).join(", ") || "no signals"}.`, data: { signals: r.signals } }; });
    const ps = await ctx.passages(`${input.lead.interest ?? ""} ${input.lead.company ?? ""}`, 3); ctx.cite(...ps.map((p) => p.citation));
    for (const f of facts.filter((f) => productTerms.includes(f.subject) && (input.lead.interest ?? "").toLowerCase().includes(f.subject.toLowerCase()))) ctx.cite(f.citation);
    await ctx.step("next_action", "Plan the next action", () => ({ value: null, detail: `Follow up by ${s.nextActionDate} (${s.priority === "hot" ? "within 1 day" : s.priority === "warm" ? "within 3 days" : "within a week"}).` }));
    const body = [`Hi ${firstName(input.lead.name)},`, "", `Thanks for your interest${input.lead.interest ? ` in ${input.lead.interest.replace(/\.$/, "")}` : ""}${input.lead.company ? ` for ${input.lead.company}` : ""}.`,
      /pric|quote/i.test(`${input.lead.notes} ${input.lead.interest}`) ? "I'd be glad to walk you through pricing options that fit what you described." : "I'd love to learn more about what you're looking for.",
      /call|meeting|demo/i.test(input.lead.notes ?? "") ? "Would a 20-minute call next week work? Let me know a couple of times that suit you." : "Would you be open to a short call to discuss next steps?", "", "Best regards,", input.senderName ?? "[Your name]"].join("\n");
    const polished = await ctx.polish("sales follow-up email", body, ps, `${input.lead.interest ?? ""}\n${input.lead.notes ?? ""}`);
    const draft = await draftOrSkip(ctx, "Store follow-up draft", polished.text, "Follow-up email");
    return { output: { score: s.score, priority: s.priority, signals: s.signals, nextActionDate: s.nextActionDate, daysSinceContact: s.daysSinceContact, draft, mode: polished.mode },
      summary: `${input.lead.name}${input.lead.company ? ` (${input.lead.company})` : ""} is a ${s.priority} lead (score ${s.score}/100). Next follow-up by ${s.nextActionDate}.${draft ? " A follow-up email draft is ready for review." : ""}` };
  },
};

// ============================================================================================ update_crm
const Rec = z.object({ name: z.string().trim().min(1).max(160), email: z.string().max(200).optional(), phone: z.string().max(40).optional(), company: z.string().max(160).optional(), stage: z.string().max(60).optional(), notes: z.string().max(2000).optional(), id: z.string().max(80).optional() });
const CrmInput = z.object({ sampleKey: SampleKey, records: z.array(Rec).min(1, "Add at least one record").max(500), existing: z.array(Rec).max(5000).optional(), allowedStages: z.array(z.string().max(60)).max(30).optional() });
type CrmT = z.infer<typeof CrmInput>;
const DEFAULT_STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
export function normalizeRecord(r: z.infer<typeof Rec>) {
  const issues: string[] = [];
  const email = r.email?.trim().toLowerCase() || undefined;
  if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) issues.push(`invalid email “${r.email}”`);
  let phone = r.phone?.replace(/[^\d+]/g, "") || undefined;
  if (phone) { const d = phone.replace(/\D/g, ""); if (d.length === 10) phone = `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`; else if (d.length === 11 && d.startsWith("1")) phone = `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`; else if (d.length < 7) { issues.push(`invalid phone “${r.phone}”`); } }
  const name = r.name.replace(/\s+/g, " ").trim().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  return { ...r, name, email, phone, company: r.company?.trim() || undefined, stage: r.stage?.trim().toLowerCase() || undefined, issues };
}
const nameSim = (a: string, b: string) => { const t = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean); const A = t(a), B = t(b); return A.length && B.length ? A.filter((x) => B.includes(x)).length / Math.max(A.length, B.length) : 0; };
export const updateCrm: SkillImpl<CrmT> = {
  key: "update_crm", name: "Update CRM records", category: "sales", access: "act", alwaysApproveSteps: ["apply_changes"],
  description: "Cleans and de-duplicates contact records (email/phone normalization, stage validation, matching against existing records by email, phone or name+company), and prepares a reviewable change set of creates, updates and merges. Applying changes always requires a person's approval. Manual baseline 2 min per record (assumption) — the static baseline assumes a 10-record batch (20 min).",
  outputDescription: "Change set (create/update/merge/invalid) with field-level diffs; application status.",
  manualBaselineMinutes: 20, reviewMinutes: 3, baselineBasis: "Assumption: ~2 min per CRM record, 10-record batch (20 min).",
  requiresProviders: ["hubspot", "salesforce"],
  inputSchema: CrmInput as unknown as z.ZodType<CrmT>,
  sampleInput: () => updateCrm.samples()[0].input,
  samples: () => [{ key: "trade_show", label: "Trade-show contacts", description: "Synthetic sample — 5 new contacts vs 3 existing records.", input: { sampleKey: "trade_show",
    records: [{ name: "morgan ellis", email: "MORGAN@deltadocks.example", phone: "(251) 555-0142", company: "Delta Docks Co.", stage: "Qualified" }, { name: "Priya Natarajan", email: "priya@bayviewboats.example", company: "Bayview Boats", stage: "lead" }, { name: "Sam O'Neal", email: "sam@@pelican", phone: "555", company: "Pelican Charters", stage: "lead" }, { name: "Chris Duarte", phone: "251.555.0199", company: "Gulf Marine Services", stage: "hot" }, { name: "Priya Natarajan", email: "priya@bayviewboats.example", company: "Bayview Boats", notes: "Met at booth 14" }],
    existing: [{ id: "C-1001", name: "Morgan Ellis", email: "morgan@deltadocks.example", company: "Delta Docks Co.", stage: "lead" }, { id: "C-1002", name: "Chris Duarte", phone: "+1 (251) 555-0199", company: "Gulf Marine Services", stage: "proposal" }, { id: "C-1003", name: "Lee Park", email: "lee@seawall.example", company: "Seawall Partners", stage: "won" }] } }],
  async execute(ctx, input) {
    const terms = await ctx.facts(["terminology", "procedure"]);
    const stageFact = terms.find((f) => /pipeline|stages?/i.test(`${f.subject} ${f.statement}`) && /,/.test(f.statement));
    const stages = input.allowedStages?.map((s) => s.toLowerCase()) ?? (stageFact ? stageFact.statement.replace(/^.*?:/, "").split(/[,;]|\band\b/).map((s) => s.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean) : DEFAULT_STAGES);
    if (stageFact && !input.allowedStages) ctx.cite(stageFact.citation);
    const recs = await ctx.step("normalize", "Normalize and validate records", () => { const r = input.records.map(normalizeRecord).map((x) => (x.stage && !stages.includes(x.stage) ? { ...x, issues: [...x.issues, `unknown stage “${x.stage}” (allowed: ${stages.join(", ")})`] } : x)); return { value: r, detail: `${plural(r.length, "record")} normalized; ${r.filter((x) => x.issues.length).length} with issues. Stages: ${input.allowedStages ? "provided" : stageFact ? `AI Brain “${stageFact.subject}”` : "BridgeBox default pipeline"}.` }; });
    const existing = (input.existing ?? []).map(normalizeRecord);
    if (!ctx.synthetic && !input.existing) ctx.skip("existing", "Load existing CRM records", "No CRM records supplied and no CRM connection is used by skills yet — records are compared within this batch only.");
    const changes = await ctx.step("dedupe", "De-duplicate and build change set", () => {
      const out: { action: "create" | "update" | "merge" | "invalid"; record: ReturnType<typeof normalizeRecord>; targetId?: string; diff?: Record<string, { from: unknown; to: unknown }>; reason: string }[] = [];
      const seen: ReturnType<typeof normalizeRecord>[] = [];
      for (const r of recs) {
        if (r.issues.some((i) => /invalid email|invalid phone/.test(i)) && !r.email?.includes("@") && !r.phone) { out.push({ action: "invalid", record: r, reason: r.issues.join("; ") }); continue; }
        const same = (a: ReturnType<typeof normalizeRecord>) => (r.email && a.email === r.email) || (r.phone && a.phone === r.phone) || (nameSim(a.name, r.name) >= 0.99 && (a.company ?? "").toLowerCase() === (r.company ?? "").toLowerCase());
        const dupInBatch = seen.find(same);
        if (dupInBatch) { out.push({ action: "merge", record: r, reason: `Duplicate of ${dupInBatch.name} earlier in this batch — merged (notes kept)` }); continue; }
        seen.push(r);
        const ex = existing.find(same);
        if (ex) { const diff: Record<string, { from: unknown; to: unknown }> = {}; for (const k of ["email", "phone", "company", "stage", "notes"] as const) if (r[k] && r[k] !== ex[k]) diff[k] = { from: ex[k] ?? null, to: r[k] }; out.push({ action: "update", record: r, targetId: ex.id, diff, reason: Object.keys(diff).length ? `Matches existing ${ex.id ?? ex.name}; ${Object.keys(diff).join(", ")} change` : `Matches existing ${ex.id ?? ex.name}; no changes` }); }
        else out.push({ action: "create", record: r, reason: r.issues.length ? `New record (issues: ${r.issues.join("; ")})` : "New record" });
      }
      const c = (a: string) => out.filter((x) => x.action === a).length;
      return { value: out, detail: `${c("create")} create, ${c("update")} update, ${c("merge")} merge, ${c("invalid")} invalid.`, data: { counts: { create: c("create"), update: c("update"), merge: c("merge"), invalid: c("invalid") } } };
    });
    const output: Record<string, unknown> = { changeSet: changes, stages };
    let pending = null as import("./runtime").PendingAction | null;
    const actionable = changes.filter((c) => c.action === "create" || (c.action === "update" && Object.keys(c.diff ?? {}).length)).length;
    if (!ctx.canDraft()) ctx.skip("apply_changes", "Apply changes", "Not done: read-only AI employee (analysis only).");
    else {
      const d = ctx.gate("apply_changes");
      if (d === "simulated") await ctx.step("apply_changes", "Apply changes", () => ({ value: null, detail: `Synthetic sample — would apply ${plural(actionable, "change")} after approval; nothing was written.`, data: { simulated: true } }));
      else if (d === "blocked") ctx.skip("apply_changes", "Apply changes", "Change set stored in BridgeBox for a person to apply (draft-only).");
      else { pending = { stepKey: "apply_changes", label: "Apply CRM change set", requestedAction: `Apply ${plural(actionable, "CRM change")}`, reasons: ["CRM changes always require approval"], approverRole: "manager", elevated: false, payload: { count: actionable }, requestedAt: new Date().toISOString() }; await ctx.step("apply_changes", "Apply changes", () => ({ value: null, status: "awaiting_approval", detail: `Approval requested to apply ${plural(actionable, "change")}.` })); }
    }
    return { output, summary: `Reviewed ${plural(input.records.length, "record")}: ${changes.filter((c) => c.action === "create").length} new, ${changes.filter((c) => c.action === "update").length} matched existing, ${changes.filter((c) => c.action === "merge").length} duplicates merged, ${changes.filter((c) => c.action === "invalid").length} invalid.${pending ? " Waiting for approval to apply." : ""}`, humanReviewMinutes: 3 + changes.filter((c) => c.action === "invalid").length, pending };
  },
  async performAction(_ctx, pending) {
    return { detail: `Change set (${pending.payload.count} changes) approved and stored in BridgeBox. No CRM write was performed: skills do not write to HubSpot/Salesforce yet — export the change set or apply it in your CRM.`, outputPatch: { applied: { status: "approved_not_written", externalSystem: null, approvedAt: new Date().toISOString() } } };
  },
};

// ============================================================================================ generate_marketing
const Channel = z.enum(["email", "linkedin", "x", "google_ad", "landing"]);
const MarketingInput = z.object({ sampleKey: SampleKey, product: z.string().trim().min(2).max(160), audience: z.string().trim().min(2).max(300), channel: Channel, goal: z.string().max(300).optional(), keyPoints: z.array(z.string().trim().min(2).max(300)).max(8).default([]), tone: z.enum(["professional", "friendly", "bold"]).default("professional"), cta: z.string().max(80).optional() });
type MarketingT = z.infer<typeof MarketingInput>;
const LIMITS: Record<z.infer<typeof Channel>, { headline?: number; body: number; note: string }> = {
  email: { headline: 60, body: 1200, note: "Subject ≤ 60 characters" }, linkedin: { body: 3000, note: "LinkedIn post ≤ 3,000 characters" }, x: { body: 280, note: "X post ≤ 280 characters" },
  google_ad: { headline: 30, body: 90, note: "Google Ads responsive search ad: headlines ≤ 30, descriptions ≤ 90 characters" }, landing: { headline: 70, body: 1500, note: "Hero headline ≤ 70 characters" },
};
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…");
export const generateMarketing: SkillImpl<MarketingT> = {
  key: "generate_marketing", name: "Generate marketing copy", category: "marketing", access: "draft", generative: true,
  description: "Writes three channel-ready copy variants within each channel's character limits, grounded in your approved product and brand knowledge, and flags claims (numbers, guarantees, superlatives) that approved knowledge does not support. Drafts only. Manual baseline 30 min is a BridgeBox assumption for three variants by a marketer.",
  outputDescription: "Three variants (headline/body/CTA) with character counts, limit checks and unsupported-claim flags.",
  manualBaselineMinutes: 30, reviewMinutes: 5, baselineBasis: "Assumption: three copy variants by a marketer (30 min).",
  inputSchema: MarketingInput as unknown as z.ZodType<MarketingT>,
  sampleInput: () => generateMarketing.samples()[0].input,
  samples: () => [{ key: "maintenance_launch", label: "Maintenance plan launch (LinkedIn)", description: "Synthetic sample — B2B marine audience.", input: { sampleKey: "maintenance_launch", product: "Annual maintenance plan", audience: "Charter and fleet operators on the Gulf Coast", channel: "linkedin", goal: "Book inspection calls", keyPoints: ["Quarterly valve inspections", "Written condition report after every visit", "Guaranteed 2-hour response"], tone: "professional", cta: "Book an inspection" } }],
  async execute(ctx, input) {
    const [facts, ps] = await Promise.all([ctx.facts(["product", "preference", "company", "pricing"]), ctx.passages(`${input.product} ${input.audience} brand voice`, 4)]);
    ctx.cite(...ps.map((p) => p.citation));
    const brand = facts.find((f) => f.category === "preference" && /brand|voice|tone|style/i.test(`${f.subject} ${f.statement}`)); if (brand) ctx.cite(brand.citation);
    const prod = facts.filter((f) => f.category === "product" && f.subject.toLowerCase().includes(input.product.toLowerCase().split(" ")[0])); for (const f of prod) ctx.cite(f.citation);
    const claims = await ctx.step("claims", "Check claims against approved knowledge", () => { const u = unsupportedClaims(input.keyPoints.join(". "), knowledgeTexts(ps, facts)); return { value: u, detail: u.length ? `${plural(u.length, "claim")} not supported by approved knowledge: ${u.join(", ")} — removed from the copy until approved.` : "All claims are supported (or no specific claims made)." }; });
    const safePoints = input.keyPoints.filter((k) => !claims.some((c) => k.toLowerCase().includes(c.toLowerCase())));
    const L = LIMITS[input.channel]; const cta = input.cta ?? "Learn more";
    const variants = await ctx.step("compose", "Write three variants", () => {
      const hooks = [`${input.product} for ${input.audience.toLowerCase()}`, `${input.goal ? input.goal.replace(/\.$/, "") : `Meet ${input.product}`}`, `What ${input.audience.split(/\s+/).slice(0, 3).join(" ")} get with ${input.product}`];
      const v = hooks.map((h, i) => {
        const pts = safePoints.length ? safePoints : prod.map((p) => p.statement).slice(0, 2);
        const body = input.channel === "x" || input.channel === "google_ad" ? `${pts.slice(i % Math.max(1, pts.length), (i % Math.max(1, pts.length)) + 2).join(". ") || input.product}. ${cta}.` : [i === 2 ? `${input.audience}:` : "", ...pts.map((p) => (input.channel === "linkedin" || input.channel === "landing" ? `• ${p}` : p)), "", `${cta} →`].filter(Boolean).join("\n");
        const headline = L.headline ? clip(h, L.headline) : undefined; const b = clip(body, L.body);
        return { headline, body: b, cta, chars: { headline: headline?.length ?? 0, body: b.length }, withinLimits: (!L.headline || (headline?.length ?? 0) <= L.headline) && b.length <= L.body };
      });
      return { value: v, detail: `3 variants written for ${input.channel.replace("_", " ")} (${L.note}); ${v.filter((x) => x.withinLimits).length}/3 within limits.` };
    });
    const polished = await ctx.polish(`${input.channel} marketing copy (keep three variants, keep within: ${L.note})`, variants.map((v, i) => `Variant ${i + 1}\n${v.headline ? `Headline: ${v.headline}\n` : ""}${v.body}`).join("\n\n"), ps);
    const draft = await draftOrSkip(ctx, "Store copy drafts", polished.text, "Copy variants");
    return { output: { variants: draft ? variants : [], draft, limits: L, unsupportedClaims: claims, brandGuidance: brand?.statement ?? null, mode: polished.mode },
      summary: `${draft ? "Wrote" : "Planned"} 3 ${input.channel.replace("_", " ")} variants for ${input.product}.${claims.length ? ` Held back ${plural(claims.length, "unsupported claim")} (${claims.join(", ")}) until approved in the AI Brain.` : ""}` };
  },
};
