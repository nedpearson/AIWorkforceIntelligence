import { test, expect, USD_ANYWHERE } from "./fixtures";

test.describe("Search & assistant", () => {
  test("search for 'invoice' returns workflow results that link to real workflow pages", async ({ ownerPage: page }) => {
    await page.goto("/app");
    await page.getByTestId("nav-search").click();
    await page.waitForURL((u) => u.pathname === "/app/search");
    await page.getByTestId("search-input").fill("invoice");
    await page.getByTestId("search-input").press("Enter");
    await page.waitForURL(/\/app\/search\?q=invoice/);
    const results = page.getByTestId("search-results");
    await expect(results).toBeVisible();
    const workflows = page.getByTestId("search-group-workflows");
    await expect(workflows).toBeVisible();
    const hits = workflows.locator("a[data-testid^='search-hit-']");
    expect(await hits.count()).toBeGreaterThan(0);
    await expect(hits.first()).toContainText(/hrs\/wk · automation \d+/);
    await expect(page.locator("main")).toContainText(/\d+ results? for “invoice”/);
    const href = (await hits.first().getAttribute("href"))!;
    expect(href).toMatch(/^\/app\/workflows\/[0-9a-f-]{36}$/);
    await hits.first().click();
    await page.waitForURL(href);
    await expect(page.getByTestId("workflow-detail")).toBeVisible();
    // deep link form works too
    await page.goto("/app/search?q=zzzz-no-such-thing");
    await expect(page.locator("main")).toContainText(/no results|nothing|0 results/i);
  });

  test("assistant answers 'What is our top opportunity?' with evidence and a citation that resolves", async ({ ownerPage: page }) => {
    await page.goto("/app/assistant");
    await expect(page.getByRole("heading", { level: 1, name: "Ask BridgeBox" })).toBeVisible();
    await expect(page.getByTestId("assistant-page")).toBeVisible();
    await page.getByTestId("assistant-input").fill("What is our top opportunity?");
    await page.getByTestId("assistant-send").click();
    await expect(page.getByTestId("assistant-msg-user")).toContainText("What is our top opportunity?");
    const answer = page.getByTestId("assistant-answer");
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("assistant-error")).toHaveCount(0);
    await expect(answer).toContainText(/top opportunity/i);
    await expect(answer).toContainText(USD_ANYWHERE);
    await expect(answer).toContainText(/realizable/);
    await expect(page.getByTestId("assistant-msg-assistant")).toContainText(/Answered from your evidence|AI-generated from your evidence/);
    await expect(page.getByTestId("assistant-msg-assistant").first()).toContainText(/Scenario: \w+/);

    const citation = page.getByTestId("assistant-citation-opportunity").first();
    await expect(citation).toBeVisible();
    const href = (await citation.getAttribute("href"))!;
    expect(href).toMatch(/^\/app\/opportunities\/[0-9a-f-]{36}$/);
    const res = await page.request.get(href, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    const label = (await citation.innerText()).replace(/^opportunity\s*/i, "").trim();
    await citation.click();
    await page.waitForURL(href);
    await expect(page.getByTestId("opportunity-detail")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(label);
    // the cited opportunity is the rank-1 one
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/^1/);
  });
});
