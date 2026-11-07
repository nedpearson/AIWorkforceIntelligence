import { test, expect, uniq } from "./fixtures";

test.describe("Client onboarding (consulting portal)", () => {
  test("wizard creates a client with 3 CSV employees, shows an invite link, and the invitee lands in the new workspace", async ({ consultantPage: page, browser }) => {
    const slug = uniq("acme");
    const name = `Acme Industrial ${slug}`;
    const adminEmail = `${slug}-admin@example.test`;
    const csv = ["name,email,title,department,baseAnnualCost",
      `Alex Rivera,${slug}-alex@example.test,AP Specialist,Finance,52000`,
      `Jordan Lee,${slug}-jordan@example.test,Order Entry Clerk,Operations,44000`,
      `Sam Patel,${slug}-sam@example.test,Dispatcher,Operations,47000`].join("\n");

    await page.goto("/admin/clients/new");
    await expect(page.getByTestId("new-client-wizard")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Add a client" })).toBeVisible();

    // Step 1 — company & admin
    await expect(page.getByTestId("wizard-next-0")).toBeDisabled();
    await page.getByTestId("client-name").fill(name);
    await page.getByTestId("client-industry").fill("Industrial distribution");
    await page.getByTestId("client-admin-email").fill(adminEmail);
    await page.getByTestId("client-admin-name").fill("Taylor Admin");
    await page.getByTestId("wizard-next-0").click();

    // Step 2 — plan
    await expect(page.getByTestId("step-plan")).toBeVisible();
    await page.getByTestId("plan-growth").click();
    await expect(page.getByTestId("plan-growth")).toContainText("selected");
    await expect(page.getByTestId("plan-total")).toContainText(/\$\d/);
    await page.getByTestId("wizard-next-1").click();

    // Step 3 — people (CSV)
    await expect(page.getByTestId("step-people")).toBeVisible();
    await page.getByTestId("client-csv").fill(csv);
    await page.getByTestId("csv-check").click();
    await expect(page.getByTestId("csv-preview")).toHaveText("3 employees, 2 departments");
    await expect(page.getByTestId("csv-errors")).toHaveCount(0);
    await page.getByTestId("wizard-next-2").click();

    // Step 4 — review & submit
    await expect(page.getByTestId("step-review")).toBeVisible();
    await expect(page.getByTestId("step-review")).toContainText(name);
    await expect(page.getByTestId("step-review")).toContainText("3 from CSV");
    await page.getByTestId("wizard-submit").click();

    const done = page.getByTestId("new-client-done");
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done).toContainText("Employees imported: 3");
    const inviteUrl = await page.getByTestId("invite-url").inputValue();
    expect(inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);

    // The portfolio now lists the new client with its 3 employees
    await page.getByTestId("open-client").click();
    await page.waitForURL(/\/admin\/clients\/[0-9a-f-]{36}/);
    await expect(page.getByTestId("client-workspace")).toBeVisible();
    await expect(page.locator("main")).toContainText(name);
    await page.goto("/admin");
    const card = page.locator("[data-testid^='client-card-']", { hasText: name });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Employees");
    await expect(card.locator("dd", { hasText: /^3$/ })).toHaveCount(1);

    // Accept the invitation as a brand-new user in a clean browser context
    const fresh = await browser.newContext();
    try {
      const p2 = await fresh.newPage();
      await p2.goto(inviteUrl);
      const card2 = p2.getByTestId("invite-card");
      await expect(card2).toBeVisible();
      await expect(card2).toContainText(`You're invited to ${name}`);
      await expect(card2).toContainText("owner");
      await expect(p2.getByTestId("invite-create-form")).toBeVisible();
      await expect(p2.getByTestId("invite-email")).toHaveValue(adminEmail);
      await p2.getByTestId("invite-name").fill("Taylor Admin");
      await p2.getByTestId("invite-password").fill("Welcome-Aboard-2026!");
      await p2.getByTestId("invite-password2").fill("Welcome-Aboard-2026!");
      await p2.getByTestId("invite-create-accept").click();
      await p2.waitForURL((u) => u.pathname === "/app", { timeout: 45_000 });
      await expect(p2.locator("header")).toContainText(name);
      await expect(p2.getByTestId("sidebar")).toContainText(adminEmail);
      await expect(p2.getByTestId("sidebar")).toContainText("owner");
      await expect(p2.getByTestId("org-switcher")).toHaveCount(0); // single-org user
      await expect(p2.getByTestId("demo-banner")).toHaveCount(0); // real client, not synthetic
      // the invite is single-use
      await p2.goto(inviteUrl);
      await expect(p2.getByTestId("invite-invalid")).toContainText("already used");
      // their imported people are there
      await p2.goto("/app/employees");
      await expect(p2.locator("tbody tr[data-testid^='emp-row-']")).toHaveCount(3);
      await expect(p2.locator("tbody")).toContainText("Alex Rivera");
    } finally { await fresh.close(); }
  });
});
