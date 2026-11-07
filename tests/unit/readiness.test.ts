/** Readiness gate computation (task 11). Pure: proves there is no hard-coded PASS. */
import { describe, it, expect } from "vitest";
import { GATES, computeGate, computeOverall, computeReadiness, type LiveCheck, type EvidenceRow, type FindingRow } from "@/engine/readiness/gates";
import { FINDINGS } from "@/engine/readiness/findings";

const allLive = (ok = true): LiveCheck[] => (["db_reachable", "migrations_applied", "demo_password_accounts", "owner_mfa", "env_vars", "cron_recent", "rls_enabled", "audit_chain", "csp_header"] as const).map((key) => ({ key, label: key, ok, detail: "" }));
const ev = (gate: string, status: EvidenceRow["status"] = "pass", at = "2026-11-07T00:00:00Z"): EvidenceRow => ({ gate, status, commitSha: "abcdef1234", command: "cmd", environment: "local-ci-equivalent", evidence: "ok", recordedBy: "t", recordedAt: at });
const findingsClean: FindingRow[] = [{ id: "X-1", title: "t", severity: "high", status: "remediated", owner: "o", nextAction: "n" }];
const gate = (k: string) => GATES.find((g) => g.key === k)!;

describe("gate status", () => {
  it("there are exactly 18 gates with unique keys", () => {
    expect(GATES.length).toBe(18); expect(new Set(GATES.map((g) => g.key)).size).toBe(18);
  });
  it("with no evidence and no live data, nothing passes (no hard-coded PASS)", () => {
    const r = computeReadiness([], [], null);
    expect(r.gates.filter((g) => g.status === "pass")).toEqual([]);
    expect(r.overall).toBe("NO-GO");
  });
  it("live checks alone never pass an evidence gate", () => {
    expect(computeGate(gate("tenant_isolation"), allLive(true), [], null)).toMatchObject({ status: "not_verified" });
    expect(computeGate(gate("tenant_isolation"), allLive(true), [ev("tenant_isolation")], null).status).toBe("pass");
  });
  it("a failing live check fails the gate even with PASS evidence", () => {
    const live = allLive(true).map((c) => (c.key === "owner_mfa" ? { ...c, ok: false } : c));
    expect(computeGate(gate("authn_authz"), live, [ev("authn_authz")], null)).toMatchObject({ status: "fail" });
  });
  it("a live-only gate passes on live checks; a missing live check counts as failed", () => {
    expect(computeGate(gate("production_config"), allLive(true), [], null).status).toBe("pass");
    expect(computeGate(gate("production_config"), allLive(true).filter((c) => c.key !== "csp_header"), [], null).status).toBe("fail");
  });
  it("latest evidence wins; fail and blocked evidence are reported as such", () => {
    expect(computeGate(gate("e2e"), [], [ev("e2e", "pass", "2026-11-01T00:00:00Z"), ev("e2e", "fail", "2026-11-05T00:00:00Z")], null).status).toBe("fail");
    expect(computeGate(gate("e2e"), [], [ev("e2e", "fail", "2026-11-01T00:00:00Z"), ev("e2e", "pass", "2026-11-05T00:00:00Z")], null).status).toBe("pass");
    expect(computeGate(gate("desktop_collectors"), [], [ev("desktop_collectors", "blocked")], null).status).toBe("blocked");
  });
  it("security gate: empty register = not verified; open high = fail; remediated = pass", () => {
    expect(computeGate(gate("security_findings"), [], [], null).status).toBe("not_verified");
    expect(computeGate(gate("security_findings"), [], [], []).status).toBe("not_verified");
    expect(computeGate(gate("security_findings"), [], [], [{ ...findingsClean[0], status: "open" }]).status).toBe("fail");
    expect(computeGate(gate("security_findings"), [], [], [{ ...findingsClean[0], status: "open", severity: "medium" }]).status).toBe("pass");
    expect(computeGate(gate("security_findings"), [], [], findingsClean).status).toBe("pass");
  });
});

describe("overall decision", () => {
  it("GO only when all 18 pass", () => {
    const r = computeReadiness(allLive(true), GATES.map((g) => ev(g.key)), findingsClean);
    expect(r.overall).toBe("GO"); expect(r.blockers).toEqual([]);
  });
  it("CONDITIONAL GO when every critical gate passes and only non-critical gates are unverified/blocked", () => {
    const evidence = GATES.filter((g) => g.critical).map((g) => ev(g.key)).concat([ev("desktop_collectors", "blocked")]);
    const r = computeReadiness(allLive(true), evidence, findingsClean);
    expect(r.overall).toBe("CONDITIONAL GO");
    expect(r.conditions.map((g) => g.key)).toContain("desktop_collectors");
  });
  it("NO-GO when any gate fails or a critical gate is not verified", () => {
    const evidence = GATES.filter((g) => g.critical && g.key !== "backup_restore").map((g) => ev(g.key));
    const r = computeReadiness(allLive(true), evidence, findingsClean);
    expect(r.overall).toBe("NO-GO"); expect(r.blockers.map((g) => g.key)).toEqual(["backup_restore"]);
    const r2 = computeReadiness(allLive(true), GATES.map((g) => ev(g.key)).concat([ev("performance", "fail", "2030-01-01T00:00:00Z")]), findingsClean);
    expect(computeOverall(r2.gates).overall).toBe("NO-GO");
  });
  it("the shipped findings register has no open critical/high finding and unique ids", () => {
    expect(new Set(FINDINGS.map((f) => f.id)).size).toBe(FINDINGS.length);
    expect(FINDINGS.filter((f) => f.status === "open" && ["critical", "high"].includes(f.severity))).toEqual([]);
    expect(FINDINGS.find((f) => f.id === "SEC-001")?.status).toBe("remediated");
  });
});
