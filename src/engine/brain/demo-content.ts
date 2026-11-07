/**
 * SYNTHETIC demo knowledge for the Gulf Coast Supply Co. demo tenant. Every document is invented for demonstration; names,
 * numbers, vendors and accounts are fictional. Loaded only into orgs with isDemo = true, by an owner, via loadDemoKnowledge().
 * (Lead: this can be called from src/engine/seed.ts after the demo org is created — see the Phase B R report.)
 */
import { eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { ingestDocument, reviewDocument, type KnowledgeCategory } from "./index";
import { ensureSource } from "./sources";

export type DemoDoc = { key: string; title: string; category: KnowledgeCategory; content: string };
const NOTE = "Synthetic sample — fictional content generated for the BridgeBox demo.";

export const DEMO_DOCUMENTS: DemoDoc[] = [
  { key: "ap-policy", title: "Accounts Payable Policy", category: "policy", content: `# Accounts Payable Policy
${NOTE}

# Scope
This policy covers every vendor invoice received by Gulf Coast Supply Co. across all branches.

# Approval thresholds
Invoices up to $5,000 may be approved by the department manager who owns the purchase order.
Invoices over $5,000 require controller approval before payment is scheduled.
Invoices over $25,000 require controller approval and CFO sign-off.

# Three-way match
Accounts payable matches every invoice to its purchase order and the warehouse receiving report before approval.
Quantity variances above 2% or price variances above $50 per line are routed back to purchasing.

# Duplicate invoices
An invoice is treated as a possible duplicate when vendor, invoice number and amount match an invoice already entered in the last 18 months. Possible duplicates are held, never paid automatically.

# Payment runs
Payment runs happen every Tuesday and Friday. Standard terms are Net 30 unless the approved vendor list states otherwise. Early-payment discounts are taken when the discount is 1% or more.` },
  { key: "vendor-list", title: "Approved Vendor List", category: "vendor", content: `# Approved Vendor List
${NOTE}

# Vendors
Row 1: Vendor: Bayou Steel Distributors; Category: Steel & rebar; Payment terms: Net 45; GL account: 5010 Materials - Metals; Contact role: Branch rep.
Row 2: Vendor: Delta Pipe & Valve; Category: Plumbing supplies; Payment terms: 2/10 Net 30; GL account: 5020 Materials - Plumbing; Contact role: Inside sales.
Row 3: Vendor: Crescent Fasteners; Category: Fasteners; Payment terms: Net 30; GL account: 5030 Materials - Hardware; Contact role: Account manager.
Row 4: Vendor: Pelican Freight Lines; Category: Freight; Payment terms: Net 15; GL account: 6110 Freight In; Contact role: Dispatch.
Row 5: Vendor: Magnolia Office Supply; Category: Office supplies; Payment terms: Net 30; GL account: 6400 Office Expense; Contact role: Customer service.
Row 6: Vendor: Gulfline Electrical; Category: Electrical; Payment terms: 1/15 Net 45; GL account: 5040 Materials - Electrical; Contact role: Branch rep.

# Rules
Only vendors on this list may be paid without a new-vendor form. New vendors require a W-9 and controller approval before the first payment.` },
  { key: "po-register", title: "Purchase Order Register (sample)", category: "vendor", content: `# Purchase Order Register — sample month
${NOTE}

# Open purchase orders
Row 1: PO number: PO-24-1182; Vendor: Bayou Steel Distributors; Amount: $18,450.00; Branch: Houston; Status: Received, awaiting invoice.
Row 2: PO number: PO-24-1187; Vendor: Delta Pipe & Valve; Amount: $3,912.40; Branch: Mobile; Status: Partially received.
Row 3: PO number: PO-24-1190; Vendor: Crescent Fasteners; Amount: $1,268.75; Branch: Baton Rouge; Status: Received and invoiced.
Row 4: PO number: PO-24-1194; Vendor: Gulfline Electrical; Amount: $7,640.00; Branch: Houston; Status: Open.
Row 5: PO number: PO-24-1201; Vendor: Pelican Freight Lines; Amount: $2,150.00; Branch: Mobile; Status: Received, awaiting invoice.

# Notes
Purchase orders over $5,000 follow the controller approval threshold in the Accounts Payable Policy when invoiced.` },
  { key: "pricing", title: "Contractor Pricing Sheet", category: "pricing", content: `# Contractor Pricing Sheet
${NOTE}

# Price tiers
Retail customers pay list price.
Contractor tier 1 (annual purchases under $50,000) receives 8% off list.
Contractor tier 2 (annual purchases $50,000 to $250,000) receives 12% off list.
Contractor tier 3 (annual purchases over $250,000) receives 15% off list and free delivery within 25 miles.

# Delivery
Standard delivery within 25 miles of a branch is $65 per drop. Same-day delivery is $125 when ordered before 11 am.

# Quotes
Quotes are valid for 14 days. Discounts beyond the tier require branch manager approval; discounts beyond 20% require the sales director.` },
  { key: "sla", title: "Customer Service SLA", category: "customer", content: `# Customer Service Service-Level Agreement
${NOTE}

# Response times
Phone calls are answered within 60 seconds during business hours (7 am – 6 pm Central).
Emails and web tickets receive a first response within 4 business hours.
Urgent jobsite outages (customer cannot work) receive a callback within 30 minutes.

# Resolution
Order errors are corrected within 1 business day. Returns are credited within 5 business days of the item arriving back at the branch.

# Escalation
Tickets open more than 2 business days escalate to the customer service lead. Any complaint mentioning safety escalates immediately to the branch manager.` },
  { key: "onboarding", title: "New Employee Onboarding Procedure", category: "procedure", content: `# New Employee Onboarding Procedure
${NOTE}

# Before day one
HR sends the offer packet, I-9 instructions and the handbook acknowledgement at least 5 business days before the start date.
IT creates the network account, email and ERP login with role-based access approved by the hiring manager.

# Day one
The hiring manager gives a branch walkthrough and safety briefing. Warehouse staff complete forklift safety orientation before operating equipment.

# First 30 days
New employees complete the product basics course in week 1 and shadow an experienced teammate for 2 weeks. The manager holds a 30-day check-in and records it in the HR system.` },
  { key: "travel", title: "Travel & Expense Policy", category: "policy", content: `# Travel & Expense Policy
${NOTE}

# Approval
Overnight travel requires manager pre-approval. Trips over $2,000 total require director approval.

# Limits
Hotel: up to $185 per night. Meals: up to $60 per day while traveling. Mileage is reimbursed at the current IRS standard rate.

# Submission
Expense reports are submitted within 30 days with itemized receipts for any expense over $25. Alcohol is not reimbursable.` },
  { key: "overview", title: "Company Overview", category: "company", content: `# Gulf Coast Supply Co. — Company Overview
${NOTE}

# Who we are
Gulf Coast Supply Co. is a fictional building-materials distributor serving contractors along the Gulf Coast from branches in Houston, Baton Rouge and Mobile.

# What we sell
Steel and rebar, plumbing supplies, electrical supplies, fasteners and jobsite essentials, with same-day delivery from each branch.

# Goals this year
Reduce invoice processing time by half, answer every customer email within 4 business hours, and grow contractor tier 2 and tier 3 accounts by 10%.` },
  { key: "glossary", title: "Company Glossary", category: "terminology", content: `# Company Glossary
${NOTE}

# Terms
Three-way match: comparing the purchase order, the receiving report and the vendor invoice before approving payment.
Drop: one delivery to one customer jobsite.
Tier pricing: the contractor discount level based on annual purchases.
Controller threshold: the $5,000 invoice amount above which controller approval is required.
Will-call: an order the customer picks up at the branch counter.` },
];

export async function loadDemoKnowledge(orgId: string, userId: string): Promise<{ created: number; skipped: number }> {
  const [org] = await withTenant(orgId, (tx) => tx.select({ isDemo: schema.organizations.isDemo }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1));
  if (!org?.isDemo) throw new Error("Synthetic demo knowledge can only be loaded into a demo organization.");
  const sourceId = await ensureSource(orgId, "upload", "Synthetic demo knowledge", null, userId);
  let created = 0; let skipped = 0;
  for (const d of DEMO_DOCUMENTS) {
    const r = await ingestDocument(orgId, userId, { title: d.title, content: d.content, category: d.category, sourceId, mimeType: "text/markdown" });
    if (r.status !== "created" || !r.documentId) { skipped++; continue; }
    await reviewDocument(orgId, userId, r.documentId, "approve");
    created++;
  }
  await audit({ orgId, actorUserId: userId, action: "brain.demo_knowledge_loaded", entityType: "brain", details: { created, skipped, note: "synthetic demo content" } });
  return { created, skipped };
}
