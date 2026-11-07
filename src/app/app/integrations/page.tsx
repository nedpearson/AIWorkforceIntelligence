import { requireCtx } from "@/lib/session";
import { listConnectorStates } from "@/engine/connectors/service";
import { CONNECTOR_CATEGORIES } from "@/engine/connectors/catalog";
import { Marketplace } from "./marketplace";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

const STATUSES = [{ value: "connected", label: "Connected" }, { value: "configured", label: "Configured" }, { value: "available", label: "Available" }, { value: "license_required", label: "License required" }, { value: "not_built", label: "Not built yet" }];

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("org:manage");
  const sp = await searchParams;
  const all = await listConnectorStates(ctx.orgId);
  const category = sp.category && (CONNECTOR_CATEGORIES as string[]).includes(sp.category) ? sp.category : "";
  const status = sp.status && STATUSES.some((s) => s.value === sp.status) ? sp.status : "";
  const shown = all.filter((c) => (!category || c.category === category) && (!status || c.status === status));
  const counts = { connected: all.filter((c) => c.status === "connected").length, configured: all.filter((c) => c.status === "configured").length, available: all.filter((c) => c.status === "available").length, notBuilt: all.filter((c) => c.status === "not_built").length, license: all.filter((c) => c.status === "license_required").length, failing: all.filter((c) => c.health === "failing").length };
  const filterDefs = [
    { key: "category", label: "Category", all: "All categories", options: CONNECTOR_CATEGORIES.map((c) => ({ value: c, label: c })) },
    { key: "status", label: "Status", all: "All statuses", options: STATUSES },
  ];
  return <Marketplace connectors={shown} total={all.length} counts={counts} filterDefs={filterDefs} vaultReady={!!process.env.VAULT_KEY} initialOpen={sp.open ?? null} />;
}
