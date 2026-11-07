/**
 * AI Brain — connected knowledge sources.
 *
 *  listBrainSources(orgId)                 → every source the Brain can learn from, with an honest status
 *  syncBrainSource(orgId, userId, key)     → "bridgebox": deriveFactsFromPlatform (pending facts)
 *                                            "hubspot":   pipeline/stage summary of the connected HubSpot portal → pending facts
 *                                            anything else → { ok:false, error: "not connected" } (never a fake success)
 *  ensureSource(orgId, kind, name, provider?) → knowledge_sources row id (upserts by kind+name), used by uploads too.
 *
 * Nothing synced here is approved automatically: every fact lands in the review queue.
 */
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { deriveFactsFromPlatform, proposeFact } from "./index";
import { syncHubSpot } from "@/engine/connectors/service";
import { fmtUSD } from "@/lib/utils";

export type BrainSourceKey = "bridgebox" | "upload" | "manual" | "hubspot" | "sharepoint" | "google_workspace" | "salesforce" | "zendesk" | "quickbooks" | "servicenow";
export type BrainSource = {
  key: BrainSourceKey; name: string; description: string;
  status: "connected" | "available" | "not_connected" | "not_built";
  statusDetail: string; syncable: boolean; lastSyncedAt: string | null; items: number; href?: string;
};

const EXTERNAL: { key: BrainSourceKey; name: string; provider: string; description: string }[] = [
  { key: "sharepoint", name: "SharePoint / OneDrive", provider: "sharepoint", description: "Policies and SOPs stored in Microsoft 365 document libraries." },
  { key: "google_workspace", name: "Google Drive", provider: "google_workspace", description: "Docs and Sheets shared with the company." },
  { key: "salesforce", name: "Salesforce", provider: "salesforce", description: "Account, product and pricing records." },
  { key: "zendesk", name: "Zendesk", provider: "zendesk", description: "Help-center articles and macros." },
  { key: "quickbooks", name: "QuickBooks", provider: "quickbooks", description: "Vendor list, payment terms and chart of accounts." },
  { key: "servicenow", name: "ServiceNow", provider: "servicenow", description: "Knowledge-base articles and service catalog." },
];

export async function ensureSource(orgId: string, kind: string, name: string, provider: string | null = null, userId: string | null = null): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [s] = await tx.select({ id: schema.knowledgeSources.id }).from(schema.knowledgeSources).where(and(eq(schema.knowledgeSources.orgId, orgId), eq(schema.knowledgeSources.kind, kind), eq(schema.knowledgeSources.name, name))).limit(1);
    if (s) return s.id;
    const [n] = await tx.insert(schema.knowledgeSources).values({ orgId, kind, name, integrationProvider: provider, createdBy: userId }).returning({ id: schema.knowledgeSources.id });
    return n.id;
  });
}
async function touchSource(orgId: string, id: string, config: Record<string, unknown>) {
  await withTenant(orgId, (tx) => tx.update(schema.knowledgeSources).set({ lastSyncedAt: new Date(), config }).where(and(eq(schema.knowledgeSources.id, id), eq(schema.knowledgeSources.orgId, orgId))));
}

export async function listBrainSources(orgId: string): Promise<BrainSource[]> {
  const d = await withTenant(orgId, async (tx) => {
    const sources = await tx.select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.orgId, orgId));
    const integ = await tx.select({ provider: schema.integrations.provider, status: schema.integrations.status, credentialId: schema.integrations.credentialId }).from(schema.integrations).where(eq(schema.integrations.orgId, orgId));
    const docs = await tx.select({ sourceId: schema.knowledgeDocuments.sourceId, createdBy: schema.knowledgeDocuments.createdBy }).from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.orgId, orgId));
    const facts = await tx.select({ sourceRef: schema.brainFacts.sourceRef }).from(schema.brainFacts).where(eq(schema.brainFacts.orgId, orgId));
    return { sources, integ, docs, facts };
  });
  const src = (kind: string, name?: string) => d.sources.find((s) => s.kind === kind && (!name || s.name === name));
  const bb = src("bridgebox"); const up = src("upload"); const man = src("manual"); const hs = src("integration", "HubSpot");
  const hsInteg = d.integ.find((i) => i.provider === "hubspot");
  const hsConnected = !!hsInteg?.credentialId && (hsInteg.status === "connected" || hsInteg.status === "configured");
  const iso = (x: Date | null | undefined) => (x ? x.toISOString() : null);
  const out: BrainSource[] = [
    { key: "bridgebox", name: "BridgeBox platform data", description: "Departments, headcount, locations, systems in use and observed workflows — proposed as facts for review.", status: "connected", statusDetail: "Built in", syncable: true, lastSyncedAt: iso(bb?.lastSyncedAt), items: d.facts.filter((f) => f.sourceRef?.startsWith("bridgebox:")).length },
    { key: "upload", name: "Uploaded files", description: "TXT, Markdown, CSV, HTML, JSON, Word and PDF files added in the Library.", status: "connected", statusDetail: "Built in", syncable: false, lastSyncedAt: iso(up?.lastSyncedAt), items: up ? d.docs.filter((x) => x.sourceId === up.id).length : 0 },
    { key: "manual", name: "Pasted text & manual facts", description: "Text pasted into the Library and facts typed into Business memory.", status: "connected", statusDetail: "Built in", syncable: false, lastSyncedAt: iso(man?.lastSyncedAt), items: (man ? d.docs.filter((x) => x.sourceId === man.id).length : 0) + d.facts.filter((f) => !f.sourceRef).length },
    { key: "hubspot", name: "HubSpot CRM", description: "Deal pipelines and stages (counts and totals only — no contact data) proposed as sales facts.", status: hsConnected ? "connected" : "not_connected", statusDetail: hsConnected ? "Connected via Integrations" : "Not connected — add a HubSpot private app token under Integrations", syncable: hsConnected, lastSyncedAt: iso(hs?.lastSyncedAt), items: d.facts.filter((f) => f.sourceRef?.startsWith("hubspot:")).length, href: "/app/integrations" },
    ...EXTERNAL.map((e): BrainSource => ({ key: e.key, name: e.name, description: e.description, status: "not_built", statusDetail: "Not connected — knowledge sync for this system is not available yet. Export the documents and upload them to the Library instead.", syncable: false, lastSyncedAt: null, items: 0, href: "/app/integrations" })),
  ];
  return out;
}

export type SyncResult = { ok: true; proposed: number; created: number; message: string } | { ok: false; error: string };

export async function syncBrainSource(orgId: string, userId: string | null, key: string, deps: { hubspotSync?: typeof syncHubSpot } = {}): Promise<SyncResult> {
  if (key === "bridgebox") {
    const id = await ensureSource(orgId, "bridgebox", "BridgeBox platform", null, userId);
    const r = await deriveFactsFromPlatform(orgId, userId);
    await touchSource(orgId, id, { proposed: r.proposed, created: r.created });
    await audit({ orgId, actorUserId: userId, action: "brain.source_synced", entityType: "knowledge_source", entityId: id, details: { source: "bridgebox", ...r } });
    return { ok: true, ...r, message: r.created ? `${r.created} new fact${r.created === 1 ? "" : "s"} proposed from BridgeBox data — review them in the queue.` : `Checked ${r.proposed} facts — nothing new to propose.` };
  }
  if (key === "hubspot") {
    const sync = await (deps.hubspotSync ?? syncHubSpot)(orgId, userId);
    let summary: { at: string; deals: number; dealAmount: number; pipelines: { id: string; label: string; deals: number; amount: number; stages: { label: string; deals: number; amount: number; probability: number | null }[] }[] } | null = sync.ok ? sync.summary : null;
    if (!summary) {
      // fall back to the last stored sync (counts only) when a live refresh fails
      const row = await withTenant(orgId, async (tx) => (await tx.select({ config: schema.integrations.config, credentialId: schema.integrations.credentialId }).from(schema.integrations).where(and(eq(schema.integrations.orgId, orgId), eq(schema.integrations.provider, "hubspot"))).limit(1))[0]);
      const last = (row?.config as Record<string, unknown> | undefined)?.lastSync as typeof summary | undefined;
      if (!row?.credentialId || !last) return { ok: false, error: sync.ok ? "HubSpot returned no data" : `HubSpot is not connected: ${sync.error}` };
      summary = last;
    }
    const id = await ensureSource(orgId, "integration", "HubSpot", "hubspot", userId);
    const asOf = summary.at.slice(0, 10);
    let created = 0; let proposed = 0;
    for (const p of summary.pipelines) {
      proposed++;
      const stages = p.stages.map((s) => `${s.label} (${s.deals} deal${s.deals === 1 ? "" : "s"}, ${fmtUSD(s.amount)}${s.probability != null ? `, ${Math.round(s.probability * 100)}% win probability` : ""})`).join("; ");
      const r = await proposeFact(orgId, userId, { category: "customer", subject: `Sales pipeline: ${p.label}`, statement: `HubSpot pipeline "${p.label}" had ${p.deals} open deal${p.deals === 1 ? "" : "s"} worth ${fmtUSD(p.amount)} as of ${asOf}. Stages in order: ${stages || "none"}.`, sourceRef: `hubspot:pipeline:${p.id}`, confidence: "derived" });
      if (!r.duplicate) created++;
    }
    await touchSource(orgId, id, { pipelines: summary.pipelines.length, deals: summary.deals, at: summary.at, live: sync.ok });
    await audit({ orgId, actorUserId: userId, action: "brain.source_synced", entityType: "knowledge_source", entityId: id, details: { source: "hubspot", proposed, created, live: sync.ok } });
    return { ok: true, proposed, created, message: `${created} pipeline fact${created === 1 ? "" : "s"} proposed from HubSpot${sync.ok ? "" : " (last stored sync — live refresh failed)"}.` };
  }
  const ext = EXTERNAL.find((e) => e.key === key);
  return { ok: false, error: ext ? `${ext.name} is not connected — knowledge sync for it is not available yet.` : "Unknown source" };
}
