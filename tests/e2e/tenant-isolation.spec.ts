import { test, expect, BAYOU_NAME, GULF_COAST_NAME } from "./fixtures";
import { closeDb, orgIdBySlug, seededIdsFor, GULF_SLUG, aiEmployeeByPersona, brainDocByTitle, skillRunStatus, latestSkillRunId, type SeededIds } from "./db";
import { ensureCharlotteLive, overThresholdInvoice } from "./workforce-helpers";

test.describe("Tenant isolation", () => {
  let gulf: SeededIds;
  test.beforeAll(async () => { gulf = await seededIdsFor(await orgIdBySlug(GULF_SLUG)); });
  test.afterAll(async () => { await closeDb(); });

  test("Bayou Dental's owner sees only their own (empty) org and cannot reach Gulf Coast entities by id", async ({ bayouPage: page }) => {
    await page.goto("/app");
    await expect(page.locator("header")).toContainText(BAYOU_NAME);
    await expect(page.locator("header")).not.toContainText(GULF_COAST_NAME);
    await expect(page.getByTestId("org-switcher")).toHaveCount(0); // single-org user: no switcher
    await expect(page.getByTestId("nav-admin")).toHaveCount(0);
    await expect(page.getByTestId("sidebar")).toContainText("admin@bayoudental.demo");

    await page.goto("/app/workflows");
    await expect(page.getByRole("heading", { level: 1, name: "Workflows" })).toBeVisible();
    await expect(page.locator("[data-testid^='wf-row-']")).toHaveCount(0);
    await expect(page.locator("main")).toContainText("No workflows discovered yet");
    await expect(page.locator("main").getByRole("link", { name: /rollout checklist/i })).toBeVisible();

    // Direct navigation to Gulf Coast ids: 404 page, never the content
    const targets: [string, string][] = [["workflow", `/app/workflows/${gulf.workflowId}`], ["opportunity", `/app/opportunities/${gulf.opportunityId}`], ["employee", `/app/employees/${gulf.employeeId}`]];
    if (gulf.agentId) targets.push(["agent", `/app/agents/${gulf.agentId}`]);
    for (const [kind, url] of targets) {
      const res = await page.goto(url);
      expect(res?.status(), `${kind} ${url} must be 404 for another tenant`).toBe(404);
      await expect(page.locator("body")).toContainText("This page could not be found");
      await expect(page.getByTestId("workflow-detail")).toHaveCount(0);
      await expect(page.getByTestId("opportunity-detail")).toHaveCount(0);
    }
    // same for the API route that serves report PDFs (an unknown id and, when one exists, a real Gulf Coast id)
    const ids = [gulf.reportId, "00000000-0000-4000-8000-000000000000"].filter(Boolean) as string[];
    for (const id of ids) {
      const res = await page.request.get(`/api/reports/${id}`);
      expect(res.status(), `/api/reports/${id}`).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    }
    // and the Bayou owner cannot switch into Gulf Coast by forging the org cookie through the switch API
    const sw = await page.request.post("/api/org/switch", { data: { orgId: gulf.orgId } });
    expect(sw.status()).toBe(403);
    await page.goto("/app");
    await expect(page.locator("header")).toContainText(BAYOU_NAME);
  });

  test("Gulf Coast's own owner does reach the same ids (proves the ids are real, not just missing)", async ({ ownerPage: page }) => {
    const res = await page.goto(`/app/workflows/${gulf.workflowId}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId("workflow-detail")).toBeVisible();
    const res2 = await page.goto(`/app/opportunities/${gulf.opportunityId}`);
    expect(res2?.status()).toBe(200);
    await expect(page.getByTestId("opportunity-detail")).toBeVisible();
    const res3 = await page.goto(`/app/employees/${gulf.employeeId}`);
    expect(res3?.status()).toBe(200);
    if (gulf.reportId) expect((await page.request.get(`/api/reports/${gulf.reportId}`)).status()).toBe(200);
  });

  test("consultancy owner can switch into Gulf Coast through the org switcher and sees its data", async ({ consultantPage: page }) => {
    await page.goto("/app");
    const switcher = page.getByTestId("sidebar").getByTestId("org-switcher");
    await expect(switcher).toBeVisible();
    const labels = await switcher.locator("option").allInnerTexts();
    expect(labels.some((l) => l.includes("BridgeBox Consulting"))).toBe(true);
    expect(labels.some((l) => l.includes(GULF_COAST_NAME))).toBe(true);
    expect(labels.some((l) => l.includes(BAYOU_NAME))).toBe(true);
    await switcher.selectOption({ label: labels.find((l) => l.includes(GULF_COAST_NAME))! });
    await expect(page.locator("header")).toContainText(GULF_COAST_NAME, { timeout: 20_000 });
    await expect(page.getByTestId("sidebar")).toContainText("consultant"); // acts with the consultant role inside a client
    await expect(page.getByTestId("demo-banner")).toBeVisible();
    await page.goto("/app/workflows");
    expect(await page.locator("[data-testid^='wf-row-']").count()).toBeGreaterThanOrEqual(9);
    await page.goto(`/app/workflows/${gulf.workflowId}`);
    await expect(page.getByTestId("workflow-detail")).toBeVisible();
    // and back into Bayou Dental, which is empty
    await switcher.selectOption({ label: labels.find((l) => l.includes(BAYOU_NAME))! });
    await expect(page.locator("header")).toContainText(BAYOU_NAME, { timeout: 20_000 });
    await page.goto("/app/workflows");
    await expect(page.locator("[data-testid^='wf-row-']")).toHaveCount(0);
  });
});

/**
 * AI Workforce security: tenant isolation of AI employees, skill runs, AI Brain documents and media assets; the skills API
 * refuses another tenant's AI employees; the assistant's action allow-list rejects off-origin navigation; a manager can
 * neither raise an AI employee's permission level nor approve an over-threshold (elevated) skill run.
 */
test.describe("AI Workforce security", () => {
  let orgId = ""; let charlotteId = ""; let docId = ""; let runId = "";
  test.beforeAll(async () => {
    orgId = await orgIdBySlug(GULF_SLUG);
    const c = await aiEmployeeByPersona(orgId, "charlotte"); if (!c) throw new Error("Charlotte not seeded");
    charlotteId = c.id;
    const d = await brainDocByTitle(orgId, "Purchase Order Register (sample)"); if (!d) throw new Error("Brain demo document missing");
    docId = d.id;
  });
  test.afterAll(async () => { await closeDb(); });

  test("Bayou Dental's owner gets 404 for Gulf Coast AI employees, skill runs, Brain documents and media, and cannot run Gulf Coast skills", async ({ ownerPage, bayouPage }) => {
    // a Gulf Coast skill run (sandbox, harmless) and a Gulf Coast media asset (unattached AI portrait) to aim at
    const sb = await ownerPage.request.post("/api/skills/run", { data: { aiEmployeeId: charlotteId, skillKey: "process_invoice", mode: "sandbox" } });
    expect(sb.status()).toBe(200);
    runId = (await sb.json()).skillRunId;
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0000003010100c9fe92ef0000000049454e44ae426082", "hex");
    const up = await ownerPage.request.post("/api/media", { multipart: { file: { name: "ai.png", mimeType: "image/png", buffer: png }, kind: "ai_portrait", provenance: "ai_generated" } });
    expect(up.status()).toBe(201);
    const mediaId = (await up.json()).id as string;
    expect((await ownerPage.request.get(`/api/media/${mediaId}`)).status()).toBe(200); // real id, real bytes for its own tenant

    // AI employee profile → 404 page, never the content
    const prof = await bayouPage.goto(`/app/workforce/${charlotteId}`);
    expect(prof?.status()).toBe(404);
    await expect(bayouPage.locator("body")).toContainText("This page could not be found");
    await expect(bayouPage.getByTestId("profile-hero")).toHaveCount(0);
    await bayouPage.goto("/app/workforce");
    await expect(bayouPage.locator("main")).not.toContainText("Charlotte");
    // skill run read-back → 404
    const rr = await bayouPage.request.get(`/api/skills/run?id=${runId}`);
    expect(rr.status()).toBe(404);
    // running a skill on Gulf Coast's AI employee: sandbox and live → 404 (no existence leak, nothing executed)
    for (const mode of ["sandbox", "live"] as const) {
      const r = await bayouPage.request.post("/api/skills/run", { data: { aiEmployeeId: charlotteId, skillKey: "process_invoice", mode, input: mode === "live" ? { text: overThresholdInvoice("X-1") } : undefined } });
      expect([403, 404], `/api/skills/run ${mode}`).toContain(r.status());
      expect(JSON.stringify(await r.json())).not.toContain("Charlotte");
    }
    expect(await latestSkillRunId(charlotteId), "no run was recorded for the other tenant's request").toBe(runId);
    // deciding / reviewing Gulf Coast's run → 404
    const dec = await bayouPage.request.post("/api/skills/decide", { data: { skillRunId: runId, decision: "approve", confirm: true } });
    expect(dec.status()).toBe(404);
    const rev = await bayouPage.request.post("/api/skills/review", { data: { skillRunId: runId, verdict: "accepted" } });
    expect(rev.status()).toBe(404);
    // media asset → 404 for the other tenant
    const media = await bayouPage.request.get(`/api/media/${mediaId}`);
    expect(media.status()).toBe(404);
    // AI Brain document: deep link by id shows nothing of Gulf Coast's document
    const brain = await bayouPage.goto(`/app/brain?tab=library&doc=${docId}`);
    expect(brain?.status()).toBe(200);
    await expect(bayouPage.locator("main")).not.toContainText("Purchase Order Register");
    await expect(bayouPage.locator("main")).not.toContainText("PO-24-1194");
    // and the Bayou assistant cannot retrieve it either
    const ans = await bayouPage.request.post("/api/assistant", { data: { question: "What is the amount of purchase order PO-24-1194 for Gulfline Electrical?", universal: true } });
    expect(ans.status()).toBe(200);
    const aj = await ans.json() as { answer: string; citations: { id: string }[] };
    expect(aj.answer).not.toContain("7,640");
    expect(aj.citations.map((c) => c.id)).not.toContain(docId);
  });

  test("assistant actions: only allow-listed in-app navigation; off-origin, scheme and unknown actions are rejected", async ({ ownerPage: page }) => {
    const ok = await page.request.post("/api/assistant/action", { data: { kind: "navigate", href: "/app/workforce" } });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).href).toBe("/app/workforce");
    for (const href of ["https://evil.example/phish", "//evil.example/app", "javascript:alert(1)", "/\\evil.example", "/api/reports/00000000-0000-4000-8000-000000000000", "/app/../admin", "/app/workforce/../../admin", "/app/workforce/%2e%2e/%2e%2e/admin"]) {
      const r = await page.request.post("/api/assistant/action", { data: { kind: "navigate", href } });
      expect(r.status(), `navigate ${href}`).toBe(400);
      expect((await r.json()).href).toBeUndefined();
    }
    const unknown = await page.request.post("/api/assistant/action", { data: { kind: "set_permission", payload: { level: "autonomous" } } });
    expect(unknown.status()).toBe(400);
  });

  test("manager cannot raise an AI employee's permission level or approve an over-threshold skill run", async ({ ownerPage, managerPage }) => {
    test.setTimeout(4 * 60_000);
    await ensureCharlotteLive(ownerPage, orgId);
    const before = (await aiEmployeeByPersona(orgId, "charlotte"))!;
    // UI: the manager sees the permission ladder read-only
    await managerPage.goto(`/app/workforce/${charlotteId}?tab=customize`);
    for (const k of ["read_only", "draft_only", "act_with_approval", "autonomous"]) await expect(managerPage.getByTestId(`perm-${k}`)).toBeDisabled();
    // server: invoking the page's own setPermissionAction server action directly (as a forged client would) is refused
    // and nothing changes — the check lives in the server action, not in the disabled button
    const up = ["read_only", "draft_only", "act_with_approval", "autonomous"][["read_only", "draft_only", "act_with_approval", "autonomous"].indexOf(before.permissionLevel) + 1];
    const forged = await managerPage.evaluate(async ({ id, level }) => {
      const srcs = [...new Set([...document.querySelectorAll("script[src]")].map((s) => (s as HTMLScriptElement).src).concat(performance.getEntriesByType("resource").map((e) => e.name)))].filter((u) => u.includes("/_next/static/chunks/") && u.endsWith(".js"));
      let actionId: string | null = null;
      for (const u of srcs) { const t = await (await fetch(u)).text(); const m = t.match(/createServerReference\)\("([0-9a-f]+)",[^)]*"setPermissionAction"\)/); if (m) { actionId = m[1]; break; } }
      if (!actionId) return { actionId: null, status: 0, body: "" };
      const r = await fetch(location.pathname, { method: "POST", headers: { "Next-Action": actionId, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" }, body: JSON.stringify([{ id, level, confirm: true }]) });
      return { actionId, status: r.status, body: await r.text() };
    }, { id: charlotteId, level: up });
    expect(forged.actionId, "found the page's setPermissionAction reference").not.toBeNull();
    expect(forged.body).toContain("requires agents:write");
    expect(forged.body).not.toContain('"ok":true');
    expect((await aiEmployeeByPersona(orgId, "charlotte"))!.permissionLevel).toBe(before.permissionLevel);

    // an over-threshold live run (owner) waits for an owner/admin
    const live = await ownerPage.request.post("/api/skills/run", { data: { aiEmployeeId: charlotteId, skillKey: "process_invoice", mode: "live", input: { text: overThresholdInvoice(`SEC-${Date.now().toString().slice(-7)}`) } } });
    expect(live.status()).toBe(200);
    const lj = await live.json() as { skillRunId: string; status: string; output: { approval: { elevated: boolean } } };
    expect(lj.status).toBe("awaiting_approval");
    expect(lj.output.approval.elevated).toBe(true);
    // manager (has agents:approve) is refused by the server for the elevated action
    const dec = await managerPage.request.post("/api/skills/decide", { data: { skillRunId: lj.skillRunId, decision: "approve", confirm: true } });
    expect(dec.status()).toBe(409);
    expect((await dec.json()).error).toMatch(/owner or admin/);
    expect(await skillRunStatus(lj.skillRunId)).toBe("awaiting_approval");
    // and the manager's work queue says so instead of offering Approve
    await managerPage.goto(`/app/workforce/${charlotteId}?tab=work`);
    await expect(managerPage.getByTestId(`approve-blocked-${lj.skillRunId}`)).toContainText("owner or admin");
    await expect(managerPage.getByTestId(`approve-${lj.skillRunId}`)).toHaveCount(0);
    // the owner can (here: rejects, so nothing is posted and the queue stays clean)
    const rej = await ownerPage.request.post("/api/skills/decide", { data: { skillRunId: lj.skillRunId, decision: "reject", confirm: true } });
    expect(rej.status()).toBe(200);
    expect(await skillRunStatus(lj.skillRunId)).toBe("rejected");
  });
});
