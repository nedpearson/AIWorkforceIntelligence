/**
 * Integrations Marketplace: catalog honesty + the HubSpot connector against a mocked fetch.
 * Asserts the exact request shapes from HubSpot's CRM v3 docs, 401 → error status, the token living only in the
 * vault (encrypted), and that NO contact / owner personal data is persisted by a sync.
 * (Not tested against a live HubSpot account — the UI says so.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { decrypt } from "@/lib/crypto";
import { CONNECTOR_CATALOG } from "@/engine/connectors/catalog";
import { testConnection, syncSummary, HubSpotError, HUBSPOT_API, type FetchLike } from "@/engine/connectors/hubspot";
import { connectHubSpot, testHubSpot, syncHubSpot, disconnectHubSpot, listConnectorStates } from "@/engine/connectors/service";

const TOKEN = "test-hubspot-token-not-real";
const PII = ["jane.doe@acme.example", "Jane", "Doe", "+1-225-555-0199", "owner.person@yourco.example", "Olivia Owner"];
type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function mockHubSpot(opts: { status?: number } = {}): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetchFn: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (opts.status) return json({ status: "error", message: "Authentication credentials not found.", category: "INVALID_AUTHENTICATION" }, opts.status);
    const u = new URL(url);
    if (u.pathname === "/crm/v3/objects/contacts" && u.searchParams.get("limit") === "1") return json({ results: [{ id: "1", properties: { email: PII[0], firstname: PII[1], lastname: PII[2], phone: PII[3] } }] });
    if (u.pathname === "/crm/v3/owners") {
      if (!u.searchParams.get("after")) return json({ results: [{ id: "o1", email: PII[4], firstName: "Olivia", lastName: "Owner" }, { id: "o2", email: "x@y.z" }], paging: { next: { after: "o2" } } });
      return json({ results: [{ id: "o3", email: "z@y.x" }] });
    }
    if (u.pathname === "/crm/v3/objects/contacts/search") return json({ total: 1234, results: [{ id: "1", properties: { email: PII[0] } }] });
    if (u.pathname === "/crm/v3/pipelines/deals") return json({ results: [{ id: "default", label: "Sales Pipeline", stages: [{ id: "appointmentscheduled", label: "Appointment scheduled", metadata: { probability: "0.2" } }, { id: "closedwon", label: "Closed won", metadata: { probability: "1.0" } }] }] });
    if (u.pathname === "/crm/v3/objects/deals") {
      if (!u.searchParams.get("after")) return json({ results: [{ id: "d1", properties: { amount: "1000", dealstage: "appointmentscheduled", pipeline: "default", dealname: "Acme — Jane Doe" } }, { id: "d2", properties: { amount: "2500.5", dealstage: "closedwon", pipeline: "default" } }], paging: { next: { after: "d2" } } });
      return json({ results: [{ id: "d3", properties: { amount: null, dealstage: "appointmentscheduled", pipeline: "default" } }] });
    }
    return json({ message: "not found" }, 404);
  };
  return { fetch: fetchFn, calls };
}

let orgId = "", userId = "";
beforeAll(async () => {
  const [o] = await db.insert(schema.organizations).values({ name: "Connectors Test", slug: `connectors-${Date.now()}`, isDemo: true }).returning();
  const [u] = await db.insert(schema.users).values({ email: `connectors-${Date.now()}@test.local` }).returning();
  orgId = o.id; userId = u.id;
});
afterAll(async () => {
  await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
});

describe("catalog", () => {
  it("lists every required system with docs, auth and scopes, and is honest about build state", () => {
    const keys = CONNECTOR_CATALOG.map((c) => c.key);
    for (const k of ["microsoft_365", "google_workspace", "salesforce", "hubspot", "sap", "oracle", "netsuite", "workday", "adp", "quickbooks", "servicenow", "slack", "teams", "sharepoint", "zendesk", "n8n", "stripe", "anthropic", "oidc", "scim", "power_automate", "uipath", "mimica", "celonis"]) expect(keys).toContain(k);
    for (const c of CONNECTOR_CATALOG) { expect(c.docsUrl).toMatch(/^https:\/\//); expect(c.auth.length).toBeGreaterThan(0); expect(c.scopes.length).toBeGreaterThan(0); expect(c.dataAvailable.length).toBeGreaterThan(0); }
    const built = CONNECTOR_CATALOG.filter((c) => c.implemented === "full" || c.implemented === "env").map((c) => c.key).sort();
    expect(built).toEqual(["anthropic", "hubspot", "n8n", "oidc", "stripe"]);
  });
  it("resolves statuses per org: not_built for catalog-only, license_required for adapters, env-driven for platform", async () => {
    const st = await listConnectorStates(orgId, { ANTHROPIC_API_KEY: "x" });
    const by = Object.fromEntries(st.map((s) => [s.key, s.status]));
    expect(by).toMatchObject({ salesforce: "not_built", sap: "not_built", celonis: "not_built", scim: "not_built", hubspot: "available", n8n: "available", anthropic: "configured", stripe: "available", oidc: "available", power_automate: "license_required", uipath: "license_required", mimica: "license_required" });
  });
});

describe("HubSpot connector (pure)", () => {
  it("testConnection sends GET /crm/v3/objects/contacts?limit=1 with the bearer token", async () => {
    const m = mockHubSpot();
    await expect(testConnection(TOKEN, m.fetch)).resolves.toMatchObject({ ok: true });
    expect(m.calls).toEqual([{ url: `${HUBSPOT_API}/crm/v3/objects/contacts?limit=1`, method: "GET", headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" }, body: undefined }]);
  });
  it("401 → HubSpotError with status 401, token never echoed", async () => {
    const m = mockHubSpot({ status: 401 });
    const err = await testConnection(TOKEN, m.fetch).catch((e) => e);
    expect(err).toBeInstanceOf(HubSpotError); expect(err.status).toBe(401); expect(err.message).toMatch(/401 \(token is invalid or revoked\)/); expect(err.message).not.toContain(TOKEN);
  });
  it("syncSummary paginates owners and deals, counts contacts via search total, aggregates per stage", async () => {
    const m = mockHubSpot();
    const s = await syncSummary(TOKEN, m.fetch, new Date("2026-11-07T00:00:00Z"));
    expect(s).toMatchObject({ at: "2026-11-07T00:00:00.000Z", owners: 3, contacts: 1234, deals: 3, dealAmount: 3500.5, truncated: false, requests: 6 });
    expect(s.pipelines).toEqual([{ id: "default", label: "Sales Pipeline", deals: 3, amount: 3500.5, stages: [{ id: "appointmentscheduled", label: "Appointment scheduled", probability: 0.2, deals: 2, amount: 1000 }, { id: "closedwon", label: "Closed won", probability: 1, deals: 1, amount: 2500.5 }] }]);
    expect(m.calls.map((c) => `${c.method} ${c.url.replace(HUBSPOT_API, "")}`)).toEqual([
      "GET /crm/v3/owners?limit=100", "GET /crm/v3/owners?limit=100&after=o2",
      "POST /crm/v3/objects/contacts/search",
      "GET /crm/v3/pipelines/deals",
      "GET /crm/v3/objects/deals?limit=100&properties=amount,dealstage,pipeline&archived=false", "GET /crm/v3/objects/deals?limit=100&properties=amount,dealstage,pipeline&archived=false&after=d2",
    ]);
    expect(m.calls[2].body).toEqual({ limit: 1, properties: ["hs_object_id"] });
    expect(m.calls[2].headers["content-type"]).toBe("application/json");
    for (const c of m.calls) expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const dump = JSON.stringify(s);
    for (const p of [...PII, "Acme — Jane Doe"]) expect(dump).not.toContain(p);
  });
});

describe("HubSpot connector (DB service)", () => {
  it("connect stores the token encrypted in the vault, tests it and marks connected; sync persists counts only", async () => {
    const m = mockHubSpot();
    const r = await connectHubSpot(orgId, userId, TOKEN, { fetch: m.fetch });
    expect(r.connected).toBe(true);
    const [row] = await db.select().from(schema.integrations).where(eq(schema.integrations.orgId, orgId));
    expect(row).toMatchObject({ provider: "hubspot", status: "connected", lastError: null, credentialId: r.credentialId });
    const [cred] = await db.select().from(schema.credentials).where(eq(schema.credentials.id, r.credentialId));
    expect(cred.provider).toBe("hubspot"); expect(cred.fields).toEqual(["accessToken"]);
    expect(cred.secretEnc).not.toContain(TOKEN); expect(JSON.parse(decrypt(cred.secretEnc))).toEqual({ accessToken: TOKEN });
    expect(JSON.stringify(row)).not.toContain(TOKEN);

    const s = await syncHubSpot(orgId, userId, { fetch: m.fetch });
    expect(s.ok).toBe(true);
    const [after] = await db.select().from(schema.integrations).where(eq(schema.integrations.orgId, orgId));
    const lastSync = (after.config as { lastSync: Record<string, unknown> }).lastSync;
    expect(lastSync).toMatchObject({ owners: 3, contacts: 1234, deals: 3, dealAmount: 3500.5 });
    const persisted = JSON.stringify(after);
    for (const p of [...PII, "Acme — Jane Doe", TOKEN]) expect(persisted).not.toContain(p);
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["integration.configured", "integration.tested", "integration.synced"]));
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
    const st = (await listConnectorStates(orgId, {})).find((x) => x.key === "hubspot")!;
    expect(st).toMatchObject({ status: "connected", health: "healthy", hasCredential: true }); expect(st.lastSyncAt).toBeTruthy();
  });

  it("401 on test or sync → integration status error with the reason recorded", async () => {
    const bad = mockHubSpot({ status: 401 });
    const t = await testHubSpot(orgId, userId, { fetch: bad.fetch });
    expect(t.connected).toBe(false); expect(t.message).toMatch(/401/);
    let [row] = await db.select().from(schema.integrations).where(eq(schema.integrations.orgId, orgId));
    expect(row.status).toBe("error"); expect(row.lastError).toMatch(/HubSpot 401/);
    expect((await listConnectorStates(orgId, {})).find((x) => x.key === "hubspot")).toMatchObject({ status: "configured", health: "failing" });
    const s = await syncHubSpot(orgId, userId, { fetch: bad.fetch });
    expect(s.ok).toBe(false);
    [row] = await db.select().from(schema.integrations).where(eq(schema.integrations.orgId, orgId));
    expect(row.status).toBe("error");
    // previous counts are kept (stale but labelled by their timestamp), never replaced by partial data
    expect((row.config as { lastSync?: { contacts: number } }).lastSync?.contacts).toBe(1234);
  });

  it("disconnect clears config and deletes the vault credential when no agent uses it", async () => {
    const [{ credentialId }] = await db.select({ credentialId: schema.integrations.credentialId }).from(schema.integrations).where(eq(schema.integrations.orgId, orgId));
    const r = await disconnectHubSpot(orgId, userId);
    expect(r.credentialDeleted).toBe(true);
    const [row] = await db.select().from(schema.integrations).where(eq(schema.integrations.orgId, orgId));
    expect(row).toMatchObject({ status: "not_configured", credentialId: null, config: {} });
    expect(await db.select().from(schema.credentials).where(eq(schema.credentials.id, credentialId!))).toHaveLength(0);
    expect((await testHubSpot(orgId, userId, { fetch: mockHubSpot().fetch })).connected).toBe(false);
  });
});
