import { eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { processMiningStatuses } from "@/engine/adapters/process-mining";
import { IntegrationsClient, type IntegrationRow } from "./integrations-client";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const ctx = await requireCtx("org:manage");
  const rows = await withTenant(ctx.orgId, (tx) => tx.select({ provider: schema.integrations.provider, status: schema.integrations.status, config: schema.integrations.config, lastCheckedAt: schema.integrations.lastCheckedAt, lastError: schema.integrations.lastError, credentialId: schema.integrations.credentialId }).from(schema.integrations).where(eq(schema.integrations.orgId, ctx.orgId)));
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const row = (p: string): IntegrationRow | null => { const r = byProvider.get(p as IntegrationRow["provider"]); return r ? { provider: r.provider as IntegrationRow["provider"], status: r.status, config: (r.config as Record<string, unknown>) ?? {}, lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null, lastError: r.lastError, hasCredential: !!r.credentialId } : null; };
  const n8nEnv = !!(process.env.N8N_BASE_URL && process.env.N8N_API_KEY);
  return (
    <IntegrationsClient
      n8n={{ row: row("n8n"), envConfigured: n8nEnv, envBaseUrl: n8nEnv ? String(process.env.N8N_BASE_URL) : null, vaultReady: !!process.env.VAULT_KEY }}
      anthropic={{ row: row("anthropic"), envConfigured: !!process.env.ANTHROPIC_API_KEY }}
      stripe={{ row: row("stripe"), envConfigured: !!process.env.STRIPE_SECRET_KEY, webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET, canBilling: can(ctx.role, "org:billing") }}
      mining={processMiningStatuses().map((s) => ({ ...s, row: row(s.provider) }))}
    />
  );
}
