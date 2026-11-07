/** Shared DB fixtures for skills tests: two orgs, users per role, an AP department with costed performers on an observed
 *  workflow, a deployed agent on that workflow, approved AI Brain knowledge, and an AI-employee factory. Cleaned up by org cascade. */
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ingestDocument, reviewDocument, proposeFact, reviewFact } from "@/engine/brain";

export type Fx = Awaited<ReturnType<typeof makeFixtures>>;
export async function makeFixtures(tag: string) {
  const stamp = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [a] = await db.insert(schema.organizations).values({ name: `Skills A ${tag}`, slug: `skills-a-${stamp}`, isDemo: true }).returning();
  const [b] = await db.insert(schema.organizations).values({ name: `Skills B ${tag}`, slug: `skills-b-${stamp}`, isDemo: true }).returning();
  const mkUser = async (role: "owner" | "admin" | "manager" | "viewer" | "employee", orgId = a.id) => { const [u] = await db.insert(schema.users).values({ email: `${role}-${stamp}@skills.test` }).returning(); await db.insert(schema.memberships).values({ userId: u.id, orgId, role }); return u.id; };
  const owner = await mkUser("owner"), manager = await mkUser("manager"), viewer = await mkUser("viewer"), employee = await mkUser("employee");
  const [ub] = await db.insert(schema.users).values({ email: `ownerb-${stamp}@skills.test` }).returning(); await db.insert(schema.memberships).values({ userId: ub.id, orgId: b.id, role: "owner" });
  const [dept] = await db.insert(schema.departments).values({ orgId: a.id, name: "Accounts Payable" }).returning();
  const [e1] = await db.insert(schema.employees).values({ orgId: a.id, departmentId: dept.id, displayName: "AP Clerk 1", baseAnnualCost: "52000", costBasis: "observed", hoursPerWeek: "40" }).returning();
  const [e2] = await db.insert(schema.employees).values({ orgId: a.id, departmentId: dept.id, displayName: "AP Clerk 2", loadedHourlyCost: "40", costBasis: "observed", hoursPerWeek: "40" }).returning();
  const [wf] = await db.insert(schema.workflows).values({ orgId: a.id, departmentId: dept.id, name: "AP invoice entry (Outlook → QuickBooks)", signature: `ap-${stamp}`, hoursPerWeek: "18", avgDurationMin: "14", runsPerWeek: "77", repetitionScore: "92", automationScore: "85", reworkRate: "0.06", handoffCount: 3, employeeCount: 2, basis: "observed" }).returning();
  await db.insert(schema.workflowEmployees).values([{ orgId: a.id, workflowId: wf.id, employeeId: e1.id, hoursPerWeek: "12" }, { orgId: a.id, workflowId: wf.id, employeeId: e2.id, hoursPerWeek: "6" }]);
  const [agent] = await db.insert(schema.agents).values({ orgId: a.id, workflowId: wf.id, name: "AP intake agent", category: "invoice", templateKey: "ap_invoice_intake", status: "deployed", definition: { nodes: [{ id: "t", type: "trigger", label: "t", config: {} }, { id: "e", type: "end", label: "e", config: {} }], edges: [{ from: "t", to: "e" }] }, baselineMinutesPerRun: "14", expectedMinutesSavedPerRun: "10", monthlyCost: "0" }).returning();

  // approved knowledge (org A only)
  const doc = await ingestDocument(a.id, owner, { title: "AP policy", category: "policy", content: "# Invoice approval\nInvoices over $5,000 require controller approval before payment. PO match tolerance is 2%.\n\n# GL coding\nFreight is coded to GL 5150. Accounts payable is GL account 2010.\n\n# Payment terms\nPayment terms are Net 30 unless the vendor contract says otherwise." });
  await reviewDocument(a.id, owner, doc.documentId!, "approve");
  const ops = await ingestDocument(a.id, owner, { title: "Operations handbook", category: "procedure", content: "# Bank reconciliation\nReconcile the operating account at month end close; investigate any bank fee or interest line.\n\n# Scheduling\nSchedule site inspections and appointments with at least 15 minutes between visits.\n\n# Goals\nOur weekly priorities and financial goals: keep gross margin above 30%, cut invoice backlog, and reduce operations bottlenecks.\n\n# Customer care\nWhen a delivery is late, apologize, give the new delivery date, and offer to waive freight on the order.\n\n# Meetings\nThe AP pilot and invoice backlog are reviewed in the weekly ops sync.\n\n# Supply agreements\nSupply agreement payment terms must be Net 30; avoid automatic renewal clauses." });
  await reviewDocument(a.id, owner, ops.documentId!, "approve");
  const facts = [
    { category: "vendor", subject: "Northwind Industrial Supply LLC", statement: "Approved vendor for valves and fittings. Open PO PO-24017: Northwind Industrial Supply LLC $1,280.00 open." },
    { category: "vendor", subject: "Summit Office Products Inc.", statement: "Approved vendor for furniture. Open PO PO-24022: Summit Office Products Inc. $6,200.00 open." },
    { category: "vendor", subject: "Coastal Seals Trading", statement: "Not approved — on hold pending insurance certificate." },
    { category: "pricing", subject: "Standard labor rate", statement: "Standard labor rate is $85/hour." },
    { category: "pricing", subject: "Annual maintenance plan", statement: "Annual maintenance plan is $1,200 per year." },
    { category: "product", subject: "Annual maintenance plan", statement: "Quarterly valve inspections with a written condition report after every visit." },
    { category: "preference", subject: "Brand voice", statement: "Our brand voice is plain, warm and practical; avoid hype." },
    { category: "terminology", subject: "Sales pipeline stages", statement: "Pipeline stages: lead, qualified, proposal, negotiation, won, lost" },
    { category: "policy", subject: "Payment terms", statement: "Standard payment terms are Net 30." },
  ];
  for (const f of facts) { const r = await proposeFact(a.id, owner, f); await reviewFact(a.id, owner, r.id, "approve"); }

  const mkEmp = async (o: Partial<typeof schema.aiEmployees.$inferInsert> = {}, orgId = a.id) => {
    const [e] = await db.insert(schema.aiEmployees).values({ orgId, firstName: "Charlotte", title: "AI Accounts Payable Specialist", team: "finance", intro: "Hi, I'm Charlotte — an AI agent.", skills: [], status: "pilot", permissionLevel: "act_with_approval", ...o }).returning();
    return e;
  };
  const cleanup = async () => { await db.delete(schema.organizations).where(eq(schema.organizations.id, a.id)); await db.delete(schema.organizations).where(eq(schema.organizations.id, b.id)); for (const u of [owner, manager, viewer, employee, ub.id]) await db.delete(schema.users).where(eq(schema.users.id, u)); };
  return { orgA: a.id, orgB: b.id, owner, manager, viewer, employee, ownerB: ub.id, dept: dept.id, wf: wf.id, agent: agent.id, mkEmp, cleanup };
}
