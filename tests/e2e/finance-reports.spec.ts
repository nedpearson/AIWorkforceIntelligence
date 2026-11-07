import { test, expect, USD_ANYWHERE } from "./fixtures";

const money = (s: string) => { const m = s.match(/-?\$([\d.,]+)\s?([KMB])?/); if (!m) return NaN; const n = Number(m[1].replace(/,/g, "")); return n * (m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "B" ? 1e9 : 1); };

test.describe("Financial model & reports", () => {
  test("moving the adoption slider changes net savings; scenario presets change it too", async ({ ownerPage: page }) => {
    await page.goto("/app/finance");
    await expect(page.getByTestId("finance-page")).toBeVisible();
    const net = page.getByTestId("finance-tile-net");
    await expect(net).toContainText(USD_ANYWHERE);
    const before = await net.innerText();
    const v0 = money(before);
    expect(Number.isFinite(v0)).toBe(true);

    // adoption 75% → 20% (number input is bound to the same state as the range slider)
    const adoption = page.getByTestId("finance-number-adoptionRate");
    const initialAdoption = Number(await adoption.inputValue());
    await adoption.fill(initialAdoption === 20 ? "40" : "20");
    await expect(page.getByTestId("finance-slider-adoptionRate")).toContainText(initialAdoption === 20 ? "40%" : "20%");
    await expect.poll(async () => money(await net.innerText()), { timeout: 15_000 }).not.toBe(v0);
    const v1 = money(await net.innerText());
    if (initialAdoption === 20) expect(v1).toBeGreaterThan(v0); else expect(v1).toBeLessThan(v0); // adoption moves net in the same direction
    await expect(page.getByTestId("finance-tile-realizable")).toContainText(USD_ANYWHERE);

    // scenario presets
    await page.getByTestId("finance-scenario-aggressive").click();
    await expect(page.getByTestId("finance-slider-adoptionRate")).not.toContainText(initialAdoption === 20 ? "40%" : "20%");
    await expect.poll(async () => money(await net.innerText())).not.toBe(v1);
    const vAggr = money(await net.innerText());
    await page.getByTestId("finance-scenario-conservative").click();
    await expect.poll(async () => money(await net.innerText())).toBeLessThan(vAggr);
    await expect(page.locator("main")).toContainText("Scenario: Conservative");
    // the comparison table shows all three scenarios as $ amounts
    await expect(page.getByTestId("finance-scenarios")).toContainText("Net annual savings");
    await page.getByTestId("finance-reset").click();
    await expect.poll(async () => money(await net.innerText())).toBe(v0);
  });

  test("executive ROI PDF downloads as application/pdf over 10KB and is saved under Reports", async ({ ownerPage: page }) => {
    await page.goto("/app/finance");
    const [res, download] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/reports/generate") && r.request().method() === "POST"),
      page.waitForEvent("download"),
      page.getByTestId("finance-download-roi").click(),
    ]);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    const body = await res.body();
    expect(body.length).toBeGreaterThan(10 * 1024);
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(download.suggestedFilename()).toMatch(/^executive_roi-\d{4}-\d{2}-\d{2}\.pdf$/);
    await expect(page.getByTestId("finance-flash")).toContainText("PDF downloaded and saved under Reports");
    await page.goto("/app/reports");
    await expect(page.locator("tr[data-testid^='reports-row-']").first()).toContainText("Executive ROI");
  });

  test("generate a report from /app/reports, download it via /api/reports/[id]; another org's owner gets 404 for that id", async ({ ownerPage: page, bayouPage }) => {
    await page.goto("/app/reports");
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    const rowsBefore = await page.locator("tr[data-testid^='reports-row-']").count();
    await page.getByTestId("reports-preview-generate-investment_proposal").click();
    await expect(page.getByTestId("reports-kind")).toHaveValue("investment_proposal");
    await page.getByTestId("reports-generate-confirm").click();
    await expect(page.getByTestId("reports-flash")).toContainText("Report generated", { timeout: 45_000 });
    await expect.poll(async () => page.locator("tr[data-testid^='reports-row-']").count()).toBe(rowsBefore + 1);
    const newest = page.locator("tr[data-testid^='reports-row-']").first();
    await expect(newest).toContainText("Investment proposal");
    const link = newest.locator("a[data-testid^='reports-download-']");
    const href = (await link.getAttribute("href"))!;
    expect(href).toMatch(/^\/api\/reports\/[0-9a-f-]{36}$/);

    const mine = await page.request.get(href);
    expect(mine.status()).toBe(200);
    expect(mine.headers()["content-type"]).toContain("application/pdf");
    expect(mine.headers()["content-disposition"]).toMatch(/attachment; filename="investment_proposal-.*\.pdf"/);
    expect((await mine.body()).length).toBeGreaterThan(10 * 1024);
    // clicking the link in the UI downloads the same file
    const [dl] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(dl.suggestedFilename()).toMatch(/investment_proposal-.*\.pdf/);

    // tenant isolation: Bayou Dental's owner cannot fetch Gulf Coast's report (404, never 403/200)
    const theirs = await bayouPage.request.get(href);
    expect(theirs.status()).toBe(404);
    expect(await theirs.json()).toEqual({ error: "not found" });
    await bayouPage.goto("/app/reports");
    await expect(bayouPage.getByTestId(`reports-row-${href.split("/").pop()}`)).toHaveCount(0);
  });
});
