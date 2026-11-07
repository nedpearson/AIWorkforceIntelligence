/**
 * Process / task-mining adapters: Power Automate Process Mining, UiPath Task Mining, Mimica.
 *
 * Honest status: none of these can be exercised without a paid license and tenant credentials we do not
 * have. Each adapter therefore (a) reports `license_required` with the exact prerequisite, (b) throws
 * NotConfiguredError from importProcesses() with instructions, and (c) ships a *pure* mapper from the
 * vendor's documented export shape to our `workflows` rows (basis "observed", evidence note "imported
 * from X"). The mappers are unit-testable without any vendor access. See docs/INTEGRATIONS.md.
 */
import type { WorkflowStep, Evidence } from "@/db/schema";

export type AdapterStatus = { provider: "power_automate" | "uipath" | "mimica"; status: "license_required" | "not_configured" | "configured"; requirement: string; docsUrl: string; envVars: string[] };
export type ImportedWorkflow = {
  name: string; description: string; signature: string; steps: WorkflowStep[]; avgDurationMin: string; runsPerWeek: string; hoursPerWeek: string;
  employeeCount: number; repetitionScore: string; automationScore: string; basis: "observed"; evidence: Evidence; externalRef: { provider: string; id: string };
};
export class NotConfiguredError extends Error { constructor(public readonly provider: string, msg: string) { super(msg); this.name = "NotConfiguredError"; } }
export interface ProcessMiningAdapter {
  status(): AdapterStatus;
  /** Fetches processes from the vendor API. Always throws NotConfiguredError until the license + env are present. */
  importProcesses(orgId: string): Promise<ImportedWorkflow[]>;
}

const sig = (steps: { app: string; action: string }[]) => steps.map((s) => `${s.app}:${s.action}`.toLowerCase().replace(/\s+/g, "_")).join(">");
const share = (ms: number, total: number) => (total > 0 ? ms / total : 0);

// ---------------------------------------------------------------------------------------------
// Power Automate Process Mining (Dataverse). Expected export: the `processes` entity + process map.
// Shape (from Dataverse Web API, simplified):
// { "value": [ { "pm_processid": "guid", "pm_name": "Invoice approval", "pm_description": "...",
//   "pm_casecount": 1240, "pm_eventcount": 9800, "pm_avgcaseduration": "PT2H10M" (ISO 8601 duration) | 7800 (seconds),
//   "pm_activities": [ { "name": "Open invoice", "application": "SAP", "avgDurationSeconds": 120, "frequency": 1240 } ],
//   "pm_resourcecount": 6, "pm_periodstart": "2026-09-01", "pm_periodend": "2026-10-31" } ] }
// ---------------------------------------------------------------------------------------------
export type PowerAutomateProcess = { pm_processid: string; pm_name: string; pm_description?: string; pm_casecount?: number; pm_eventcount?: number; pm_avgcaseduration?: string | number; pm_activities?: { name: string; application?: string; avgDurationSeconds?: number; frequency?: number }[]; pm_resourcecount?: number; pm_periodstart?: string; pm_periodend?: string };
export function mapPowerAutomateProcesses(payload: { value: PowerAutomateProcess[] }): ImportedWorkflow[] {
  return (payload.value ?? []).map((p) => {
    const acts = p.pm_activities ?? [];
    const totalMs = acts.reduce((s, a) => s + (a.avgDurationSeconds ?? 0) * 1000, 0);
    const steps: WorkflowStep[] = acts.map((a, idx) => ({ idx, app: a.application ?? "Unknown", action: a.name, avgMs: (a.avgDurationSeconds ?? 0) * 1000, share: share((a.avgDurationSeconds ?? 0) * 1000, totalMs) }));
    const avgMin = isoDurationToMinutes(p.pm_avgcaseduration) || totalMs / 60000;
    const weeks = weeksBetween(p.pm_periodstart, p.pm_periodend);
    const runsPerWeek = (p.pm_casecount ?? 0) / weeks;
    return build("power_automate", p.pm_processid, p.pm_name, p.pm_description ?? "", steps, avgMin, runsPerWeek, p.pm_resourcecount ?? 0, p.pm_eventcount ?? 0, p.pm_periodstart, p.pm_periodend);
  });
}

// ---------------------------------------------------------------------------------------------
// UiPath Task Mining (Automation Cloud / Orchestrator). Expected export: Task Mining "Analysis export"
// { "tasks": [ { "id": "t-1", "name": "Create vendor in ERP", "description": "...", "traceCount": 320,
//   "avgDurationSec": 410, "userCount": 4, "steps": [ { "order": 1, "appName": "Excel", "actionType": "Copy", "avgDurationSec": 40 } ],
//   "recordingWindow": { "start": "2026-09-01", "end": "2026-09-30" } } ] }
// ---------------------------------------------------------------------------------------------
export type UiPathTask = { id: string; name: string; description?: string; traceCount?: number; avgDurationSec?: number; userCount?: number; steps?: { order: number; appName: string; actionType: string; avgDurationSec?: number }[]; recordingWindow?: { start?: string; end?: string } };
export function mapUiPathTasks(payload: { tasks: UiPathTask[] }): ImportedWorkflow[] {
  return (payload.tasks ?? []).map((t) => {
    const st = [...(t.steps ?? [])].sort((a, b) => a.order - b.order);
    const totalMs = st.reduce((s, a) => s + (a.avgDurationSec ?? 0) * 1000, 0);
    const steps: WorkflowStep[] = st.map((a, idx) => ({ idx, app: a.appName, action: a.actionType, avgMs: (a.avgDurationSec ?? 0) * 1000, share: share((a.avgDurationSec ?? 0) * 1000, totalMs) }));
    const weeks = weeksBetween(t.recordingWindow?.start, t.recordingWindow?.end);
    return build("uipath", t.id, t.name, t.description ?? "", steps, (t.avgDurationSec ?? totalMs / 1000) / 60, (t.traceCount ?? 0) / weeks, t.userCount ?? 0, (t.traceCount ?? 0) * Math.max(1, st.length), t.recordingWindow?.start, t.recordingWindow?.end);
  });
}

// ---------------------------------------------------------------------------------------------
// Mimica (Mapper). Expected export: "Process export (JSON)" from the Mimica Mapper UI:
// { "processes": [ { "processId": "p1", "title": "Expense claim", "summary": "...", "observedInstances": 150,
//   "averageHandlingTimeSeconds": 300, "contributors": 3, "automatabilityScore": 0.82,
//   "steps": [ { "index": 0, "application": "Concur", "label": "Enter claim", "medianSeconds": 90 } ],
//   "observationPeriod": { "from": "2026-10-01", "to": "2026-10-28" } } ] }
// ---------------------------------------------------------------------------------------------
export type MimicaProcess = { processId: string; title: string; summary?: string; observedInstances?: number; averageHandlingTimeSeconds?: number; contributors?: number; automatabilityScore?: number; steps?: { index: number; application: string; label: string; medianSeconds?: number }[]; observationPeriod?: { from?: string; to?: string } };
export function mapMimicaProcesses(payload: { processes: MimicaProcess[] }): ImportedWorkflow[] {
  return (payload.processes ?? []).map((p) => {
    const st = [...(p.steps ?? [])].sort((a, b) => a.index - b.index);
    const totalMs = st.reduce((s, a) => s + (a.medianSeconds ?? 0) * 1000, 0);
    const steps: WorkflowStep[] = st.map((a, idx) => ({ idx, app: a.application, action: a.label, avgMs: (a.medianSeconds ?? 0) * 1000, share: share((a.medianSeconds ?? 0) * 1000, totalMs) }));
    const weeks = weeksBetween(p.observationPeriod?.from, p.observationPeriod?.to);
    const w = build("mimica", p.processId, p.title, p.summary ?? "", steps, (p.averageHandlingTimeSeconds ?? totalMs / 1000) / 60, (p.observedInstances ?? 0) / weeks, p.contributors ?? 0, (p.observedInstances ?? 0) * Math.max(1, st.length), p.observationPeriod?.from, p.observationPeriod?.to);
    if (p.automatabilityScore != null) w.automationScore = (Math.max(0, Math.min(1, p.automatabilityScore)) * 100).toFixed(2);
    return w;
  });
}

function build(provider: string, id: string, name: string, description: string, steps: WorkflowStep[], avgMin: number, runsPerWeek: number, employeeCount: number, sampleSize: number, from?: string, to?: string): ImportedWorkflow {
  const hoursPerWeek = (avgMin * runsPerWeek) / 60;
  const repetition = Math.min(100, Math.round(Math.log10(1 + runsPerWeek) * 40));
  const apps = new Set(steps.map((s) => s.app));
  const automation = Math.max(0, Math.min(100, Math.round(60 + repetition * 0.3 - (apps.size - 1) * 5)));
  return {
    name, description: description || `Imported process (${steps.length} steps)`, signature: sig(steps), steps,
    avgDurationMin: avgMin.toFixed(2), runsPerWeek: runsPerWeek.toFixed(2), hoursPerWeek: hoursPerWeek.toFixed(2), employeeCount,
    repetitionScore: repetition.toFixed(2), automationScore: automation.toFixed(2), basis: "observed",
    evidence: { eventIds: [], sampleSize, observedFrom: from ?? "", observedTo: to ?? "", notes: [`imported from ${PROVIDER_NAMES[provider] ?? provider}`, `external id ${id}`] },
    externalRef: { provider, id },
  };
}
const PROVIDER_NAMES: Record<string, string> = { power_automate: "Power Automate Process Mining", uipath: "UiPath Task Mining", mimica: "Mimica" };
function weeksBetween(a?: string, b?: string): number { if (!a || !b) return 4; const d = (new Date(b).getTime() - new Date(a).getTime()) / (7 * 86400_000); return d > 0 ? d : 4; }
function isoDurationToMinutes(v?: string | number): number {
  if (v == null) return 0; if (typeof v === "number") return v / 60;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(v); if (!m) return Number(v) / 60 || 0;
  return (Number(m[1] ?? 0) * 1440) + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 60;
}

// ---------------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------------
const has = (...k: string[]) => k.every((x) => !!process.env[x]);
export const powerAutomateAdapter: ProcessMiningAdapter = {
  status: () => ({ provider: "power_automate", status: has("POWER_AUTOMATE_TENANT_ID", "POWER_AUTOMATE_CLIENT_ID", "POWER_AUTOMATE_CLIENT_SECRET") ? "configured" : "license_required",
    requirement: "Requires a Power Automate Premium (per-user) or Process Mining add-on license, an Entra ID app registration with Dataverse `user_impersonation` scope, and the environment's Dataverse URL. Process data is read from the `pm_process` entity via the Dataverse Web API.",
    docsUrl: "https://learn.microsoft.com/power-automate/process-mining-overview", envVars: ["POWER_AUTOMATE_TENANT_ID", "POWER_AUTOMATE_CLIENT_ID", "POWER_AUTOMATE_CLIENT_SECRET"] }),
  async importProcesses() { throw new NotConfiguredError("power_automate", "Power Automate Process Mining is not connected. Buy/assign a Process Mining license, register an Entra ID app with Dataverse access, then set POWER_AUTOMATE_TENANT_ID, POWER_AUTOMATE_CLIENT_ID and POWER_AUTOMATE_CLIENT_SECRET. Until then, export processes to JSON from the Process Mining portal and import them with mapPowerAutomateProcesses()."); },
};
export const uipathAdapter: ProcessMiningAdapter = {
  status: () => ({ provider: "uipath", status: has("UIPATH_ORG", "UIPATH_TENANT", "UIPATH_CLIENT_ID", "UIPATH_CLIENT_SECRET") ? "configured" : "license_required",
    requirement: "Requires UiPath Automation Cloud with the Task Mining service enabled (Enterprise licensing), an External Application (OAuth client credentials) with scope `TaskMining` / `OR.Default`, and the organization + tenant names.",
    docsUrl: "https://docs.uipath.com/task-mining/automation-cloud/latest/user-guide/introduction", envVars: ["UIPATH_ORG", "UIPATH_TENANT", "UIPATH_CLIENT_ID", "UIPATH_CLIENT_SECRET"] }),
  async importProcesses() { throw new NotConfiguredError("uipath", "UiPath Task Mining is not connected. Enable Task Mining in Automation Cloud, create an External Application with client credentials, then set UIPATH_ORG, UIPATH_TENANT, UIPATH_CLIENT_ID and UIPATH_CLIENT_SECRET. Until then, export an analysis to JSON and import it with mapUiPathTasks()."); },
};
export const mimicaAdapter: ProcessMiningAdapter = {
  status: () => ({ provider: "mimica", status: has("MIMICA_API_KEY") ? "configured" : "license_required",
    requirement: "Requires a Mimica Mapper subscription and an API key issued by Mimica support (the API is not self-serve).",
    docsUrl: "https://www.mimica.ai/", envVars: ["MIMICA_API_KEY"] }),
  async importProcesses() { throw new NotConfiguredError("mimica", "Mimica is not connected. Request an API key from Mimica support and set MIMICA_API_KEY. Until then, export processes to JSON from Mimica Mapper and import them with mapMimicaProcesses()."); },
};
export const PROCESS_MINING_ADAPTERS = { power_automate: powerAutomateAdapter, uipath: uipathAdapter, mimica: mimicaAdapter } as const;
export function processMiningStatuses(): AdapterStatus[] { return Object.values(PROCESS_MINING_ADAPTERS).map((a) => a.status()); }
