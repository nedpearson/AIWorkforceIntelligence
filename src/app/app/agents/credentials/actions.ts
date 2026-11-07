"use server";
/** Credentials vault actions. Values are encrypted with AES-256-GCM (VAULT_KEY) and never returned after save. */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { encrypt } from "@/lib/crypto";
import { CREDENTIAL_PRESETS } from "./presets";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): Result<never> => ({ ok: false, error });


const CreateInput = z.object({ name: z.string().min(2).max(120), provider: z.enum(["smtp", "http_bearer", "quickbooks", "hubspot", "n8n", "zendesk"]), values: z.record(z.string().min(1).max(64), z.string().max(4000)) });
export async function createCredential(raw: unknown): Promise<Result<{ id: string }>> {
  const ctx = await requireCtx("credentials:manage");
  const p = CreateInput.safeParse(raw); if (!p.success) return fail(p.error.issues[0]?.message ?? "invalid");
  const preset = CREDENTIAL_PRESETS[p.data.provider];
  const values: Record<string, string> = {};
  for (const f of preset.fields) { const v = (p.data.values[f.name] ?? "").trim(); if (!v) return fail(`${f.label} is required`); values[f.name] = v; }
  // Zendesk basic auth is "email/token:token" — store the composed user so the runner's basic auth works.
  if (p.data.provider === "zendesk") values.email = values.email.endsWith("/token") ? values.email : `${values.email}/token`;
  let secretEnc: string;
  try { secretEnc = encrypt(JSON.stringify(values)); } catch (e) { return fail(`vault unavailable: ${e instanceof Error ? e.message : String(e)} (set VAULT_KEY)`); }
  const id = await withTenant(ctx.orgId, async (tx) => (await tx.insert(schema.credentials).values({ orgId: ctx.orgId, name: p.data.name, provider: p.data.provider, secretEnc, fields: Object.keys(values), createdBy: ctx.userId }).returning({ id: schema.credentials.id }))[0].id);
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "credential.created", entityType: "credential", entityId: id, details: { provider: p.data.provider, fields: Object.keys(values) } });
  revalidatePath("/app/agents/credentials"); revalidatePath("/app/agents/new");
  return { ok: true, id };
}

const IdInput = z.object({ id: z.string().uuid() });
export async function deleteCredential(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("credentials:manage");
  const p = IdInput.safeParse(raw); if (!p.success) return fail("invalid input");
  let n = 0;
  try { n = await withTenant(ctx.orgId, async (tx) => {
    const agents = await tx.select({ id: schema.agents.id, credentialIds: schema.agents.credentialIds, status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.orgId, ctx.orgId));
    const inUse = agents.filter((a) => a.status !== "retired" && (a.credentialIds ?? []).includes(p.data.id));
    if (inUse.length) throw new Error(`in use by ${inUse.length} active agent(s) — detach or retire them first`);
    return (await tx.delete(schema.credentials).where(and(eq(schema.credentials.id, p.data.id), eq(schema.credentials.orgId, ctx.orgId))).returning({ id: schema.credentials.id })).length;
  }); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  if (!n) return fail("credential not found");
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "credential.deleted", entityType: "credential", entityId: p.data.id });
  revalidatePath("/app/agents/credentials");
  return { ok: true };
}
