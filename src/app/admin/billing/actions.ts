"use server";
import { revalidatePath } from "next/cache";
import { requireConsultant, listClients } from "../_lib";
import { stripeConfig, syncSubscriptionFromStripe } from "@/engine/billing";
import { audit } from "@/lib/audit";

export type SyncAllResult = { ok: true; synced: { client: string; status: string; invoices: number }[]; skipped: { client: string; reason: string }[] } | { ok: false; error: string; missing?: string[] };
/** Sync every Stripe-linked client subscription. Clients without a Stripe subscription are listed as skipped, never faked. */
export async function syncAllStripe(): Promise<SyncAllResult> {
  const { ctx, consultancy } = await requireConsultant();
  const cfg = stripeConfig(); if (!cfg.ok) return { ok: false, error: cfg.reason, missing: cfg.missing };
  const clients = await listClients(consultancy.id);
  const synced: { client: string; status: string; invoices: number }[] = []; const skipped: { client: string; reason: string }[] = [];
  for (const c of clients) {
    const r = await syncSubscriptionFromStripe(c.id, ctx.userId);
    if (r.ok) synced.push({ client: c.name, status: r.status, invoices: r.invoices }); else skipped.push({ client: c.name, reason: r.reason });
  }
  await audit({ orgId: consultancy.id, actorUserId: ctx.userId, action: "billing.sync_all", details: { synced: synced.length, skipped: skipped.length } });
  revalidatePath("/admin/billing"); revalidatePath("/admin");
  return { ok: true, synced, skipped };
}
