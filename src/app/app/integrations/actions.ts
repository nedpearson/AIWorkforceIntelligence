"use server";
/** Integrations Marketplace actions. zod-validated, org:manage, tenant-scoped, audited (inside the connector service). */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { connectHubSpot, testHubSpot, syncHubSpot, disconnectHubSpot } from "@/engine/connectors/service";
import { saveN8n, testN8n, disconnectN8n } from "@/app/app/settings/actions";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): Result<never> => ({ ok: false, error });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const refresh = () => { revalidatePath("/app/integrations"); revalidatePath("/app/settings/integrations"); };
const KeyInput = z.object({ key: z.enum(["hubspot", "n8n"]) });

const HubSpotInput = z.object({ token: z.string().trim().min(10, "paste the full private app token").max(4000) });
export async function connectHubSpotAction(raw: unknown): Promise<Result<{ connected: boolean; message: string }>> {
  const ctx = await requireCtx("org:manage");
  const p = HubSpotInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid input");
  try { const r = await connectHubSpot(ctx.orgId, ctx.userId, p.data.token); refresh(); return { ok: true, connected: r.connected, message: r.message }; }
  catch (e) { return fail(/VAULT_KEY|key/i.test(msg(e)) ? `vault unavailable: ${msg(e)} (set VAULT_KEY)` : msg(e)); }
}

const N8nInput = z.object({ baseUrl: z.string().trim().url().max(500), apiKey: z.string().trim().min(8).max(4000) });
export async function connectN8nAction(raw: unknown): Promise<Result<{ connected: boolean; message: string }>> {
  await requireCtx("org:manage");
  const p = N8nInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid input");
  const r = await saveN8n(p.data); refresh(); return r;
}

export async function testConnectorAction(raw: unknown): Promise<Result<{ connected: boolean; message: string }>> {
  const ctx = await requireCtx("org:manage");
  const p = KeyInput.safeParse(raw); if (!p.success) return fail("this connector has nothing to test here");
  if (p.data.key === "n8n") { const r = await testN8n(); refresh(); return r; }
  const r = await testHubSpot(ctx.orgId, ctx.userId); refresh(); return { ok: true, ...r };
}

export async function syncConnectorAction(raw: unknown): Promise<Result<{ message: string }>> {
  const ctx = await requireCtx("org:manage");
  const p = KeyInput.safeParse(raw); if (!p.success) return fail("invalid input");
  if (p.data.key !== "hubspot") return fail("n8n has no data sync — import executions from each n8n agent's page");
  const r = await syncHubSpot(ctx.orgId, ctx.userId); refresh();
  return r.ok ? { ok: true, message: `Synced: ${r.summary.owners} owners, ${r.summary.contacts} contacts, ${r.summary.deals} deals in ${r.summary.pipelines.length} pipeline(s)${r.summary.truncated ? " (truncated at 5,000)" : ""}.` } : fail(r.error);
}

export async function disconnectConnectorAction(raw: unknown): Promise<Result<{ message: string }>> {
  const ctx = await requireCtx("org:manage");
  const p = KeyInput.safeParse(raw); if (!p.success) return fail("invalid input");
  if (p.data.key === "n8n") { const r = await disconnectN8n(); refresh(); return r.ok ? { ok: true, message: "n8n disconnected." } : r; }
  const r = await disconnectHubSpot(ctx.orgId, ctx.userId); refresh();
  return { ok: true, message: r.credentialDeleted ? "HubSpot disconnected and its token deleted from the vault." : "HubSpot disconnected. The token stays in the vault because an active agent still uses it." };
}
