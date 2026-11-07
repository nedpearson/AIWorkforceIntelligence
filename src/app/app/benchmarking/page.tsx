import { and, eq } from "drizzle-orm";
import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { withTenant } from "@/db/tenant";
import { db, schema } from "@/db/client";
import { computeBenchmarks, type EntityType } from "@/engine/benchmark";
import { BenchmarkingClient, type DatasetRow } from "./benchmarking-client";

export const metadata = { title: "Benchmarking" };
export const dynamic = "force-dynamic";

export default async function BenchmarkingPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const ctx = await requireCtx("workflows:read");
  const sp = await searchParams;
  // Portfolio comparison only for consultancy staff: the consultancy itself, or a consultant acting inside one of its clients.
  // Cross-org lookup uses the admin handle and is restricted to children of the verified consultancy.
  let consultancyId: string | null = null;
  if (ctx.orgKind === "consultancy" && ["owner", "admin", "consultant"].includes(ctx.role)) consultancyId = ctx.orgId;
  else if (ctx.role === "consultant") { const [o] = await db.select({ parent: schema.organizations.parentOrgId }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1); consultancyId = o?.parent ?? null; }
  const portfolio = consultancyId ? await db.select({ id: schema.organizations.id, name: schema.organizations.name }).from(schema.organizations).where(and(eq(schema.organizations.parentOrgId, consultancyId), eq(schema.organizations.kind, "client"))) : [];
  const [bm, datasets] = await Promise.all([
    computeBenchmarks(ctx.orgId, { portfolioOrgIds: portfolio }),
    withTenant(ctx.orgId, (tx) => tx.select().from(schema.benchmarkDatasets).where(eq(schema.benchmarkDatasets.orgId, ctx.orgId))),
  ]);
  const rows: DatasetRow[] = datasets.map((d) => ({ id: d.id, name: d.name, source: d.source, sourceUrl: d.sourceUrl, publishedAt: d.publishedAt?.toISOString() ?? null, sampleDescription: d.sampleDescription, applicability: d.applicability, metrics: d.metrics, createdAt: d.createdAt.toISOString() }));
  const available = (Object.keys(bm.sets) as EntityType[]).filter((k) => (bm.sets[k]?.entities.length ?? 0) > 0);
  const initial = (available.includes(sp.type as EntityType) ? sp.type : available[0] ?? "department") as EntityType;
  return <BenchmarkingClient bm={bm} datasets={rows} initialType={initial} canManage={can(ctx.role, "org:manage")} />;
}
