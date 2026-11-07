import { desc, eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { CredentialsClient } from "./credentials-client";

export const metadata = { title: "Credentials" };
export const dynamic = "force-dynamic";

export default async function CredentialsPage() {
  const ctx = await requireCtx("credentials:manage");
  const data = await withTenant(ctx.orgId, async (tx) => {
    const creds = await tx.select({ id: schema.credentials.id, name: schema.credentials.name, provider: schema.credentials.provider, fields: schema.credentials.fields, lastUsedAt: schema.credentials.lastUsedAt, createdAt: schema.credentials.createdAt }).from(schema.credentials).where(eq(schema.credentials.orgId, ctx.orgId)).orderBy(desc(schema.credentials.createdAt));
    const agents = await tx.select({ id: schema.agents.id, name: schema.agents.name, credentialIds: schema.agents.credentialIds, status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.orgId, ctx.orgId));
    return { creds, agents };
  });
  const rows = data.creds.map((c) => ({ id: c.id, name: c.name, provider: c.provider, fields: c.fields ?? [], lastUsedAt: c.lastUsedAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(), usedBy: data.agents.filter((a) => a.status !== "retired" && (a.credentialIds ?? []).includes(c.id)).map((a) => a.name) }));
  return <CredentialsClient rows={rows} vaultReady={!!process.env.VAULT_KEY} />;
}
