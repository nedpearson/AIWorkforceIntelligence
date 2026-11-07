import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

/** Seeded demo accounts (scripts/seed.ts). All share one password. */
export const PASSWORD = process.env.SEED_PASSWORD ?? "Demo!Pass123";
export const ACCOUNTS = {
  consultant: { email: "owner@bridgebox.demo", label: "consultancy owner (BridgeBox Consulting)" },
  owner: { email: "admin@gulfcoast.demo", label: "client owner (Gulf Coast Supply Co.)" },
  manager: { email: "manager@gulfcoast.demo", label: "client manager (Gulf Coast Supply Co.)" },
  bayou: { email: "admin@bayoudental.demo", label: "owner of a different client (Bayou Dental Group)" },
} as const;
export type Role = keyof typeof ACCOUNTS;
export const GULF_COAST_NAME = "Gulf Coast Supply Co.";
export const BAYOU_NAME = "Bayou Dental Group";

export const AUTH_DIR = path.join(__dirname, ".auth");
export const statePath = (role: Role) => path.join(AUTH_DIR, `${role}.json`);

/** Unique suffix so re-runs never collide with rows created by a previous run. */
export const uniq = (prefix = "e2e") => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Log in through the real login form (what a user does) and wait for the app shell. */
export async function loginViaForm(page: Page, email: string, password = PASSWORD, next = "/app") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((u) => u.pathname.startsWith(next), { timeout: 45_000 });
}

type RoleFixtures = {
  /** Page authenticated as admin@gulfcoast.demo (client owner). */
  ownerPage: Page;
  /** Page authenticated as manager@gulfcoast.demo. */
  managerPage: Page;
  /** Page authenticated as owner@bridgebox.demo (consultancy owner). */
  consultantPage: Page;
  /** Page authenticated as admin@bayoudental.demo (owner of an unrelated client org). */
  bayouPage: Page;
  /** Builds a fresh context for a role; the caller closes it. */
  contextFor: (role: Role) => Promise<BrowserContext>;
};

export const test = base.extend<RoleFixtures>({
  contextFor: async ({ browser }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (role) => {
      const file = statePath(role);
      if (!fs.existsSync(file)) throw new Error(`missing storage state for ${role}: run the "setup" project first`);
      const ctx = await browser.newContext({ storageState: file });
      opened.push(ctx);
      return ctx;
    });
    for (const c of opened) await c.close().catch(() => {});
  },
  ownerPage: async ({ contextFor }, use) => { const c = await contextFor("owner"); await use(await c.newPage()); },
  managerPage: async ({ contextFor }, use) => { const c = await contextFor("manager"); await use(await c.newPage()); },
  consultantPage: async ({ contextFor }, use) => { const c = await contextFor("consultant"); await use(await c.newPage()); },
  bayouPage: async ({ contextFor }, use) => { const c = await contextFor("bayou"); await use(await c.newPage()); },
});
export { expect };

/** Collects console errors + uncaught exceptions for "no console errors" assertions. */
export function watchConsole(page: Page, opts: { ignore?: RegExp[] } = {}) {
  const errors: string[] = [];
  const ignore = opts.ignore ?? [];
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!ignore.some((r) => r.test(t))) errors.push(`console.error: ${t}`); } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Money as rendered by fmtUSD: "$12,345" / "$1.2M" / "$950K" / "$12,345.50". */
export const USD = /^-?\$\d[\d,]*(\.\d+)?\s?[KMB]?$/;
export const USD_ANYWHERE = /-?\$\d[\d,]*(\.\d+)?\s?[KMB]?/;

/** Expands every collapsed node of a <CalcTreeView> inside `root` (nodes below depth 1 start collapsed). */
export async function expandCalcTree(root: import("@playwright/test").Locator) {
  const collapsed = root.locator("button[aria-label='toggle']:not(.invisible)").filter({ has: root.page().locator("svg:not(.rotate-90)") });
  for (let i = 0; i < 100; i++) {
    if (!(await collapsed.count())) return;
    await collapsed.first().click();
  }
}
