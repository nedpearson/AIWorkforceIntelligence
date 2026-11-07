import { describe, it, expect } from "vitest";
import { DEMO_ORG, WORKFLOW_PATTERNS, generateEvents, type SynthEvent } from "@/engine/synthetic";
import {
  type MiningEvent, sessionize, toInstance, mineEmployee, clusterInstances, workflowMetrics, nameWorkflow, sequenceSimilarity, jaccard, lcsLength, isNoise, stepToken, observedWeeksFromDays, dayKey, capitalize,
} from "@/engine/mining";

let nextId = 1;
const mk = (p: Partial<MiningEvent> & { ts: number; type: string; app: string }): MiningEvent => ({ id: nextId++, employeeId: "e", appCategory: "x", titleCategory: "t", durationMs: 1000, meta: {}, ...p });
const fromSynth = (events: SynthEvent[]): MiningEvent[] => events.map((e) => ({ id: nextId++, employeeId: e.employeeKey, ts: e.ts.getTime(), type: e.type, app: e.app, appCategory: e.appCategory, titleCategory: e.titleCategory, titleHash: e.titleHash, durationMs: Math.round(e.durationMs), meta: e.meta }));
const patternTokens = (key: string) => WORKFLOW_PATTERNS[key].steps.map(([app, , title, type]) => `${app}:${title}:${type}`);

describe("sessionize", () => {
  it("splits at idle markers and drops them", () => {
    const ev = [mk({ ts: 0, type: "document_open", app: "A" }), mk({ ts: 1000, type: "data_entry", app: "A" }), mk({ ts: 2000, type: "idle_start", app: "", appCategory: "idle", durationMs: 600000 }), mk({ ts: 602000, type: "idle_end", app: "", appCategory: "idle", durationMs: 0 }), mk({ ts: 602000, type: "document_open", app: "A" }), mk({ ts: 603000, type: "data_entry", app: "A" })];
    const s = sessionize(ev);
    expect(s).toHaveLength(2);
    expect(s.every((x) => x.events.every((e) => !e.type.startsWith("idle")))).toBe(true);
  });
  it("splits at gaps > 10 minutes measured from the end of the previous event", () => {
    const ev = [mk({ ts: 0, type: "navigation", app: "A", durationMs: 60000 }), mk({ ts: 60000 + 9 * 60000, type: "data_entry", app: "A" }), mk({ ts: 60000 + 9 * 60000 + 1000 + 11 * 60000, type: "navigation", app: "B" })];
    expect(sessionize(ev)).toHaveLength(2);
  });
  it("strips ambient noise (app_focus, inbox, meeting) without cutting", () => {
    const ev = [mk({ ts: 0, type: "document_open", app: "Outlook", titleCategory: "invoice" }), mk({ ts: 1000, type: "app_focus", app: "Slack", appCategory: "chat", titleCategory: "team channel" }), mk({ ts: 2000, type: "data_entry", app: "QuickBooks", titleCategory: "bill entry" })];
    const s = sessionize(ev);
    expect(s).toHaveLength(1); expect(s[0].events.map((e) => e.app)).toEqual(["Outlook", "QuickBooks"]);
    expect(isNoise(mk({ ts: 0, type: "navigation", app: "Chrome", titleCategory: "general" }))).toBe(true);
    expect(isNoise(mk({ ts: 0, type: "navigation", app: "Chrome", titleCategory: "customer portal" }))).toBe(false);
  });
  it("cuts after a producing event when a new document is opened, but not when rework re-navigates to a middle step", () => {
    const run = (ts: number, rework = false) => [
      mk({ ts, type: "document_open", app: "Zendesk", titleCategory: "ticket" }), mk({ ts: ts + 1000, type: "navigation", app: "NetSuite", titleCategory: "customer record" }), mk({ ts: ts + 2000, type: "data_entry", app: "Zendesk", titleCategory: "ticket reply" }), mk({ ts: ts + 3000, type: "form_submit", app: "Zendesk", titleCategory: "ticket" }),
      ...(rework ? [mk({ ts: ts + 4000, type: "navigation", app: "NetSuite", titleCategory: "customer record", meta: { rework: true } }), mk({ ts: ts + 5000, type: "data_entry", app: "Zendesk", titleCategory: "ticket reply", meta: { rework: true } })] : []),
    ];
    const s = sessionize([...run(0), ...run(10000, true), ...run(20000)]);
    expect(s).toHaveLength(3);
    expect(s[1].events).toHaveLength(6);
    expect(toInstance(s[1])!.hasRework).toBe(true);
    expect(toInstance(s[0])!.hasRework).toBe(false);
  });
  it("treats re-navigating to the first screen as a new run (marketing → marketing)", () => {
    const run = (ts: number) => [mk({ ts, type: "navigation", app: "Chrome", titleCategory: "ads dashboard" }), mk({ ts: ts + 1000, type: "copy_paste", app: "Excel", titleCategory: "campaign tracker" }), mk({ ts: ts + 2000, type: "email_compose", app: "Slack", appCategory: "chat", titleCategory: "marketing channel" })];
    expect(sessionize([...run(0), ...run(5000)])).toHaveLength(2);
  });
  it("separates an unrelated document opened in another app from the task that follows", () => {
    const ev = [mk({ ts: 0, type: "document_open", app: "Word", titleCategory: "memo", durationMs: 400000 }), mk({ ts: 400000, type: "document_open", app: "Outlook", titleCategory: "invoice" }), mk({ ts: 401000, type: "document_open", app: "Adobe Acrobat", titleCategory: "invoice" }), mk({ ts: 402000, type: "data_entry", app: "QuickBooks", titleCategory: "bill entry" })];
    const s = sessionize(ev);
    expect(s).toHaveLength(2); expect(s[1].events.map((e) => e.app)).toEqual(["Outlook", "Adobe Acrobat", "QuickBooks"]);
  });
});

describe("toInstance", () => {
  it("collapses consecutive duplicate steps and merges their durations", () => {
    const s = { employeeId: "e", events: [mk({ ts: 0, type: "data_entry", app: "A", titleCategory: "x", durationMs: 1000, meta: { pasteCount: 2 } }), mk({ ts: 1000, type: "data_entry", app: "A", titleCategory: "x", durationMs: 2000 }), mk({ ts: 3000, type: "form_submit", app: "A", titleCategory: "x", durationMs: 500 })] };
    const i = toInstance(s)!;
    expect(i.tokens).toEqual(["A:x:data_entry", "A:x:form_submit"]); expect(i.steps[0].durationMs).toBe(3000); expect(i.steps[0].pasteCount).toBe(2); expect(i.durationMs).toBe(3500); expect(i.signature).toBe("A:x:data_entry>A:x:form_submit");
  });
  it("drops single-step sessions (ad-hoc work) and counts handoffs", () => {
    expect(toInstance({ employeeId: "e", events: [mk({ ts: 0, type: "document_open", app: "Word" })] })).toBeNull();
    const i = toInstance({ employeeId: "e", events: [mk({ ts: 0, type: "email_compose", app: "Outlook", titleCategory: "a" }), mk({ ts: 1, type: "handoff", app: "Outlook", titleCategory: "a" })] })!;
    expect(i.handoffs).toBe(1);
  });
  it("detects rework from repeated non-adjacent steps even without meta flags", () => {
    const i = toInstance({ employeeId: "e", events: [mk({ ts: 0, type: "navigation", app: "A", titleCategory: "1" }), mk({ ts: 1, type: "data_entry", app: "B", titleCategory: "2" }), mk({ ts: 2, type: "navigation", app: "A", titleCategory: "1" })] })!;
    expect(i.hasRework).toBe(true);
  });
});

describe("similarity + clustering", () => {
  it("jaccard / lcs / sequenceSimilarity behave", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1); expect(jaccard(["a"], ["b"])).toBe(0); expect(lcsLength(["a", "b", "c"], ["a", "c"])).toBe(2);
    expect(sequenceSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    expect(sequenceSimilarity(["a", "b", "c", "d", "e"], ["a", "b", "c", "d"])).toBeGreaterThan(0.7);
    expect(sequenceSimilarity(["a", "b", "c", "d"], ["a", "b", "x", "y"])).toBeLessThan(0.7);
  });
  it("clusters rework variants with their canonical sequence and keeps distinct patterns apart", () => {
    const events = fromSynth(generateEvents({ seed: 7, days: 10, employees: [DEMO_ORG.employees[1]] })); // Marcus: ap_invoice + bank recon
    const inst = mineEmployee(events);
    const clusters = clusterInstances(inst).filter((c) => c.instances.length >= 3);
    const sigs = clusters.map((c) => c.canonical.join(">"));
    expect(sigs).toContain(patternTokens("ap_invoice").join(">"));
    expect(clusters[0].instances.some((i) => i.hasRework)).toBe(true);
    for (const c of clusters) expect(c.instances.every((i) => jaccard(i.tokens, c.canonical) >= 0.5)).toBe(true);
    expect(clusters.length).toBeLessThanOrEqual(3);
  });
});

describe("workflowMetrics + naming", () => {
  it("computes runs/week, hours, rework, handoffs, per-employee stats and a process map for the AP pattern", () => {
    const emps = [DEMO_ORG.employees[0], DEMO_ORG.employees[1]];
    const synth = generateEvents({ seed: 42, days: 20, employees: emps });
    const days = new Set(synth.map((e) => dayKey(e.ts.getTime())));
    const weeks = observedWeeksFromDays(days); expect(weeks).toBe(4);
    const inst = emps.flatMap((e) => mineEmployee(fromSynth(synth.filter((x) => x.employeeKey === e.key))));
    const ap = clusterInstances(inst).find((c) => c.canonical.join(">") === patternTokens("ap_invoice").join(">"))!;
    const m = workflowMetrics(ap, weeks);
    expect(m.runsPerWeek).toBeGreaterThan(50); expect(m.runsPerWeek).toBeLessThan(80); // 9 + 4 runs/day × 5
    expect(m.avgDurationMin).toBeGreaterThan(8); expect(m.avgDurationMin).toBeLessThan(11);
    expect(m.hoursPerWeek).toBeCloseTo((m.runsPerWeek * m.avgDurationMin) / 60, 6);
    expect(m.employeeIds.sort()).toEqual(["e1", "e2"]); expect(m.employees[0].employeeId).toBe("e1");
    expect(m.reworkRate).toBeGreaterThan(0.05); expect(m.reworkRate).toBeLessThan(0.2);
    expect(m.handoffCount).toBe(m.instanceCount); expect(m.handoffRate).toBe(1);
    expect(m.steps).toHaveLength(6); expect(m.steps[2].app).toBe("QuickBooks"); expect(m.steps.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 1);
    expect(m.processMap.nodes.length).toBe(6); expect(m.processMap.edges[0].count).toBeGreaterThan(100);
    expect(m.apps).toEqual(["Outlook", "Adobe Acrobat", "QuickBooks", "Excel"]);
    expect(m.typeShare.data_entry).toBeGreaterThan(0.5);
    expect(nameWorkflow(m)).toBe("Bill entry (Outlook → Adobe Acrobat → QuickBooks → Excel)");
  });
  it("names use plain English with acronyms", () => { expect(capitalize("hr system")).toBe("HR system"); expect(capitalize("sales order")).toBe("Sales order"); expect(stepToken({ app: "A", titleCategory: "B", type: "x" })).toBe("A:b:x"); });
});
