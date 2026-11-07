/**
 * Connector service — DB orchestration for the Integrations Marketplace.
 *
 *  - listConnectorStates(orgId, env?)  → catalog + honest live status per connector for this org
 *  - connectHubSpot(orgId, userId, token, deps?) → stores the token in the credentials vault (AES-256-GCM), upserts
 *                                        the `integrations` row, tests it and records the real result
 *  - testHubSpot / syncHubSpot / disconnectHubSpot
 *
 * Every DB access runs in withTenant(orgId). Sync persists COUNTS ONLY into integrations.config.lastSync.
 * Status mapping: integrations.status "connected" → connected, "configured"/"error" → configured (with health
 * "failing" + lastError for error), connector code present but nothing stored → available, catalog-only →
 * not_built, adapter needing a vendor license → license_required.
 */
import { and, eq } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { encrypt, decrypt } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { processMiningStatuses } from "@/engine/adapters/process-mining";
import { CONNECTOR_CATALOG, type CatalogEntry, type ConnectorStatus } from "./catalog";
import { testConnection as hsTest, syncSummary as hsSync, HubSpotError, type FetchLike, type HubSpotSyncSummary } from "./hubspot";

export type ConnectorHealth = "healthy" | "failing" | "untested" | "n/a";
export type ConnectorState = CatalogEntry & {
  status: ConnectorStatus; health: ConnectorHealth; dbStatus: string | null;
  lastCheckedAt: string | null; lastError: string | null; lastSync: Record<string, unknown> | null; lastSyncAt: string | null;
  envSet: Record<string, boolean>; hasCredential: boolean; configurable: boolean;
};
type Deps = { fetch?: FetchLike; now?: Date };
type IntegrationProvider = (typeof schema.integrationProvider.enumValues)[number];

export async function listConnectorStates(orgId: string, env: Record<string, string | undefined> = process.env): Promise<ConnectorState[]> {
  const rows = await withTenant(orgId, (tx) => tx.select().from(schema.integrations).where(eq(schema.integrations.orgId, orgId)));
  const byProvider = new Map(rows.map((r) => [r.provider as string, r]));
  const pm = new Map(processMiningStatuses().map((s) => [s.provider as string, s]));
  return CONNECTOR_CATALOG.map((c) => {
    const row = c.provider ? byProvider.get(c.provider) : undefined;
    const envSet = Object.fromEntries((c.envVars ?? []).map((v) => [v, !!env[v]]));
    const allEnv = (c.envVars ?? []).length > 0 && Object.values(envSet).every(Boolean);
    const cfg = (row?.config ?? {}) as Record<string, unknown>;
    const lastSync = (cfg.lastSync as Record<string, unknown> | undefined) ?? null;
    let status: ConnectorStatus; let health: ConnectorHealth = "n/a";
    if (c.implemented === "none") status = "not_built";
    else if (c.implemented === "adapter") status = row?.status === "configured" || row?.status === "connected" ? (row.status as ConnectorStatus) : (pm.get(c.key)?.status === "configured" ? "configured" : "license_required");
    else if (c.implemented === "env") {
      const primary = c.key === "stripe" ? !!env.STRIPE_SECRET_KEY : c.key === "anthropic" ? !!env.ANTHROPIC_API_KEY : c.key === "oidc" ? !!(env.OIDC_ISSUER && env.OIDC_CLIENT_ID) : allEnv;
      status = primary ? (row?.status === "connected" ? "connected" : "configured") : "available";
      health = primary ? (row?.status === "error" ? "failing" : row?.status === "connected" ? "healthy" : "untested") : "n/a";
    } else {
      // full: HubSpot / n8n
      const stored = !!row?.credentialId || (c.key === "n8n" && allEnv);
      if (!stored) status = "available";
      else status = row?.status === "connected" ? "connected" : "configured";
      health = !stored ? "n/a" : row?.status === "error" ? "failing" : row?.status === "connected" ? "healthy" : "untested";
    }
    const docsUrl = pm.get(c.key)?.docsUrl ?? c.docsUrl;
    return {
      ...c, docsUrl, status, health, dbStatus: row?.status ?? null,
      lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null, lastError: row?.lastError ?? null,
      lastSync, lastSyncAt: typeof lastSync?.at === "string" ? lastSync.at : null,
      envSet, hasCredential: !!row?.credentialId, configurable: c.implemented === "full",
      note: c.implemented === "adapter" ? (pm.get(c.key)?.requirement ?? c.note) : c.note,
    };
  });
}

async function upsertIntegration(orgId: string, provider: IntegrationProvider, patch: Partial<typeof schema.integrations.$inferInsert>) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx.select({ id: schema.integrations.id }).from(schema.integrations).where(and(eq(schema.integrations.orgId, orgId), eq(schema.integrations.provider, provider))).limit(1);
    if (row) { await tx.update(schema.integrations).set({ ...patch, updatedAt: new Date() }).where(eq(schema.integrations.id, row.id)); return row.id; }
    const [ins] = await tx.insert(schema.integrations).values({ orgId, provider, ...patch }).returning({ id: schema.integrations.id });
    return ins.id;
  });
}

async function hubspotToken(orgId: string): Promise<{ token: string; credentialId: string } | null> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx.select({ credentialId: schema.integrations.credentialId }).from(schema.integrations).where(and(eq(schema.integrations.orgId, orgId), eq(schema.integrations.provider, "hubspot"))).limit(1);
    if (!row?.credentialId) return null;
    const [cred] = await tx.select().from(schema.credentials).where(and(eq(schema.credentials.id, row.credentialId), eq(schema.credentials.orgId, orgId))).limit(1);
    if (!cred) return null;
    let token = ""; try { const s = JSON.parse(decrypt(cred.secretEnc)); token = String(s.accessToken ?? s.token ?? ""); } catch { token = ""; }
    return token ? { token, credentialId: cred.id } : null;
  });
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Store token (vault) → test → record real status. Replaces a previous integration-owned token. */
export async function connectHubSpot(orgId: string, userId: string | null, token: string, deps: Deps = {}): Promise<{ connected: boolean; message: string; credentialId: string }> {
  const t = token.trim();
  if (t.length < 10 || t.length > 4000) throw new Error("token looks invalid");
  const secretEnc = encrypt(JSON.stringify({ accessToken: t }));
  const credentialId = await withTenant(orgId, async (tx) => {
    const [cred] = await tx.insert(schema.credentials).values({ orgId, name: "HubSpot private app (Integrations)", provider: "hubspot", secretEnc, fields: ["accessToken"], createdBy: userId }).returning({ id: schema.credentials.id });
    const [row] = await tx.select({ id: schema.integrations.id, credentialId: schema.integrations.credentialId, config: schema.integrations.config }).from(schema.integrations).where(and(eq(schema.integrations.orgId, orgId), eq(schema.integrations.provider, "hubspot"))).limit(1);
    const config = { ...((row?.config as Record<string, unknown>) ?? {}), source: "integration" };
    if (row) {
      await tx.update(schema.integrations).set({ credentialId: cred.id, config, status: "configured", lastError: null, updatedAt: new Date() }).where(eq(schema.integrations.id, row.id));
      if (row.credentialId) await deleteCredentialIfUnused(tx, orgId, row.credentialId);
    } else await tx.insert(schema.integrations).values({ orgId, provider: "hubspot", credentialId: cred.id, config, status: "configured" });
    return cred.id;
  });
  await audit({ orgId, actorUserId: userId, action: "integration.configured", entityType: "integration", entityId: "hubspot", details: { credentialId } });
  const r = await testHubSpot(orgId, userId, deps);
  return { ...r, credentialId };
}

export async function testHubSpot(orgId: string, userId: string | null, deps: Deps = {}): Promise<{ connected: boolean; message: string }> {
  const tok = await hubspotToken(orgId);
  if (!tok) return { connected: false, message: "HubSpot is not configured — add a private app token first." };
  const now = deps.now ?? new Date();
  try {
    const r = await hsTest(tok.token, deps.fetch ?? fetch);
    await upsertIntegration(orgId, "hubspot", { status: "connected", lastCheckedAt: now, lastError: null });
    await withTenant(orgId, (tx) => tx.update(schema.credentials).set({ lastUsedAt: now }).where(eq(schema.credentials.id, tok.credentialId)));
    await audit({ orgId, actorUserId: userId, action: "integration.tested", entityType: "integration", entityId: "hubspot", details: { ok: true } });
    return { connected: true, message: r.message };
  } catch (e) {
    const message = errMsg(e);
    await upsertIntegration(orgId, "hubspot", { status: "error", lastCheckedAt: now, lastError: message.slice(0, 500) });
    await audit({ orgId, actorUserId: userId, action: "integration.tested", entityType: "integration", entityId: "hubspot", details: { ok: false, status: e instanceof HubSpotError ? e.status : null, reason: message.slice(0, 300) } });
    return { connected: false, message };
  }
}

/** Sync counts into integrations.config.lastSync. No contact / owner personal data is persisted. */
export async function syncHubSpot(orgId: string, userId: string | null, deps: Deps = {}): Promise<{ ok: true; summary: HubSpotSyncSummary } | { ok: false; error: string }> {
  const tok = await hubspotToken(orgId);
  if (!tok) return { ok: false, error: "HubSpot is not configured — add a private app token first." };
  const now = deps.now ?? new Date();
  try {
    const summary = await hsSync(tok.token, deps.fetch ?? fetch, now);
    // Whitelist the persisted shape explicitly (defence in depth against future fields carrying PII).
    const lastSync = { at: summary.at, owners: summary.owners, contacts: summary.contacts, deals: summary.deals, dealAmount: summary.dealAmount, truncated: summary.truncated, requests: summary.requests,
      pipelines: summary.pipelines.map((p) => ({ id: p.id, label: p.label, deals: p.deals, amount: p.amount, stages: p.stages.map((s) => ({ id: s.id, label: s.label, probability: s.probability, deals: s.deals, amount: s.amount })) })) };
    const cur = await withTenant(orgId, async (tx) => (await tx.select({ config: schema.integrations.config }).from(schema.integrations).where(and(eq(schema.integrations.orgId, orgId), eq(schema.integrations.provider, "hubspot"))).limit(1))[0]);
    await upsertIntegration(orgId, "hubspot", { status: "connected", lastCheckedAt: now, lastError: null, config: { ...((cur?.config as Record<string, unknown>) ?? {}), lastSync } });
    await audit({ orgId, actorUserId: userId, action: "integration.synced", entityType: "integration", entityId: "hubspot", details: { owners: summary.owners, contacts: summary.contacts, deals: summary.deals, pipelines: summary.pipelines.length, requests: summary.requests } });
    return { ok: true, summary };
  } catch (e) {
    const message = errMsg(e);
    await upsertIntegration(orgId, "hubspot", { status: "error", lastCheckedAt: now, lastError: message.slice(0, 500) });
    await audit({ orgId, actorUserId: userId, action: "integration.sync_failed", entityType: "integration", entityId: "hubspot", details: { status: e instanceof HubSpotError ? e.status : null, reason: message.slice(0, 300) } });
    return { ok: false, error: message };
  }
}

async function deleteCredentialIfUnused(tx: Parameters<Parameters<typeof withTenant>[1]>[0], orgId: string, credentialId: string) {
  const agents = await tx.select({ credentialIds: schema.agents.credentialIds, status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.orgId, orgId));
  const inUse = agents.some((a) => a.status !== "retired" && (a.credentialIds ?? []).includes(credentialId));
  if (!inUse) await tx.delete(schema.credentials).where(and(eq(schema.credentials.id, credentialId), eq(schema.credentials.orgId, orgId)));
  return !inUse;
}

/** Unlink the token and clear synced counts. The vault credential is deleted unless an active agent still uses it. */
export async function disconnectHubSpot(orgId: string, userId: string | null): Promise<{ credentialDeleted: boolean }> {
  const r = await withTenant(orgId, async (tx) => {
    const [row] = await tx.select({ id: schema.integrations.id, credentialId: schema.integrations.credentialId }).from(schema.integrations).where(and(eq(schema.integrations.orgId, orgId), eq(schema.integrations.provider, "hubspot"))).limit(1);
    if (!row) return { credentialDeleted: false };
    await tx.update(schema.integrations).set({ credentialId: null, config: {}, status: "not_configured", lastError: null, updatedAt: new Date() }).where(eq(schema.integrations.id, row.id));
    return { credentialDeleted: row.credentialId ? await deleteCredentialIfUnused(tx, orgId, row.credentialId) : false };
  });
  await audit({ orgId, actorUserId: userId, action: "integration.disconnected", entityType: "integration", entityId: "hubspot", details: r });
  return r;
}
