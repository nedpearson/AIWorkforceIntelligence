/**
 * HubSpot connector (private app token). Implemented against HubSpot's published CRM v3 API documentation;
 * NOT yet exercised against a live HubSpot account — the UI says so.
 *
 *   testConnection: GET  https://api.hubapi.com/crm/v3/objects/contacts?limit=1
 *   sync:           GET  /crm/v3/owners?limit=100[&after=…]                         → owner COUNT
 *                   POST /crm/v3/objects/contacts/search {limit:1, properties:[hs_object_id]} → `total` (contact COUNT)
 *                   GET  /crm/v3/pipelines/deals                                    → pipelines + stage labels/probability
 *                   GET  /crm/v3/objects/deals?limit=100&properties=amount,dealstage,pipeline[&after=…] → per-stage count + Σ amount
 *
 * Privacy: the summary keeps counts, stage labels and amounts only. Owner names/emails and contact properties are
 * never read into the summary and never persisted (asserted by tests/unit/connectors.test.ts).
 * Pure apart from `fetch` (injectable). No DB.
 */
export const HUBSPOT_API = "https://api.hubapi.com";
const MAX_PAGES = 50; // 5,000 deals / owners — the summary says when it was truncated
const TIMEOUT_MS = 15_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export class HubSpotError extends Error {
  constructor(message: string, public readonly status: number | null, public readonly category?: string) { super(message); this.name = "HubSpotError"; }
}
export type HubSpotStage = { id: string; label: string; probability: number | null; deals: number; amount: number };
export type HubSpotPipeline = { id: string; label: string; stages: HubSpotStage[]; deals: number; amount: number };
export type HubSpotSyncSummary = {
  at: string; owners: number; contacts: number; deals: number; dealAmount: number;
  pipelines: HubSpotPipeline[]; truncated: boolean; requests: number;
};

async function call(fetchFn: FetchLike, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${HUBSPOT_API}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) { throw new HubSpotError(`request failed: ${e instanceof Error ? e.message : String(e)}`, null); }
  const text = await res.text();
  let json: unknown = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const j = (json ?? {}) as { message?: string; category?: string };
    const hint = res.status === 401 ? "token is invalid or revoked" : res.status === 403 ? "token is missing a required scope" : res.status === 429 ? "HubSpot rate limit reached — try again shortly" : "";
    // Never echo the token; HubSpot error bodies do not include it, but strip it defensively.
    const msg = (j.message ?? text.slice(0, 200)).split(token).join("[redacted]");
    throw new HubSpotError(`HubSpot ${res.status}${hint ? ` (${hint})` : ""}: ${msg}`, res.status, j.category);
  }
  return json;
}

/** One cheap authenticated read. 401 → HubSpotError(status 401). */
export async function testConnection(token: string, fetchFn: FetchLike = fetch): Promise<{ ok: true; message: string }> {
  if (!token || token.length < 10) throw new HubSpotError("token looks empty or too short", null);
  await call(fetchFn, token, "/crm/v3/objects/contacts?limit=1");
  return { ok: true, message: "HubSpot accepted the token (GET /crm/v3/objects/contacts?limit=1 returned 200)." };
}

type Paged<T> = { results?: T[]; paging?: { next?: { after?: string } } };

export async function syncSummary(token: string, fetchFn: FetchLike = fetch, now: Date = new Date()): Promise<HubSpotSyncSummary> {
  let requests = 0, truncated = false;
  const req = async (path: string, init?: { method?: string; body?: unknown }) => { requests++; return call(fetchFn, token, path, init); };

  // Owners: count only (owner records contain names/emails — we only take results.length).
  let owners = 0;
  { let after: string | undefined; let pages = 0;
    do { const r = (await req(`/crm/v3/owners?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`)) as Paged<unknown>; owners += r.results?.length ?? 0; after = r.paging?.next?.after; pages++; if (after && pages >= MAX_PAGES) { truncated = true; break; } } while (after); }

  // Contacts: the search endpoint returns `total`; we request a single id property and discard results.
  const cs = (await req("/crm/v3/objects/contacts/search", { method: "POST", body: { limit: 1, properties: ["hs_object_id"] } })) as { total?: number };
  const contacts = Number(cs.total ?? 0) || 0;

  // Pipelines & stages.
  const pl = (await req("/crm/v3/pipelines/deals")) as { results?: { id: string; label: string; stages?: { id: string; label: string; metadata?: { probability?: string } }[] }[] };
  const pipelines: HubSpotPipeline[] = (pl.results ?? []).map((p) => ({ id: String(p.id), label: String(p.label), deals: 0, amount: 0,
    stages: (p.stages ?? []).map((s) => ({ id: String(s.id), label: String(s.label), probability: s.metadata?.probability != null && s.metadata.probability !== "" ? Number(s.metadata.probability) : null, deals: 0, amount: 0 })) }));
  const stageIndex = new Map<string, HubSpotStage>(); const pipeIndex = new Map(pipelines.map((p) => [p.id, p]));
  for (const p of pipelines) for (const s of p.stages) stageIndex.set(`${p.id}:${s.id}`, s);

  // Deals: amount + stage + pipeline only.
  let deals = 0, dealAmount = 0;
  { let after: string | undefined; let pages = 0;
    do {
      const r = (await req(`/crm/v3/objects/deals?limit=100&properties=amount,dealstage,pipeline&archived=false${after ? `&after=${encodeURIComponent(after)}` : ""}`)) as Paged<{ properties?: { amount?: string | null; dealstage?: string | null; pipeline?: string | null } }>;
      for (const d of r.results ?? []) {
        const amt = Number(d.properties?.amount ?? 0) || 0; deals++; dealAmount += amt;
        const pid = String(d.properties?.pipeline ?? ""); const sid = String(d.properties?.dealstage ?? "");
        const st = stageIndex.get(`${pid}:${sid}`); if (st) { st.deals++; st.amount += amt; }
        const p = pipeIndex.get(pid); if (p) { p.deals++; p.amount += amt; }
      }
      after = r.paging?.next?.after; pages++; if (after && pages >= MAX_PAGES) { truncated = true; break; }
    } while (after);
  }
  return { at: now.toISOString(), owners, contacts, deals, dealAmount: Math.round(dealAmount * 100) / 100, pipelines, truncated, requests };
}
