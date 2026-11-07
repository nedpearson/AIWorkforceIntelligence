/**
 * Pilot runtime agent — when an AI employee enters Pilot, it is linked to an executable agent so its live work lands on
 * the agent run ledger (agent_runs, trigger "skill") and can be measured into verified savings (savings_measurements).
 *
 *  - Reuses the agent already linked to the employee, or the (non-retired) agent already managing its opportunity.
 *  - Otherwise creates one from the matching template: process_invoice → ap_ar "Vendor bill intake (AP)"; else the
 *    template recommended for the employee's opportunity/workflow. Status "deployed" (deployed for the pilot), internal
 *    runtime, schedule removed (live work is only ever started by a person assigning a task), version 1 recorded.
 *  - Never grants a permission or changes the opportunity's status; audited (agent.created + ai_employee.agent_linked).
 */
import { and, eq, ne } from "drizzle-orm";
import { schema } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { getTemplate, recommendTemplate, type AgentTemplate } from "@/engine/agents/templates";
import { recordVersionTx } from "@/engine/agents/versions";
import type { AgentDefinition } from "@/db/schema";

type Emp = typeof schema.aiEmployees.$inferSelect;

export function pilotTemplateFor(emp: Pick<Emp, "skills">, opp: { recommendedAgentCategory?: string | null; title?: string; type?: string } | null, wf: { steps?: { app: string; category?: string }[] | null; name?: string } | null): AgentTemplate {
  if (emp.skills?.includes("process_invoice")) return getTemplate("ap_ar_invoice_intake")!;
  return recommendTemplate(opp, wf);
}

/** Returns the employee with `agentId` set (unchanged when it already had a live agent). */
export async function ensurePilotAgent(orgId: string, actorUserId: string | null, emp: Emp): Promise<Emp> {
  const r = await withTenant(orgId, async (tx) => {
    if (emp.agentId) {
      const [a] = await tx.select({ id: schema.agents.id, status: schema.agents.status }).from(schema.agents).where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, emp.agentId))).limit(1);
      if (a && a.status !== "retired") return { emp, created: null as null | { id: string; templateKey: string }, reused: false };
    }
    const [opp] = emp.opportunityId ? await tx.select().from(schema.opportunities).where(and(eq(schema.opportunities.orgId, orgId), eq(schema.opportunities.id, emp.opportunityId))).limit(1) : [];
    const [wf] = opp?.workflowId ? await tx.select().from(schema.workflows).where(and(eq(schema.workflows.orgId, orgId), eq(schema.workflows.id, opp.workflowId))).limit(1) : [];
    let agentId: string | null = null; let created: null | { id: string; templateKey: string } = null;
    if (opp?.agentId) {
      const [a] = await tx.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, opp.agentId), ne(schema.agents.status, "retired"))).limit(1);
      agentId = a?.id ?? null;
    }
    if (!agentId) {
      const t = pilotTemplateFor(emp, opp ?? null, wf ?? null);
      const { schedule: _s, ...rest } = t.definition; void _s;
      const definition: AgentDefinition = rest;
      const [row] = await tx.insert(schema.agents).values({
        orgId, opportunityId: opp?.id ?? null, workflowId: wf?.id ?? null, name: `${emp.firstName} (AI employee pilot) — ${t.name}`, category: t.category, templateKey: t.key,
        status: "deployed", runtime: "internal", definition, credentialIds: [], approvalPolicy: { mode: "all" }, deployedAt: new Date(),
        expectedMinutesSavedPerRun: String(t.expectedMinutesSavedPerRun), baselineMinutesPerRun: String(t.baselineMinutesPerRun), monthlyCost: String(t.monthlyCost), createdBy: actorUserId,
      }).returning({ id: schema.agents.id });
      await recordVersionTx(tx, { orgId, agentId: row.id, definition, approvalPolicy: { mode: "all" }, note: `created for ${emp.firstName}'s pilot from template ${t.key}`, createdBy: actorUserId });
      if (opp && !opp.agentId) await tx.update(schema.opportunities).set({ agentId: row.id, updatedAt: new Date() }).where(and(eq(schema.opportunities.orgId, orgId), eq(schema.opportunities.id, opp.id)));
      agentId = row.id; created = { id: row.id, templateKey: t.key };
    }
    const [updated] = await tx.update(schema.aiEmployees).set({ agentId, updatedAt: new Date() }).where(and(eq(schema.aiEmployees.orgId, orgId), eq(schema.aiEmployees.id, emp.id))).returning();
    return { emp: updated, created, reused: !created };
  });
  if (r.created) await audit({ orgId, actorUserId, action: "agent.created", entityType: "agent", entityId: r.created.id, details: { templateKey: r.created.templateKey, runtime: "internal", status: "deployed", source: "ai_employee_pilot", aiEmployeeId: emp.id, opportunityId: emp.opportunityId } });
  if (r.emp.agentId !== emp.agentId) await audit({ orgId, actorUserId, action: "ai_employee.agent_linked", entityType: "ai_employee", entityId: emp.id, details: { agentId: r.emp.agentId, created: !!r.created, reason: "pilot" } });
  return r.emp;
}
