import { test, expect, USD_ANYWHERE, expandCalcTree } from "./fixtures";

test.describe("Opportunities", () => {
  test("ranked list, type filter, rank-1 detail with calculation tree, approve and reopen", async ({ ownerPage: page }) => {
    await page.goto("/app/opportunities");
    await expect(page.getByRole("heading", { level: 1, name: "Opportunities" })).toBeVisible();
    const cards = page.getByTestId("opp-list").locator("[data-testid^='opp-card-']");
    const total = await cards.count();
    expect(total).toBeGreaterThanOrEqual(3);

    // Ranked: the rank bubbles are ascending and start at 1
    const ranks = await cards.locator("span[title='Rank']").allInnerTexts();
    expect(ranks.map(Number)).toEqual([...ranks.map(Number)].sort((a, b) => a - b));
    expect(ranks[0]).toBe("1");
    await expect(page.locator("main")).toContainText(/realizable/);
    await expect(page.locator("main")).toContainText(USD_ANYWHERE);

    // Filter by type
    const typeSelect = page.getByTestId("opp-filter-type");
    const types = await typeSelect.locator("option[value]:not([value=''])").evaluateAll((os) => os.map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent ?? "" })));
    let picked: { value: string; label: string } | null = null;
    for (const t of types) { if (await cards.filter({ hasText: t.label }).count()) { picked = t; break; } }
    expect(picked, "at least one type has opportunities").not.toBeNull();
    await typeSelect.selectOption(picked!.value);
    await expect.poll(async () => cards.count()).toBeLessThanOrEqual(total);
    const n = await cards.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await expect(cards.nth(i)).toContainText(picked!.label);
    await expect(page.locator("main")).toContainText(`${n} of ${total}`);
    await typeSelect.selectOption("");
    await expect.poll(async () => cards.count()).toBe(total);

    // Open rank 1
    const rank1 = cards.first();
    const title = (await rank1.locator("a[href^='/app/opportunities/']").first().innerText()).trim();
    await rank1.locator("a[href^='/app/opportunities/']").first().click();
    await page.waitForURL(/\/app\/opportunities\/([0-9a-f-]{36})$/);
    const oppId = page.url().split("/").pop()!;
    await expect(page.getByTestId("opportunity-detail")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(title);

    // CalcTree with the adoption-rate assumption
    const calc = page.getByTestId("opp-calculation");
    await expect(calc).toBeVisible();
    await expect(calc).toContainText("Realizable annual savings");
    await expandCalcTree(calc);
    await expect(calc).toContainText("Adoption rate");
    await expect(calc).toContainText("workflow hrs/wk × automation % × adoption rate");
    await expect(calc).toContainText(/\d+(\.\d+)?%/);
    await expect(calc.locator(".font-mono").first()).toBeVisible();
    await expect(page.getByTestId("opp-meters")).toContainText("Feasibility");

    // Approve → badge changes; Reopen → back to identified. Rank 1 may already be managed by an agent
    // (a previous run of agents.spec.ts deploys one); then the actions are legitimately locked.
    const actions = page.getByTestId(`opp-actions-${oppId}`);
    if (!(await actions.isVisible().catch(() => false))) {
      await expect(page.locator("main")).toContainText("Managed by its agent");
      test.info().annotations.push({ type: "note", description: `rank-1 opportunity ${oppId} is locked by an agent; approve/reopen skipped` });
      return;
    }
    const header = page.locator("h1 + p"); // PageHeader subtitle: type badge, status badge, basis chip
    const statusBefore = (await header.textContent())?.match(/(identified|reviewing|approved|rejected)/)?.[1];
    expect(statusBefore).toBeTruthy();
    if (statusBefore === "approved") { await page.getByTestId(`opp-reopen-${oppId}`).click(); await expect(header).toContainText("identified"); }
    await page.getByTestId(`opp-approve-${oppId}`).click();
    await expect(header).toContainText("approved");
    await expect(page.getByTestId(`opp-approve-${oppId}`)).toHaveCount(0);
    await page.reload(); // persisted, not just local state
    await expect(header).toContainText("approved");
    await page.getByTestId(`opp-reopen-${oppId}`).click();
    await expect(header).toContainText("identified");
    await page.reload();
    await expect(header).toContainText("identified");
    await expect(page.getByTestId(`opp-approve-${oppId}`)).toBeVisible();
  });
});
