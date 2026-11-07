"use server";
/**
 * External benchmark datasets. Never bundled — each row must cite source, URL, publication date, sample and
 * applicability. Permission org:manage; audited.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/session";
import { withTenant } from "@/db/tenant";
import { schema } from "@/db/client";
import { audit } from "@/lib/audit";
import { METRICS } from "@/engine/benchmark";

type Result = { ok: true; id: string } | { ok: false; error: string };
const KEYS = METRICS.map((m) => m.key) as [string, ...string[]];
const Input = z.object({
  name: z.string().trim().min(3, "Name is required").max(200),
  source: z.string().trim().min(2, "Source (publisher) is required").max(200),
  sourceUrl: z.string().trim().url("A valid source URL is required").refine((u) => /^https?:\/\//i.test(u), "Source URL must be http(s)"),
  publishedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Published date is required"),
  sampleDescription: z.string().trim().min(10, "Describe the sample (who, how many, when) — at least 10 characters").max(2000),
  applicability: z.string().trim().min(5, "State where this benchmark applies (industry, size, region)").max(1000),
  metrics: z.array(z.object({ key: z.enum(KEYS), value: z.coerce.number().refine(Number.isFinite, "Metric value must be a number") })).min(1, "Enter at least one metric value"),
});

export async function addBenchmarkDataset(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("org:manage");
  const p = Input.safeParse(raw);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "invalid input" };
  const v = p.data;
  if (Date.parse(v.publishedAt) > Date.now()) return { ok: false, error: "Published date cannot be in the future" };
  const metrics = v.metrics.map((m) => { const def = METRICS.find((x) => x.key === m.key)!; return { key: m.key, label: def.label, value: m.value, unit: def.unit }; });
  try {
    const [row] = await withTenant(ctx.orgId, (tx) => tx.insert(schema.benchmarkDatasets).values({ orgId: ctx.orgId, name: v.name, source: v.source, sourceUrl: v.sourceUrl, publishedAt: new Date(v.publishedAt), sampleDescription: v.sampleDescription, applicability: v.applicability, metrics, createdBy: ctx.userId }).returning({ id: schema.benchmarkDatasets.id }));
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "benchmark.dataset_added", entityType: "benchmark_dataset", entityId: row.id, details: { name: v.name, source: v.source, sourceUrl: v.sourceUrl, metrics: metrics.length } });
    revalidatePath("/app/benchmarking");
    return { ok: true, id: row.id };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

export async function deleteBenchmarkDataset(raw: unknown): Promise<Result> {
  const ctx = await requireCtx("org:manage");
  const p = z.object({ id: z.string().uuid() }).safeParse(raw);
  if (!p.success) return { ok: false, error: "invalid input" };
  const n = await withTenant(ctx.orgId, (tx) => tx.delete(schema.benchmarkDatasets).where(and(eq(schema.benchmarkDatasets.id, p.data.id), eq(schema.benchmarkDatasets.orgId, ctx.orgId))).returning({ id: schema.benchmarkDatasets.id }));
  if (!n.length) return { ok: false, error: "dataset not found" };
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "benchmark.dataset_deleted", entityType: "benchmark_dataset", entityId: p.data.id });
  revalidatePath("/app/benchmarking");
  return { ok: true, id: p.data.id };
}
