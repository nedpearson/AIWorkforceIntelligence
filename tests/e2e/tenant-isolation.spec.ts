import { test, expect, BAYOU_NAME, GULF_COAST_NAME } from "./fixtures";
import { closeDb, orgIdBySlug, seededIdsFor, GULF_SLUG, type SeededIds } from "./db";

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
