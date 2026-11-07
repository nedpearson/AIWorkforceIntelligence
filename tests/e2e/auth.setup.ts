import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import { ACCOUNTS, AUTH_DIR, loginViaForm, statePath, type Role } from "./fixtures";

/** Logs in once per role through the real form and stores the cookies for the role fixtures. */
setup.beforeAll(() => { fs.mkdirSync(AUTH_DIR, { recursive: true }); });

for (const role of Object.keys(ACCOUNTS) as Role[]) {
  setup(`authenticate as ${role} (${ACCOUNTS[role].email})`, async ({ page }) => {
    await loginViaForm(page, ACCOUNTS[role].email);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.context().storageState({ path: statePath(role) });
  });
}
