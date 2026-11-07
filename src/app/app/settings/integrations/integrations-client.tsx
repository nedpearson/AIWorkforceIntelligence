"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Plug, RefreshCw, Unplug } from "lucide-react";
import { Badge, Button, Card, CardHeader, Input, Modal } from "@/components/ui";
import { cn } from "@/lib/utils";
import { disconnectN8n, saveN8n, testN8n } from "../actions";

export type IntegrationRow = { provider: "n8n" | "power_automate" | "uipath" | "mimica" | "stripe" | "oidc" | "anthropic"; status: "not_configured" | "configured" | "connected" | "error" | "license_required"; config: Record<string, unknown>; lastCheckedAt: string | null; lastError: string | null; hasCredential: boolean };
type Mining = { provider: "power_automate" | "uipath" | "mimica"; status: "license_required" | "not_configured" | "configured"; requirement: string; docsUrl: string; envVars: string[]; row: IntegrationRow | null };
const date = (s: string | null) => (s ? new Date(s).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "never");
const NAMES: Record<string, string> = { power_automate: "Power Automate Process Mining", uipath: "UiPath Task Mining", mimica: "Mimica Mapper" };

function StatusBadge({ status }: { status: string }) {
  const tone = status === "connected" ? "verified" : status === "configured" ? "info" : status === "error" ? "danger" : status === "license_required" ? "warn" : "neutral";
  return <Badge tone={tone}>{status.replace(/_/g, " ")}</Badge>;
}

export function IntegrationsClient({ n8n, anthropic, stripe, mining }: { n8n: { row: IntegrationRow | null; envConfigured: boolean; envBaseUrl: string | null; vaultReady: boolean }; anthropic: { row: IntegrationRow | null; envConfigured: boolean }; stripe: { row: IntegrationRow | null; envConfigured: boolean; webhookConfigured: boolean; canBilling: boolean }; mining: Mining[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false); const [baseUrl, setBaseUrl] = React.useState(String(n8n.row?.config.baseUrl ?? "")); const [apiKey, setApiKey] = React.useState("");
  const [busy, setBusy] = React.useState(""); const [flash, setFlash] = React.useState<{ ok: boolean; text: string } | null>(null);
  async function save(e: React.FormEvent) { e.preventDefault(); setBusy("save"); const r = await saveN8n({ baseUrl, apiKey }); setBusy(""); if (r.ok) { setOpen(false); setApiKey(""); setFlash({ ok: r.connected, text: r.connected ? `Saved and connected: ${r.message}` : `Saved, but the connection test failed: ${r.message}` }); router.refresh(); } else setFlash({ ok: false, text: r.error }); }
  async function test() { setBusy("test"); const r = await testN8n(); setBusy(""); if (r.ok) setFlash({ ok: r.connected, text: r.message }); else setFlash({ ok: false, text: r.error }); router.refresh(); }
  async function disconnect() { if (!confirm("Disconnect n8n? Agents with runtime n8n will stop syncing until it is reconnected.")) return; setBusy("disc"); const r = await disconnectN8n(); setBusy(""); setFlash(r.ok ? { ok: true, text: "n8n disconnected." } : { ok: false, text: r.error }); router.refresh(); }
  const n8nStatus = n8n.row?.status ?? (n8n.envConfigured ? "configured" : "not_configured");
  const anthropicStatus = anthropic.envConfigured ? "configured" : "not_configured";
  const stripeStatus = stripe.envConfigured ? (stripe.webhookConfigured ? "configured" : "error") : "not_configured";
  return (
    <div className="space-y-5" data-testid="integrations-page">
      {flash && <div className={cn("rounded-lg px-3 py-2 text-xs", flash.ok ? "bg-money-soft text-money" : "bg-danger-soft text-danger")} role="status" data-testid="integrations-flash">{flash.text}</div>}
      <p className="text-xs text-ink-2">Statuses are real: “connected” means a live request succeeded; nothing here reports success it has not verified.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card data-testid="integration-n8n">
          <CardHeader title={<span className="flex items-center gap-2"><Plug size={15} />n8n (agent runtime)</span>} subtitle="Runs agent workflows on your own n8n instance via its public REST API. Needs an n8n API key (Settings → n8n API in n8n)." action={<StatusBadge status={n8nStatus} />} />
          <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-xs">
            <dt className="text-ink-3">Base URL</dt><dd className="font-mono break-all">{String(n8n.row?.config.baseUrl ?? n8n.envBaseUrl ?? "—")}</dd>
            <dt className="text-ink-3">Source</dt><dd>{n8n.row?.hasCredential ? "API key in the credentials vault" : n8n.envConfigured ? "Server env (N8N_BASE_URL / N8N_API_KEY)" : "not set"}</dd>
            <dt className="text-ink-3">Last checked</dt><dd>{date(n8n.row?.lastCheckedAt ?? null)}</dd>
            {n8n.row?.lastError && <><dt className="text-ink-3">Last error</dt><dd className="text-danger" data-testid="integration-n8n-error">{n8n.row.lastError}</dd></>}
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setOpen(true)} disabled={!n8n.vaultReady} data-testid="n8n-configure">{n8n.row?.hasCredential ? "Replace API key" : "Connect n8n"}</Button>
            <Button size="sm" variant="secondary" onClick={test} loading={busy === "test"} disabled={n8nStatus === "not_configured" && !n8n.envConfigured} data-testid="n8n-test"><RefreshCw size={13} />Test connection</Button>
            {n8n.row?.hasCredential && <Button size="sm" variant="ghost" onClick={disconnect} loading={busy === "disc"} data-testid="n8n-disconnect"><Unplug size={13} />Disconnect</Button>}
          </div>
          {!n8n.vaultReady && <p className="mt-2 text-[11px] text-danger">VAULT_KEY is not set; the API key cannot be stored encrypted.</p>}
        </Card>
        <Card data-testid="integration-anthropic">
          <CardHeader title="Anthropic (AI model)" subtitle="Powers free-form answers in Ask BridgeBox and the LLM step inside agents. Model: claude-sonnet-4-5." action={<StatusBadge status={anthropicStatus} />} />
          <p className="text-xs text-ink-2">The key is read from the server environment variable <code>ANTHROPIC_API_KEY</code> only. It is never accepted through this screen, stored in the database or shown here.{anthropic.row?.lastCheckedAt && <> Last checked {date(anthropic.row.lastCheckedAt)}.</>}</p>
          {!anthropic.envConfigured && <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-ink-2" data-testid="anthropic-howto">Set <code>ANTHROPIC_API_KEY</code> on the server and restart. Until then, Ask BridgeBox answers in evidence-retrieval mode and agent LLM steps are skipped (recorded as such, never faked).</p>}
        </Card>
        <Card data-testid="integration-stripe">
          <CardHeader title="Stripe (billing)" subtitle="Subscriptions and invoices for this organization. Keys live in the server environment." action={<StatusBadge status={stripeStatus} />} />
          <ul className="space-y-1 text-xs">{[["STRIPE_SECRET_KEY", stripe.envConfigured], ["STRIPE_WEBHOOK_SECRET", stripe.webhookConfigured]].map(([k, v]) => <li key={String(k)} className="flex items-center gap-2"><span className={cn("h-2 w-2 rounded-full", v ? "bg-verified" : "bg-ink-3")} /><code>{String(k)}</code><span className="text-ink-3">{v ? "set" : "missing"}</span></li>)}</ul>
          {stripe.envConfigured && !stripe.webhookConfigured && <p className="mt-2 text-[11px] text-danger">Secret key is set but the webhook secret is missing: invoice and subscription updates will not sync.</p>}
          <div className="mt-3">{stripe.canBilling ? <Button size="sm" variant="secondary" href="/admin/billing" data-testid="stripe-billing-link"><ExternalLink size={13} />Open billing</Button> : <p className="text-[11px] text-ink-3">Billing is managed by the organization owner.</p>}</div>
        </Card>
        {mining.map((m) => (
          <Card key={m.provider} data-testid={`integration-${m.provider}`}>
            <CardHeader title={NAMES[m.provider]} subtitle="Process-mining import: pulls discovered processes into Workflows as observed data." action={<StatusBadge status={m.row?.status ?? m.status} />} />
            <p className="text-xs text-ink-2">{m.requirement}</p>
            <p className="mt-2 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] text-ink-3">Environment variables: {m.envVars.map((v) => <code key={v} className="break-all">{v}</code>)}</p>
            <p className="mt-1 text-[11px] text-ink-3">Without a license you can still export processes to JSON from the vendor UI and import them (see docs/INTEGRATIONS.md). Last checked {date(m.row?.lastCheckedAt ?? null)}.</p>
            <div className="mt-3"><a href={m.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline" data-testid={`${m.provider}-docs`}><ExternalLink size={12} />Vendor documentation</a></div>
          </Card>
        ))}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Connect n8n">
        <form onSubmit={save} className="space-y-3" data-testid="n8n-form">
          <Input label="Base URL" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://n8n.yourcompany.com" required data-testid="n8n-base-url" />
          <Input label="API key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required minLength={8} autoComplete="off" hint="Stored encrypted in the credentials vault (AES-256-GCM); never shown again." data-testid="n8n-api-key" />
          <p className="text-[11px] text-ink-3">On save we call <code>GET /api/v1/workflows?limit=1</code> with your key and record the real result.</p>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={busy === "save"} data-testid="n8n-save">Save & test</Button></div>
        </form>
      </Modal>
    </div>
  );
}
