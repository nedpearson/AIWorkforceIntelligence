/** Operations & executive skills: schedule_appointment, purchasing_recommendation, analyze_operations, weekly_report, summarize_meeting, review_document. */
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { computeOrgFinancials } from "@/engine/finance";
import { computeSavingsIntelligence } from "@/engine/savings";
import { SYNTHETIC_VENDORS, findVendor, termsDays } from "./invoice";
import { vendorsFromFacts } from "./knowledge";
import { money, plural, type SkillImpl } from "./runtime";

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const SampleKey = z.string().max(40).optional();

// ============================================================================================ schedule_appointment
const HHMM = z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM");
const LocalDT = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "Use local date-time YYYY-MM-DDTHH:MM (no time zone)");
const ScheduleInput = z.object({
  sampleKey: SampleKey, title: z.string().trim().min(2).max(160), durationMinutes: z.number().int().min(15).max(480), timezone: z.string().max(60).default("America/Chicago"),
  window: z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), workingHours: z.object({ start: HHMM, end: HHMM }).default({ start: "09:00", end: "17:00" }),
  workdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]), bufferMinutes: z.number().int().min(0).max(120).default(0),
  attendees: z.array(z.object({ name: z.string().trim().min(1).max(120), email: z.string().email().optional(), busy: z.array(z.object({ start: LocalDT, end: LocalDT })).max(500).default([]) })).min(1).max(20),
}).refine((v) => v.window.end >= v.window.start, { message: "window.end must be on or after window.start" }).refine((v) => (Date.parse(v.window.end) - Date.parse(v.window.start)) / 86_400_000 <= 31, { message: "Search window can be at most 31 days" });
type ScheduleT = z.infer<typeof ScheduleInput>;
const wall = (s: string) => Date.parse(s.slice(0, 16) + ":00Z"); // wall-clock minutes in the stated time zone
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
export function findSlots(v: ScheduleT, max = 3) {
  const [hs, ms] = v.workingHours.start.split(":").map(Number), [he, me] = v.workingHours.end.split(":").map(Number);
  const busy = v.attendees.flatMap((a) => a.busy.map((b) => ({ who: a.name, s: wall(b.start) - v.bufferMinutes * 60000, e: wall(b.end) + v.bufferMinutes * 60000 })));
  const out: { start: string; end: string }[] = []; let examined = 0;
  for (let d = Date.parse(v.window.start + "T00:00:00Z"); d <= Date.parse(v.window.end + "T00:00:00Z") && out.length < max; d += 86_400_000) {
    if (!v.workdays.includes(new Date(d).getUTCDay())) continue;
    for (let t = d + (hs * 60 + ms) * 60000; t + v.durationMinutes * 60000 <= d + (he * 60 + me) * 60000 && out.length < max; t += 15 * 60000) {
      examined++; const e = t + v.durationMinutes * 60000;
      if (busy.some((b) => b.s < e && b.e > t)) continue;
      out.push({ start: fmt(t), end: fmt(e) }); t += v.durationMinutes * 60000 - 15 * 60000; // next slot after this one
    }
  }
  return { slots: out, examined };
}
export const scheduleAppointment: SkillImpl<ScheduleT> = {
  key: "schedule_appointment", name: "Schedule appointment", category: "operations", access: "draft",
  description: "Finds the earliest times that work for every attendee within working hours (with optional buffers), and drafts a confirmation. Works from availability you provide; calendar connectors are not used by skills yet, so nothing is booked automatically. Manual baseline 15 min is a BridgeBox assumption for coordinating 3+ people by email.",
  outputDescription: "Up to three candidate slots, conflicts considered and a confirmation draft.",
  manualBaselineMinutes: 15, reviewMinutes: 1, baselineBasis: "Assumption: coordinating a meeting for 3+ people (15 min).",
  requiresProviders: ["google_workspace", "microsoft_365"],
  inputSchema: ScheduleInput as unknown as z.ZodType<ScheduleT>,
  sampleInput: () => scheduleAppointment.samples()[0].input,
  samples: () => [{ key: "site_visit", label: "Site inspection with 3 people", description: "Synthetic sample — three calendars.", input: { sampleKey: "site_visit", title: "Valve inspection — Pelican Charters (Synthetic)", durationMinutes: 60, timezone: "America/Chicago", window: { start: "2026-11-09", end: "2026-11-11" }, workingHours: { start: "08:00", end: "17:00" }, workdays: [1, 2, 3, 4, 5], bufferMinutes: 15,
    attendees: [{ name: "Jordan (Technician)", busy: [{ start: "2026-11-09T08:00", end: "2026-11-09T12:00" }, { start: "2026-11-10T13:00", end: "2026-11-10T17:00" }] }, { name: "Dana (Customer)", busy: [{ start: "2026-11-09T13:00", end: "2026-11-09T15:30" }, { start: "2026-11-10T09:00", end: "2026-11-10T10:00" }] }, { name: "Alex (Service manager)", busy: [{ start: "2026-11-10T10:30", end: "2026-11-10T11:30" }] }] } }],
  async execute(ctx, input) {
    const r = await ctx.step("find_slots", "Find times that work for everyone", () => { const x = findSlots(input); return { value: x, detail: x.slots.length ? `${plural(x.slots.length, "slot")} found after checking ${x.examined} 15-minute starts: ${x.slots.map((s) => s.start).join(", ")} (${input.timezone}).` : `No common ${input.durationMinutes}-minute slot in the window — widen it or shorten the meeting.`, data: { slots: x.slots } }; });
    const ps = await ctx.passages(`scheduling appointment ${input.title}`, 2); ctx.cite(...ps.map((p) => p.citation));
    if (!ctx.synthetic) ctx.skip("calendar", "Check connected calendars", "Calendar connectors are not used by skills yet — only the availability you provided was considered.");
    const best = r.slots[0];
    const text = best ? `Subject: ${input.title}\n\nHi all,\n\nI'd like to propose ${best.start.replace(" ", " at ")} (${input.timezone}) for ${input.durationMinutes} minutes.${r.slots.length > 1 ? ` If that doesn't work, alternatives: ${r.slots.slice(1).map((s) => s.start.replace(" ", " at ")).join("; ")}.` : ""}\n\nPlease reply to confirm.\n` : null;
    let draft: string | null = null;
    if (text && ctx.canDraft()) draft = await ctx.step("draft", "Draft confirmation", () => ({ value: text, detail: "Confirmation draft stored in BridgeBox — nothing was booked or sent." }));
    else if (text) ctx.skip("draft", "Draft confirmation", "Not stored: read-only AI employee.");
    return { output: { slots: r.slots, timezone: input.timezone, draft, booked: false }, summary: best ? `Best time for “${input.title}”: ${best.start} (${input.timezone}), ${input.durationMinutes} min, free for all ${plural(input.attendees.length, "attendee")}.${r.slots.length > 1 ? ` ${r.slots.length - 1} alternative(s) included.` : ""} Nothing was booked.` : `No time works for all ${plural(input.attendees.length, "attendee")} in that window.` };
  },
};

// ============================================================================================ purchasing_recommendation
const PurchItem = z.object({ sku: z.string().trim().min(1).max(60), description: z.string().max(200).default(""), onHand: z.number().min(0), onOrder: z.number().min(0).default(0), avgDailyUsage: z.number().min(0), leadTimeDays: z.number().min(0).max(365), safetyStockDays: z.number().min(0).max(180).default(7), targetDaysOfCover: z.number().min(1).max(365).default(30), moq: z.number().min(0).default(0), unitCost: z.number().min(0).optional(), vendor: z.string().max(160).optional() });
const PurchInput = z.object({ sampleKey: SampleKey, items: z.array(PurchItem).min(1, "Add at least one item").max(500) });
type PurchT = z.infer<typeof PurchInput>;
export function reorderPlan(items: PurchT["items"]) {
  return items.map((i) => {
    const reorderPoint = r2(i.avgDailyUsage * (i.leadTimeDays + i.safetyStockDays));
    const position = i.onHand + i.onOrder;
    const daysOfCover = i.avgDailyUsage ? r2(i.onHand / i.avgDailyUsage) : Infinity;
    const need = position <= reorderPoint;
    const target = i.avgDailyUsage * (i.leadTimeDays + i.targetDaysOfCover);
    const qty = need ? Math.ceil(Math.max(i.moq, target - position)) : 0;
    const urgency = !need ? "ok" : daysOfCover < i.leadTimeDays ? "stockout_risk" : "reorder";
    return { ...i, reorderPoint, inventoryPosition: position, daysOfCover: Number.isFinite(daysOfCover) ? daysOfCover : null, recommendQty: qty, estCost: i.unitCost != null ? r2(qty * i.unitCost) : null, urgency };
  });
}
export const purchasingRecommendation: SkillImpl<PurchT> = {
  key: "purchasing_recommendation", name: "Purchasing recommendation", category: "operations", access: "draft",
  description: "Calculates reorder points (daily usage × (lead time + safety stock)), flags stock-out risk, recommends order quantities to reach target days of cover (respecting minimum order quantities), checks vendors against your approved vendor list and drafts purchase orders by vendor. Manual baseline 25 min is a BridgeBox assumption for a weekly reorder review of ~20 SKUs.",
  outputDescription: "Per-SKU reorder point, position, days of cover, recommended qty and cost; vendor checks; draft POs.",
  manualBaselineMinutes: 25, reviewMinutes: 4, baselineBasis: "Assumption: weekly reorder review of ~20 SKUs (25 min).",
  inputSchema: PurchInput as unknown as z.ZodType<PurchT>,
  sampleInput: () => purchasingRecommendation.samples()[0].input,
  samples: () => [{ key: "weekly", label: "Weekly reorder review", description: "Synthetic sample — 4 SKUs.", input: { sampleKey: "weekly", items: [
    { sku: "BGV-2", description: "Brass gate valve 2in", onHand: 40, onOrder: 0, avgDailyUsage: 6, leadTimeDays: 10, safetyStockDays: 5, targetDaysOfCover: 30, moq: 50, unitCost: 38.5, vendor: "Northwind Industrial Supply LLC" },
    { sku: "SPF-K", description: "Stainless pipe fitting kit", onHand: 220, onOrder: 0, avgDailyUsage: 4, leadTimeDays: 7, safetyStockDays: 7, targetDaysOfCover: 30, moq: 0, unitCost: 35, vendor: "Northwind Industrial Supply LLC" },
    { sku: "GSK-4", description: "Neoprene gasket 4in", onHand: 18, onOrder: 20, avgDailyUsage: 3, leadTimeDays: 14, safetyStockDays: 5, targetDaysOfCover: 21, moq: 25, unitCost: 4.2, vendor: "Coastal Seals Trading" },
    { sku: "FLT-9", description: "Fuel filter element", onHand: 9, onOrder: 0, avgDailyUsage: 2, leadTimeDays: 12, safetyStockDays: 3, targetDaysOfCover: 30, moq: 10, unitCost: 17.75 }] } }],
  async execute(ctx, input) {
    const facts = await ctx.facts(["vendor", "policy", "procedure"]);
    const { approved, blocked } = vendorsFromFacts(facts);
    const vendors = ctx.synthetic ? [...SYNTHETIC_VENDORS, ...approved] : approved;
    const plan = await ctx.step("calculate", "Calculate reorder points and quantities", () => { const p = reorderPlan(input.items); const n = p.filter((x) => x.recommendQty > 0).length; return { value: p, detail: `${plural(n, "SKU")} to reorder (${p.filter((x) => x.urgency === "stockout_risk").length} at stock-out risk) out of ${p.length}.`, data: { plan: p.map((x) => ({ sku: x.sku, reorderPoint: x.reorderPoint, position: x.inventoryPosition, daysOfCover: x.daysOfCover, qty: x.recommendQty, urgency: x.urgency })) } }; });
    const vchk = await ctx.step("vendors", "Check vendors", () => {
      const res = plan.filter((p) => p.recommendQty > 0).map((p) => {
        if (!p.vendor) return { sku: p.sku, vendor: null, status: "missing" as const, note: "No vendor — a buyer must choose an approved vendor." };
        const bl = blocked.find((b) => findVendor(p.vendor!, [b])); if (bl) { if (bl.citationId) ctx.cite(facts.find((f) => f.id === bl.citationId)?.citation); return { sku: p.sku, vendor: p.vendor, status: "blocked" as const, note: `${p.vendor} is not approved (${bl.source}).` }; }
        if (!vendors.length) return { sku: p.sku, vendor: p.vendor, status: "unverified" as const, note: "No approved vendor list in the AI Brain." };
        const m = findVendor(p.vendor, vendors); if (m?.vendor.citationId) ctx.cite(facts.find((f) => f.id === m.vendor.citationId)?.citation);
        return m ? { sku: p.sku, vendor: m.vendor.name, status: "approved" as const, note: m.vendor.source } : { sku: p.sku, vendor: p.vendor, status: "not_on_list" as const, note: `${p.vendor} is not on the approved vendor list.` };
      });
      return { value: res, detail: `${res.filter((r) => r.status === "approved").length}/${res.length} reorder lines use an approved vendor${vendors.length ? "" : " (no approved vendor list in the AI Brain)"}.` };
    });
    const policy = facts.find((f) => /purchase|purchasing|procure/i.test(`${f.subject} ${f.statement}`) && /approv/i.test(f.statement)); if (policy) ctx.cite(policy.citation);
    const byVendor = new Map<string, typeof plan>();
    for (const p of plan.filter((x) => x.recommendQty > 0)) { const v = vchk.find((c) => c.sku === p.sku); const key = v?.status === "approved" ? v.vendor! : "Needs vendor review"; byVendor.set(key, [...(byVendor.get(key) ?? []), p]); }
    const pos = [...byVendor].map(([vendor, lines]) => ({ vendor, lines: lines.map((l) => ({ sku: l.sku, description: l.description, qty: l.recommendQty, unitCost: l.unitCost ?? null, amount: l.estCost })), total: r2(lines.reduce((s, l) => s + (l.estCost ?? 0), 0)) }));
    let drafts: typeof pos | null = null;
    if (ctx.canDraft()) drafts = await ctx.step("draft_pos", "Draft purchase orders", () => ({ value: pos, detail: `${plural(pos.length, "draft PO")} stored in BridgeBox (${money(pos.reduce((s, p) => s + p.total, 0))} estimated). Nothing was sent to a vendor.${policy ? ` Purchasing policy applies: ${policy.statement}` : ""}` }));
    else ctx.skip("draft_pos", "Draft purchase orders", "Not stored: read-only AI employee.");
    const n = plan.filter((x) => x.recommendQty > 0);
    return { output: { plan, vendorChecks: vchk, draftPurchaseOrders: drafts, policy: policy?.statement ?? null }, summary: n.length ? `Reorder ${plural(n.length, "SKU")} (${n.filter((x) => x.urgency === "stockout_risk").map((x) => x.sku).join(", ") || "none"} at stock-out risk), estimated ${money(pos.reduce((s, p) => s + p.total, 0))}.${vchk.some((v) => v.status !== "approved") ? ` ${vchk.filter((v) => v.status !== "approved").length} line(s) need a vendor decision.` : ""}` : "Nothing needs reordering — all SKUs are above their reorder points." };
  },
};

// ============================================================================================ analyze_operations
const OpsInput = z.object({ sampleKey: SampleKey, departmentId: z.string().uuid().optional(), top: z.number().int().min(1).max(20).default(5) });
type OpsT = z.infer<typeof OpsInput>;
type WfRow = { id: string; name: string; hoursPerWeek: number; repetitionScore: number; automationScore: number; reworkRate: number; handoffCount: number; employeeCount: number; requiresJudgment: boolean };
const SYNTHETIC_WFS: WfRow[] = [
  { id: "syn-1", name: "Invoice entry (Outlook → Excel → QuickBooks)", hoursPerWeek: 22, repetitionScore: 91, automationScore: 84, reworkRate: 0.08, handoffCount: 3, employeeCount: 3, requiresJudgment: false },
  { id: "syn-2", name: "Order status replies (Zendesk → ERP)", hoursPerWeek: 18, repetitionScore: 88, automationScore: 76, reworkRate: 0.04, handoffCount: 2, employeeCount: 4, requiresJudgment: false },
  { id: "syn-3", name: "Weekly sales report (CRM → Excel → PowerPoint)", hoursPerWeek: 6, repetitionScore: 95, automationScore: 90, reworkRate: 0.02, handoffCount: 1, employeeCount: 1, requiresJudgment: false },
  { id: "syn-4", name: "Vendor dispute resolution", hoursPerWeek: 9, repetitionScore: 35, automationScore: 22, reworkRate: 0.15, handoffCount: 5, employeeCount: 2, requiresJudgment: true },
];
export function rankBottlenecks(wfs: WfRow[]) {
  return wfs.map((w) => ({ ...w, impact: r2(w.hoursPerWeek * (w.repetitionScore / 100) * (1 + w.reworkRate) * (1 + Math.min(w.handoffCount, 6) * 0.05)), why: [w.hoursPerWeek >= 10 ? `${w.hoursPerWeek} h/week` : "", w.repetitionScore >= 70 ? `${Math.round(w.repetitionScore)}% repetitive` : "", w.reworkRate >= 0.05 ? `${Math.round(w.reworkRate * 100)}% rework` : "", w.handoffCount >= 3 ? `${w.handoffCount} handoffs` : "", w.requiresJudgment ? "needs human judgment" : ""].filter(Boolean) })).sort((a, b) => b.impact - a.impact);
}
export const analyzeOperations: SkillImpl<OpsT> = {
  key: "analyze_operations", name: "Analyze operations", category: "executive", access: "read",
  description: "Ranks operational bottlenecks from BridgeBox's observed workflows (hours, repetition, rework, handoffs), links each to its automation opportunity and the finance engine's realizable savings, and explains where to start. Live mode uses your real process-mining data; sandbox uses a synthetic workflow set. Manual baseline 90 min is a BridgeBox assumption for an analyst's ops review.",
  outputDescription: "Ranked bottlenecks with reasons, linked opportunities, recoverable hours and realizable savings (projected).",
  manualBaselineMinutes: 90, reviewMinutes: 10, baselineBasis: "Assumption: analyst operations review (90 min).",
  inputSchema: OpsInput as unknown as z.ZodType<OpsT>,
  sampleInput: () => ({ sampleKey: "synthetic_ops", top: 5 }),
  samples: () => [{ key: "synthetic_ops", label: "Distributor operations", description: "Synthetic sample — four workflows.", input: { sampleKey: "synthetic_ops", top: 5 } }],
  async execute(ctx, input) {
    const data = await ctx.step("load", "Load observed workflows", async () => {
      if (ctx.synthetic) return { value: { wfs: SYNTHETIC_WFS, opps: [] as { id: string; title: string; workflowId: string | null; status: string; realizableAnnualSavings: number }[] }, detail: `${SYNTHETIC_WFS.length} synthetic workflows loaded (Synthetic sample).` };
      const r = await withTenant(ctx.orgId, async (tx) => {
        const w = await tx.select().from(schema.workflows).where(and(eq(schema.workflows.orgId, ctx.orgId), input.departmentId ? eq(schema.workflows.departmentId, input.departmentId) : sql`true`)).orderBy(desc(schema.workflows.hoursPerWeek)).limit(200);
        const o = await tx.select({ id: schema.opportunities.id, title: schema.opportunities.title, workflowId: schema.opportunities.workflowId, status: schema.opportunities.status, realizableAnnualSavings: schema.opportunities.realizableAnnualSavings }).from(schema.opportunities).where(eq(schema.opportunities.orgId, ctx.orgId));
        return { w, o };
      });
      const wfs: WfRow[] = r.w.map((w) => ({ id: w.id, name: w.name, hoursPerWeek: num(w.hoursPerWeek), repetitionScore: num(w.repetitionScore), automationScore: num(w.automationScore), reworkRate: num(w.reworkRate), handoffCount: w.handoffCount ?? 0, employeeCount: w.employeeCount, requiresJudgment: w.requiresJudgment }));
      return { value: { wfs, opps: r.o.map((o) => ({ ...o, realizableAnnualSavings: num(o.realizableAnnualSavings) })) }, detail: wfs.length ? `${plural(wfs.length, "observed workflow")} and ${plural(r.o.length, "opportunity", )} loaded.` : "No observed workflows yet — run discovery (collectors + analysis) first." };
    });
    const ranked = await ctx.step("rank", "Rank bottlenecks", () => { const r = rankBottlenecks(data.wfs).slice(0, input.top); return { value: r, detail: r.length ? `Top: ${r.slice(0, 3).map((x) => `${x.name} (${x.why.join(", ")})`).join("; ")}.` : "Nothing to rank." }; });
    let fin: Awaited<ReturnType<typeof computeOrgFinancials>> | null = null;
    if (!ctx.synthetic && data.wfs.length) fin = await ctx.step("value", "Value with the finance engine", async () => { const f = await computeOrgFinancials(ctx.orgId); ctx.cite({ type: "savings", id: "org-financials", label: "BridgeBox financial model", href: "/app/finance" }); return { value: f, detail: `${r2(f.hoursRecoverablePerWeek)} recoverable h/week; realizable ${money(f.realizableAnnualSavings)}/yr (projected — not realized until verified).` }; });
    for (const w of ranked) if (!ctx.synthetic) ctx.cite({ type: "workflow", id: w.id, label: w.name, href: `/app/workflows/${w.id}` });
    const rows = ranked.map((w) => { const o = data.opps.find((x) => x.workflowId === w.id); if (o) ctx.cite({ type: "opportunity", id: o.id, label: o.title, href: `/app/opportunities/${o.id}` }); const line = fin?.opportunities.find((l) => l.id === o?.id); return { workflowId: w.id, name: w.name, impact: w.impact, why: w.why, hoursPerWeek: w.hoursPerWeek, opportunity: o ? { id: o.id, title: o.title, status: o.status, realizableAnnualSavings: line?.realizableAnnualSavings ?? o.realizableAnnualSavings } : null, recommendation: w.requiresJudgment ? "Assist, don't automate: keep a person in the loop and remove handoffs." : w.automationScore >= 70 ? "Strong automation candidate." : "Standardize the steps first, then automate." }; });
    const ps = await ctx.passages("operations goals priorities bottleneck", 3); ctx.cite(...ps.map((p) => p.citation));
    const top = rows[0];
    return { output: { bottlenecks: rows, totals: fin ? { hoursRecoverablePerWeek: fin.hoursRecoverablePerWeek, realizableAnnualSavings: fin.realizableAnnualSavings, verifiedAnnualizedSavings: fin.verifiedAnnualizedSavings } : null, goals: ps.map((p) => p.citation.label) },
      summary: top ? `Biggest bottleneck: ${top.name} — ${top.why.join(", ")}. ${top.recommendation}${fin ? ` Across the organization, ${r2(fin.hoursRecoverablePerWeek)} hours/week are recoverable (projected ${money(fin.realizableAnnualSavings)}/yr; time saved is capacity, not a payroll cut).` : ""}${ctx.synthetic ? " Synthetic sample." : ""}` : "No observed workflows to analyze yet — start discovery first.", humanReviewMinutes: 10 };
  },
};

// ============================================================================================ weekly_report
const WeeklyInput = z.object({ sampleKey: SampleKey, weekEnding: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
type WeeklyT = z.infer<typeof WeeklyInput>;
export const weeklyReport: SkillImpl<WeeklyT> = {
  key: "weekly_report", name: "Weekly report", category: "executive", access: "read",
  description: "Writes the weekly operating report from real BridgeBox data: agent and AI-employee runs (succeeded/failed/minutes saved), approvals waiting, opportunity pipeline, and the savings tiers (potential vs verified vs realized) from the savings engine. Sandbox uses a synthetic week. Manual baseline 60 min is a BridgeBox assumption for compiling a weekly ops report from several systems.",
  outputDescription: "Report markdown with sections and the underlying numbers.",
  manualBaselineMinutes: 60, reviewMinutes: 5, baselineBasis: "Assumption: compiling a weekly report from several systems (60 min).",
  inputSchema: WeeklyInput as unknown as z.ZodType<WeeklyT>,
  sampleInput: () => ({ sampleKey: "synthetic_week" }),
  samples: () => [{ key: "synthetic_week", label: "Synthetic week", description: "Synthetic sample — illustrative activity, not your data.", input: { sampleKey: "synthetic_week" } }],
  async execute(ctx, input) {
    const end = input.weekEnding ? new Date(input.weekEnding + "T23:59:59Z") : new Date(); const start = new Date(+end - 7 * 86_400_000);
    type W = { agentRuns: number; succeeded: number; failed: number; minutesSaved: number; skillRuns: number; awaiting: number; pendingApprovals: number; oppsByStatus: Record<string, number>; potential: number; verified: number; realized: number };
    const w: W = await ctx.step("collect", "Collect this week's activity", async () => {
      if (ctx.synthetic) return { value: { agentRuns: 46, succeeded: 43, failed: 3, minutesSaved: 512, skillRuns: 18, awaiting: 2, pendingApprovals: 4, oppsByStatus: { identified: 7, approved: 3, in_progress: 2, deployed: 1 }, potential: 184_000, verified: 21_400, realized: 0 }, detail: "Synthetic sample week loaded (not your data)." };
      const r = await withTenant(ctx.orgId, async (tx) => {
        const ar = await tx.select({ status: schema.agentRuns.status, minutesSaved: schema.agentRuns.minutesSaved, trigger: schema.agentRuns.trigger }).from(schema.agentRuns).where(and(eq(schema.agentRuns.orgId, ctx.orgId), gte(schema.agentRuns.createdAt, start), sql`${schema.agentRuns.createdAt} <= ${end.toISOString()}::timestamptz`, sql`${schema.agentRuns.trigger} <> 'test'`));
        const sr = await tx.select({ status: schema.skillRuns.status }).from(schema.skillRuns).where(and(eq(schema.skillRuns.orgId, ctx.orgId), eq(schema.skillRuns.mode, "live"), gte(schema.skillRuns.createdAt, start)));
        const ap = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.approvals).where(and(eq(schema.approvals.orgId, ctx.orgId), eq(schema.approvals.status, "pending")));
        const op = await tx.select({ status: schema.opportunities.status, n: sql<number>`count(*)::int` }).from(schema.opportunities).where(eq(schema.opportunities.orgId, ctx.orgId)).groupBy(schema.opportunities.status);
        return { ar, sr, ap: ap[0]?.n ?? 0, op };
      });
      const s = await computeSavingsIntelligence(ctx.orgId);
      ctx.cite({ type: "savings", id: "savings-intelligence", label: "Savings Intelligence (tiers)", href: "/app/savings" });
      const v: W = { agentRuns: r.ar.length, succeeded: r.ar.filter((x) => x.status === "succeeded").length, failed: r.ar.filter((x) => x.status === "failed").length, minutesSaved: r2(r.ar.reduce((a, x) => a + num(x.minutesSaved), 0)), skillRuns: r.sr.length, awaiting: r.sr.filter((x) => x.status === "awaiting_approval").length, pendingApprovals: r.ap, oppsByStatus: Object.fromEntries(r.op.map((o) => [o.status, o.n])), potential: s.tiers.potential.amount, verified: s.tiers.verifiedTime.amount, realized: s.tiers.realizedHard.amount };
      return { value: v, detail: `${plural(v.agentRuns, "agent run")}, ${plural(v.skillRuns, "live skill run")} in ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}.` };
    });
    const ps = await ctx.passages("weekly goals priorities targets", 3); ctx.cite(...ps.map((p) => p.citation));
    const md = await ctx.step("write", "Write the report", () => {
      const t = [`# Weekly report — week ending ${end.toISOString().slice(0, 10)}${ctx.synthetic ? " (Synthetic sample)" : ""}`, "", "## Automation activity", `- Agent runs: ${w.agentRuns} (${w.succeeded} succeeded, ${w.failed} failed)`, `- Time saved by runs: ${r2(w.minutesSaved / 60)} hours (measured on the run ledger)`, `- Live AI-employee skill runs: ${w.skillRuns}${w.awaiting ? ` (${w.awaiting} waiting for approval)` : ""}`, `- Approvals waiting on a person: ${w.pendingApprovals}`, "",
        "## Opportunity pipeline", ...Object.entries(w.oppsByStatus).map(([k, n]) => `- ${k.replace(/_/g, " ")}: ${n}`), "", "## Savings (annualized)", `- Potential (projected): ${money(w.potential)}`, `- Verified time savings (measured): ${money(w.verified)}`, `- Realized hard savings (approved ledger): ${money(w.realized)}`, "", "_Time saved is capacity, not a payroll reduction. Only approved ledger entries count as hard savings._",
        ps.length ? `\n## Goals referenced\n${ps.map((p) => `- ${p.citation.label}`).join("\n")}` : ""].join("\n");
      return { value: t, detail: "Report written (5 sections)." };
    });
    return { output: { report: md, numbers: w, period: { start: start.toISOString(), end: end.toISOString() } }, summary: `This week: ${w.agentRuns} agent runs (${w.failed} failed), ${r2(w.minutesSaved / 60)} hours saved on the run ledger, ${w.pendingApprovals} approvals waiting. Verified savings ${money(w.verified)}/yr vs potential ${money(w.potential)}/yr.${ctx.synthetic ? " Synthetic sample." : ""}` };
  },
};

// ============================================================================================ summarize_meeting
const MeetingInput = z.object({ sampleKey: SampleKey, transcript: z.string().trim().min(40, "Paste the meeting notes or transcript (40+ characters)").max(200_000), meetingTitle: z.string().max(160).optional(), date: z.string().max(40).optional() });
type MeetingT = z.infer<typeof MeetingInput>;
const STOP = new Set("the a an and or but to of in on for with at by from is are was were be been it this that we you i they he she our your their as so if then than will would can could should just about into over also not do does did have has had there here what which who".split(" "));
export function analyzeTranscript(t: string) {
  const lines = t.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  const turns = lines.map((l) => { const m = l.match(/^(?:\[[\d:]+\]\s*)?([A-Z][\w .'-]{1,40}?):\s+(.+)$/); return m ? { speaker: m[1].trim(), text: m[2] } : { speaker: null, text: l }; });
  const speakers = [...new Set(turns.map((x) => x.speaker).filter(Boolean))] as string[];
  const sents = turns.flatMap((x) => x.text.split(/(?<=[.!?])\s+/).map((s) => ({ speaker: x.speaker, s: s.trim() }))).filter((x) => x.s.length > 3);
  const actions = sents.filter((x) => /\b(action item|todo|to-do|will|i'll|we'll|going to|need to|follow up|by (monday|tuesday|wednesday|thursday|friday|eod|end of)|assign|owner)\b/i.test(x.s) && !/\?$/.test(x.s)).map((x) => {
    const owner = x.s.match(/^(I|We|[A-Z][a-z]+)\s+(?:will|'ll|is going to|to)\b/)?.[1]; const due = x.s.match(/\bby\s+((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|end of (?:day|week|month)|\w+ \d{1,2}(?:st|nd|rd|th)?))/i)?.[1];
    return { text: x.s, owner: owner && !/^(I|We)$/.test(owner) ? owner : x.speaker ?? null, due: due ?? null };
  });
  const decisions = sents.filter((x) => /\b(decided|agreed|approved|we'll go with|decision|let's go with|final answer|signed off)\b/i.test(x.s)).map((x) => x.s);
  const questions = sents.filter((x) => /\?$/.test(x.s)).map((x) => x.s);
  const freq = new Map<string, number>(); for (const x of sents) for (const w of x.s.toLowerCase().match(/[a-z]{3,}/g) ?? []) if (!STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scored = sents.map((x, i) => ({ ...x, i, score: (x.s.toLowerCase().match(/[a-z]{3,}/g) ?? []).reduce((s, w) => s + (freq.get(w) ?? 0), 0) / Math.max(4, x.s.split(/\s+/).length) }));
  const key = scored.sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.i - b.i).map((x) => x.s);
  const topics = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  return { speakers, actions, decisions, questions, keyPoints: key, topics, sentences: sents.length };
}
export const summarizeMeeting: SkillImpl<MeetingT> = {
  key: "summarize_meeting", name: "Summarize meeting", category: "executive", access: "read", generative: true,
  description: "Turns meeting notes or a transcript into key points, decisions, action items (with owner and due date when stated) and open questions. Deterministic extraction (speaker turns, decision/action language, keyword-weighted key sentences); optionally polished by the model when configured. Manual baseline 20 min is a BridgeBox assumption for writing up a 45-minute meeting.",
  outputDescription: "Key points, decisions, action items with owners/dates, open questions, attendees, topics.",
  manualBaselineMinutes: 20, reviewMinutes: 3, baselineBasis: "Assumption: writing up a 45-minute meeting (20 min).",
  inputSchema: MeetingInput as unknown as z.ZodType<MeetingT>,
  sampleInput: () => summarizeMeeting.samples()[0].input,
  samples: () => [{ key: "ops_sync", label: "Ops sync transcript", description: "Synthetic sample — 4 participants.", input: { sampleKey: "ops_sync", meetingTitle: "Weekly ops sync (Synthetic)", date: "2026-11-05", transcript:
`Alex: Thanks everyone. First topic is the invoice backlog in accounts payable.
Jordan: We have 140 invoices waiting, mostly from Northwind and Bluebird Freight.
Priya: The AI employee pilot cleared 60 invoices last week with two exceptions.
Alex: We agreed to extend the AP pilot to Bluebird Freight invoices next week.
Jordan: I will send the vendor list to Priya by Friday.
Priya: I'll set up the approval threshold at $5,000 for controller review.
Sam: Do we need IT to approve the QuickBooks connection?
Alex: Good question. Sam will check with IT by Wednesday.
Alex: Decision: the pilot stays in draft-only mode until the controller signs off.` } }],
  async execute(ctx, input) {
    const a = await ctx.step("extract", "Extract decisions and action items", () => { const r = analyzeTranscript(input.transcript); return { value: r, detail: `${plural(r.speakers.length, "speaker")}, ${plural(r.decisions.length, "decision")}, ${plural(r.actions.length, "action item")}, ${plural(r.questions.length, "open question")}.`, data: { actions: r.actions, decisions: r.decisions } }; });
    const ps = await ctx.passages(a.topics.join(" "), 3); ctx.cite(...ps.map((p) => p.citation));
    const md = [`## ${input.meetingTitle ?? "Meeting summary"}${input.date ? ` — ${input.date}` : ""}`, a.speakers.length ? `Attendees: ${a.speakers.join(", ")}` : "", "", "### Key points", ...a.keyPoints.map((k) => `- ${k}`), "", "### Decisions", ...(a.decisions.length ? a.decisions.map((d) => `- ${d}`) : ["- None recorded"]), "", "### Action items", ...(a.actions.length ? a.actions.map((x) => `- [ ] ${x.text}${x.owner ? ` — **${x.owner}**` : ""}${x.due ? ` (due ${x.due})` : ""}`) : ["- None recorded"]), "", "### Open questions", ...(a.questions.length ? a.questions.map((q) => `- ${q}`) : ["- None"])].filter((x, i, arr) => x !== "" || arr[i - 1] !== "").join("\n");
    const polished = await ctx.polish("meeting summary (markdown; keep every decision and action item)", md, ps, input.transcript);
    await ctx.step("write", "Write summary", () => ({ value: null, detail: `Summary written${polished.mode === "llm" ? " and polished by the model" : " (deterministic extraction)"}.` }));
    return { output: { summary: polished.text, ...a, mode: polished.mode }, summary: `${plural(a.decisions.length, "decision")} and ${plural(a.actions.length, "action item")} captured${a.actions.filter((x) => x.owner).length ? ` (${a.actions.filter((x) => x.owner).length} with an owner)` : ""}; ${plural(a.questions.length, "open question")}.`, humanReviewMinutes: 3 };
  },
};

// ============================================================================================ review_document
const ReviewInput = z.object({ sampleKey: SampleKey, title: z.string().max(200).optional(), text: z.string().trim().min(60, "Paste the document text (60+ characters)").max(400_000), checklist: z.array(z.string().trim().min(2).max(120)).max(30).optional() });
type ReviewT = z.infer<typeof ReviewInput>;
const CONTRACT_CHECKS: { item: string; re: RegExp }[] = [
  { item: "Payment terms", re: /\b(payment terms|net \d+|payable within|due within)\b/i }, { item: "Term and termination", re: /\b(terminat|term of this agreement|expire)/i },
  { item: "Limitation of liability", re: /\blimitation of liability|liability (shall|will) not exceed|in no event shall\b/i }, { item: "Confidentiality", re: /\bconfidential/i },
  { item: "Governing law", re: /\bgoverning law|governed by the laws\b/i }, { item: "Signatures", re: /\b(signature|signed by|authorized signatory|in witness whereof)\b/i },
];
const RISKY: { label: string; re: RegExp; severity: "high" | "medium" }[] = [
  { label: "Unlimited liability", re: /unlimited liability|without limit(ation)?/i, severity: "high" }, { label: "Automatic renewal", re: /auto(matic(ally)?)?[- ]renew/i, severity: "medium" },
  { label: "Broad indemnity", re: /indemnify,? defend,? and hold harmless|indemnify .* any and all/i, severity: "medium" }, { label: "Exclusivity", re: /\bexclusive(ly)?\b/i, severity: "medium" },
  { label: "Unilateral price changes", re: /(may|reserves the right to) (change|increase|adjust) (the )?(prices?|fees|rates)/i, severity: "high" }, { label: "Late fees / interest", re: /late fee|interest (at|of) \d+(\.\d+)?%/i, severity: "medium" },
];
export function reviewText(text: string, checklist: { item: string; re: RegExp }[], approvedTermsDays: number | null) {
  const missing = checklist.filter((c) => !c.re.test(text)).map((c) => c.item);
  const present = checklist.filter((c) => c.re.test(text)).map((c) => c.item);
  const risks = RISKY.flatMap((r) => { const m = text.match(r.re); if (!m) return []; const at = m.index ?? 0; return [{ label: r.label, severity: r.severity, excerpt: text.slice(Math.max(0, at - 60), at + m[0].length + 60).replace(/\s+/g, " ").trim() }]; });
  const conflicts: string[] = [];
  const nt = text.match(/net\s*(\d{1,3})/i);
  if (approvedTermsDays != null && nt && Number(nt[1]) !== approvedTermsDays) conflicts.push(`Document says Net ${nt[1]}; your approved policy is Net ${approvedTermsDays}.`);
  const words = text.split(/\s+/).length; const sents = Math.max(1, text.split(/[.!?]+\s/).length);
  return { missing, present, risks, conflicts, words, avgSentenceWords: Math.round(words / sents) };
}
export const reviewDocument: SkillImpl<ReviewT> = {
  key: "review_document", name: "Review document", category: "operations", access: "read",
  description: "Reviews a contract, policy or other business document: checks a clause checklist (or yours), highlights risky language with excerpts, compares terms with your approved AI Brain policies (e.g. payment terms), and lists the approved knowledge that applies. It never gives legal advice — high-risk items are routed to a person. Manual baseline 30 min is a BridgeBox assumption for a first-pass review of a 5–10 page agreement.",
  outputDescription: "Checklist (present/missing), risky clauses with excerpts and severity, policy conflicts, related approved knowledge.",
  manualBaselineMinutes: 30, reviewMinutes: 8, baselineBasis: "Assumption: first-pass review of a 5–10 page agreement (30 min).",
  inputSchema: ReviewInput as unknown as z.ZodType<ReviewT>,
  sampleInput: () => reviewDocument.samples()[0].input,
  samples: () => [{ key: "supply_agreement", label: "Vendor supply agreement", description: "Synthetic sample — contains auto-renewal and Net 60.", input: { sampleKey: "supply_agreement", title: "Supply Agreement — Coastal Seals Trading (Synthetic)", text:
`SUPPLY AGREEMENT. This agreement is between Coastal Seals Trading ("Supplier") and the Customer. Term: one year, and it will automatically renew for successive one-year terms unless either party gives 60 days notice. Payment terms: Net 60 from invoice date. Supplier may change prices on 15 days written notice. Customer shall indemnify, defend, and hold harmless Supplier against any and all claims. Both parties will keep confidential information confidential. This agreement is governed by the laws of the State of Texas.` } }],
  async execute(ctx, input) {
    const facts = await ctx.facts(["policy", "vendor", "procedure"]);
    const termsFact = facts.find((f) => /payment terms|net \d+/i.test(f.statement) && termsDays(f.statement) != null);
    const checklist = input.checklist?.length ? input.checklist.map((c) => ({ item: c, re: new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split(/\s+/).join("\\W+\\w*\\W*"), "i") })) : CONTRACT_CHECKS;
    const r = await ctx.step("review", "Check clauses and risky language", () => { const x = reviewText(input.text, checklist, termsFact ? termsDays(termsFact.statement) : null); return { value: x, detail: `${x.present.length}/${checklist.length} checklist items present; ${plural(x.risks.length, "risk flag")} (${x.risks.filter((y) => y.severity === "high").length} high); ${plural(x.conflicts.length, "policy conflict")}.`, data: { missing: x.missing, risks: x.risks } }; });
    if (termsFact && r.conflicts.length) ctx.cite(termsFact.citation);
    const ps = await ctx.passages(`${input.title ?? ""} ${input.text.slice(0, 400)}`, 4); ctx.cite(...ps.map((p) => p.citation));
    await ctx.step("compare", "Compare with approved policies", () => ({ value: null, detail: ps.length ? `${plural(ps.length, "approved source")} relate to this document: ${ps.map((p) => p.citation.label).join("; ")}.` : "No related approved knowledge found in the AI Brain." }));
    const high = r.risks.filter((x) => x.severity === "high");
    return { output: { ...r, related: ps.map((p) => ({ label: p.citation.label, excerpt: p.text.slice(0, 240) })), routeToHuman: high.length > 0 || r.conflicts.length > 0, note: "Automated first-pass review — not legal advice." },
      summary: `${input.title ?? "Document"}: ${r.missing.length ? `missing ${r.missing.join(", ")}; ` : "all checklist items present; "}${r.risks.length ? `${plural(r.risks.length, "risk flag")} (${r.risks.map((x) => x.label.toLowerCase()).join(", ")})` : "no risky language found"}${r.conflicts.length ? `; ${r.conflicts.join(" ")}` : ""}.${high.length || r.conflicts.length ? " Route to a person for review." : ""}`, humanReviewMinutes: 8 };
  },
};
