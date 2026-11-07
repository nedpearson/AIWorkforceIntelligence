import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, ACCOUNTS, loginViaForm, statePath } from "./fixtures";
import { navFor } from "./nav-map";

/**
 * Security + production-readiness acceptance (docs/SECURITY_VERIFICATION.md):
 *  - CSP: every owner nav page and the consulting portal render with a nonce-based CSP and ZERO CSP violations
 *    (securitypolicyviolation events + "Refused to …" console messages), and the theme script still applies.
 *  - /api/health public response discloses nothing but { ok, version }.
 *  - Session revocation: "Sign out all my sessions" kills a second, independent browser session server-side.
 *  - /admin/readiness: 404 for everyone except the consultancy owner; renders with no page errors and axe 0 serious/critical.
 */
const CSP_CONSOLE = /Content Security Policy|Refused to (load|execute|apply|connect|frame)/i;

async function cspWatch(page: import("@playwright/test").Page) {
  const violations: string[] = [];
  page.on("console", (m) => { if (CSP_CONSOLE.test(m.text())) violations.push(`${page.url()} :: ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => violations.push(`pageerror ${page.url()} :: ${e.message.slice(0, 200)}`));
  await page.addInitScript(() => { document.addEventListener("securitypolicyviolation", (e) => console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`)); });
  return violations;
}

test.describe("security headers", () => {
  test("nonce CSP on every owner nav page with zero violations; theme script runs", async ({ ownerPage: page }) => {
    const violations = await cspWatch(page);
    const first = await page.goto("/app");
    const csp = first!.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(first!.headers()["x-frame-options"]).toBe("DENY");
    for (const n of navFor("owner")) {
      const r = await page.goto(n.path);
      expect.soft(r?.status(), n.path).toBe(200);
      await expect.soft(page.locator("h1").first(), n.path).toBeVisible();
      expect.soft(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), `${n.path}: theme script applied`).toMatch(/light|dark|present/);
    }
    expect(violations).toEqual([]);
  });
  test("consulting portal pages: zero CSP violations", async ({ consultantPage: page }) => {
    const violations = await cspWatch(page);
    for (const p of ["/admin", "/admin/pipeline", "/admin/projects", "/admin/reports", "/admin/billing", "/admin/team", "/admin/readiness", "/login"]) {
      const r = await page.goto(p); expect.soft(r?.status(), p).toBeLessThan(400);
    }
    expect(violations).toEqual([]);
  });
  test("/api/health: public response is { ok, version } only", async ({ request }) => {
    const r = await request.get("/api/health");
    expect(r.status()).toBe(200);
    expect(Object.keys(await r.json()).sort()).toEqual(["ok", "version"]);
  });
});

test.describe("session revocation", () => {
  test("'Sign out all my sessions' revokes a second, independent session server-side", async ({ browser }) => {
    const email = ACCOUNTS.bayou.email;
    const a = await browser.newContext(); const b = await browser.newContext();
    const pa = await a.newPage(); const pb = await b.newPage();
    await loginViaForm(pa, email); await loginViaForm(pb, email);
    await pb.goto("/app"); await expect(pb.getByTestId("sidebar")).toBeVisible();
    await pa.goto("/app/settings/security");
    pa.once("dialog", (d) => d.accept());
    await pa.getByTestId("sessions-signout-all").click();
    await pa.waitForURL(/\/login/);
    // b still holds its (now stale) cookie: the server must refuse it.
    await pb.goto("/app");
    await expect(pb).toHaveURL(/\/login/);
    const api = await pb.request.get("/api/assistant");
    expect(api.status()).toBe(401);
    await a.close(); await b.close();
    // The stored bayou state (used by later specs) was revoked too: refresh it with a new sign-in.
    const c = await browser.newContext(); const pc = await c.newPage();
    await loginViaForm(pc, email);
    await expect(pc.getByTestId("sidebar")).toBeVisible();
    const advanced = pc.getByTestId("sidebar").getByTestId("nav-mode-advanced");
    if ((await advanced.getAttribute("aria-checked")) !== "true") await advanced.click();
    if (fs.existsSync(statePath("bayou"))) await c.storageState({ path: statePath("bayou") });
    await c.close();
  });
});

test.describe("Production Readiness Command Center", () => {
  for (const role of ["owner", "manager", "bayou"] as const) {
    test(`/admin/readiness is a 404 for the ${role}`, async ({ contextFor }) => {
      const ctx = await contextFor(role); const page = await ctx.newPage();
      const r = await page.goto("/admin/readiness");
      expect(r?.status()).toBe(404);
      await expect(page.getByTestId("readiness-page")).toHaveCount(0);
    });
  }
  test("consultancy owner: renders 18 gates, a computed decision, no buttons that record evidence; no page errors; axe clean", async ({ consultantPage: page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon\.ico/.test(m.text())) errors.push(m.text()); });
    const r = await page.goto("/admin/readiness");
    expect(r?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Production readiness");
    await expect(page.getByTestId("readiness-decision")).toHaveText(/^(GO|CONDITIONAL GO|NO-GO)$/);
    await expect(page.locator("[data-testid^='gate-']")).toHaveCount(18);
    // Live checks really ran: the production-config gate shows the database and migration checks.
    await expect(page.getByTestId("gate-production_config")).toContainText("Database reachable");
    await expect(page.getByTestId("gate-production_config")).toContainText(/applied \/ \d+ migration files/);
    await expect(page.getByTestId("readiness-page").locator("main button, button")).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).include("[data-testid='readiness-page']").analyze();
      const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect.soft(bad.map((v) => `${theme}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
});

/**
 * MFA enrolment gate (regression: production incident 2026-11-07). The /app layout used redirect() for users who must
 * enrol MFA; Next.js reused that layout segment on the enrolment page and replayed the redirect ~80×/s (blank page).
 * Uses Bayou Dental (isolated tenant): its owner turns on "Require MFA for owners and admins", which applies to them.
 */
test.describe("MFA enrolment gate", () => {
  test("required user lands on Security without a refresh loop; gated pages bounce there; policy restored", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: statePath("bayou") });
    const page = await ctx.newPage();
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    let rsc = 0, docs = 0;
    page.on("request", (r) => { if (r.resourceType() === "document") docs++; else if (r.headers()["rsc"]) rsc++; });
    try {
      await page.goto("/app/settings/security");
      await page.getByTestId("mfa-policy-require").check();
      await page.getByTestId("mfa-policy-save").click();
      await expect(page.getByTestId("security-flash")).toContainText("must now set up MFA");

      // Soft (client) navigation into a gated page: must end on the enrolment page via one full load, then go quiet.
      await page.getByRole("link", { name: "Executive Command Center" }).first().click();
      await page.waitForURL(/\/app\/settings\/security\?mfa=required/, { timeout: 20_000 });
      await expect(page.getByTestId("mfa-required-banner")).toBeVisible();
      await page.waitForTimeout(1500);
      const r0 = rsc, d0 = docs;
      await page.waitForTimeout(4000);
      expect(rsc - r0, "RSC requests while idle on the enrolment page").toBeLessThanOrEqual(2);
      expect(docs - d0, "document loads while idle on the enrolment page").toBe(0);

      // Fresh sign-in (router.push to /app) and direct loads of gated pages.
      await page.goto("/app/finance");
      await expect(page).toHaveURL(/\/app\/settings\/security\?mfa=required/);
      await page.goto("/admin").catch(() => {});
      await expect(page.getByTestId("security-page")).toBeVisible();
      await expect(page.getByTestId("security-mfa")).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await page.goto("/app/settings/security?mfa=required");
      const box = page.getByTestId("mfa-policy-require");
      if (await box.isChecked()) { await box.uncheck(); await page.getByTestId("mfa-policy-save").click(); await expect(page.getByTestId("security-flash")).toContainText("optional"); }
      await ctx.close();
    }
  });
});
