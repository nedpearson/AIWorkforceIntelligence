"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Plug, Search, X, ExternalLink, RefreshCw, Unplug, KeyRound, ShieldCheck, Database, HeartPulse, Clock, TriangleAlert, Lock, CircleCheck, Hammer } from "lucide-react";
import { Button, Empty, Input, PageHeader, Table, Th, Td } from "@/components/ui";
import { KpiCard, FilterBar, SectionHeader, StatusPill, Drawer, type FilterDef, type Accent } from "@/components/ui/enterprise";
import { fmtNum, fmtUSD, cn } from "@/lib/utils";
import { CATEGORY_ACCENT } from "@/engine/connectors/catalog";
import type { ConnectorState } from "@/engine/connectors/service";
import { connectHubSpotAction, connectN8nAction, testConnectorAction, syncConnectorAction, disconnectConnectorAction } from "./actions";

const TILE: Record<Accent, string> = { royal: "bg-royal-soft text-royal-ink", purple: "bg-purple-soft text-purple-ink", cyan: "bg-cyan-soft text-cyan-ink", emerald: "bg-emerald-soft text-emerald-ink", gold: "bg-gold-soft text-gold-ink", coral: "bg-coral-soft text-coral-ink", indigo: "bg-indigo-soft text-indigo-ink", midnight: "bg-surface-2 text-ink" };
const STATUS_MAP: Record<string, Accent> = { connected: "emerald", configured: "purple", available: "royal", not_built: "midnight", license_required: "gold" };
const STATUS_LABEL: Record<string, string> = { connected: "connected", configured: "configured", available: "available", not_built: "not built", license_required: "license required" };
const HEALTH: Record<string, { label: string; cls: string }> = { healthy: { label: "Healthy", cls: "text-emerald-ink" }, failing: { label: "Failing", cls: "text-coral-ink" }, untested: { label: "Not yet tested", cls: "text-gold-ink" }, "n/a": { label: "—", cls: "text-ink-3" } };
const initials = (n: string) => n.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "never");
const ago = (iso: string | null) => { if (!iso) return "never"; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

export function Marketplace({ connectors, total, counts, filterDefs, vaultReady, initialOpen }: { connectors: ConnectorState[]; total: number; counts: { connected: number; configured: number; available: number; notBuilt: number; license: number; failing: number }; filterDefs: FilterDef[]; vaultReady: boolean; initialOpen: string | null }) {
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(initialOpen);
  const n = q.trim().toLowerCase();
  const shown = n ? connectors.filter((c) => `${c.name} ${c.vendor} ${c.category} ${c.api} ${c.dataAvailable.join(" ")}`.toLowerCase().includes(n)) : connectors;
  const current = connectors.find((c) => c.key === open) ?? null;
  return (
    <div className="space-y-5">
      <PageHeader hero eyebrow="Administration" icon={<Plug size={22} className="text-cyan-300" />} title="Integrations Marketplace"
        subtitle="Every system BridgeBox can connect to — with the exact API, authentication, data and permissions involved. Statuses are real: “connected” means a live request succeeded; “not built” means we have not written that connector yet."
        actions={<Button variant="glass" href="/app/settings/integrations" data-testid="mkt-to-settings"><KeyRound size={15} />Integration settings</Button>} />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5 stagger">
        <KpiCard testid="mkt-kpi-connected" label="Connected" value={counts.connected} format={(x) => fmtNum(x)} accent="emerald" icon={<CircleCheck size={16} />} caption="last live request succeeded" />
        <KpiCard testid="mkt-kpi-configured" label="Configured" value={counts.configured} format={(x) => fmtNum(x)} accent="purple" icon={<KeyRound size={16} />} caption={counts.failing ? `${counts.failing} failing` : "credentials present"} />
        <KpiCard testid="mkt-kpi-available" label="Ready to configure" value={counts.available} format={(x) => fmtNum(x)} accent="royal" icon={<Plug size={16} />} caption="connector code exists" />
        <KpiCard testid="mkt-kpi-license" label="License required" value={counts.license} format={(x) => fmtNum(x)} accent="gold" icon={<Lock size={16} />} caption="vendor license needed" />
        <KpiCard testid="mkt-kpi-notbuilt" label="Not built yet" value={counts.notBuilt} format={(x) => fmtNum(x)} accent="midnight" icon={<Hammer size={16} />} caption="catalog only — no fake connect" />
      </div>
      <FilterBar filters={filterDefs} testid="mkt-filter" extra={
        <label className="relative ml-auto flex min-w-0 flex-1 items-center sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-2.5 text-ink-3" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search systems, data…" aria-label="Search integrations" data-testid="mkt-search" className="h-8 w-full rounded-lg border border-border bg-surface pl-8 pr-7 text-xs focus:border-royal focus:outline-none" />
          {q && <button onClick={() => setQ("")} aria-label="Clear search" className="absolute right-2 text-ink-3 hover:text-ink"><X size={13} /></button>}
        </label>} />
      <SectionHeader accent="cyan" title="Connectors" subtitle={`${shown.length} of ${total}`} />
      {shown.length === 0 ? <Empty title="No integrations match" body="Clear the search or filters to see every connector." /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 stagger" data-testid="mkt-grid">
          {shown.map((c) => {
            const a = CATEGORY_ACCENT[c.category];
            return (
              <button key={c.key} type="button" onClick={() => setOpen(c.key)} className="card card-hover flex flex-col p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo" data-testid={`mkt-card-${c.key}`} aria-haspopup="dialog">
                <div className="flex items-start gap-3">
                  <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl font-display text-sm font-bold", TILE[a])} aria-hidden>{initials(c.name)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-1.5"><span className="text-sm font-bold">{c.name}</span><StatusPill status={c.status} map={STATUS_MAP} /></div>
                    <div className="text-[11px] text-ink-3">{c.vendor} · {c.category}</div>
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 text-xs text-ink-2">{c.purpose}</p>
                <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-3 text-[11px] text-ink-3">
                  <span className="inline-flex items-center gap-1"><Lock size={11} />{c.auth[0]}</span>
                  {c.health !== "n/a" && <span className={cn("inline-flex items-center gap-1 font-semibold", HEALTH[c.health].cls)}><HeartPulse size={11} />{HEALTH[c.health].label}</span>}
                  {c.lastSyncAt ? <span className="inline-flex items-center gap-1"><Clock size={11} />synced {ago(c.lastSyncAt)}</span> : c.lastCheckedAt ? <span className="inline-flex items-center gap-1"><Clock size={11} />checked {ago(c.lastCheckedAt)}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-ink-3">“Available” = connector code exists and can be configured here (or via server environment for Stripe, Anthropic and OIDC). “Not built” = documented here so you can plan; there is no connect button because there is nothing to connect yet. Agents can still call many of these APIs today through an HTTP step with a credential from the vault.</p>
      <Drawer open={!!current} onClose={() => setOpen(null)} title={current ? <span className="flex items-center gap-2">{current.name}<StatusPill status={current.status} map={STATUS_MAP} /></span> : ""} testid="mkt-drawer" width="max-w-2xl">
        {current && <ConnectorDetail c={current} vaultReady={vaultReady} />}
      </Drawer>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) { return <><dt className="text-ink-3">{k}</dt><dd className="min-w-0 break-words">{children}</dd></>; }

function ConnectorDetail({ c, vaultReady }: { c: ConnectorState; vaultReady: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(""); const [flash, setFlash] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [token, setToken] = React.useState(""); const [baseUrl, setBaseUrl] = React.useState(""); const [apiKey, setApiKey] = React.useState("");
  const a = CATEGORY_ACCENT[c.category];
  const run = async (k: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string; connected?: boolean }>) => {
    setBusy(k); setFlash(null); const r = await fn(); setBusy("");
    setFlash(r.ok ? { ok: r.connected !== false, text: r.message ?? "Done" } : { ok: false, text: r.error ?? "failed" }); router.refresh();
  };
  const lastSync = c.lastSync as null | { at: string; owners: number; contacts: number; deals: number; dealAmount: number; truncated?: boolean; pipelines: { id: string; label: string; deals: number; amount: number; stages: { id: string; label: string; probability: number | null; deals: number; amount: number }[] }[] };
  return (
    <div className="space-y-5" data-testid={`mkt-detail-${c.key}`}>
      <div className="flex items-start gap-3">
        <span className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-xl font-display font-bold", TILE[a])} aria-hidden>{initials(c.name)}</span>
        <div className="min-w-0"><div className="text-xs text-ink-3">{c.vendor} · {c.category}</div><p className="mt-1 text-sm text-ink-2">{c.purpose}</p></div>
      </div>
      {c.note && <p className={cn("rounded-xl px-3 py-2 text-xs", c.key === "hubspot" ? "bg-gold-soft text-gold-ink" : "bg-surface-2 text-ink-2")} data-testid="mkt-note">{c.note}</p>}
      {flash && <div className={cn("rounded-xl px-3 py-2 text-xs", flash.ok ? "bg-emerald-soft text-emerald-ink" : "bg-coral-soft text-coral-ink")} role="status" data-testid="mkt-flash">{flash.text}</div>}

      {c.status === "not_built" && (
        <div className="rounded-xl border border-dashed border-border p-4" data-testid="mkt-not-built">
          <div className="flex items-center gap-2 text-sm font-bold"><Hammer size={16} className="text-ink-3" />Not available yet</div>
          <p className="mt-1 text-xs text-ink-2">No BridgeBox connector exists for {c.name} yet, so there is nothing to connect. When built, it will: {c.purpose.replace(/^Would /, "").replace(/^would /, "")}</p>
          <a href={c.docsUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-royal-ink hover:underline" data-testid="mkt-docs"><ExternalLink size={12} />{c.vendor} API documentation</a>
        </div>
      )}
      {c.status === "license_required" && (
        <div className="rounded-xl border border-gold/40 bg-gold-soft/40 p-4 text-xs" data-testid="mkt-license">
          <div className="flex items-center gap-2 text-sm font-bold text-gold-ink"><Lock size={16} />License required</div>
          <p className="mt-1 text-ink-2">The import mapper for this vendor&apos;s documented export format is built; live API access needs a vendor license and tenant credentials. Set these on the server once licensed:</p>
          <EnvList c={c} />
        </div>
      )}
      {c.implemented === "env" && (
        <div className="rounded-xl border border-border p-4 text-xs" data-testid="mkt-env">
          <div className="text-sm font-bold">Server configuration</div>
          <p className="mt-1 text-ink-2">Configured through server environment variables only — keys are never accepted through this screen, stored in the database or shown.</p>
          <EnvList c={c} />
        </div>
      )}

      {c.key === "hubspot" && (
        <section className="space-y-3" data-testid="mkt-hubspot">
          <SectionHeader accent="royal" icon={<KeyRound size={15} />} title="Authentication" subtitle="HubSpot → Settings → Integrations → Private apps → create app with the scopes below → copy the access token." />
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void run("connect", () => connectHubSpotAction({ token })).then(() => setToken("")); }} data-testid="hubspot-form">
            <Input label={c.hasCredential ? "Replace private app token" : "Private app access token"} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="pat-na1-…" required minLength={10} disabled={!vaultReady} hint="Encrypted with AES-256-GCM in the credentials vault; never shown again. HubSpot agents can attach the same credential." data-testid="hubspot-token" />
            <Button type="submit" loading={busy === "connect"} disabled={!vaultReady || token.trim().length < 10} data-testid="hubspot-save">Save &amp; test</Button>
            {!vaultReady && <p className="text-[11px] text-coral-ink">VAULT_KEY is not set on the server; tokens cannot be stored encrypted.</p>}
          </form>
          {c.hasCredential && <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => run("test", () => testConnectorAction({ key: "hubspot" }))} loading={busy === "test"} data-testid="hubspot-test"><RefreshCw size={13} />Test connection</Button>
            <Button size="sm" variant="secondary" onClick={() => run("sync", () => syncConnectorAction({ key: "hubspot" }))} loading={busy === "sync"} data-testid="hubspot-sync"><Database size={13} />Sync now</Button>
            <Button size="sm" variant="ghost" onClick={() => confirm("Disconnect HubSpot? Synced counts are cleared; the token is deleted unless an active agent uses it.") && run("disc", () => disconnectConnectorAction({ key: "hubspot" }))} loading={busy === "disc"} data-testid="hubspot-disconnect"><Unplug size={13} />Disconnect</Button>
          </div>}
          {lastSync && <div data-testid="hubspot-last-sync">
            <div className="mb-2 grid grid-cols-3 gap-2 text-center">
              {[["Owners", lastSync.owners], ["Contacts", lastSync.contacts], ["Deals", lastSync.deals]].map(([k, v]) => <div key={String(k)} className="rounded-xl bg-surface-2 p-2"><div className="text-[10px] font-semibold uppercase text-ink-3">{k}</div><div className="font-display text-lg font-bold tabular">{fmtNum(Number(v))}</div></div>)}
            </div>
            {lastSync.pipelines.map((p) => <div key={p.id} className="mb-2">
              <div className="mb-1 text-xs font-semibold">{p.label} · {fmtNum(p.deals)} deals · {fmtUSD(p.amount, { compact: true })}</div>
              <Table><thead><tr><Th>Stage</Th><Th className="text-right">Probability</Th><Th className="text-right">Deals</Th><Th className="text-right">Amount</Th></tr></thead>
                <tbody>{p.stages.map((s) => <tr key={s.id}><Td className="text-xs">{s.label}</Td><Td className="text-right text-xs tabular">{s.probability == null ? "—" : `${Math.round(s.probability * 100)}%`}</Td><Td className="text-right text-xs tabular">{fmtNum(s.deals)}</Td><Td className="text-right text-xs tabular">{fmtUSD(s.amount)}</Td></tr>)}</tbody></Table>
            </div>)}
            <p className="text-[11px] text-ink-3">Counts and amounts only — no names, emails or other contact data are stored.{lastSync.truncated ? " Truncated at 5,000 records." : ""}</p>
          </div>}
        </section>
      )}

      {c.key === "n8n" && (
        <section className="space-y-3" data-testid="mkt-n8n">
          <SectionHeader accent="royal" icon={<KeyRound size={15} />} title="Authentication" subtitle="n8n → Settings → n8n API → create an API key." />
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void run("connect", () => connectN8nAction({ baseUrl, apiKey })).then(() => setApiKey("")); }} data-testid="n8n-form">
            <Input label="Base URL" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://n8n.yourcompany.com" required disabled={!vaultReady} data-testid="n8n-base-url" />
            <Input label={c.hasCredential ? "Replace API key" : "API key"} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required minLength={8} disabled={!vaultReady} hint="Stored encrypted in the credentials vault; on save we call GET /api/v1/workflows?limit=1 and record the real result." data-testid="n8n-api-key" />
            <Button type="submit" loading={busy === "connect"} disabled={!vaultReady} data-testid="n8n-save">Save &amp; test</Button>
          </form>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => run("test", () => testConnectorAction({ key: "n8n" }))} loading={busy === "test"} disabled={c.status === "available"} data-testid="n8n-test"><RefreshCw size={13} />Test connection</Button>
            {c.hasCredential && <Button size="sm" variant="ghost" onClick={() => confirm("Disconnect n8n? Agents with runtime n8n stop syncing until reconnected.") && run("disc", () => disconnectConnectorAction({ key: "n8n" }))} loading={busy === "disc"} data-testid="n8n-disconnect"><Unplug size={13} />Disconnect</Button>}
          </div>
          <EnvList c={c} />
        </section>
      )}

      <section>
        <SectionHeader accent="indigo" icon={<ShieldCheck size={15} />} title="API & permissions" />
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          <Row k="API">{c.api}</Row>
          <Row k="Authentication">{c.auth.join(" · ")}</Row>
          <Row k={c.implemented === "none" ? "Scopes we would request" : "Scopes requested"}><ul className="flex flex-wrap gap-1">{c.scopes.map((s) => <li key={s} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px]">{s}</li>)}</ul></Row>
          <Row k="Documentation"><a href={c.docsUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 break-all font-semibold text-royal-ink hover:underline" data-testid="mkt-docs-link"><ExternalLink size={11} />{c.docsUrl.replace(/^https:\/\//, "").slice(0, 60)}</a></Row>
        </dl>
      </section>
      <section>
        <SectionHeader accent="cyan" icon={<Database size={15} />} title="Data sources" />
        <ul className="space-y-1 text-xs text-ink-2">{c.dataAvailable.map((d) => <li key={d} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan" />{d}</li>)}</ul>
      </section>
      <section>
        <SectionHeader accent={c.health === "failing" ? "coral" : "emerald"} icon={<HeartPulse size={15} />} title="Sync status & health" />
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          <Row k="Status"><StatusPill status={c.status} map={STATUS_MAP} /> <span className="text-ink-3">{STATUS_LABEL[c.status]}</span></Row>
          <Row k="Health"><span className={cn("font-semibold", HEALTH[c.health].cls)}>{HEALTH[c.health].label}</span></Row>
          <Row k="Last checked">{when(c.lastCheckedAt)}</Row>
          <Row k="Last sync">{c.lastSyncAt ? `${when(c.lastSyncAt)} (${ago(c.lastSyncAt)})` : c.key === "hubspot" ? "never" : "no data sync for this connector"}</Row>
          {c.lastError && <Row k="Last error"><span className="inline-flex items-start gap-1 text-coral-ink" data-testid="mkt-last-error"><TriangleAlert size={12} className="mt-0.5 shrink-0" />{c.lastError}</span></Row>}
        </dl>
      </section>
    </div>
  );
}

function EnvList({ c }: { c: ConnectorState }) {
  const vars = Object.entries(c.envSet);
  if (!vars.length) return null;
  return <ul className="mt-2 space-y-1 text-xs">{vars.map(([k, v]) => <li key={k} className="flex items-center gap-2"><span className={cn("h-2 w-2 rounded-full", v ? "bg-emerald" : "bg-surface-3")} /><code className="break-all">{k}</code><span className="text-ink-3">{v ? "set" : "missing"}</span></li>)}</ul>;
}
