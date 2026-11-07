import { test, expect, statePath, type Role } from "./fixtures";
import { BENIGN_CONSOLE, navFor } from "./nav-map";
import { orgIdBySlug, aiEmployeeByPersona, seededIdsFor, closeDb, GULF_SLUG } from "./db";

/**
 * Hydration guard (CI run 42389504107). The production server renders in UTC (Vercel; `TZ: UTC` in CI) while the
 * browser hydrates in the viewer's zone. Any text that depends on the runtime's time zone or locale (a timestamp
 * formatted without an explicit `timeZone`, a default-locale number) then differs between the two renders → React
 * #418 → React client-renders the root and drops `<html data-theme>` set by the inline theme script.
 *
 * The browser here runs in Pacific/Kiritimati (UTC+14), which differs from both UTC and America/Chicago, so a
 * viewer-local format mismatches whatever zone the server runs in. Every page must load with zero `pageerror`s and
 * zero console errors, and `data-theme` must already be set when the page settles.
 */
const VIEWER_TZ = "Pacific/Kiritimati";

async function sweep(role: Role, paths: string[], browser: import("@playwright/test").Browser) {
  const ctx = await browser.newContext({ storageState: statePath(role), viewport: { width: 1440, height: 900 }, timezoneId: VIEWER_TZ, colorScheme: "dark", reducedMotion: "reduce" });
  const failures: string[] = [];
  try {
    const page = await ctx.newPage();
    let current: string[] = [];
    page.on("pageerror", (e) => current.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !BENIGN_CONSOLE.some((r) => r.test(m.text()))) current.push(`console.error: ${m.text()}`); });
    for (const p of paths) {
      current = [];
      const res = await page.goto(p, { waitUntil: "load" });
      expect(res?.status(), `${role} ${p} status`).toBe(200);
      await page.locator("h1").first().waitFor();
      await page.waitForLoadState("networkidle").catch(() => {});
      const theme = await page.locator("html").getAttribute("data-theme");
      if (theme !== "dark") current.push(`<html data-theme> is ${JSON.stringify(theme)}, expected "dark"`);
      failures.push(...current.map((e) => `${role} ${p}: ${e.slice(0, 300)}`));
    }
  } finally { await ctx.close(); }
  expect(failures, "pages with hydration / page errors (server in UTC, browser in UTC+14)").toEqual([]);
}

test.describe("Hydration: no page errors when server and browser time zones differ", () => {
  test("client owner: every nav page, AI Brain tabs, AI employee profile tabs and detail pages", async ({ browser }) => {
    test.setTimeout(15 * 60_000);
    const orgId = await orgIdBySlug(GULF_SLUG);
    const ids = await seededIdsFor(orgId);
    const e = await aiEmployeeByPersona(orgId, "charlotte");
    await closeDb();
    expect(e, "seeded AI employee").not.toBeNull();
    await sweep("owner", [
      ...navFor("owner").map((n) => n.path),
      ...["overview", "library", "facts", "review", "ask", "sources"].map((t) => `/app/brain?tab=${t}`),
      ...["talk", "skills", "demo", "assign", "work", "connect", "savings", "customize", "memory"].map((t) => `/app/workforce/${e!.id}?tab=${t}`),
      `/app/workflows/${ids.workflowId}`, `/app/opportunities/${ids.opportunityId}`,
      ...(ids.agentId ? [`/app/agents/${ids.agentId}`] : []),
      "/app/agents/approvals", "/app/agents/credentials", "/app/onboarding", "/app/settings/security", "/app/settings/data", "/app/settings/integrations",
    ], browser);
  });

  test("consultancy owner: consulting portal pages and every client-workspace tab", async ({ browser }) => {
    test.setTimeout(15 * 60_000);
    const clientId = await orgIdBySlug(GULF_SLUG);
    await closeDb();
    const tabs = ["overview", "checklist", "collectors", "campaigns", "opportunities", "projects", "agents", "billing", "reports", "branding"];
    await sweep("consultant", [
      "/admin", "/admin/pipeline", "/admin/projects", "/admin/billing", "/admin/reports", "/admin/team",
      ...tabs.map((t) => `/admin/clients/${clientId}?tab=${t}`),
    ], browser);
  });
});
