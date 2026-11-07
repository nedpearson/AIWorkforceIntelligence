/** Process-mining adapters: honest stubs + pure mappers. No vendor access needed. */
import { describe, it, expect } from "vitest";
import { PROCESS_MINING_ADAPTERS, NotConfiguredError, mapPowerAutomateProcesses, mapUiPathTasks, mapMimicaProcesses, processMiningStatuses } from "@/engine/adapters/process-mining";

describe("process mining adapters", () => {
  it("report license_required with prerequisites and throw NotConfiguredError on import", async () => {
    for (const k of ["POWER_AUTOMATE_TENANT_ID", "UIPATH_ORG", "MIMICA_API_KEY"]) delete process.env[k];
    for (const s of processMiningStatuses()) { expect(s.status).toBe("license_required"); expect(s.requirement.length).toBeGreaterThan(40); expect(s.docsUrl).toMatch(/^https:/); expect(s.envVars.length).toBeGreaterThan(0); }
    for (const a of Object.values(PROCESS_MINING_ADAPTERS)) await expect(a.importProcesses("org")).rejects.toBeInstanceOf(NotConfiguredError);
  });
  it("maps vendor exports to observed workflow rows with provenance", () => {
    const pa = mapPowerAutomateProcesses({ value: [{ pm_processid: "p1", pm_name: "Invoice approval", pm_casecount: 80, pm_eventcount: 640, pm_avgcaseduration: "PT1H30M", pm_resourcecount: 3, pm_periodstart: "2026-09-01", pm_periodend: "2026-09-29", pm_activities: [{ name: "Open invoice", application: "SAP", avgDurationSeconds: 120, frequency: 80 }, { name: "Approve", application: "Outlook", avgDurationSeconds: 60, frequency: 80 }] }] });
    expect(pa).toHaveLength(1);
    expect(pa[0]).toMatchObject({ name: "Invoice approval", basis: "observed", avgDurationMin: "90.00", runsPerWeek: "20.00", hoursPerWeek: "30.00", employeeCount: 3, signature: "sap:open_invoice>outlook:approve", externalRef: { provider: "power_automate", id: "p1" } });
    expect(pa[0].evidence.notes).toContain("imported from Power Automate Process Mining");
    expect(pa[0].steps[0].share).toBeCloseTo(2 / 3);
    const ui = mapUiPathTasks({ tasks: [{ id: "t1", name: "Create vendor", traceCount: 40, avgDurationSec: 600, userCount: 2, steps: [{ order: 2, appName: "ERP", actionType: "Save", avgDurationSec: 100 }, { order: 1, appName: "Excel", actionType: "Copy", avgDurationSec: 500 }], recordingWindow: { start: "2026-10-01", end: "2026-10-15" } }] });
    expect(ui[0].steps.map((s) => s.app)).toEqual(["Excel", "ERP"]);
    expect(ui[0]).toMatchObject({ avgDurationMin: "10.00", runsPerWeek: "20.00", basis: "observed" });
    const mi = mapMimicaProcesses({ processes: [{ processId: "m1", title: "Expense claim", observedInstances: 28, averageHandlingTimeSeconds: 300, contributors: 3, automatabilityScore: 0.82, steps: [{ index: 0, application: "Concur", label: "Enter claim", medianSeconds: 90 }], observationPeriod: { from: "2026-10-01", to: "2026-10-29" } }] });
    expect(mi[0]).toMatchObject({ automationScore: "82.00", runsPerWeek: "7.00", avgDurationMin: "5.00" });
    expect(mi[0].evidence.notes?.[0]).toBe("imported from Mimica");
  });
});
