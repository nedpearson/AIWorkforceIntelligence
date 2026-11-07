import { test, expect, watchConsole, GULF_COAST_NAME } from "./fixtures";

/** Every client-app sidebar item (src/components/app-shell.tsx NAV) → expected URL + h1. */
const APP_NAV: { testid: string; path: string; h1: string }[] = [
  { testid: "nav-executive", path: "/app", h1: "Executive Summary" },
  { testid: "nav-departments", path: "/app/departments", h1: "Departments" },
  { testid: "nav-employees", path: "/app/employees", h1: "People" },
  { testid: "nav-workflows", path: "/app/workflows", h1: "Workflows" },
  { testid: "nav-opportunities", path: "/app/opportunities", h1: "Opportunities" },
  { testid: "nav-agents", path: "/app/agents", h1: "AI Agents" },
  { testid: "nav-finance", path: "/app/finance", h1: "Financial Model" },
  { testid: "nav-reports", path: "/app/reports", h1: "Reports" },
  { testid: "nav-collection", path: "/app/collection", h1: "Data Collection" },
  { testid: "nav-assistant", path: "/app/assistant", h1: "Ask BridgeBox" },
  { testid: "nav-settings", path: "/app/settings", h1: "Settings" },
  { testid: "nav-trust", path: "/app/trust", h1: "Trust & Privacy" },
];
/** Consulting-portal items (src/components/admin/admin-shell.tsx ADMIN_NAV). */
const ADMIN_NAV: { testid: string; path: string; h1: string }[] = [
  { testid: "admin-nav-clients", path: "/admin", h1: "Client portfolio" },
  { testid: "admin-nav-pipeline", path: "/admin/pipeline", h1: "Opportunity pipeline" },
  { testid: "admin-nav-projects", path: "/admin/projects", h1: "Projects" },
  { testid: "admin-nav-billing", path: "/admin/billing", h1: "Billing" },
  { testid: "admin-nav-reports", path: "/admin/reports", h1: "Reports" },
  { testid: "admin-nav-team", path: "/admin/team", h1: "Consultancy team" },
];

/** Console noise that is not an application error. Everything else fails the test. */
const IGNORED_CONSOLE = [/favicon\.ico/];

test.describe("Navigation", () => {
  test("client owner: every sidebar item loads its page with the right URL and heading and no console errors", async ({ ownerPage: page }) => {
    const errors = watchConsole(page, { ignore: IGNORED_CONSOLE });
    await page.goto("/app");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    const sidebar = page.getByTestId("sidebar");
    const visible = await sidebar.locator("nav a[data-testid^='nav-']").evaluateAll((as) => as.map((a) => a.getAttribute("data-testid")));
    expect(visible.sort()).toEqual([...APP_NAV.map((n) => n.testid)].sort()); // the owner sees exactly the 12 items
    for (const item of APP_NAV) {
      await sidebar.getByTestId(item.testid).click();
      await page.waitForURL((u) => u.pathname === item.path);
      await expect(page.getByRole("heading", { level: 1, name: item.h1, exact: true })).toBeVisible();
      await expect(page.locator("body")).not.toContainText("Application error");
      await expect(page.locator("main")).not.toContainText("This page could not be found");
      expect(errors, `console errors on ${item.path}`).toEqual([]);
    }
    await expect(page.locator("header")).toContainText(GULF_COAST_NAME);
    await expect(page.getByTestId("demo-banner")).toBeVisible();
  });

  test("consultancy owner: every consulting-portal item loads with the right URL and heading and no console errors", async ({ consultantPage: page }) => {
    const errors = watchConsole(page, { ignore: IGNORED_CONSOLE });
    await page.goto("/admin");
    const sidebar = page.getByTestId("admin-sidebar");
    await expect(sidebar).toBeVisible();
    await expect(page.getByTestId("admin-consultancy-name")).toHaveText("BridgeBox Consulting");
    for (const item of ADMIN_NAV) {
      await sidebar.getByTestId(item.testid).click();
      await page.waitForURL((u) => u.pathname === item.path);
      await expect(page.getByRole("heading", { level: 1, name: item.h1, exact: true })).toBeVisible();
      await expect(page.locator("body")).not.toContainText("Application error");
      expect(errors, `console errors on ${item.path}`).toEqual([]);
    }
    // the cross-link back to the client app works and the client app links back to the portal
    await sidebar.getByTestId("admin-nav-client-app").click();
    await page.waitForURL((u) => u.pathname === "/app");
    await expect(page.getByTestId("sidebar").getByTestId("nav-admin")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("@mobile hamburger menu navigates between pages without horizontal overflow", async ({ ownerPage: page }) => {
    const errors = watchConsole(page, { ignore: IGNORED_CONSOLE });
    await page.goto("/app");
    await expect(page.getByTestId("menu-button")).toBeVisible();
    await expect(page.getByTestId("sidebar")).toBeHidden(); // desktop sidebar is lg:flex only
    const noOverflow = async (where: string) => {
      const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(sw, `horizontal overflow on ${where}: scrollWidth ${sw} > innerWidth ${iw}`).toBeLessThanOrEqual(iw);
    };
    await noOverflow("/app");
    for (const item of [APP_NAV[3], APP_NAV[4], APP_NAV[6]]) { // Workflows, Opportunities, Financial Model
      await page.getByTestId("menu-button").click();
      const drawer = page.getByTestId("mobile-sidebar");
      await expect(drawer).toBeVisible();
      await drawer.getByTestId(item.testid).click();
      await page.waitForURL((u) => u.pathname === item.path);
      await expect(page.getByRole("heading", { level: 1, name: item.h1, exact: true })).toBeVisible();
      await expect(drawer).not.toBeInViewport(); // drawer closed itself (translated off-screen)
      await noOverflow(item.path);
    }
    expect(errors).toEqual([]);
  });

  test("@mobile consulting portal opens on a phone and its drawer works", async ({ consultantPage: page }) => {
    await page.goto("/admin");
    await expect(page.getByTestId("admin-menu-button")).toBeVisible();
    await page.getByTestId("admin-menu-button").click();
    const drawer = page.getByTestId("admin-mobile-sidebar");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("admin-nav-pipeline").click();
    await page.waitForURL((u) => u.pathname === "/admin/pipeline");
    await expect(page.getByRole("heading", { level: 1, name: "Opportunity pipeline" })).toBeVisible();
    const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(sw).toBeLessThanOrEqual(iw);
  });
});
