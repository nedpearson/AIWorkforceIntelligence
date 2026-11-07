import { test, expect, uniq, GULF_COAST_NAME, BAYOU_NAME, USD_ANYWHERE } from "./fixtures";

const TABS = ["overview", "checklist", "collectors", "campaigns", "opportunities", "projects", "agents", "billing", "reports", "branding"] as const;

test.describe("Consulting portal", () => {
  test("portfolio lists both demo clients with projected and verified figures", async ({ consultantPage: page }) => {
    await page.goto("/admin");
    await expect(page.getByTestId("admin-portfolio")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Client portfolio" })).toBeVisible();
    const totals = page.getByTestId("portfolio-totals");
    await expect(totals).toContainText("Projected savings / yr");
    await expect(totals).toContainText("Verified savings / yr");
    await expect(totals).toContainText("Monthly recurring revenue");
    expect((await totals.innerText()).match(/\$[\d.,]+[KMB]?/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId("portfolio-chart").locator("svg.recharts-surface").first()).toBeVisible();

    for (const name of [GULF_COAST_NAME, BAYOU_NAME]) {
      const card = page.locator("[data-testid^='client-card-']", { hasText: name });
      await expect(card).toBeVisible();
      await expect(card).toContainText("synthetic demo");
      await expect(card).toContainText("Projected / yr");
      await expect(card).toContainText("Verified / yr");
      const projected = await card.locator("dd.text-projected").innerText();
      const verified = await card.locator("dd.text-verified").innerText();
      expect(projected).toMatch(USD_ANYWHERE);
      expect(verified).toMatch(USD_ANYWHERE);
      await expect(card.getByTestId("client-next-step")).not.toBeEmpty();
    }
    // Gulf Coast has an analysis and real projected savings; Bayou Dental has nothing yet (honest zero)
    const gulf = page.locator("[data-testid^='client-card-']", { hasText: GULF_COAST_NAME });
    expect(await gulf.locator("dd.text-projected").innerText()).not.toBe("$0");
    await expect(gulf).toContainText("growth");
    await expect(gulf).toContainText("active");
    const bayou = page.locator("[data-testid^='client-card-']", { hasText: BAYOU_NAME });
    expect(await bayou.locator("dd.text-projected").innerText()).toBe("$0");
    await expect(bayou).toContainText("trialing");
  });

  test("client workspace: every tab loads; a project can be created; billing is honest about Stripe not being configured", async ({ consultantPage: page }) => {
    await page.goto("/admin");
    await page.locator("[data-testid^='client-card-']", { hasText: GULF_COAST_NAME }).click();
    await page.waitForURL(/\/admin\/clients\/([0-9a-f-]{36})/);
    const ws = page.getByTestId("client-workspace");
    await expect(ws).toBeVisible();
    await expect(ws).toContainText(GULF_COAST_NAME);

    const goTab = async (t: (typeof TABS)[number]) => {
      await page.getByTestId(`tab-${t}`).click();
      await page.waitForURL(new RegExp(`tab=${t}$`));
      await expect(page.getByTestId(`tab-${t}`)).toHaveClass(/border-brand/);
    };
    for (const t of TABS) {
      await goTab(t);
      await expect(page.locator("body")).not.toContainText("Application error");
      await expect(page.locator("main")).not.toContainText("Something went wrong");
    }
    // Overview shows the financial slice; opportunities tab lists the ranked rows; collectors tab lists the seeded workstations
    await goTab("overview");
    await expect(page.locator("main")).toContainText(USD_ANYWHERE);
    await goTab("opportunities");
    await expect.poll(() => page.locator("tr[data-testid^='opp-row-']").count()).toBeGreaterThanOrEqual(3);
    await goTab("collectors");
    await expect.poll(() => page.locator("tr[data-testid^='collector-row-']").count()).toBeGreaterThanOrEqual(3);
    await goTab("campaigns");
    await expect.poll(() => page.locator("tr[data-testid^='campaign-row-']").count()).toBeGreaterThanOrEqual(1);

    // Projects: create one
    await goTab("projects");
    const projectName = `E2E rollout ${uniq("proj")}`;
    const newBtn = page.getByTestId("project-new").or(page.getByTestId("project-new-empty"));
    await newBtn.first().click();
    await expect(page.getByTestId("project-form")).toBeVisible();
    await page.getByTestId("project-name").fill(projectName);
    await page.getByTestId("project-status").selectOption("in_progress");
    await page.getByTestId("project-budget").fill("12000");
    await page.getByTestId("project-spent").fill("1500");
    await page.getByTestId("project-notes").fill("Created by the Playwright acceptance suite.");
    const firstOpp = page.getByTestId("project-form").locator("input[data-testid^='project-opp-']").first();
    if (await firstOpp.count()) await firstOpp.check();
    await page.getByTestId("project-save").click();
    await expect(page.getByTestId("project-form")).toBeHidden();
    const row = page.locator("tr[data-testid^='project-row-']", { hasText: projectName });
    await expect(row).toBeVisible();
    await expect(row).toContainText("in progress");
    await expect(row).toContainText("$12,000");
    await expect(row).toContainText("$1,500");
    // and it shows up in the cross-client Projects page
    await page.goto("/admin/projects");
    await expect(page.getByTestId("projects-page")).toContainText(projectName);
    await page.goBack();

    // Billing tab: Stripe is not configured → says so with the env var names, offers no fake checkout success
    await page.goto(page.url().replace(/tab=\w+/, "tab=billing"));
    const notConfigured = page.getByTestId("stripe-not-configured");
    await expect(notConfigured).toBeVisible();
    await expect(notConfigured).toContainText("Stripe is not configured");
    for (const v of ["STRIPE_SECRET_KEY", "STRIPE_PRICE_STARTER", "STRIPE_PRICE_GROWTH", "STRIPE_PRICE_ENTERPRISE"]) await expect(notConfigured).toContainText(v);
    await expect(page.getByTestId("checkout-success")).toHaveCount(0);
    await expect(page.locator("main")).toContainText(/growth/i);
    for (const tid of ["billing-portal", "billing-sync"]) {
      const b = page.getByTestId(tid);
      if (await b.count()) await expect(b).toBeDisabled();
    }
    // Trying to start checkout anyway yields a clear refusal, never a fake success
    const checkout = page.getByTestId("billing-checkout");
    if (await checkout.count()) {
      await checkout.click();
      const err = page.getByRole("alert").filter({ hasText: /Stripe is not configured/ });
      await expect(err).toBeVisible();
      await expect(err).toContainText("STRIPE_SECRET_KEY");
      await expect(page.getByTestId("checkout-success")).toHaveCount(0);
      expect(page.url()).not.toContain("stripe.com");
    }
    // the portal-wide billing page is consistent with that
    await page.goto("/admin/billing");
    await expect(page.getByTestId("billing-page")).toBeVisible();
    await expect(page.locator("main")).toContainText(GULF_COAST_NAME);
    await expect(page.locator("main")).toContainText(BAYOU_NAME);
    await expect(page.locator("main")).toContainText(/not configured/i);
  });

  test("team page lists the consultancy members with roles", async ({ consultantPage: page }) => {
    await page.goto("/admin/team");
    await expect(page.getByTestId("team-page")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Consultancy team" })).toBeVisible();
    const rows = page.locator("tr[data-testid^='member-row-']");
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
    const me = rows.filter({ hasText: "owner@bridgebox.demo" });
    await expect(me).toHaveCount(1);
    await expect(me).toContainText("Ned Pearson");
    await expect(me).toContainText(/owner/i);
    await expect(page.locator("main")).not.toContainText("admin@gulfcoast.demo"); // client users are not consultancy members
  });
});
