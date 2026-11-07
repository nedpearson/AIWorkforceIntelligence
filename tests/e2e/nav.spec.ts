import { test, expect, watchConsole, GULF_COAST_NAME } from "./fixtures";
import { APP_NAV, BENIGN_CONSOLE, navFor } from "./nav-map";

const byTestid = (t: string) => APP_NAV.find((n) => n.testid === t)!;

/** Consulting-portal items (src/components/admin/admin-shell.tsx ADMIN_NAV). */
const ADMIN_NAV: { testid: string; path: string; h1: string }[] = [
  { testid: "admin-nav-clients", path: "/admin", h1: "Client portfolio" },
  { testid: "admin-nav-pipeline", path: "/admin/pipeline", h1: "Opportunity pipeline" },
  { testid: "admin-nav-projects", path: "/admin/projects", h1: "Projects" },
  { testid: "admin-nav-billing", path: "/admin/billing", h1: "Billing" },
  { testid: "admin-nav-reports", path: "/admin/reports", h1: "Reports" },
  { testid: "admin-nav-team", path: "/admin/team", h1: "Consultancy team" },
];

/** Console noise that is not an application error (documented in nav-map.ts). Everything else fails the test. */
const IGNORED_CONSOLE = BENIGN_CONSOLE;

test.describe("Navigation", () => {
  test("client owner: every sidebar item loads its page with the right URL and heading and no console errors", async ({ ownerPage: page }) => {
    const errors = watchConsole(page, { ignore: IGNORED_CONSOLE });
    await page.goto("/app");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    const sidebar = page.getByTestId("sidebar");
    const visible = await sidebar.locator("nav a[data-testid^='nav-']").evaluateAll((as) => as.map((a) => a.getAttribute("data-testid")));
    const mine = navFor("owner");
    expect(visible.sort()).toEqual(mine.map((n) => n.testid).sort()); // the owner sees exactly the documented 26 items
    for (const item of mine) {
      await sidebar.getByTestId(item.testid).click();
      await page.waitForURL((u) => u.pathname === item.path);
      await expect(page.getByRole("heading", { level: 1, name: item.h1, exact: true })).toBeVisible();
      await expect(page.getByTestId("sidebar").getByTestId(item.testid)).toHaveAttribute("aria-current", "page");
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
    for (const item of [byTestid("nav-workflows"), byTestid("nav-opportunities"), byTestid("nav-finance")]) {
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
