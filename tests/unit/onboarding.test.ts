/**
 * Onboarding engine tests. Requires DATABASE_URL pointing at a scratch DB (bridgebox_f), never the seeded default:
 *   DATABASE_URL=postgresql://bridgebox:bridgebox@localhost:5432/bridgebox_f npx vitest run tests/unit/onboarding.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { createClientOrg, acceptInvitation, lookupInvitation, parseEmployeeCsv, assertClientOfConsultancy, createInvitation, OnboardingError } from "@/engine/onboarding";

const T = Date.now();
const ids = { consA: "", consB: "", ownerA: "", clientA: "", clientDemo: "", clientCsv: "" };
const orgsToDelete: string[] = []; const usersToDelete: string[] = [];

beforeAll(async () => {
  process.env.VAULT_KEY ??= Buffer.alloc(32, 7).toString("base64");
  const [a] = await db.insert(schema.organizations).values({ name: `Consultancy A ${T}`, slug: `cons-a-${T}`, kind: "consultancy", branding: { reportName: "A Advisory", primaryColor: "#123456" } }).returning();
  const [b] = await db.insert(schema.organizations).values({ name: `Consultancy B ${T}`, slug: `cons-b-${T}`, kind: "consultancy" }).returning();
  ids.consA = a.id; ids.consB = b.id; orgsToDelete.push(a.id, b.id);
  const [u] = await db.insert(schema.users).values({ email: `owner-a-${T}@test.local`, name: "Owner A", passwordHash: await bcrypt.hash("Password!1234", 4) }).returning();
  ids.ownerA = u.id; usersToDelete.push(u.id);
  await db.insert(schema.memberships).values({ userId: u.id, orgId: a.id, role: "owner" });
});
afterAll(async () => {
  if (orgsToDelete.length) await db.delete(schema.organizations).where(inArray(schema.organizations.id, orgsToDelete));
  if (usersToDelete.length) await db.delete(schema.users).where(inArray(schema.users.id, usersToDelete));
  await db.delete(schema.jobs).where(and(eq(schema.jobs.kind, "analysis"), inArray(schema.jobs.orgId, orgsToDelete)));
});

describe("parseEmployeeCsv", () => {
  it("parses rows with an optional header and reports bad lines", () => {
    const { rows, errors } = parseEmployeeCsv('name,email,title,department,baseAnnualCost\nDana W,dana@x.com,AP,Finance,"52,000"\n"Lee, Tom",,Clerk,Ops,44000\nNoCost,n@x.com,Mgr,Ops,\nBad,notanemail,,,1');
    expect(errors).toEqual(["Line 5: \"notanemail\" is not an email address"]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ name: "Dana W", email: "dana@x.com", title: "AP", department: "Finance", baseAnnualCost: 52000 });
    expect(rows[1].name).toBe("Lee, Tom"); expect(rows[1].email).toBeNull();
    expect(rows[2].baseAnnualCost).toBeNull();
  });
});

describe("createClientOrg", () => {
  it("creates org + trial subscription + model + integrations + owner invitation (audited)", async () => {
    const r = await createClientOrg({ consultancyId: ids.consA, name: `Acme Client ${T}`, industry: "Dental", adminEmail: `admin-${T}@acme.test`, plan: "growth", actorUserId: ids.ownerA, appUrl: "http://localhost:3103" });
    ids.clientA = r.orgId; orgsToDelete.push(r.orgId);
    expect(r.inviteUrl).toBe(`http://localhost:3103/invite/${r.inviteToken}`);
    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, r.orgId));
    expect(org.kind).toBe("client"); expect(org.parentOrgId).toBe(ids.consA); expect(org.isDemo).toBe(false);
    expect(org.branding?.reportName).toBe("A Advisory"); // inherits consultancy white-label defaults
    const d = await withTenant(r.orgId, async (tx) => ({
      sub: (await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, r.orgId)))[0],
      model: await tx.select().from(schema.financialModels).where(eq(schema.financialModels.orgId, r.orgId)),
      integ: await tx.select().from(schema.integrations).where(eq(schema.integrations.orgId, r.orgId)),
      inv: (await tx.select().from(schema.invitations).where(eq(schema.invitations.orgId, r.orgId)))[0],
    }));
    expect(d.sub.status).toBe("trialing"); expect(d.sub.plan).toBe("growth"); expect(d.sub.seats).toBe(50); expect(d.sub.agentSlots).toBe(10);
    expect(d.sub.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    expect(d.model).toHaveLength(1); expect(d.model[0].isDefault).toBe(true);
    const st = Object.fromEntries(d.integ.map((i) => [i.provider, i.status]));
    expect(st).toEqual({ n8n: "not_configured", stripe: "not_configured", anthropic: "not_configured", power_automate: "license_required", uipath: "license_required", mimica: "license_required" });
    expect(d.inv.role).toBe("owner"); expect(d.inv.email).toBe(`admin-${T}@acme.test`); expect(d.inv.acceptedAt).toBeNull();
    const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, "client.created"), eq(schema.auditLog.entityId, r.orgId)));
    expect(audits).toHaveLength(1); expect(audits[0].orgId).toBe(ids.consA);
  });

  it("imports CSV employees into departments", async () => {
    const { rows } = parseEmployeeCsv("A One,a@x.test,AP,Finance,52000\nB Two,b@x.test,Clerk,Ops,44000\nC Three,,Clerk,ops,");
    const r = await createClientOrg({ consultancyId: ids.consA, name: `CSV Client ${T}`, adminEmail: `csv-${T}@x.test`, plan: "starter", seats: 12, employees: rows });
    ids.clientCsv = r.orgId; orgsToDelete.push(r.orgId);
    expect(r.employeesCreated).toBe(3); expect(r.departmentsCreated).toBe(2);
    const emps = await withTenant(r.orgId, (tx) => tx.select().from(schema.employees).where(eq(schema.employees.orgId, r.orgId)));
    expect(emps).toHaveLength(3);
    const a = emps.find((e) => e.displayName === "A One")!;
    expect(Number(a.loadedHourlyCost)).toBeCloseTo((52000 * 1.3) / 1920, 2); expect(a.costBasis).toBe("observed");
    expect(emps.find((e) => e.displayName === "C Three")!.costBasis).toBe("assumed");
    const [sub] = await withTenant(r.orgId, (tx) => tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, r.orgId)));
    expect(sub.seats).toBe(12);
  });

  it("demo path creates employees, events, simulated collectors, marks isDemo and enqueues analysis", async () => {
    const r = await createClientOrg({ consultancyId: ids.consA, name: `Demo Client ${T}`, adminEmail: `demo-${T}@x.test`, plan: "starter", demo: true, actorUserId: ids.ownerA });
    ids.clientDemo = r.orgId; orgsToDelete.push(r.orgId);
    expect(r.demo).not.toBeNull(); expect(r.demo!.events).toBeGreaterThan(500); expect(r.demo!.collectors).toBe(6);
    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, r.orgId));
    expect(org.isDemo).toBe(true); expect(org.name).toMatch(/Synthetic Demo/);
    const d = await withTenant(r.orgId, async (tx) => ({
      emps: await tx.select().from(schema.employees).where(eq(schema.employees.orgId, r.orgId)),
      events: await tx.select({ id: schema.activityEvents.id }).from(schema.activityEvents).where(eq(schema.activityEvents.orgId, r.orgId)),
      cols: await tx.select().from(schema.collectors).where(eq(schema.collectors.orgId, r.orgId)),
      consents: await tx.select().from(schema.consentRecords).where(eq(schema.consentRecords.orgId, r.orgId)),
      camps: await tx.select().from(schema.observationCampaigns).where(eq(schema.observationCampaigns.orgId, r.orgId)),
    }));
    expect(d.emps).toHaveLength(6); expect(d.events.length).toBe(r.demo!.events); expect(d.cols.every((c) => c.platform === "simulated" && c.status === "active")).toBe(true);
    expect(d.consents).toHaveLength(6); expect(d.camps).toHaveLength(1);
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, r.demo!.analysisJobId));
    expect(job.kind).toBe("analysis"); expect(job.status).toBe("queued"); expect(job.payload).toMatchObject({ orgId: r.orgId, campaignId: r.demo!.campaignId });
  });

  it("rejects bad input", async () => {
    await expect(createClientOrg({ consultancyId: ids.consA, name: "X", adminEmail: "a@b.co", plan: "starter" })).rejects.toThrow(/too short/);
    await expect(createClientOrg({ consultancyId: ids.consA, name: "Valid Name", adminEmail: "nope", plan: "starter" })).rejects.toThrow(/email/);
    await expect(createClientOrg({ consultancyId: ids.clientA, name: "Valid Name", adminEmail: "a@b.co", plan: "starter" })).rejects.toThrow(/Consultancy not found/);
  });
});

describe("tenancy", () => {
  it("consultancy B cannot read a client of consultancy A (parent check throws)", async () => {
    await expect(assertClientOfConsultancy(ids.consB, ids.clientA)).rejects.toThrow(OnboardingError);
    await expect(assertClientOfConsultancy(ids.consB, ids.clientA)).rejects.toMatchObject({ code: "forbidden" });
    const ok = await assertClientOfConsultancy(ids.consA, ids.clientA);
    expect(ok.id).toBe(ids.clientA);
    // a consultancy is not a client of itself, and a client cannot be the parent
    await expect(assertClientOfConsultancy(ids.consA, ids.consA)).rejects.toThrow();
    await expect(assertClientOfConsultancy(ids.clientA, ids.clientCsv)).rejects.toThrow();
    await expect(assertClientOfConsultancy(ids.consA, "not-a-uuid")).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("invitations", () => {
  it("new user: lookup → accept creates user + membership, marks accepted, audited; second use rejected", async () => {
    const [inv] = await withTenant(ids.clientA, (tx) => tx.select().from(schema.invitations).where(eq(schema.invitations.orgId, ids.clientA)));
    // we need the raw token: create a fresh invitation we control
    const fresh = await createInvitation({ orgId: ids.clientA, email: `newowner-${T}@acme.test`, role: "owner", invitedBy: ids.ownerA, appUrl: "http://localhost:3103" });
    const look = await lookupInvitation(fresh.token);
    expect(look.ok && look.userExists).toBe(false); expect(look.ok && look.orgName).toMatch(/Acme Client/);
    await expect(acceptInvitation({ token: fresh.token, mode: "new", name: "New Owner", password: "short" })).rejects.toThrow(/10 characters/);
    const r = await acceptInvitation({ token: fresh.token, mode: "new", name: "New Owner", password: "LongEnoughPassword1" });
    usersToDelete.push(r.userId);
    expect(r.orgId).toBe(ids.clientA); expect(r.role).toBe("owner");
    const m = await withTenant(ids.clientA, (tx) => tx.select().from(schema.memberships).where(and(eq(schema.memberships.orgId, ids.clientA), eq(schema.memberships.userId, r.userId))));
    expect(m).toHaveLength(1); expect(m[0].role).toBe("owner");
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, r.userId));
    expect(await bcrypt.compare("LongEnoughPassword1", u.passwordHash!)).toBe(true);
    const after = await lookupInvitation(fresh.token);
    expect(after).toEqual({ ok: false, reason: "accepted" });
    await expect(acceptInvitation({ token: fresh.token, mode: "new", name: "Again", password: "LongEnoughPassword1" })).rejects.toMatchObject({ code: "accepted" });
    const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, "invitation.accepted"), eq(schema.auditLog.entityId, fresh.invitationId)));
    expect(audits).toHaveLength(1);
    expect(inv.acceptedAt).toBeNull(); // the original wizard invitation is still open
  });

  it("existing user: email must match; employeeId is linked on accept", async () => {
    const [emp] = await withTenant(ids.clientCsv, (tx) => tx.select().from(schema.employees).where(eq(schema.employees.orgId, ids.clientCsv)).limit(1));
    const email = `existing-${T}@x.test`;
    const [u] = await db.insert(schema.users).values({ email, name: "Existing", passwordHash: await bcrypt.hash("Password!1234", 4) }).returning(); usersToDelete.push(u.id);
    const inv = await createInvitation({ orgId: ids.clientCsv, email, role: "manager", employeeId: emp.id, invitedBy: ids.ownerA });
    const look = await lookupInvitation(inv.token); expect(look.ok && look.userExists).toBe(true);
    await expect(acceptInvitation({ token: inv.token, mode: "new", name: "Dup", password: "LongEnoughPassword1" })).rejects.toMatchObject({ code: "exists" });
    await expect(acceptInvitation({ token: inv.token, mode: "existing", userId: ids.ownerA })).rejects.toMatchObject({ code: "forbidden" });
    const r = await acceptInvitation({ token: inv.token, mode: "existing", userId: u.id });
    const [m] = await withTenant(ids.clientCsv, (tx) => tx.select().from(schema.memberships).where(eq(schema.memberships.id, r.membershipId)));
    expect(m.role).toBe("manager"); expect(m.employeeId).toBe(emp.id);
    const [e2] = await withTenant(ids.clientCsv, (tx) => tx.select().from(schema.employees).where(eq(schema.employees.id, emp.id)));
    expect(e2.userId).toBe(u.id);
  });

  it("expired and unknown tokens are rejected", async () => {
    expect(await lookupInvitation("nope")).toEqual({ ok: false, reason: "not_found" });
    expect(await lookupInvitation("x".repeat(40))).toEqual({ ok: false, reason: "not_found" });
    const inv = await createInvitation({ orgId: ids.clientA, email: `exp-${T}@x.test`, role: "viewer" });
    await withTenant(ids.clientA, (tx) => tx.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invitations.id, inv.invitationId)));
    expect(await lookupInvitation(inv.token)).toEqual({ ok: false, reason: "expired" });
    await expect(acceptInvitation({ token: inv.token, mode: "new", name: "Late", password: "LongEnoughPassword1" })).rejects.toMatchObject({ code: "expired" });
  });
});
