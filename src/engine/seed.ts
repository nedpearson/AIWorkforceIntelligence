/**
 * Seeds: BridgeBox consultancy org + owner, one SYNTHETIC demo client with 20 workdays of
 * metadata-only activity, consent + authorization records, simulated collectors, default financial model,
 * then runs the analysis engine so workflows/opportunities exist. Everything is labelled is_demo=true.
 */
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DEMO_ORG, generateEvents } from "@/engine/synthetic";
import { sha256, randomToken } from "@/lib/crypto";
import { runAnalysis } from "@/engine/analysis";
import { ensureDefaultFinancialModel } from "@/engine/finance";
import { DEFAULT_NOTICE_VERSION } from "@/collector-protocol/schema";

export type SeedResult = { skipped: boolean; events?: number; analysis?: unknown };
/** Seeds the synthetic demo. Idempotent: returns {skipped:true} if already seeded. `days` controls event volume. */
export async function seedDemo(opts: { days?: number; log?: (m: string) => void; runAnalysisNow?: boolean } = {}): Promise<SeedResult> {
  const log = opts.log ?? console.log;
  const PASSWORD = process.env.SEED_PASSWORD ?? "Demo!Pass123";
  const [existing] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, "bridgebox")).limit(1);
  if (existing) {
    // Already seeded — but make sure the demo client has been analysed (a previous bootstrap may have died mid-way).
    const [demo] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, DEMO_ORG.slug)).limit(1);
    if (demo) {
      const [wf] = await db.select({ id: schema.workflows.id }).from(schema.workflows).where(eq(schema.workflows.orgId, demo.id)).limit(1);
      if (!wf) { const [camp] = await db.select({ id: schema.observationCampaigns.id }).from(schema.observationCampaigns).where(eq(schema.observationCampaigns.orgId, demo.id)).limit(1); const run = await runAnalysis({ orgId: demo.id, campaignId: camp?.id }); log("analysis (repair): " + JSON.stringify(run)); return { skipped: true, analysis: run }; }
    }
    log("already seeded"); return { skipped: true };
  }
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const [consultancy] = await db.insert(schema.organizations).values({ name: "BridgeBox Consulting", slug: "bridgebox", kind: "consultancy", branding: { reportName: "BridgeBox AI Workforce Intelligence", primaryColor: "#0f766e" } }).returning();
  const [owner] = await db.insert(schema.users).values({ email: "owner@bridgebox.demo", name: "Ned Pearson", passwordHash, emailVerified: new Date() }).returning();
  await db.insert(schema.memberships).values({ userId: owner.id, orgId: consultancy.id, role: "owner" });

  const [client] = await db.insert(schema.organizations).values({ name: DEMO_ORG.name, slug: DEMO_ORG.slug, kind: "client", parentOrgId: consultancy.id, industry: DEMO_ORG.industry, isDemo: true, settings: { benefitsLoadPct: 0.3, workHoursPerWeek: 40, workWeeksPerYear: 48, adoptionRate: 0.75, realizationRate: 0.6 } }).returning();
  const [clientAdmin] = await db.insert(schema.users).values({ email: "admin@gulfcoast.demo", name: "Patricia Guidry", passwordHash, emailVerified: new Date() }).returning();
  await db.insert(schema.memberships).values({ userId: clientAdmin.id, orgId: client.id, role: "owner" });
  const [viewer] = await db.insert(schema.users).values({ email: "manager@gulfcoast.demo", name: "Priya Natarajan", passwordHash, emailVerified: new Date() }).returning();

  // second client to prove isolation
  const [other] = await db.insert(schema.organizations).values({ name: "Bayou Dental Group (Synthetic Demo)", slug: "bayou-dental-demo", kind: "client", parentOrgId: consultancy.id, industry: "Healthcare", isDemo: true }).returning();
  const [otherAdmin] = await db.insert(schema.users).values({ email: "admin@bayoudental.demo", name: "Kevin Thibodeaux", passwordHash, emailVerified: new Date() }).returning();
  await db.insert(schema.memberships).values({ userId: otherAdmin.id, orgId: other.id, role: "owner" });
  await db.insert(schema.subscriptions).values({ orgId: other.id, plan: "starter", status: "trialing", seats: 10, agentSlots: 3, trialEndsAt: new Date(Date.now() + 14 * 86400000) });
  await db.insert(schema.departments).values({ orgId: other.id, name: "Front Desk" });

  await db.insert(schema.subscriptions).values({ orgId: client.id, plan: "growth", status: "active", seats: 25, agentSlots: 10, currentPeriodEnd: new Date(Date.now() + 20 * 86400000) });
  await db.insert(schema.authorizations).values({ orgId: client.id, signedByUserId: clientAdmin.id, signerName: "Patricia Guidry", signerTitle: "Chief Executive Officer", scope: "All departments; business hours; metadata-only workflow observation for automation assessment", documentText: "Gulf Coast Supply Co. authorizes BridgeBox Consulting to deploy the BridgeBox Collector on company-owned devices for the purpose of workflow discovery. Collection is limited to application usage metadata. No keystroke contents, passwords, message bodies, or screenshots are collected. Employees receive written notice and may pause collection at any time." });

  const deptIds: Record<string, string> = {};
  for (const name of DEMO_ORG.departments) { const [d] = await db.insert(schema.departments).values({ orgId: client.id, name }).returning(); deptIds[name] = d.id; }
  const empIds: Record<string, string> = {};
  for (const e of DEMO_ORG.employees) {
    const loaded = (e.baseAnnualCost * 1.3) / (40 * 48);
    const [row] = await db.insert(schema.employees).values({ orgId: client.id, departmentId: deptIds[e.department], displayName: e.name, title: e.title, email: `${e.key}@gulfcoast.demo`, baseAnnualCost: String(e.baseAnnualCost), loadedHourlyCost: loaded.toFixed(2), costBasis: "observed", hoursPerWeek: "40", userId: e.key === "e3" ? viewer.id : null }).returning();
    empIds[e.key] = row.id;
  }
  for (const e of DEMO_ORG.employees) {
    for (const r of e.managerOf ?? []) await db.update(schema.employees).set({ managerEmployeeId: empIds[e.key] }).where(eq(schema.employees.id, empIds[r]));
    if (e.managerOf?.length) await db.update(schema.departments).set({ headEmployeeId: empIds[e.key] }).where(eq(schema.departments.id, deptIds[e.department]));
  }
  await db.insert(schema.memberships).values({ userId: viewer.id, orgId: client.id, role: "manager", employeeId: empIds["e3"] });

  const noticeText = "Notice of workflow observation: your employer has authorized BridgeBox to observe which applications you use and how long tasks take, to find automation opportunities. We do not record what you type, your passwords, message contents, or screenshots. You may pause collection from the tray icon at any time.";
  const [campaign] = await db.insert(schema.observationCampaigns).values({ orgId: client.id, name: "Baseline observation — Q4", description: "Four-week baseline across all departments", status: "completed", startsAt: new Date(Date.now() - 29 * 86400000), endsAt: new Date(Date.now() - 86400000), departmentIds: Object.values(deptIds), employeeIds: Object.values(empIds), createdBy: clientAdmin.id }).returning();

  const collectorIds: Record<string, string> = {};
  for (const e of DEMO_ORG.employees) {
    await db.insert(schema.consentRecords).values({ orgId: client.id, employeeId: empIds[e.key], noticeVersion: DEFAULT_NOTICE_VERSION, noticeText, acknowledgedAt: new Date(Date.now() - 30 * 86400000), method: "collector_ui" });
    const [c] = await db.insert(schema.collectors).values({ orgId: client.id, employeeId: empIds[e.key], name: `${e.name.split(" ")[0]}'s workstation`, platform: "simulated", tokenHash: sha256(randomToken()), status: "active", version: "0.1.0-sim", lastSeenAt: new Date(Date.now() - 3600000), lastEventAt: new Date(Date.now() - 86400000), config: { titleMode: "category", idleThresholdSec: 180 } }).returning();
    collectorIds[e.key] = c.id;
  }

  const events = generateEvents({ seed: 42, days: opts.days ?? 20 });
  log(`generated ${events.length} synthetic events`);
  const BATCH = 2000;
  for (let i = 0; i < events.length; i += BATCH) {
    await db.insert(schema.activityEvents).values(events.slice(i, i + BATCH).map((ev) => ({ orgId: client.id, employeeId: empIds[ev.employeeKey], collectorId: collectorIds[ev.employeeKey], campaignId: campaign.id, ts: ev.ts, type: ev.type, app: ev.app, appCategory: ev.appCategory, titleCategory: ev.titleCategory, titleHash: ev.titleHash, durationMs: ev.durationMs, meta: ev.meta })));
  }
  for (const e of DEMO_ORG.employees) {
    const n = events.filter((x) => x.employeeKey === e.key).length;
    await db.update(schema.collectors).set({ eventsReceived: n }).where(eq(schema.collectors.id, collectorIds[e.key]));
  }

  for (const provider of ["n8n", "power_automate", "uipath", "mimica", "stripe", "anthropic"] as const) {
    const status = provider === "power_automate" || provider === "uipath" || provider === "mimica" ? "license_required" : "not_configured";
    await db.insert(schema.integrations).values({ orgId: client.id, provider, status });
  }
  await ensureDefaultFinancialModel(client.id);
  let run: unknown = null;
  if (opts.runAnalysisNow !== false) { run = await runAnalysis({ orgId: client.id, campaignId: campaign.id }); log("analysis: " + JSON.stringify(run)); }
  else { const { enqueue } = await import("@/engine/jobs"); await enqueue("analysis", { orgId: client.id, campaignId: campaign.id }, client.id); log("analysis job enqueued"); }
  log(`\nSeeded.\n  Consultancy owner: owner@bridgebox.demo / ${PASSWORD}\n  Client owner:      admin@gulfcoast.demo / ${PASSWORD}\n  Client manager:    manager@gulfcoast.demo / ${PASSWORD}\n  Isolation org:     admin@bayoudental.demo / ${PASSWORD}`);
  return { skipped: false, events: events.length, analysis: run };
}
