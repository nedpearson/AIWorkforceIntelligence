import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import type { CalcTree } from "@/db/schema";
import { loadRoadmap, verificationBlocker } from "@/engine/roadmap";
import { RoadmapClient } from "./roadmap-client";

export const metadata = { title: "Transformation Roadmap" };
export const dynamic = "force-dynamic";

export default async function RoadmapPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("opportunities:read");
  const sp = await searchParams;
  const rm = await loadRoadmap(ctx.orgId);
  const { si: _si, ...client } = rm; void _si;
  const budget = rm.projects.reduce((s, p) => s + p.budget, 0);
  const spent = rm.projects.reduce((s, p) => s + p.spent, 0);
  const target = rm.projects.reduce((s, p) => s + p.targetAnnualSavings, 0);
  const verified = rm.projects.reduce((s, p) => s + p.savings.verifiedTime.amount, 0);
  const realized = rm.projects.reduce((s, p) => s + p.savings.realizedAnnual, 0);
  const trees: Record<string, CalcTree> = {
    budget: { label: "Budget vs spent", value: spent, unit: "usd", basis: "observed", formula: "Σ projects.spent (of Σ projects.budget)", children: rm.projects.map((p) => ({ label: `${p.name} — spent of ${Math.round(p.budget).toLocaleString("en-US")} budget`, value: p.spent, unit: "usd", basis: "observed" as const, source: "Project record" })) },
    savings: { label: "Verified savings on roadmap projects (annualized)", value: verified, unit: "usd", basis: "observed", formula: "Σ Savings Intelligence verified-time lineage filtered to each project's opportunities and agents", source: `Target Σ ${Math.round(target).toLocaleString("en-US")}/yr · realized hard + cost avoidance ${Math.round(realized).toLocaleString("en-US")}/yr`, children: rm.projects.map((p) => ({ label: p.name, value: p.savings.verifiedTime.amount, unit: "usd", basis: "observed" as const, source: `${p.savings.measurementCount} measurement(s) · target ${Math.round(p.targetAnnualSavings).toLocaleString("en-US")}/yr`, children: p.savings.verifiedTime.items.map((i) => ({ label: i.label, value: i.amount, unit: "usd", basis: i.basis, source: `savings_measurements ${i.id}` })) })) },
  };
  return (
    <RoadmapClient data={client} kpis={{ projects: rm.projects.length, active: rm.projects.filter((p) => !["closed"].includes(p.status)).length, budget, spent, target, verified, realized, atRisk: rm.attention.length }} trees={trees}
      blockers={Object.fromEntries(rm.projects.map((p) => [p.id, verificationBlocker(p)]))} canWrite={can(ctx.role, "opportunities:write")} initialProject={sp.project ?? null} initialView={sp.view ?? null} today={new Date().toISOString()} />
  );
}
