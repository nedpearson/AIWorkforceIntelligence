import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, statePath, type Role } from "./fixtures";
import { navFor } from "./nav-map";

/**
 * WCAG 2.2 AA (axe-core: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa) on every sidebar page, light and dark.
 * Bar: zero `serious` / `critical` violations. Moderate / minor ones are recorded in the report but do not fail.
 * Report: test-results/a11y/a11y-report.json (per page × theme: violation id, impact, node count, first targets).
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const THEMES = ["light", "dark"] as const;
// Client owner (Gulf Coast data) and consultancy owner (portfolio views + consulting portal). The manager's pages are a
// subset of the owner's with less data, so they add no distinct markup.
const ROLES: Role[] = ["owner", "consultant"];

type Row = { role: Role; theme: string; path: string; violations: { id: string; impact: string | null | undefined; nodes: number; help: string; targets: string[] }[] };
const rows: Row[] = [];
const OUT = path.join(process.cwd(), "test-results", "a11y", "a11y-report.json");

test.describe("Accessibility (axe, WCAG 2.2 AA)", () => {
  test.afterAll(() => {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const prev = fs.existsSync(OUT) ? (JSON.parse(fs.readFileSync(OUT, "utf8")) as { pages: Row[] }).pages : [];
    const merged = [...prev.filter((p) => !rows.some((r) => r.role === p.role && r.theme === p.theme && r.path === p.path)), ...rows];
    const count = (imp: string[]) => merged.reduce((a, r) => a + r.violations.filter((v) => imp.includes(v.impact ?? "")).length, 0);
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), tags: TAGS, totals: { pages: merged.length, seriousOrCritical: count(["serious", "critical"]), moderateOrMinor: count(["moderate", "minor"]) }, pages: merged }, null, 2));
  });

  for (const role of ROLES) {
    for (const theme of THEMES) {
      test(`${role} · ${theme}: no serious or critical WCAG violations on any nav page`, async ({ browser }) => {
        test.setTimeout(15 * 60_000);
        const ctx = await browser.newContext({ storageState: statePath(role), viewport: { width: 1440, height: 900 }, colorScheme: theme });
        try {
          const page = await ctx.newPage();
          const pages = navFor(role);
          for (const entry of pages) {
            await page.goto(entry.path, { waitUntil: "load" });
            await page.locator("h1").first().waitFor();
            await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
            await page.waitForTimeout(300);
            const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
            const row: Row = { role, theme, path: entry.path, violations: res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) })) };
            rows.push(row);
            const bad = row.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
            expect.soft(bad.map((v) => `${v.id} (${v.impact}, ${v.nodes} nodes): ${v.targets.slice(0, 3).join(" | ")}`), `${role} ${theme} ${entry.path}`).toEqual([]);
          }
        } finally { await ctx.close(); }
      });
    }
  }
});
