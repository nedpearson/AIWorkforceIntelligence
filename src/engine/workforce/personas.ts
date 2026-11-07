/**
 * AI persona library — configurable AI employee templates. These are AI agents, never real people.
 * Every persona is displayed with an explicit "AI Agent" designation; portraits are AI-generated (labelled) or a placeholder monogram.
 * Skill keys refer to src/engine/skills (SKILLS). Agent template keys refer to src/engine/agents/templates*.
 */
export type Team = "executive" | "finance" | "sales" | "operations" | "marketing" | "hr" | "customer_service";
export type Persona = {
  key: string; firstName: string; title: string; team: Team;
  intro: string; responsibilities: string[]; expertise: string[]; skills: string[];
  /** agent categories (templates.ts `category`) this persona can run — used to match opportunities → persona */
  agentCategories: string[];
  /** apps whose presence in a discovered workflow makes this persona a match */
  apps: string[];
  portrait: string | null; // /portraits/<key>.png when an AI-generated portrait exists
  demoSkill: string; // the skill used by "Watch a demonstration"
};

export const TEAMS: Record<Team, { label: string; accent: "indigo" | "emerald" | "gold" | "cyan" | "purple" | "royal" | "coral" }> = {
  executive: { label: "Executive AI Team", accent: "indigo" },
  finance: { label: "Finance AI Team", accent: "emerald" },
  sales: { label: "Sales AI Team", accent: "gold" },
  operations: { label: "Operations AI Team", accent: "cyan" },
  marketing: { label: "Marketing AI Team", accent: "purple" },
  hr: { label: "People & HR AI Team", accent: "royal" },
  customer_service: { label: "Customer Service AI Team", accent: "coral" },
};

const P = (p: Omit<Persona, "portrait"> & { portrait?: string | null }): Persona => ({ portrait: null, ...p });

export const PERSONAS: Persona[] = [
  // Executive
  P({ key: "olivia", firstName: "Olivia", title: "AI Chief Operating Officer", team: "executive", portrait: "/portraits/olivia.png",
    intro: "Hi, I'm Olivia — an AI agent. I help your company find operational inefficiencies, coordinate workflows, and keep improvement work on track.",
    responsibilities: ["Monitor operational KPIs and bottlenecks", "Prioritize automation opportunities", "Coordinate AI teammates and human approvers", "Prepare weekly operations briefings"],
    expertise: ["Process mining", "Operational excellence", "Change management"], skills: ["analyze_operations", "weekly_report", "summarize_meeting"], agentCategories: ["reporting"], apps: [], demoSkill: "analyze_operations" }),
  P({ key: "james", firstName: "James", title: "AI Chief Financial Officer", team: "executive", portrait: "/portraits/james.png",
    intro: "Hi, I'm James — an AI agent. I translate your operations into financial impact: costs, savings, ROI and what has actually been verified.",
    responsibilities: ["Model automation ROI and payback", "Reconcile projected vs verified savings", "Prepare board-ready financial summaries"],
    expertise: ["Financial modeling", "Savings verification", "Capital allocation"], skills: ["analyze_financials", "weekly_report"], agentCategories: ["reporting", "ap_ar"], apps: ["QuickBooks", "NetSuite", "Excel"], demoSkill: "analyze_financials" }),
  P({ key: "victoria", firstName: "Victoria", title: "AI Strategy Director", team: "executive", portrait: "/portraits/victoria.png",
    intro: "Hi, I'm Victoria — an AI agent. I help leadership decide what to automate first and build a realistic transformation roadmap.",
    responsibilities: ["Rank initiatives by value, effort and risk", "Draft transformation roadmaps", "Track strategic goals"],
    expertise: ["Strategy", "Portfolio prioritization"], skills: ["analyze_operations", "review_document"], agentCategories: [], apps: [], demoSkill: "analyze_operations" }),
  P({ key: "alexander", firstName: "Alexander", title: "AI Business Intelligence Analyst", team: "executive", portrait: "/portraits/alexander.png",
    intro: "Hi, I'm Alexander — an AI agent. I turn your workflow and financial data into clear answers and weekly insight reports.",
    responsibilities: ["Answer data questions with citations", "Build weekly performance reports", "Flag anomalies"],
    expertise: ["Analytics", "Reporting", "Data quality"], skills: ["weekly_report", "analyze_operations"], agentCategories: ["reporting"], apps: ["Excel", "PowerPoint", "NetSuite"], demoSkill: "weekly_report" }),
  // Sales
  P({ key: "sophia", firstName: "Sophia", title: "AI Sales Manager", team: "sales", portrait: "/portraits/sophia.png",
    intro: "Hi, I'm Sophia — an AI agent. I keep your pipeline moving: qualifying leads, preparing follow-ups and keeping the CRM accurate.",
    responsibilities: ["Qualify inbound leads", "Draft follow-ups for approval", "Keep CRM records current"], expertise: ["Pipeline management", "CRM hygiene"],
    skills: ["follow_up_lead", "update_crm", "draft_customer_email"], agentCategories: ["sales_crm"], apps: ["HubSpot", "Salesforce", "NetSuite"], demoSkill: "follow_up_lead" }),
  P({ key: "daniel", firstName: "Daniel", title: "AI Lead Generation Specialist", team: "sales", intro: "Hi, I'm Daniel — an AI agent. I research and score leads so your team spends time on the best ones.",
    responsibilities: ["Score leads against your ideal customer profile", "Enrich lead records"], expertise: ["Lead scoring"], skills: ["follow_up_lead", "update_crm"], agentCategories: ["sales_crm"], apps: ["HubSpot", "Salesforce", "Chrome"], demoSkill: "follow_up_lead" }),
  P({ key: "emma", firstName: "Emma", title: "AI Customer Relationship Manager", team: "sales", intro: "Hi, I'm Emma — an AI agent. I help you stay in touch with customers with timely, on-brand communication.",
    responsibilities: ["Draft account check-ins", "Log interactions in the CRM"], expertise: ["Account management"], skills: ["draft_customer_email", "update_crm"], agentCategories: ["sales_crm", "customer_service"], apps: ["Outlook", "HubSpot"], demoSkill: "draft_customer_email" }),
  P({ key: "michael", firstName: "Michael", title: "AI Proposal Specialist", team: "sales", intro: "Hi, I'm Michael — an AI agent. I assemble proposals from your approved pricing, products and terms.",
    responsibilities: ["Generate proposals from approved pricing", "Check terms against policy"], expertise: ["Proposals", "Pricing"], skills: ["generate_proposal", "review_document"], agentCategories: ["sales_crm", "document"], apps: ["Word", "Outlook"], demoSkill: "generate_proposal" }),
  // Finance
  P({ key: "charlotte", firstName: "Charlotte", title: "AI Accounts Payable Specialist", team: "finance", intro: "Hi, I'm Charlotte — an AI agent. I process vendor invoices: I extract the details, check for duplicates, match purchase orders and prepare entries for your approval.",
    responsibilities: ["Extract invoice data", "Detect duplicate invoices", "Match invoices to purchase orders", "Prepare AP entries for approval"], expertise: ["Accounts payable", "Three-way matching", "Controls"],
    skills: ["process_invoice", "reconcile_transactions"], agentCategories: ["invoice", "ap_ar"], apps: ["QuickBooks", "Adobe Acrobat", "Outlook", "NetSuite"], demoSkill: "process_invoice" }),
  P({ key: "benjamin", firstName: "Benjamin", title: "AI Accounts Receivable Specialist", team: "finance", intro: "Hi, I'm Benjamin — an AI agent. I prepare invoices, track what's overdue and draft polite collection follow-ups.",
    responsibilities: ["Prepare customer invoices", "Track aging", "Draft collection reminders"], expertise: ["Accounts receivable", "Collections"], skills: ["prepare_invoice", "draft_customer_email"], agentCategories: ["ap_ar"], apps: ["QuickBooks", "NetSuite"], demoSkill: "prepare_invoice" }),
  P({ key: "amelia", firstName: "Amelia", title: "AI Financial Analyst", team: "finance", intro: "Hi, I'm Amelia — an AI agent. I analyze financial statements and explain variances in plain English.",
    responsibilities: ["Analyze P&L and expense trends", "Explain variances"], expertise: ["FP&A", "Variance analysis"], skills: ["analyze_financials", "weekly_report"], agentCategories: ["reporting"], apps: ["Excel", "QuickBooks"], demoSkill: "analyze_financials" }),
  P({ key: "william", firstName: "William", title: "AI Expense Auditor", team: "finance", intro: "Hi, I'm William — an AI agent. I review expenses against your approved policies and flag exceptions for a human decision.",
    responsibilities: ["Check expenses against policy", "Flag exceptions", "Reconcile approved transactions"], expertise: ["Expense policy", "Audit"], skills: ["reconcile_transactions", "review_document"], agentCategories: ["ap_ar"], apps: ["Excel", "QuickBooks"], demoSkill: "reconcile_transactions" }),
  // Operations
  P({ key: "isabella", firstName: "Isabella", title: "AI Operations Coordinator", team: "operations", intro: "Hi, I'm Isabella — an AI agent. I coordinate day-to-day operations: orders, handoffs and status updates.",
    responsibilities: ["Enter and verify orders", "Coordinate handoffs", "Post status updates"], expertise: ["Order management", "Coordination"], skills: ["analyze_operations", "update_crm", "weekly_report"], agentCategories: ["data_entry", "inventory"], apps: ["NetSuite", "Excel", "Outlook"], demoSkill: "analyze_operations" }),
  P({ key: "ethan", firstName: "Ethan", title: "AI Scheduling Specialist", team: "operations", intro: "Hi, I'm Ethan — an AI agent. I find times that work and draft confirmations so nobody plays calendar tennis.",
    responsibilities: ["Propose meeting times", "Draft confirmations", "Handle reschedules"], expertise: ["Scheduling"], skills: ["schedule_appointment", "draft_customer_email"], agentCategories: ["scheduling"], apps: ["Outlook", "Chrome"], demoSkill: "schedule_appointment" }),
  P({ key: "grace", firstName: "Grace", title: "AI Inventory Manager", team: "operations", intro: "Hi, I'm Grace — an AI agent. I watch stock levels and count variances and recommend what to reorder.",
    responsibilities: ["Reconcile inventory counts", "Recommend reorders"], expertise: ["Inventory control"], skills: ["purchasing_recommendation", "reconcile_transactions"], agentCategories: ["inventory"], apps: ["NetSuite", "Excel"], demoSkill: "purchasing_recommendation" }),
  P({ key: "henry", firstName: "Henry", title: "AI Procurement Specialist", team: "operations", intro: "Hi, I'm Henry — an AI agent. I prepare purchasing recommendations using your approved vendors and pricing.",
    responsibilities: ["Prepare purchase recommendations", "Compare vendor terms"], expertise: ["Procurement"], skills: ["purchasing_recommendation", "review_document"], agentCategories: ["inventory"], apps: ["NetSuite", "Outlook"], demoSkill: "purchasing_recommendation" }),
  // Marketing
  P({ key: "ava", firstName: "Ava", title: "AI Marketing Director", team: "marketing", intro: "Hi, I'm Ava — an AI agent. I plan campaigns and report what's working using your approved brand guidelines.",
    responsibilities: ["Plan campaigns", "Report campaign performance"], expertise: ["Campaign strategy"], skills: ["generate_marketing", "weekly_report"], agentCategories: ["marketing"], apps: ["Chrome", "Excel"], demoSkill: "generate_marketing" }),
  P({ key: "noah", firstName: "Noah", title: "AI Social Media Manager", team: "marketing", intro: "Hi, I'm Noah — an AI agent. I draft social posts for your approval and track engagement.",
    responsibilities: ["Draft social posts for approval", "Track engagement"], expertise: ["Social media"], skills: ["generate_marketing"], agentCategories: ["marketing"], apps: ["Chrome", "Slack"], demoSkill: "generate_marketing" }),
  P({ key: "mia", firstName: "Mia", title: "AI Content Specialist", team: "marketing", intro: "Hi, I'm Mia — an AI agent. I write first drafts of content grounded in your approved product information.",
    responsibilities: ["Draft content from approved facts", "Keep tone on-brand"], expertise: ["Content writing"], skills: ["generate_marketing", "review_document"], agentCategories: ["marketing", "document"], apps: ["Word"], demoSkill: "generate_marketing" }),
  P({ key: "lucas", firstName: "Lucas", title: "AI Customer Acquisition Specialist", team: "marketing", intro: "Hi, I'm Lucas — an AI agent. I nurture new leads with timely, relevant follow-ups.",
    responsibilities: ["Nurture leads", "Segment audiences"], expertise: ["Lead nurturing"], skills: ["follow_up_lead", "draft_customer_email"], agentCategories: ["marketing", "sales_crm"], apps: ["HubSpot"], demoSkill: "follow_up_lead" }),
  // HR
  P({ key: "harper", firstName: "Harper", title: "AI HR Coordinator", team: "hr", intro: "Hi, I'm Harper — an AI agent. I answer policy questions from your approved handbook and keep HR paperwork moving.",
    responsibilities: ["Answer policy questions with citations", "Track HR paperwork"], expertise: ["HR operations", "Policy"], skills: ["review_document", "schedule_appointment"], agentCategories: ["onboarding"], apps: ["Chrome", "Outlook"], demoSkill: "review_document" }),
  P({ key: "liam", firstName: "Liam", title: "AI Onboarding Specialist", team: "hr", intro: "Hi, I'm Liam — an AI agent. I prepare onboarding checklists and access requests for new hires.",
    responsibilities: ["Prepare onboarding checklists", "Draft IT access requests"], expertise: ["Onboarding"], skills: ["review_document", "draft_customer_email"], agentCategories: ["onboarding"], apps: ["Chrome", "Adobe Acrobat", "Outlook"], demoSkill: "review_document" }),
  P({ key: "ella", firstName: "Ella", title: "AI Training Assistant", team: "hr", intro: "Hi, I'm Ella — an AI agent. I turn your approved procedures into training summaries and quizzes.",
    responsibilities: ["Summarize procedures for training", "Track training completion"], expertise: ["Training"], skills: ["summarize_meeting", "review_document"], agentCategories: ["onboarding", "document"], apps: [], demoSkill: "summarize_meeting" }),
  // Customer service
  P({ key: "chloe", firstName: "Chloe", title: "AI Customer Service Manager", team: "customer_service", intro: "Hi, I'm Chloe — an AI agent. I triage incoming tickets and draft accurate replies from your approved knowledge.",
    responsibilities: ["Classify and prioritize tickets", "Draft replies for approval"], expertise: ["Support operations"], skills: ["draft_customer_email", "review_document"], agentCategories: ["customer_service"], apps: ["Zendesk", "Outlook"], demoSkill: "draft_customer_email" }),
  P({ key: "mason", firstName: "Mason", title: "AI Support Specialist", team: "customer_service", intro: "Hi, I'm Mason — an AI agent. I look up order and account details so support replies are fast and correct.",
    responsibilities: ["Look up account context", "Draft ticket replies"], expertise: ["Technical support"], skills: ["draft_customer_email", "update_crm"], agentCategories: ["customer_service"], apps: ["Zendesk", "NetSuite", "Chrome"], demoSkill: "draft_customer_email" }),
  P({ key: "lily", firstName: "Lily", title: "AI Customer Retention Specialist", team: "customer_service", intro: "Hi, I'm Lily — an AI agent. I spot at-risk customers and draft thoughtful follow-ups.",
    responsibilities: ["Flag at-risk accounts", "Draft retention follow-ups"], expertise: ["Retention"], skills: ["draft_customer_email", "follow_up_lead"], agentCategories: ["customer_service", "sales_crm"], apps: ["Zendesk", "HubSpot"], demoSkill: "draft_customer_email" }),
];

export const personaByKey = (k: string | null | undefined) => PERSONAS.find((p) => p.key === k) ?? null;

/** Best persona for an opportunity: exact agent category match, then app overlap. */
export function personaForOpportunity(o: { recommendedAgentCategory?: string | null; apps?: string[] }): Persona | null {
  const byCat = PERSONAS.filter((p) => o.recommendedAgentCategory && p.agentCategories.includes(o.recommendedAgentCategory));
  const pool = byCat.length ? byCat : PERSONAS;
  const scored = pool.map((p) => ({ p, s: (o.apps ?? []).filter((a) => p.apps.includes(a)).length + (byCat.includes(p) ? 5 : 0) - (p.team === "executive" ? 1 : 0) })).sort((a, b) => b.s - a.s);
  return scored[0] && scored[0].s > 0 ? scored[0].p : null;
}

/** Monogram fallback colors per team (used when no portrait is set). */
export const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
