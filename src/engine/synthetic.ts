/**
 * Synthetic workplace activity generator — DEMO / TEST DATA ONLY.
 * Produces metadata-only activity events shaped like what the desktop collector sends.
 * Deterministic for a given seed so unit tests and e2e are reproducible.
 * Every org seeded from here has `is_demo = true` and the UI labels it "Synthetic demo data".
 */
export type SynthEvent = {
  employeeKey: string; ts: Date; type: "app_focus" | "app_switch" | "idle_start" | "idle_end" | "click_burst" | "navigation" | "data_entry" | "copy_paste" | "document_open" | "document_save" | "form_submit" | "email_compose" | "handoff" | "print";
  app: string; appCategory: string; titleCategory: string; titleHash: string; durationMs: number; meta: Record<string, number | string | boolean>;
};
export type SynthEmployee = { key: string; name: string; title: string; department: string; baseAnnualCost: number; patterns: PatternAssignment[]; managerKey?: string };
export type PatternAssignment = { pattern: string; runsPerDay: number; variance: number };

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, "0"); };

/** Step templates. Each step: [app, category, titleCategory, eventType, baseMs, extra meta] */
type Step = [string, string, string, SynthEvent["type"], number, Record<string, number | string | boolean>?];
export const WORKFLOW_PATTERNS: Record<string, { label: string; steps: Step[]; rework: number; handoff: boolean; judgment?: boolean; regulatory?: string }> = {
  ap_invoice: {
    label: "Vendor invoice processing", rework: 0.12, handoff: true,
    steps: [
      ["Outlook", "email", "invoice", "document_open", 45000, { attachments: 1 }],
      ["Adobe Acrobat", "document", "invoice", "document_open", 60000],
      ["QuickBooks", "accounting", "bill entry", "data_entry", 240000, { fieldCount: 14, keysCount: 220 }],
      ["Excel", "spreadsheet", "invoice log", "data_entry", 90000, { fieldCount: 6, pasteCount: 3 }],
      ["Outlook", "email", "approval request", "email_compose", 70000],
      ["Outlook", "email", "approval request", "handoff", 1000, { to: "manager" }],
    ],
  },
  order_entry: {
    label: "Customer order entry", rework: 0.08, handoff: false,
    steps: [
      ["Outlook", "email", "purchase order", "document_open", 40000],
      ["Chrome", "browser", "customer portal", "navigation", 50000, { clicks: 18 }],
      ["NetSuite", "erp", "sales order", "data_entry", 300000, { fieldCount: 22, keysCount: 400, pasteCount: 6 }],
      ["Excel", "spreadsheet", "pricing sheet", "copy_paste", 60000, { pasteCount: 4 }],
      ["NetSuite", "erp", "sales order", "form_submit", 15000],
      ["Outlook", "email", "order confirmation", "email_compose", 80000],
    ],
  },
  support_ticket: {
    label: "Support ticket triage & reply", rework: 0.15, handoff: true,
    steps: [
      ["Zendesk", "helpdesk", "ticket", "document_open", 30000],
      ["Chrome", "browser", "knowledge base", "navigation", 90000, { clicks: 25 }],
      ["NetSuite", "erp", "customer record", "navigation", 70000, { clicks: 12 }],
      ["Zendesk", "helpdesk", "ticket reply", "data_entry", 180000, { keysCount: 500 }],
      ["Zendesk", "helpdesk", "ticket", "form_submit", 8000],
    ],
  },
  weekly_report: {
    label: "Weekly sales report compilation", rework: 0.2, handoff: true,
    steps: [
      ["NetSuite", "erp", "report export", "navigation", 120000, { clicks: 30 }],
      ["Excel", "spreadsheet", "raw export", "document_open", 30000],
      ["Excel", "spreadsheet", "weekly report", "copy_paste", 400000, { pasteCount: 22, fieldCount: 60 }],
      ["Excel", "spreadsheet", "weekly report", "document_save", 5000],
      ["PowerPoint", "presentation", "weekly deck", "data_entry", 600000, { pasteCount: 10 }],
      ["Outlook", "email", "weekly report", "email_compose", 90000, { attachments: 2 }],
    ],
  },
  appointment_scheduling: {
    label: "Appointment scheduling", rework: 0.1, handoff: false,
    steps: [
      ["Outlook", "email", "scheduling request", "document_open", 30000],
      ["Outlook", "calendar", "availability", "navigation", 60000, { clicks: 14 }],
      ["Outlook", "email", "scheduling reply", "email_compose", 90000],
      ["Chrome", "browser", "crm contact", "data_entry", 60000, { fieldCount: 5 }],
    ],
  },
  employee_onboarding: {
    label: "New-hire onboarding paperwork", rework: 0.18, handoff: true, regulatory: "PII",
    steps: [
      ["Chrome", "browser", "hr system", "navigation", 90000, { clicks: 20 }],
      ["Adobe Acrobat", "document", "onboarding form", "document_open", 40000],
      ["Chrome", "browser", "hr system", "data_entry", 420000, { fieldCount: 35, keysCount: 600 }],
      ["Outlook", "email", "it access request", "email_compose", 70000],
      ["Excel", "spreadsheet", "onboarding tracker", "data_entry", 60000, { fieldCount: 8 }],
      ["Outlook", "email", "it access request", "handoff", 1000, { to: "it" }],
    ],
  },
  bank_reconciliation: {
    label: "Bank reconciliation", rework: 0.1, handoff: false, judgment: true, regulatory: "SOX",
    steps: [
      ["Chrome", "browser", "bank portal", "navigation", 120000, { clicks: 15 }],
      ["Excel", "spreadsheet", "bank export", "document_open", 30000],
      ["QuickBooks", "accounting", "reconcile", "navigation", 300000, { clicks: 80 }],
      ["Excel", "spreadsheet", "recon workpaper", "data_entry", 240000, { fieldCount: 20, pasteCount: 8 }],
      ["QuickBooks", "accounting", "reconcile", "form_submit", 10000],
    ],
  },
  inventory_count: {
    label: "Inventory count reconciliation", rework: 0.14, handoff: true,
    steps: [
      ["Excel", "spreadsheet", "count sheet", "document_open", 30000],
      ["NetSuite", "erp", "inventory adjustment", "data_entry", 360000, { fieldCount: 40, keysCount: 350 }],
      ["Excel", "spreadsheet", "variance report", "copy_paste", 120000, { pasteCount: 9 }],
      ["Outlook", "email", "variance report", "email_compose", 60000],
      ["Outlook", "email", "variance report", "handoff", 1000, { to: "finance" }],
    ],
  },
  marketing_campaign_ops: {
    label: "Campaign performance update", rework: 0.1, handoff: false,
    steps: [
      ["Chrome", "browser", "ads dashboard", "navigation", 150000, { clicks: 35 }],
      ["Chrome", "browser", "social analytics", "navigation", 120000, { clicks: 25 }],
      ["Excel", "spreadsheet", "campaign tracker", "copy_paste", 300000, { pasteCount: 18 }],
      ["Slack", "chat", "marketing channel", "email_compose", 30000],
    ],
  },
  contract_review: {
    label: "Contract review", rework: 0.05, handoff: true, judgment: true, regulatory: "Legal",
    steps: [
      ["Outlook", "email", "contract", "document_open", 40000],
      ["Word", "document", "contract", "document_open", 1500000],
      ["Word", "document", "contract", "document_save", 5000],
      ["Outlook", "email", "contract comments", "email_compose", 180000],
    ],
  },
};

export const DEMO_ORG = {
  name: "Gulf Coast Supply Co. (Synthetic Demo)", slug: "gulf-coast-supply-demo", industry: "Industrial distribution",
  departments: ["Finance", "Operations", "Customer Service", "Sales", "HR", "Marketing"],
  employees: [
    { key: "e1", name: "Dana Whitfield", title: "AP Specialist", department: "Finance", baseAnnualCost: 52000, patterns: [{ pattern: "ap_invoice", runsPerDay: 9, variance: 3 }, { pattern: "bank_reconciliation", runsPerDay: 0.2, variance: 0.1 }] },
    { key: "e2", name: "Marcus Lee", title: "Staff Accountant", department: "Finance", baseAnnualCost: 61000, patterns: [{ pattern: "ap_invoice", runsPerDay: 4, variance: 2 }, { pattern: "bank_reconciliation", runsPerDay: 0.5, variance: 0.2 }, { pattern: "weekly_report", runsPerDay: 0.2, variance: 0.1 }] },
    { key: "e3", name: "Priya Natarajan", title: "Controller", department: "Finance", baseAnnualCost: 98000, patterns: [{ pattern: "bank_reconciliation", runsPerDay: 0.3, variance: 0.1 }, { pattern: "contract_review", runsPerDay: 0.3, variance: 0.2 }], managerOf: ["e1", "e2"] },
    { key: "e4", name: "Tom Boudreaux", title: "Order Entry Clerk", department: "Operations", baseAnnualCost: 44000, patterns: [{ pattern: "order_entry", runsPerDay: 14, variance: 4 }] },
    { key: "e5", name: "Keisha Robinson", title: "Order Entry Clerk", department: "Operations", baseAnnualCost: 44000, patterns: [{ pattern: "order_entry", runsPerDay: 12, variance: 4 }, { pattern: "inventory_count", runsPerDay: 0.4, variance: 0.2 }] },
    { key: "e6", name: "Luis Herrera", title: "Warehouse Lead", department: "Operations", baseAnnualCost: 55000, patterns: [{ pattern: "inventory_count", runsPerDay: 1, variance: 0.5 }, { pattern: "weekly_report", runsPerDay: 0.2, variance: 0.1 }], managerOf: ["e4", "e5"] },
    { key: "e7", name: "Amber Collins", title: "Support Rep", department: "Customer Service", baseAnnualCost: 42000, patterns: [{ pattern: "support_ticket", runsPerDay: 22, variance: 6 }, { pattern: "appointment_scheduling", runsPerDay: 3, variance: 2 }] },
    { key: "e8", name: "Devin Park", title: "Support Rep", department: "Customer Service", baseAnnualCost: 42000, patterns: [{ pattern: "support_ticket", runsPerDay: 20, variance: 6 }, { pattern: "appointment_scheduling", runsPerDay: 4, variance: 2 }] },
    { key: "e9", name: "Renee Fontenot", title: "Sales Coordinator", department: "Sales", baseAnnualCost: 48000, patterns: [{ pattern: "order_entry", runsPerDay: 5, variance: 2 }, { pattern: "appointment_scheduling", runsPerDay: 6, variance: 2 }, { pattern: "weekly_report", runsPerDay: 0.2, variance: 0.1 }] },
    { key: "e10", name: "Greg Mouton", title: "Sales Manager", department: "Sales", baseAnnualCost: 92000, patterns: [{ pattern: "weekly_report", runsPerDay: 0.2, variance: 0.1 }, { pattern: "contract_review", runsPerDay: 0.4, variance: 0.2 }], managerOf: ["e9"] },
    { key: "e11", name: "Shauna Bell", title: "HR Generalist", department: "HR", baseAnnualCost: 58000, patterns: [{ pattern: "employee_onboarding", runsPerDay: 0.8, variance: 0.4 }, { pattern: "appointment_scheduling", runsPerDay: 2, variance: 1 }] },
    { key: "e12", name: "Carlos Jimenez", title: "Marketing Coordinator", department: "Marketing", baseAnnualCost: 50000, patterns: [{ pattern: "marketing_campaign_ops", runsPerDay: 1.5, variance: 0.5 }, { pattern: "weekly_report", runsPerDay: 0.2, variance: 0.1 }] },
    { key: "e13", name: "Monique Davis", title: "AP Specialist", department: "Finance", baseAnnualCost: 50000, patterns: [{ pattern: "ap_invoice", runsPerDay: 8, variance: 3 }] },
    { key: "e14", name: "Brandon Tate", title: "AR Specialist", department: "Finance", baseAnnualCost: 51000, patterns: [{ pattern: "ap_invoice", runsPerDay: 6, variance: 2 }, { pattern: "weekly_report", runsPerDay: 0.2, variance: 0.1 }] },
    { key: "e15", name: "Hailey Nguyen", title: "Order Entry Clerk", department: "Operations", baseAnnualCost: 43000, patterns: [{ pattern: "order_entry", runsPerDay: 13, variance: 4 }] },
    { key: "e16", name: "Jamal Wright", title: "Order Entry Clerk", department: "Operations", baseAnnualCost: 43000, patterns: [{ pattern: "order_entry", runsPerDay: 11, variance: 4 }, { pattern: "inventory_count", runsPerDay: 0.3, variance: 0.2 }] },
    { key: "e17", name: "Olivia Breaux", title: "Purchasing Coordinator", department: "Operations", baseAnnualCost: 49000, patterns: [{ pattern: "order_entry", runsPerDay: 6, variance: 2 }, { pattern: "inventory_count", runsPerDay: 0.6, variance: 0.3 }, { pattern: "weekly_report", runsPerDay: 0.2, variance: 0.1 }] },
    { key: "e18", name: "Sam Rivera", title: "Support Rep", department: "Customer Service", baseAnnualCost: 41000, patterns: [{ pattern: "support_ticket", runsPerDay: 24, variance: 6 }, { pattern: "appointment_scheduling", runsPerDay: 2, variance: 1 }] },
    { key: "e19", name: "Tasha Green", title: "Support Rep", department: "Customer Service", baseAnnualCost: 41000, patterns: [{ pattern: "support_ticket", runsPerDay: 19, variance: 6 }, { pattern: "appointment_scheduling", runsPerDay: 5, variance: 2 }] },
    { key: "e20", name: "Victor Landry", title: "Support Team Lead", department: "Customer Service", baseAnnualCost: 56000, patterns: [{ pattern: "support_ticket", runsPerDay: 8, variance: 3 }, { pattern: "weekly_report", runsPerDay: 0.2, variance: 0.1 }], managerOf: ["e7", "e8", "e18", "e19"] },
    { key: "e21", name: "Erin Castille", title: "Inside Sales Rep", department: "Sales", baseAnnualCost: 47000, patterns: [{ pattern: "order_entry", runsPerDay: 4, variance: 2 }, { pattern: "appointment_scheduling", runsPerDay: 7, variance: 3 }] },
    { key: "e22", name: "Derek Olsen", title: "Inside Sales Rep", department: "Sales", baseAnnualCost: 47000, patterns: [{ pattern: "order_entry", runsPerDay: 5, variance: 2 }, { pattern: "appointment_scheduling", runsPerDay: 6, variance: 3 }] },
    { key: "e23", name: "Nina Patel", title: "HR Coordinator", department: "HR", baseAnnualCost: 46000, patterns: [{ pattern: "employee_onboarding", runsPerDay: 0.6, variance: 0.4 }, { pattern: "appointment_scheduling", runsPerDay: 3, variance: 1 }] },
    { key: "e24", name: "Andre Fields", title: "Marketing Specialist", department: "Marketing", baseAnnualCost: 48000, patterns: [{ pattern: "marketing_campaign_ops", runsPerDay: 1.2, variance: 0.5 }] },
  ] as (SynthEmployee & { managerOf?: string[] })[],
};

export type GenOptions = { seed?: number; days?: number; start?: Date; employees?: SynthEmployee[] };

/** Generate events over N workdays ending yesterday. */
export function generateEvents(opts: GenOptions = {}): SynthEvent[] {
  const rnd = mulberry32(opts.seed ?? 42);
  const days = opts.days ?? 20;
  const employees = opts.employees ?? DEMO_ORG.employees;
  const end = opts.start ?? new Date(Date.now() - 86400000);
  const out: SynthEvent[] = [];
  // collect workdays
  const workdays: Date[] = [];
  const d = new Date(end); d.setHours(0, 0, 0, 0);
  while (workdays.length < days) { if (d.getDay() !== 0 && d.getDay() !== 6) workdays.push(new Date(d)); d.setDate(d.getDate() - 1); }
  workdays.reverse();

  for (const emp of employees) {
    for (const day of workdays) {
      let cursor = new Date(day); cursor.setHours(8, Math.floor(rnd() * 30), 0, 0);
      const dayEnd = new Date(day); dayEnd.setHours(17, 0, 0, 0);
      // build the day's run list
      const runs: string[] = [];
      for (const pa of emp.patterns) {
        const expected = pa.runsPerDay + (rnd() * 2 - 1) * pa.variance;
        const n = expected < 1 ? (rnd() < Math.max(0, expected) ? 1 : 0) : Math.max(0, Math.round(expected));
        for (let i = 0; i < n; i++) runs.push(pa.pattern);
      }
      // shuffle
      for (let i = runs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [runs[i], runs[j]] = [runs[j], runs[i]]; }
      for (const key of runs) {
        if (cursor >= dayEnd) break;
        const p = WORKFLOW_PATTERNS[key];
        // occasional ad-hoc noise between runs
        if (rnd() < 0.35) { const noise = pickNoise(rnd); out.push({ employeeKey: emp.key, ts: new Date(cursor), ...noise }); cursor = new Date(cursor.getTime() + noise.durationMs); }
        // lunch idle
        if (cursor.getHours() === 12 && rnd() < 0.8) { const idle = Math.round(30 * 60000 + rnd() * 20 * 60000); out.push({ employeeKey: emp.key, ts: new Date(cursor), type: "idle_start", app: "", appCategory: "idle", titleCategory: "", titleHash: "", durationMs: idle, meta: {} }); cursor = new Date(cursor.getTime() + idle); out.push({ employeeKey: emp.key, ts: new Date(cursor), type: "idle_end", app: "", appCategory: "idle", titleCategory: "", titleHash: "", durationMs: 0, meta: {} }); }
        const rework = rnd() < p.rework;
        const steps = rework ? [...p.steps, ...p.steps.slice(2, 4)] : p.steps; // rework repeats middle steps
        for (const [app, cat, title, type, baseMs, meta] of steps) {
          const dur = Math.round(baseMs * (0.7 + rnd() * 0.6));
          out.push({ employeeKey: emp.key, ts: new Date(cursor), type, app, appCategory: cat, titleCategory: title, titleHash: hash(`${app}|${title}`), durationMs: dur, meta: { ...(meta ?? {}), ...(rework ? { rework: true } : {}) } });
          cursor = new Date(cursor.getTime() + dur + Math.round(rnd() * 8000));
        }
      }
    }
  }
  out.sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.employeeKey.localeCompare(b.employeeKey));
  return out;
}

function pickNoise(rnd: () => number): Omit<SynthEvent, "employeeKey" | "ts"> {
  const choices: [string, string, string, SynthEvent["type"], number][] = [
    ["Slack", "chat", "team channel", "app_focus", 120000],
    ["Chrome", "browser", "general", "navigation", 180000],
    ["Outlook", "email", "inbox", "app_focus", 150000],
    ["Teams", "meeting", "meeting", "app_focus", 1800000],
    ["Word", "document", "memo", "document_open", 400000],
  ];
  const c = choices[Math.floor(rnd() * choices.length)];
  const dur = Math.round(c[4] * (0.5 + rnd()));
  return { type: c[3], app: c[0], appCategory: c[1], titleCategory: c[2], titleHash: hash(`${c[0]}|${c[2]}`), durationMs: dur, meta: {} };
}
