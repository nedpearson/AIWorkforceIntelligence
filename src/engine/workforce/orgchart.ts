/**
 * Org chart — humans (manager tree) + AI employees attached to the department they serve.
 * Human photos are shown ONLY when the media asset carries recorded consent (provenance = employee_consented).
 * AI → approval owner edge: ai_employees.approvalOwnerUserId → employees.userId.
 * "proposed" mode adds recommended (not yet provisioned) AI employees — advisory only, never a job recommendation.
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { computeOrgFinancials } from "@/engine/finance";
import type { OrgFinancials } from "@/engine/finance.types";
import { num } from "@/lib/utils";
import { personaByKey } from "./personas";
import { recommendations } from "./recommendations";
import { departmentForTeam } from "./core";

export type HumanNode = { kind: "human"; id: string; name: string; title: string | null; departmentId: string | null; managerId: string | null; location: string | null; locationId: string | null; photoUrl: string | null; userId: string | null; workflows: { id: string; name: string; hoursPerWeek: number }[]; hoursPerWeek: number };
export type AiNode = {
  kind: "ai"; id: string; name: string; title: string; team: string; departmentId: string | null; status: string; permissionLevel: string; portraitUrl: string | null; portraitProvenance: string | null;
  approvalOwnerEmployeeId: string | null; approvalOwnerName: string | null; proposed: boolean; personaKey: string | null; responsibilities: string[];
  workflows: { id: string; name: string; hoursPerWeek: number }[]; opportunities: { id: string; title: string; realizable: number; hoursRecoverablePerWeek: number }[];
  hoursRecoverablePerWeek: number; projectedValue: number; verifiedHours: number;
};
export type DeptSummary = { id: string | null; name: string; locationId: string | null; humans: number; ai: number; workflowHoursPerWeek: number; coveredHoursPerWeek: number; coveragePct: number; projectedValue: number };
export type OrgChart = { mode: "current" | "proposed"; humans: HumanNode[]; ai: AiNode[]; departments: DeptSummary[]; locations: { id: string; name: string }[]; counts: { humans: number; ai: number; proposedAi: number; departments: number } };
export type OrgChartFilters = { dept?: string | null; loc?: string | null; mode?: "current" | "proposed" };

export async function orgChart(orgId: string, filters: OrgChartFilters = {}, deps: { fin?: OrgFinancials } = {}): Promise<OrgChart> {
  const mode = filters.mode ?? "current";
  const fin = deps.fin ?? (await computeOrgFinancials(orgId));
  const d = await withTenant(orgId, async (tx) => {
    const depts = await tx.select().from(schema.departments).where(eq(schema.departments.orgId, orgId));
    const locs = await tx.select({ id: schema.locations.id, name: schema.locations.name }).from(schema.locations).where(eq(schema.locations.orgId, orgId));
    const emps = await tx.select().from(schema.employees).where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.isActive, true)));
    const photoIds = emps.map((e) => e.photoAssetId).filter((x): x is string => !!x);
    const photos = photoIds.length ? await tx.select({ id: schema.mediaAssets.id, provenance: schema.mediaAssets.provenance, consentAt: schema.mediaAssets.consentAt }).from(schema.mediaAssets).where(and(eq(schema.mediaAssets.orgId, orgId), inArray(schema.mediaAssets.id, photoIds))) : [];
    const ai = await tx.select().from(schema.aiEmployees).where(eq(schema.aiEmployees.orgId, orgId));
    const wfs = await tx.select({ id: schema.workflows.id, name: schema.workflows.name, departmentId: schema.workflows.departmentId, hoursPerWeek: schema.workflows.hoursPerWeek }).from(schema.workflows).where(eq(schema.workflows.orgId, orgId));
    const links = await tx.select().from(schema.workflowEmployees).where(eq(schema.workflowEmployees.orgId, orgId));
    const opps = await tx.select({ id: schema.opportunities.id, title: schema.opportunities.title, workflowId: schema.opportunities.workflowId, agentId: schema.opportunities.agentId }).from(schema.opportunities).where(eq(schema.opportunities.orgId, orgId));
    const runs = await tx.select({ aiEmployeeId: schema.skillRuns.aiEmployeeId, mode: schema.skillRuns.mode, status: schema.skillRuns.status, base: schema.skillRuns.manualBaselineMinutes, review: schema.skillRuns.humanReviewMinutes }).from(schema.skillRuns).where(eq(schema.skillRuns.orgId, orgId));
    return { depts, locs, emps, photos, ai, wfs, links, opps, runs };
  });
  const consented = new Set(d.photos.filter((p) => p.provenance === "employee_consented" && p.consentAt).map((p) => p.id));
  const wfById = new Map(d.wfs.map((w) => [w.id, w]));
  const line = new Map(fin.opportunities.map((o) => [o.id, o]));
  const deptOf = new Map(d.depts.map((x) => [x.id, x]));

  let humans: HumanNode[] = d.emps.map((e) => {
    const wl = d.links.filter((l) => l.employeeId === e.id).map((l) => ({ id: l.workflowId, name: wfById.get(l.workflowId)?.name ?? "Workflow", hoursPerWeek: num(l.hoursPerWeek) })).sort((a, b) => b.hoursPerWeek - a.hoursPerWeek);
    return { kind: "human", id: e.id, name: e.displayName, title: e.title, departmentId: e.departmentId, managerId: e.managerEmployeeId, location: e.location, locationId: e.locationId ?? deptOf.get(e.departmentId ?? "")?.locationId ?? null,
      photoUrl: e.photoAssetId && consented.has(e.photoAssetId) ? `/api/media/${e.photoAssetId}` : null, userId: e.userId, workflows: wl, hoursPerWeek: wl.reduce((s, w) => s + w.hoursPerWeek, 0) };
  });
  const empByUser = new Map(humans.filter((h) => h.userId).map((h) => [h.userId!, h]));
  const verified = (id: string) => d.runs.filter((r) => r.aiEmployeeId === id && r.mode === "live" && r.status === "succeeded").reduce((s, r) => s + Math.max(0, num(r.base) - num(r.review)) / 60, 0);
  const oppNode = (oppId: string | null) => { if (!oppId) return null; const l = line.get(oppId); const o = d.opps.find((x) => x.id === oppId); return o ? { id: o.id, title: o.title, realizable: l?.realizableAnnualSavings ?? 0, hoursRecoverablePerWeek: l?.hoursRecoverablePerWeek ?? 0, workflowId: o.workflowId } : null; };

  let ai: AiNode[] = d.ai.filter((a) => a.status !== "retired").map((a) => {
    const o = oppNode(a.opportunityId); const owner = a.approvalOwnerUserId ? empByUser.get(a.approvalOwnerUserId) ?? null : null;
    const w = o?.workflowId ? wfById.get(o.workflowId) : undefined;
    return { kind: "ai", id: a.id, name: a.firstName, title: a.title, team: a.team, departmentId: a.departmentId ?? (w?.departmentId ?? null), status: a.status, permissionLevel: a.permissionLevel, portraitUrl: a.portraitUrl, portraitProvenance: a.portraitProvenance,
      approvalOwnerEmployeeId: owner?.id ?? null, approvalOwnerName: owner?.name ?? null, proposed: false, personaKey: a.personaKey, responsibilities: a.responsibilities,
      workflows: w ? [{ id: w.id, name: w.name, hoursPerWeek: num(w.hoursPerWeek) }] : [], opportunities: o ? [{ id: o.id, title: o.title, realizable: o.realizable, hoursRecoverablePerWeek: o.hoursRecoverablePerWeek }] : [],
      hoursRecoverablePerWeek: o?.hoursRecoverablePerWeek ?? 0, projectedValue: o?.realizable ?? 0, verifiedHours: verified(a.id) };
  });
  if (mode === "proposed") {
    const recs = await recommendations(orgId, { fin });
    const have = new Set(ai.map((a) => a.personaKey).filter(Boolean));
    const byPersona = new Map<string, typeof recs>();
    for (const r of recs) if (!have.has(r.persona.key)) byPersona.set(r.persona.key, [...(byPersona.get(r.persona.key) ?? []), r]);
    for (const [key, rs] of byPersona) {
      const p = personaByKey(key)!;
      ai.push({ kind: "ai", id: `proposed-${key}`, name: p.firstName, title: p.title, team: p.team, departmentId: rs[0].departmentId ?? departmentForTeam(p.team, d.depts), status: "proposed", permissionLevel: "read_only", portraitUrl: p.portrait, portraitProvenance: p.portrait ? "ai_generated" : "none",
        approvalOwnerEmployeeId: null, approvalOwnerName: null, proposed: true, personaKey: key, responsibilities: p.responsibilities,
        workflows: rs.filter((r) => r.workflowId).map((r) => ({ id: r.workflowId!, name: r.workflowName ?? r.workflowLabel, hoursPerWeek: r.observedHoursPerWeek })),
        opportunities: rs.map((r) => ({ id: r.opportunityId, title: r.opportunityTitle, realizable: r.realizableAnnualSavings, hoursRecoverablePerWeek: r.hoursRecoverablePerWeek })),
        hoursRecoverablePerWeek: rs.reduce((s, r) => s + r.hoursRecoverablePerWeek, 0), projectedValue: rs.reduce((s, r) => s + r.realizableAnnualSavings, 0), verifiedHours: 0 });
    }
  }
  // department summaries (before filtering, so coverage is per department)
  const deptRows: DeptSummary[] = [...d.depts.map((x) => ({ id: x.id as string | null, name: x.name, locationId: x.locationId })), { id: null, name: "Organization-wide", locationId: null }].map((x) => {
    const dWfs = d.wfs.filter((w) => (w.departmentId ?? null) === x.id);
    const total = dWfs.reduce((s, w) => s + num(w.hoursPerWeek), 0);
    const dAi = ai.filter((a) => (a.departmentId ?? null) === x.id);
    const coveredIds = new Set(dAi.flatMap((a) => a.workflows.map((w) => w.id)));
    const covered = dWfs.filter((w) => coveredIds.has(w.id)).reduce((s, w) => s + num(w.hoursPerWeek), 0);
    return { id: x.id, name: x.name, locationId: x.locationId, humans: humans.filter((h) => (h.departmentId ?? null) === x.id).length, ai: dAi.length, workflowHoursPerWeek: total, coveredHoursPerWeek: covered, coveragePct: total > 0 ? covered / total : 0, projectedValue: dAi.reduce((s, a) => s + a.projectedValue, 0) };
  }).filter((x) => x.id !== null || x.humans + x.ai > 0);

  if (filters.dept) { humans = humans.filter((h) => h.departmentId === filters.dept); ai = ai.filter((a) => a.departmentId === filters.dept); }
  if (filters.loc) {
    const deptIds = new Set(d.depts.filter((x) => x.locationId === filters.loc).map((x) => x.id));
    humans = humans.filter((h) => h.locationId === filters.loc || (h.departmentId && deptIds.has(h.departmentId)));
    ai = ai.filter((a) => a.departmentId && (deptIds.has(a.departmentId) || humans.some((h) => h.departmentId === a.departmentId)));
  }
  const departments = deptRows.filter((x) => (!filters.dept || x.id === filters.dept) && (!filters.loc || humans.some((h) => h.departmentId === x.id) || ai.some((a) => a.departmentId === x.id)));
  return { mode, humans, ai, departments, locations: d.locs, counts: { humans: humans.length, ai: ai.filter((a) => !a.proposed).length, proposedAi: ai.filter((a) => a.proposed).length, departments: departments.length } };
}
