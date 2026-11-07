import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import { ACCOUNTS, AUTH_DIR, loginViaForm, statePath, type Role } from "./fixtures";

/** Logs in once per role through the real form and stores the cookies for the role fixtures. */
setup.beforeAll(() => { fs.mkdirSync(AUTH_DIR, { recursive: true }); });

for (const role of Object.keys(ACCOUNTS) as Role[]) {
  setup(`authenticate as ${role} (${ACCOUNTS[role].email})`, async ({ page }) => {
    await loginViaForm(page, ACCOUNTS[role].email);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    // Managers default to the Simple sidebar; every stored role uses Advanced so the suites see the full NAV_GROUPS
    // (persisted per user in localStorage bb-nav-mode:<userId>, which storageState captures). Simple mode is covered
    // by nav.spec.ts with a fresh login.
    const advanced = page.getByTestId("sidebar").getByTestId("nav-mode-advanced");
    if ((await advanced.getAttribute("aria-checked")) !== "true") await advanced.click();
    await expect(advanced).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("sidebar").getByTestId("nav-executive")).toBeVisible();
    await page.context().storageState({ path: statePath(role) });
  });
}
