import { test, expect } from "./fixtures";
import fs from "node:fs";

test.describe("Workflow analysis", () => {
  test("workflows list has at least 9 discovered workflows with observed metrics", async ({ ownerPage: page }) => {
    await page.goto("/app/workflows");
    await expect(page.getByRole("heading", { level: 1, name: "Workflows" })).toBeVisible();
    const rows = page.locator("[data-testid^='wf-row-']");
    expect(await rows.count()).toBeGreaterThanOrEqual(9);
    await expect(rows.first()).toContainText(/\d/);
    // search narrows the list (search by the first word of the top workflow's name)
    const total = await rows.count();
    const firstName = (await rows.first().locator("a[href^='/app/workflows/']").first().innerText()).trim();
    await page.getByTestId("wf-search").fill(firstName.split(/[\s(]/)[0]);
    await expect.poll(async () => rows.count()).toBeLessThan(total);
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(rows.first()).toContainText(firstName);
  });

  test("workflow detail: process map, evidence with sample size, sample events drawer and Markdown export", async ({ ownerPage: page }) => {
    await page.goto("/app/workflows");
    const first = page.locator("[data-testid^='wf-row-']").first();
    const name = (await first.locator("a[href^='/app/workflows/']").first().innerText()).trim();
    await first.locator("a[href^='/app/workflows/']").first().click();
    await page.waitForURL(/\/app\/workflows\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("workflow-detail")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);

    // Process map: an SVG directly-follows graph with nodes and edges
    const map = page.getByTestId("process-map");
    await expect(map.locator("svg[role='img']")).toBeVisible();
    expect(await map.locator("[data-testid^='pm-node-']").count()).toBeGreaterThanOrEqual(2);
    expect(await map.locator("svg path[marker-end]").count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator("[data-testid^='wf-step-']").count()).toBeGreaterThanOrEqual(2);

    // Evidence panel: sample size is a positive integer
    const evidence = page.getByTestId("wf-evidence");
    await expect(evidence).toContainText("Observed runs (sample size)");
    const sample = Number((await evidence.locator("dd").first().innerText()).replace(/,/g, ""));
    expect(sample).toBeGreaterThan(0);
    await expect(evidence).toContainText(/\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/);

    // Sample events drawer lists metadata-only rows
    await page.getByTestId("wf-view-events").click();
    const drawer = page.getByTestId("wf-events-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText(/Sample events \(\d+\)/);
    const evRows = drawer.locator("tbody tr");
    expect(await evRows.count()).toBeGreaterThan(0);
    await expect(evRows.first().locator("td").nth(0)).toContainText(/^\d+$/);
    await expect(drawer).not.toContainText("No sample events kept");
    await page.getByRole("dialog").getByLabel("Close").click();

    // Markdown export downloads a file containing the workflow name
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("wf-export-md").click()]);
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    const file = await download.path();
    const md = fs.readFileSync(file!, "utf8");
    expect(md.startsWith(`# ${name}`)).toBe(true);
    expect(md).toContain("## Steps");
    expect(md).toContain("## Evidence");
    expect(md).toContain(`- Observed runs: ${sample}`);
  });
});
