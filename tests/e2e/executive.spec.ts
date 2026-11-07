import { test, expect, USD_ANYWHERE } from "./fixtures";
import { EXEC_H1 } from "./nav-map";

const dollars = (s: string) => { const m = s.match(/-?\$([\d.,]+)\s?([KMB])?/); if (!m) return NaN; const n = Number(m[1].replace(/,/g, "")); return n * (m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "B" ? 1e9 : 1); };

test.describe("Executive Command Center", () => {
  test("primary KPIs show computed dollar values and each opens a drill-down with a basis chip and a formula tree", async ({ ownerPage: page }) => {
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1, name: EXEC_H1 })).toBeVisible();
    await expect(page.getByTestId("executive-summary")).toBeVisible();
    await expect(page.getByTestId("cmd-setup")).toHaveCount(0); // seeded org has data → no setup banner

    for (const tid of ["kpi-labor", "kpi-opportunity", "kpi-net"]) {
      const kpi = page.getByTestId(tid);
      await expect(kpi).toContainText(USD_ANYWHERE);
      expect(dollars(await kpi.innerText()), `${tid} is a positive $ amount`).toBeGreaterThan(0);
    }
    // Verified: a measured $ amount with its measurement count, or the honest empty state (never a placeholder)
    const verified = page.getByTestId("kpi-verified");
    const vText = await verified.innerText();
    if (USD_ANYWHERE.test(vText)) expect(vText).toMatch(/\d+ measurements?/);
    else { expect(vText).toContain("Not yet measured"); expect(vText).toMatch(/Deploy an agent|Record a measurement/); }

    const drills: [string, RegExp][] = [["kpi-labor", /Annual labor expense/], ["kpi-opportunity", /Automation opportunity/], ["kpi-net", /Projected net savings/], ["kpi-verified", /Verified savings/], ["kpi-hours", /Recoverable hours/], ["kpi-roi", /first-year ROI/i]];
    for (const [tid, title] of drills) {
      await page.getByTestId(tid).click();
      const drawer = page.getByTestId("drill-drawer");
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("heading", { level: 2 })).toHaveText(title);
      await expect(drawer).toContainText("What this means");
      expect(await drawer.locator("span", { hasText: /^(observed|estimated|assumed)$/i }).count(), `${tid}: basis chip`).toBeGreaterThan(0);
      const formulas = page.getByTestId("drill-tree").locator(".font-mono");
      expect(await formulas.count(), `${tid}: formula lines`).toBeGreaterThan(0);
      await expect(formulas.first()).toContainText(/[×÷+\-−=Σ]/); // − is U+2212 (typographic minus)
      await drawer.getByLabel("Close").click();
      await expect(drawer).toHaveCount(0);
    }
  });

  test("savings waterfall and heatmap are drawn from data and drill into calculations / opportunities", async ({ ownerPage: page }) => {
    await page.goto("/app");
    const wf = page.getByTestId("waterfall");
    await expect(wf).toBeVisible();
    await expect(wf).toHaveAttribute("aria-label", /Savings waterfall: .*\$/); // text alternative for the chart
    const bars = wf.locator("button[data-testid^='waterfall-']");
    expect(await bars.count()).toBe(7); // seven savings tiers, never mixed
    await page.getByTestId("waterfall-potential").click();
    await expect(page.getByTestId("drill-drawer")).toBeVisible();
    await expect(page.getByTestId("drill-tree")).toContainText(USD_ANYWHERE);
    await page.getByTestId("drill-drawer").getByLabel("Close").click();

    const cells = page.getByTestId("heatmap").locator("a[data-testid^='heat-']");
    expect(await cells.count()).toBeGreaterThan(0);
    const href = (await cells.first().getAttribute("href"))!;
    expect(href).toMatch(/^\/app\/opportunities\?/);
    await cells.first().click();
    await page.waitForURL((u) => u.pathname === "/app/opportunities");
    await expect(page.getByTestId("opp-list").locator("[data-testid^='opp-card-']").first()).toBeVisible();
  });

  test("recommendations link to the opportunity analysis; tracker and section links resolve", async ({ ownerPage: page }) => {
    await page.goto("/app");
    const recs = page.getByTestId("cmd-recommendations").locator("tr[data-testid^='rec-']");
    await expect(recs.first()).toBeVisible();
    const first = recs.first();
    const id = (await first.getAttribute("data-testid"))!.replace("rec-", "");
    const title = (await first.locator("td").nth(1).locator("div").first().innerText()).trim();
    await expect(first).toContainText(USD_ANYWHERE);
    await page.getByTestId(`rec-view-${id}`).click();
    await page.waitForURL(new RegExp(`/app/opportunities/${id}$`));
    await expect(page.getByTestId("opportunity-detail")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(title);

    await page.goto("/app");
    const links = await page.locator("[data-testid='cmd-tracker'] a[href], [data-testid='cmd-departments'] a[href], [data-testid='cmd-insights'] a[href]").evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))]);
    expect(links.length).toBeGreaterThan(3);
    for (const href of links) {
      const res = await page.request.get(href, { maxRedirects: 0 });
      expect(res.status(), `link ${href}`).toBe(200);
    }
  });

  test("scenario switch recomputes projected net savings (conservative < expected < aggressive) and persists in the URL", async ({ ownerPage: page }) => {
    await page.goto("/app");
    const net = page.getByTestId("kpi-net");
    const expected = dollars(await net.innerText());
    await page.getByTestId("cmd-scenario-conservative").click();
    await page.waitForURL(/scenario=conservative/);
    await expect.poll(async () => dollars(await net.innerText())).toBeLessThan(expected);
    await page.getByTestId("cmd-scenario-aggressive").click();
    await page.waitForURL(/scenario=aggressive/);
    await expect.poll(async () => dollars(await net.innerText())).toBeGreaterThan(expected);
    await expect(page.getByTestId("cmd-scenario-aggressive")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("cmd-scenario-expected").click();
    await expect.poll(async () => dollars(await net.innerText())).toBe(expected);
  });
});
