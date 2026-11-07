import { test, expect, ACCOUNTS, PASSWORD, loginViaForm } from "./fixtures";

test.describe("Authentication & authorization", () => {
  test("login succeeds with seeded client-owner credentials and lands on the executive summary", async ({ page }) => {
    await loginViaForm(page, ACCOUNTS.owner.email);
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("heading", { level: 1, name: "Executive Summary" })).toBeVisible();
    await expect(page.getByTestId("sidebar")).toContainText(ACCOUNTS.owner.email);
    await expect(page.getByTestId("sidebar")).toContainText("owner");
  });

  test("login fails with a wrong password and shows an inline error, staying on /login", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("login-email").fill(ACCOUNTS.owner.email);
    await page.getByTestId("login-password").fill("definitely-not-the-password");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-form").getByRole("alert")).toHaveText("Email or password is incorrect.");
    await expect(page).toHaveURL(/\/login/);
    // no session cookie was issued
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name.includes("authjs.session-token"))).toBe(false);
  });

  test("logout clears the session and protected routes redirect to /login afterwards", async ({ page }) => {
    await loginViaForm(page, ACCOUNTS.manager.email, PASSWORD);
    await page.getByTestId("logout").click();
    await page.waitForURL(/\/login/);
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name.includes("authjs.session-token"))).toBe(false);
    await page.goto("/app/workflows");
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fworkflows/);
  });

  test("unauthenticated requests to /app and /admin are redirected to /login with a next= parameter", async ({ page }) => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login\?next=%2Fapp$/);
    await expect(page.getByTestId("login-form")).toBeVisible();
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/);
    // API route handlers answer 401 rather than redirecting
    const res = await page.request.get("/api/reports/00000000-0000-0000-0000-000000000000");
    expect(res.status()).toBe(401);
  });

  test("manager is blocked from /app/settings and /admin (redirected to /app with a denied flag) and sees no Settings nav item", async ({ managerPage: page }) => {
    await page.goto("/app");
    await expect(page.getByTestId("sidebar")).toContainText("manager");
    await expect(page.getByTestId("nav-settings")).toHaveCount(0);
    await expect(page.getByTestId("nav-admin")).toHaveCount(0);
    await expect(page.getByTestId("nav-collection")).toHaveCount(0);

    await page.goto("/app/settings");
    await expect(page).toHaveURL(/\/app\?denied=org(:|%3A)manage/);
    await expect(page.getByRole("heading", { level: 1, name: "Executive Summary" })).toBeVisible();

    await page.goto("/admin");
    await expect(page).toHaveURL(/\/app\?denied=consultancy/);
    await expect(page.getByTestId("admin-sidebar")).toHaveCount(0);
  });

  test("employee cost columns are hidden for a manager and visible to the owner", async ({ managerPage, ownerPage }) => {
    await managerPage.goto("/app/employees");
    await expect(managerPage.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
    await expect(managerPage.getByTestId("cost-hidden-note")).toBeVisible();
    await expect(managerPage.locator("thead")).not.toContainText("Loaded cost");
    await expect(managerPage.locator("thead")).not.toContainText("Potential $/yr");
    await expect(managerPage.locator("tbody")).not.toContainText("/h");

    await ownerPage.goto("/app/employees");
    await expect(ownerPage.getByTestId("cost-hidden-note")).toHaveCount(0);
    await expect(ownerPage.locator("thead")).toContainText("Loaded cost");
    await expect(ownerPage.locator("thead")).toContainText("Potential $/yr");
    await expect(ownerPage.locator("tbody tr").first()).toContainText("/h");
  });
});
