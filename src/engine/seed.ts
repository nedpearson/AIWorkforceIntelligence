/**
 * Seeds: BridgeBox consultancy org + owner, one SYNTHETIC demo client with 20 workdays of
 * metadata-only activity, consent + authorization records, simulated collectors, default financial model,
 * then runs the analysis engine so workflows/opportunities exist. Everything is labelled is_demo=true.
 */
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DEMO_ORG, generateEvents } from "@/engine/synthetic";
import { sha256, randomToken } from "@/lib/crypto";
import { DEFAULT_DEMO_PASSWORD, MIN_PRODUCTION_SEED_PASSWORD, isProductionRuntime } from "@/lib/runtime-env";
import { runAnalysis } from "@/engine/analysis";
import { ensureDefaultFinancialModel } from "@/engine/finance";
import { DEFAULT_NOTICE_VERSION } from "@/collector-protocol/schema";

export type SeedResult = { skipped: boolean; events?: number; analysis?: unknown };

export class SeedPasswordError extends Error { constructor(m: string) { super(m); this.name = "SeedPasswordError"; } }
/**
 * Password for seeded demo accounts (SEC-001). Outside production: SEED_PASSWORD or the README default.
 * In any production context (VERCEL_ENV=production or NODE_ENV=production) the README default is refused:
 * SEED_PASSWORD must be ≥ 16 characters, otherwise a random password is generated and never printed.
 */
export function resolveSeedPassword(env: Record<string, string | undefined> = process.env): { password: string; source: "env" | "default" | "random"; printable: boolean } {
  const given = env.SEED_PASSWORD?.trim() ? env.SEED_PASSWORD : undefined;
  if (!isProductionRuntime(env)) return given ? { password: given, source: "env", printable: true } : { password: DEFAULT_DEMO_PASSWORD, source: "default", printable: true };
  if (given) {
    if (given === DEFAULT_DEMO_PASSWORD) throw new SeedPasswordError("SEED_PASSWORD is the published demo password; refusing to seed it in production");
    if (given.length < MIN_PRODUCTION_SEED_PASSWORD) throw new SeedPasswordError(`SEED_PASSWORD must be at least ${MIN_PRODUCTION_SEED_PASSWORD} characters in production`);
    return { password: given, source: "env", printable: false };
  }
  return { password: randomToken(24), source: "random", printable: false };
}
/** Seeds the synthetic demo. Idempotent: returns {skipped:true} if already seeded. `days` controls event volume. */
export async function seedDemo(opts: { days?: number; log?: (m: string) => void; runAnalysisNow?: boolean } = {}): Promise<SeedResult> {
  const log = opts.log ?? console.log;
  const [existing] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, "bridgebox")).limit(1);
  if (existing) {
    // Already seeded — but make sure the demo client has been analysed (a previous bootstrap may have died mid-way).
    const [demo] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, DEMO_ORG.slug)).limit(1);
    if (demo) {
      const [wf] = await db.select({ id: schema.workflows.id }).from(schema.workflows).where(eq(schema.workflows.orgId, demo.id)).limit(1);
      if (!wf) { const [camp] = await db.select({ id: schema.observationCampaigns.id }).from(schema.observationCampaigns).where(eq(schema.observationCampaigns.orgId, demo.id)).limit(1); const run = await runAnalysis({ orgId: demo.id, campaignId: camp?.id }); log("analysis (repair): " + JSON.stringify(run)); return { skipped: true, analysis: run }; }
    }
    if (demo) await upgradeDemo(demo.id, log);
    log("already seeded"); return { skipped: true };
  }
  const pw = resolveSeedPassword();
  const PASSWORD = pw.printable ? pw.password : pw.source === "random" ? "<random, not printed>" : "<SEED_PASSWORD, not printed>";
  const passwordHash = await bcrypt.hash(pw.password, 10);

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

  // Enterprise structure (synthetic): 2 business units, 3 locations
  const [buDist] = await db.insert(schema.businessUnits).values({ orgId: client.id, name: "Distribution", kind: "division", country: "US" }).returning();
  const [buCorp] = await db.insert(schema.businessUnits).values({ orgId: client.id, name: "Corporate Services", kind: "business_unit", country: "US" }).returning();
  const [locHq] = await db.insert(schema.locations).values({ orgId: client.id, businessUnitId: buCorp.id, name: "Baton Rouge HQ", city: "Baton Rouge", region: "LA", country: "US", timezone: "America/Chicago" }).returning();
  const [locHou] = await db.insert(schema.locations).values({ orgId: client.id, businessUnitId: buDist.id, name: "Houston Distribution Center", city: "Houston", region: "TX", country: "US", timezone: "America/Chicago" }).returning();
  const [locLaf] = await db.insert(schema.locations).values({ orgId: client.id, businessUnitId: buDist.id, name: "Lafayette Branch", city: "Lafayette", region: "LA", country: "US", timezone: "America/Chicago" }).returning();
  const deptPlacement: Record<string, { bu: string; loc: string; overhead: number }> = {
    Finance: { bu: buCorp.id, loc: locHq.id, overhead: 84000 }, HR: { bu: buCorp.id, loc: locHq.id, overhead: 38000 }, Marketing: { bu: buCorp.id, loc: locHq.id, overhead: 61000 },
    Operations: { bu: buDist.id, loc: locHou.id, overhead: 142000 }, "Customer Service": { bu: buDist.id, loc: locLaf.id, overhead: 57000 }, Sales: { bu: buDist.id, loc: locLaf.id, overhead: 73000 },
  };
  const deptIds: Record<string, string> = {};
  for (const name of DEMO_ORG.departments) { const pl = deptPlacement[name]; const [d] = await db.insert(schema.departments).values({ orgId: client.id, name, businessUnitId: pl?.bu, locationId: pl?.loc, annualOverhead: pl ? String(pl.overhead) : null, overheadBasis: "assumed" }).returning(); deptIds[name] = d.id; }
  const empIds: Record<string, string> = {};
  for (const e of DEMO_ORG.employees) {
    const loaded = (e.baseAnnualCost * 1.3) / (40 * 48);
    const [row] = await db.insert(schema.employees).values({ orgId: client.id, departmentId: deptIds[e.department], locationId: deptPlacement[e.department]?.loc, businessUnitId: deptPlacement[e.department]?.bu, displayName: e.name, title: e.title, email: `${e.key}@gulfcoast.demo`, baseAnnualCost: String(e.baseAnnualCost), loadedHourlyCost: loaded.toFixed(2), costBasis: "observed", hoursPerWeek: "40", userId: e.key === "e3" ? viewer.id : null }).returning();
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
  await upgradeDemo(client.id, log);
  log(`\nSeeded.\n  Consultancy owner: owner@bridgebox.demo / ${PASSWORD}\n  Client owner:      admin@gulfcoast.demo / ${PASSWORD}\n  Client manager:    manager@gulfcoast.demo / ${PASSWORD}\n  Isolation org:     admin@bayoudental.demo / ${PASSWORD}`);
  return { skipped: false, events: events.length, analysis: run };
}

/**
 * Idempotent upgrades for demo orgs created by earlier seed versions (e.g. production seeded before Phase A/B):
 * enterprise structure, synthetic Brain knowledge, recommended AI team (draft, read-only). Never touches non-demo orgs.
 */
export async function upgradeDemo(orgId: string, log: (m: string) => void = console.log) {
  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
  if (!org?.isDemo) return;
  const [owner] = await db.select({ userId: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.role, "owner"))).limit(1);
  const ownerId = owner?.userId ?? null;
  const [anyBu] = await db.select({ id: schema.businessUnits.id }).from(schema.businessUnits).where(eq(schema.businessUnits.orgId, orgId)).limit(1);
  if (!anyBu) {
    const [buDist] = await db.insert(schema.businessUnits).values({ orgId, name: "Distribution", kind: "division", country: "US" }).returning();
    const [buCorp] = await db.insert(schema.businessUnits).values({ orgId, name: "Corporate Services", kind: "business_unit", country: "US" }).returning();
    const [hq] = await db.insert(schema.locations).values({ orgId, businessUnitId: buCorp.id, name: "Baton Rouge HQ", city: "Baton Rouge", region: "LA", country: "US" }).returning();
    const [hou] = await db.insert(schema.locations).values({ orgId, businessUnitId: buDist.id, name: "Houston Distribution Center", city: "Houston", region: "TX", country: "US" }).returning();
    const [laf] = await db.insert(schema.locations).values({ orgId, businessUnitId: buDist.id, name: "Lafayette Branch", city: "Lafayette", region: "LA", country: "US" }).returning();
    const place: Record<string, [string, string, number]> = { Finance: [buCorp.id, hq.id, 84000], HR: [buCorp.id, hq.id, 38000], Marketing: [buCorp.id, hq.id, 61000], Operations: [buDist.id, hou.id, 142000], "Customer Service": [buDist.id, laf.id, 57000], Sales: [buDist.id, laf.id, 73000] };
    const depts = await db.select().from(schema.departments).where(eq(schema.departments.orgId, orgId));
    for (const d of depts) { const pl = place[d.name]; if (!pl) continue; await db.update(schema.departments).set({ businessUnitId: pl[0], locationId: pl[1], annualOverhead: String(pl[2]), overheadBasis: "assumed" }).where(eq(schema.departments.id, d.id)); await db.update(schema.employees).set({ businessUnitId: pl[0], locationId: pl[1] }).where(eq(schema.employees.departmentId, d.id)); }
    log("upgrade: enterprise structure added");
  }
  if (ownerId) {
    const [doc] = await db.select({ id: schema.knowledgeDocuments.id }).from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.orgId, orgId)).limit(1);
    if (!doc) { const { loadDemoKnowledge } = await import("@/engine/brain/demo-content"); const r = await loadDemoKnowledge(orgId, ownerId); log(`upgrade: demo knowledge ${r.created} documents`); }
    const [emp] = await db.select({ id: schema.aiEmployees.id }).from(schema.aiEmployees).where(eq(schema.aiEmployees.orgId, orgId)).limit(1);
    if (!emp) {
      const { recommendations } = await import("@/engine/workforce/recommendations");
      const { provisionTeam } = await import("@/engine/workforce/core");
      const recs = await recommendations(orgId);
      const keys = [...new Set(recs.map((r) => r.persona.key))];
      const r = await provisionTeam(orgId, ownerId, keys.length ? keys : undefined);
      log(`upgrade: AI team provisioned (${r.created.length})`);
    }
  }
}
