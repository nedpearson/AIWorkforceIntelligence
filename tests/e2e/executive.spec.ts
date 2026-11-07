import { test, expect, USD_ANYWHERE } from "./fixtures";

test.describe("Executive summary", () => {
  test("hero KPIs show computed dollar values and each opens a drill-down with basis chips and formulas", async ({ ownerPage: page }) => {
    await page.goto("/app");
    await expect(page.getByTestId("executive-summary")).toBeVisible();
    await expect(page.locator("main")).not.toContainText("No analysis yet");

    // 1. Spent on automatable work today — must be a real $ amount > 0
    const wasted = page.getByTestId("kpi-wasted");
    await expect(wasted).toContainText(USD_ANYWHERE);
    expect(Number((await wasted.innerText()).match(/\$([\d,]+)/)![1].replace(/,/g, ""))).toBeGreaterThan(0);
    // 2. Realistically achievable per year — $ amount > 0
    const achievable = page.getByTestId("kpi-achievable");
    await expect(achievable).toContainText(USD_ANYWHERE);
    expect(Number((await achievable.innerText()).match(/\$([\d,]+)/)![1].replace(/,/g, ""))).toBeGreaterThan(0);
    // 3. Verified so far — either a measured $ amount or the honest empty state with a working CTA (never a placeholder)
    const verified = page.getByTestId("kpi-verified");
    const vText = await verified.innerText();
    if (USD_ANYWHERE.test(vText)) expect(vText).toMatch(/\d+ measurements?/);
    else { expect(vText).toContain("No deployments measured yet"); await expect(verified.getByTestId("kpi-verified-cta")).toHaveAttribute("href", /\/app\/(opportunities|agents\/new)/); }

    for (const [tid, label] of [["kpi-wasted", "Spent on automatable work today"], ["kpi-achievable", "Realistically achievable per year"], ["kpi-verified", "Verified so far"]] as const) {
      await page.getByTestId(tid).click();
      const modal = page.getByTestId("drilldown-modal");
      await expect(modal).toBeVisible();
      await expect(page.getByRole("dialog")).toContainText(label);
      await expect(modal).toContainText(/Based on \d+ observed, \d+ estimated and \d+ assumed inputs/);
      // basis chips rendered by <BasisChip>
      expect(await modal.locator("span", { hasText: /^(observed|estimated|assumed)$/ }).count()).toBeGreaterThan(0);
      // at least one formula line (monospace) with an operator in it
      const formulas = modal.locator(".font-mono");
      expect(await formulas.count()).toBeGreaterThan(0);
      await expect(formulas.first()).toContainText(/[×÷+\-=Σ]/);
      await page.getByRole("dialog").getByLabel("Close").click();
      await expect(modal).toHaveCount(0);
    }
  });

  test("all four charts render SVG with plotted data", async ({ ownerPage: page }) => {
    await page.goto("/app");
    for (const tid of ["chart-waterfall", "chart-departments", "chart-three-year", "chart-before-after"]) {
      const frame = page.getByTestId(tid);
      await expect(frame).toBeVisible();
      await expect(frame.locator("svg.recharts-surface").first()).toBeVisible();
      await expect(frame.locator("ul[aria-label='Legend'] li").first()).toBeVisible();
      await expect(frame).not.toContainText("No department data yet");
      // bars (rect) or lines (path) were actually drawn
      expect(await frame.locator("svg .recharts-bar-rectangle, svg .recharts-line-curve, svg path.recharts-rectangle, svg path.recharts-curve").count()).toBeGreaterThan(0);
    }
  });

  test("top opportunities link through to the opportunity page and next actions resolve", async ({ ownerPage: page }) => {
    await page.goto("/app");
    const top = page.getByTestId("top-opps");
    await expect(top.locator("li[data-testid^='top-opp-']").first()).toBeVisible();
    const first = top.locator("li[data-testid^='top-opp-']").first();
    const title = (await first.locator("a[href^='/app/opportunities/']").first().innerText()).trim();
    await expect(first).toContainText(/\$[\d.,]+[KM]?\/yr/);
    await first.locator("a[href^='/app/opportunities/']").first().click();
    await page.waitForURL(/\/app\/opportunities\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("opportunity-detail")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(title);

    await page.goto("/app");
    const links = await page.getByTestId("next-actions").locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      const res = await page.request.get(href, { maxRedirects: 0 });
      expect(res.status(), `next-action link ${href}`).toBe(200);
    }
  });
});
