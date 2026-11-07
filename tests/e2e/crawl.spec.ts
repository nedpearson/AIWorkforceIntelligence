import fs from "node:fs";
import path from "node:path";
import { test, expect, statePath, type Role } from "./fixtures";
import { BENIGN_CONSOLE, navFor, type NavEntry } from "./nav-map";
import { orgIdBySlug, aiEmployeeByPersona, closeDb, GULF_SLUG } from "./db";
import type { BrowserContext, Page } from "@playwright/test";

/**
 * Full UI crawl. For the client owner, the manager and the consultancy owner, every sidebar item is opened at
 *   desktop 1440 (light), desktop 1440 (dark) and mobile 390 (light)
 * and must answer 200 with an h1, no "Application error", no console errors / page errors and no horizontal overflow.
 * On desktop-light every enabled, non-destructive control inside <main> is then clicked (buttons, links, tabs,
 * radios, selects, summaries — capped at MAX_CLICKS per page); no click may raise a page error or render the
 * Next.js error screen. Per-page counts land in test-results/crawl/crawl-report.json.
 *
 * Skipped controls (never clicked):
 *  - DESTRUCTIVE: delete/remove/revoke/disconnect/sign out/reject/withdraw/rollback/purge (task contract);
 *  - STATEFUL: actions that would irreversibly change seeded demo state other specs rely on
 *    (pause, deploy, approve, archive, complete, start/stop campaign, run analysis, run now, regenerate, rotate,
 *    publish, accept, invite, checkout, submit/save forms). These are covered by the behavioural specs instead.
 *  - links to another origin, mailto:/tel:, target=_blank, and /api/* downloads (exports are covered elsewhere).
 *  - <select>s and checkboxes that are not view controls: a role / status / owner picker saves on change (the first
 *    crawl run promoted the seeded manager to owner through /app/settings/members). Only selects that are filters or
 *    view/sort/period/scenario pickers (by data-testid or by living inside a FilterBar) are changed.
 * Every server action POST fired during the crawl is recorded in the report (`serverActions`) for transparency.
 */
const MAX_CLICKS = 60;
const DESTRUCTIVE = /delete|remove|revoke|disconnect|sign out|reject|withdraw|rollback|purge|retire/i;
const STATEFUL = /\b(pause|resume|deploy|approve|archive|complete|start|stop|run analysis|run now|re-?run|regenerate|rotate|publish|accept|invite|checkout|subscribe|upgrade|downgrade|choose|switch to|billing portal|manage billing|cancel plan|save|submit|create|generate|record|import|seed|enroll|connect|reset to|apply|confirm|send|mark|promote|restore|schedule|test connection|request|meet|add all|add the remaining|provision|hire|learn from|load demo|sync now|upload|new version|raise|move to|run demonstration|run on live|run task|pilot)\b/i;
/** AI Workforce controls that change an AI employee's lifecycle, permission, configuration or portrait (covered by the acceptance spec). */
const STATEFUL_TESTID = /^(perm-|st-|cz-|portrait-|stage-pilot|stage-next-1|rec-pilot-|xp-meet-|rec-meet-|wf-provision|chat-suggest-|assign-runner-run|demo-run|skills-lab-)/;

const VARIANTS = [
  { key: "desktop-light", viewport: { width: 1440, height: 900 }, colorScheme: "light" as const, isMobile: false, interact: true },
  { key: "desktop-dark", viewport: { width: 1440, height: 900 }, colorScheme: "dark" as const, isMobile: false, interact: false },
  { key: "mobile-light", viewport: { width: 390, height: 844 }, colorScheme: "light" as const, isMobile: true, interact: false },
];
const ROLES: Role[] = ["owner", "manager", "consultant"];

type PageReport = { role: Role; variant: string; path: string; status: number; h1: string; candidates: number; clicked: number; skipped: number; navigations: number; dialogs: number; serverActions: number; consoleErrors: string[]; pageErrors: string[]; ms: number };
const REPORT_DIR = path.join(process.cwd(), "test-results", "crawl");
const REPORT_FILE = path.join(REPORT_DIR, "crawl-report.json");
const results: PageReport[] = [];

function attachWatchers(page: Page) {
  const consoleErrors: string[] = []; const pageErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !BENIGN_CONSOLE.some((r) => r.test(m.text()))) consoleErrors.push(`${page.url()} :: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => pageErrors.push(`${page.url()} :: ${e.message.slice(0, 300)}`));
  page.on("dialog", (d) => d.dismiss().catch(() => {})); // window.confirm guards on any action → cancel
  page.on("download", (d) => d.cancel().catch(() => {}));
  page.on("popup", (p) => p.close().catch(() => {}));
  const serverActions = { n: 0 };
  page.on("request", (r) => { if (r.method() === "POST" && r.headers()["next-action"]) serverActions.n++; });
  return { consoleErrors, pageErrors, serverActions };
}

async function assertPageHealthy(page: Page, entry: NavEntry, where: string) {
  await expect.soft(page.locator("h1").first(), `${where}: h1`).toBeVisible();
  await expect.soft(page.locator("h1").first(), `${where}: h1 text`).toContainText(entry.h1);
  await expect.soft(page.locator("body"), `${where}: Next error screen`).not.toContainText("Application error");
  await expect.soft(page.locator("main"), `${where}: not-found`).not.toContainText("This page could not be found");
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect.soft(sw, `${where}: horizontal overflow (scrollWidth ${sw} > innerWidth ${iw})`).toBeLessThanOrEqual(iw + 1);
}

/** Stable-ish key for a control so each is clicked once even after re-renders / re-navigation. */
const CANDIDATES = "main button, main a[href], main [role='tab'], main [role='radio'], main [role='switch'], main [role='menuitem'], main select, main summary, main input[type='checkbox'], main input[type='radio']";

async function collect(page: Page) {
  return page.locator(CANDIDATES).evaluateAll((els) => els.map((el, i) => {
    const h = el as HTMLElement;
    const r = h.getBoundingClientRect(); const cs = getComputedStyle(h);
    const visible = r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !h.closest("[inert],[aria-hidden='true']");
    const text = (h.innerText || h.getAttribute("aria-label") || h.getAttribute("title") || (h as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const href = h.getAttribute("href") ?? "";
    const tid = h.getAttribute("data-testid") ?? "";
    const disabled = (h as HTMLButtonElement).disabled || h.getAttribute("aria-disabled") === "true";
    const label = `${h.getAttribute("aria-label") ?? ""} ${h.getAttribute("title") ?? ""} ${text}`;
    const viewCtl = !!h.closest("[data-testid*='filter']") || /filter|view|sort|period|scenario|scope|range|compare|group|tab|mode|chart|metric|lens|amort|horizon/i.test(tid + " " + (h.getAttribute("aria-label") ?? ""));
    return { i, viewCtl, tag: h.tagName.toLowerCase(), role: h.getAttribute("role") ?? "", text, label, href, tid, target: h.getAttribute("target") ?? "", type: h.getAttribute("type") ?? "", inForm: !!h.closest("form"), visible, disabled,
      key: `${h.tagName}|${tid}|${href}|${h.getAttribute("role") ?? ""}|${text}` };
  }));
}
type Cand = Awaited<ReturnType<typeof collect>>[number];

function skipReason(c: Cand, origin: string): string | null {
  if (!c.visible) return "hidden";
  if (c.disabled) return "disabled";
  if (DESTRUCTIVE.test(c.label)) return "destructive";
  if (c.tag === "a") {
    if (/^(mailto:|tel:|javascript:)/i.test(c.href)) return "external";
    if (c.target === "_blank") return "new-tab";
    try { const u = new URL(c.href, origin); if (u.origin !== origin) return "off-origin"; if (u.pathname.startsWith("/api/")) return "download"; } catch { return "bad-href"; }
    return null;
  }
  if ((c.tag === "select" || (c.tag === "input" && !c.inForm) || c.role === "switch") && !c.viewCtl) return "stateful-control";
  if (c.type === "submit" || (c.tag === "button" && c.inForm && c.type !== "button")) return "form-submit";
  if (STATEFUL.test(c.label) || STATEFUL_TESTID.test(c.tid)) return "stateful";
  return null;
}

async function closeOverlays(page: Page) {
  for (let i = 0; i < 3; i++) {
    const dlg = page.locator("[role='dialog']:visible, [role='menu']:visible");
    if (!(await dlg.count())) return;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(120);
    if (!(await dlg.count())) return;
    const close = page.locator("[role='dialog']:visible").getByRole("button", { name: /^(close|cancel|done)$/i }).first();
    if (await close.count()) await close.click({ timeout: 1500 }).catch(() => {});
    else await page.mouse.click(5, 5).catch(() => {});
  }
}

async function crawlInteractions(page: Page, base: string, rep: PageReport, pageErrors: string[]) {
  const origin = new URL(page.url()).origin;
  const done = new Set<string>();
  const baseUrl = new URL(base, origin);
  for (let guard = 0; guard < MAX_CLICKS * 3 && rep.clicked < MAX_CLICKS; guard++) {
    const cands = await collect(page);
    rep.candidates = Math.max(rep.candidates, cands.length);
    let next: Cand | undefined;
    for (const c of cands) {
      if (done.has(c.key)) continue;
      const why = skipReason(c, origin);
      if (why) { done.add(c.key); if (why !== "hidden") rep.skipped++; continue; }
      next = c; break;
    }
    if (!next) break;
    done.add(next.key);
    const loc = page.locator(CANDIDATES).nth(next.i);
    const before = pageErrors.length;
    try {
      if (next.tag === "select") {
        const vals = await loc.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
        const cur = await loc.inputValue();
        const pick = vals.find((v) => v !== cur);
        if (pick === undefined) continue;
        await loc.selectOption(pick, { timeout: 3000 });
      } else {
        await loc.click({ timeout: 3000 });
      }
      rep.clicked++;
    } catch { rep.skipped++; continue; }
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(250);
    expect.soft(pageErrors.slice(before), `page error after clicking ${next.tag} "${next.text}" (${next.tid || next.href}) on ${base}`).toEqual([]);
    await expect.soft(page.locator("body"), `Next error screen after clicking "${next.text}" on ${base}`).not.toContainText("Application error", { timeout: 2000 });
    if (await page.locator("[role='dialog']:visible").count()) rep.dialogs++;
    await closeOverlays(page);
    const now = new URL(page.url());
    if (now.pathname !== baseUrl.pathname || now.search !== baseUrl.search) {
      rep.navigations++;
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.locator("h1").first().waitFor({ timeout: 20_000 }).catch(() => {});
    }
  }
}

function writeReport() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const prev = fs.existsSync(REPORT_FILE) ? (JSON.parse(fs.readFileSync(REPORT_FILE, "utf8")) as { pages: PageReport[] }).pages : [];
  const merged = [...prev.filter((p) => !results.some((r) => r.role === p.role && r.variant === p.variant && r.path === p.path)), ...results];
  const totals = { pages: merged.length, clicked: merged.reduce((a, r) => a + r.clicked, 0), skipped: merged.reduce((a, r) => a + r.skipped, 0), navigations: merged.reduce((a, r) => a + r.navigations, 0), consoleErrors: merged.reduce((a, r) => a + r.consoleErrors.length, 0), pageErrors: merged.reduce((a, r) => a + r.pageErrors.length, 0) };
  fs.writeFileSync(REPORT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), maxClicksPerPage: MAX_CLICKS, totals, pages: merged }, null, 2));
}

test.describe("Crawl", () => {
  test.describe.configure({ mode: "serial" });
  test.afterAll(writeReport);

  for (const role of ROLES) {
    for (const v of VARIANTS) {
      test(`${role} · ${v.key}: every nav page renders cleanly${v.interact ? " and survives clicking every safe control" : ""}`, async ({ browser }) => {
        test.setTimeout(v.interact ? 45 * 60_000 : 10 * 60_000);
        const ctx: BrowserContext = await browser.newContext({ storageState: statePath(role), viewport: v.viewport, colorScheme: v.colorScheme, isMobile: v.isMobile, hasTouch: v.isMobile, acceptDownloads: false });
        try {
          const page = await ctx.newPage();
          const { consoleErrors, pageErrors, serverActions } = attachWatchers(page);
          // the sidebar this role sees must be exactly the documented list (drift fails here, not silently)
          if (!v.isMobile) {
            await page.goto("/app");
            // the stored Advanced/Simple choice is applied after hydration (localStorage) — wait for it before reading the list
            await expect(page.getByTestId("sidebar").getByTestId("nav-mode-advanced")).toHaveAttribute("aria-checked", "true");
            const seen = await page.getByTestId("sidebar").locator("nav a[data-testid^='nav-']").evaluateAll((as) => as.map((a) => a.getAttribute("data-testid")));
            expect(seen.sort()).toEqual(navFor(role).map((n) => n.testid).sort());
          }
          for (const entry of navFor(role)) {
            const t0 = Date.now();
            const c0 = consoleErrors.length; const p0 = pageErrors.length; const a0 = serverActions.n;
            const res = await page.goto(entry.path, { waitUntil: "domcontentloaded" });
            const rep: PageReport = { role, variant: v.key, path: entry.path, status: res?.status() ?? 0, h1: "", candidates: 0, clicked: 0, skipped: 0, navigations: 0, dialogs: 0, serverActions: 0, consoleErrors: [], pageErrors: [], ms: 0 };
            results.push(rep);
            expect.soft(rep.status, `${role} ${v.key} ${entry.path}: HTTP status`).toBe(200);
            expect.soft(new URL(page.url()).pathname, `${entry.path} redirected`).toBe(entry.path);
            await page.waitForLoadState("load").catch(() => {});
            await page.waitForTimeout(400); // let client effects / charts settle before measuring overflow
            rep.h1 = (await page.locator("h1").first().innerText().catch(() => "")).trim();
            await assertPageHealthy(page, entry, `${role} ${v.key} ${entry.path}`);
            if (v.interact) await crawlInteractions(page, entry.path, rep, pageErrors);
            rep.consoleErrors = consoleErrors.slice(c0); rep.pageErrors = pageErrors.slice(p0); rep.ms = Date.now() - t0; rep.serverActions = serverActions.n - a0;
            console.log(`[crawl] ${role} ${v.key} ${entry.path} status=${rep.status} clicked=${rep.clicked} skipped=${rep.skipped} nav=${rep.navigations} dialogs=${rep.dialogs} actions=${rep.serverActions} console=${rep.consoleErrors.length} pageerr=${rep.pageErrors.length} ${rep.ms}ms`);
            expect.soft(rep.pageErrors, `${role} ${v.key} ${entry.path}: page errors`).toEqual([]);
            expect.soft(rep.consoleErrors, `${role} ${v.key} ${entry.path}: console errors`).toEqual([]);
          }
        } finally { await ctx.close(); }
      });
    }
  }
});

/**
 * AI Workforce modules beyond the sidebar entries: every AI Brain tab, an AI employee profile (every tab), the builder,
 * the Skills Lab, the universal assistant panel and a guided-tour step — at 1440 light, 1440 dark and 390 light, for the
 * client owner (manager: read-only render of the Brain and the profile). Same bar as the nav crawl. On desktop-light the
 * Brain overview and the profile's Talk tab are also click-crawled (lifecycle/permission/portrait controls skipped).
 */
test.describe("Crawl · AI Workforce modules", () => {
  test.describe.configure({ mode: "serial" });
  test.afterAll(writeReport);
  let profilePath = "";
  test.beforeAll(async () => {
    const e = await aiEmployeeByPersona(await orgIdBySlug(GULF_SLUG), "charlotte");
    await closeDb();
    if (!e) throw new Error("Charlotte (seeded AI employee) not found");
    profilePath = `/app/workforce/${e.id}`;
  });
  const BRAIN_TABS = ["overview", "library", "facts", "review", "ask", "sources"];
  const PROFILE_TABS = ["talk", "skills", "demo", "assign", "work", "connect", "savings", "customize", "memory"];
  const pagesFor = (role: Role): { path: string; h1: string; interact?: boolean }[] => [
    ...BRAIN_TABS.filter((t) => role === "owner" || t !== "review").map((t) => ({ path: `/app/brain?tab=${t}`, h1: "AI Brain", interact: t === "overview" })),
    ...PROFILE_TABS.map((t) => ({ path: `${profilePath}?tab=${t}`, h1: "Meet Charlotte", interact: t === "talk" })),
    ...(role === "owner" ? [{ path: "/app/workforce/new", h1: "Build an AI employee" }, { path: "/app/skills-lab", h1: "Skills Lab" }] : []),
  ];
  const CASES: { role: Role; v: (typeof VARIANTS)[number] }[] = [...VARIANTS.map((v) => ({ role: "owner" as Role, v })), { role: "manager", v: VARIANTS[0] }];
  for (const { role, v } of CASES) {
    test(`${role} · ${v.key}: Brain tabs, profile tabs, builder, Skills Lab, assistant panel and a tour step render cleanly`, async ({ browser }) => {
      test.setTimeout(30 * 60_000);
      const ctx = await browser.newContext({ storageState: statePath(role), viewport: v.viewport, colorScheme: v.colorScheme, isMobile: v.isMobile, hasTouch: v.isMobile, acceptDownloads: false, reducedMotion: "reduce" });
      try {
        const page = await ctx.newPage();
        const { consoleErrors, pageErrors, serverActions } = attachWatchers(page);
        for (const pg of pagesFor(role)) {
          const t0 = Date.now(); const c0 = consoleErrors.length; const p0 = pageErrors.length; const a0 = serverActions.n;
          const res = await page.goto(pg.path, { waitUntil: "domcontentloaded" });
          const rep: PageReport = { role, variant: v.key, path: pg.path, status: res?.status() ?? 0, h1: "", candidates: 0, clicked: 0, skipped: 0, navigations: 0, dialogs: 0, serverActions: 0, consoleErrors: [], pageErrors: [], ms: 0 };
          results.push(rep);
          expect.soft(rep.status, `${role} ${v.key} ${pg.path}: HTTP status`).toBe(200);
          await page.waitForLoadState("load").catch(() => {});
          await page.waitForTimeout(400);
          rep.h1 = (await page.locator("h1").first().innerText().catch(() => "")).trim();
          await assertPageHealthy(page, { testid: "", group: "", roles: [role], path: pg.path, h1: pg.h1 }, `${role} ${v.key} ${pg.path}`);
          if (v.interact && pg.interact && role === "owner") await crawlInteractions(page, pg.path, rep, pageErrors);
          rep.consoleErrors = consoleErrors.slice(c0); rep.pageErrors = pageErrors.slice(p0); rep.ms = Date.now() - t0; rep.serverActions = serverActions.n - a0;
          console.log(`[crawl] ${role} ${v.key} ${pg.path} status=${rep.status} clicked=${rep.clicked} skipped=${rep.skipped} console=${rep.consoleErrors.length} pageerr=${rep.pageErrors.length} ${rep.ms}ms`);
          expect.soft(rep.pageErrors, `${role} ${v.key} ${pg.path}: page errors`).toEqual([]);
          expect.soft(rep.consoleErrors, `${role} ${v.key} ${pg.path}: console errors`).toEqual([]);
        }
        // universal assistant panel, opened from the launcher, asked a question
        const c0 = consoleErrors.length; const p0 = pageErrors.length;
        await page.goto("/app/workforce", { waitUntil: "load" });
        await page.getByTestId("assistant-launcher").click();
        const panel = page.getByTestId("assistant-panel");
        await expect(panel).toBeVisible();
        const answers = panel.getByTestId("assistant-answer");
        await expect(panel.getByTestId("assistant-messages")).toBeVisible();
        await page.waitForTimeout(500); // conversation history loads on open
        const n0 = await answers.count();
        await panel.getByTestId("assistant-input").fill("Who on my AI team can process invoices?");
        await panel.getByTestId("assistant-send").click();
        await expect(answers).toHaveCount(n0 + 1);
        await expect(answers.last().locator("[aria-label='Thinking']")).toHaveCount(0, { timeout: 45_000 });
        await expect(answers.last()).not.toContainText("couldn't answer");
        await expect(panel.getByTestId("assistant-citation").first()).toBeVisible({ timeout: 45_000 });
        await assertPageHealthy(page, { testid: "", group: "", roles: [role], path: "/app/workforce", h1: "Your AI Workforce" }, `${role} ${v.key} assistant panel`);
        await page.getByTestId("assistant-close").click();
        await expect(panel).toHaveCount(0);
        // a guided-tour step (deep link ?tour=), then Next and close
        await page.goto("/app/brain?tour=brain", { waitUntil: "load" });
        const pop = page.getByTestId("tour-popover");
        await expect(pop).toBeVisible({ timeout: 20_000 });
        await expect(pop).toContainText(/Step 1|1 of|AI Brain/i);
        await assertPageHealthy(page, { testid: "", group: "", roles: [role], path: "/app/brain", h1: "AI Brain" }, `${role} ${v.key} tour step`);
        await pop.getByTestId("tour-next").click();
        await expect(pop).toBeVisible();
        await pop.getByTestId("tour-close").click();
        await expect(page.getByTestId("tour-overlay")).toHaveCount(0);
        expect.soft(pageErrors.slice(p0), `${role} ${v.key} assistant/tour: page errors`).toEqual([]);
        expect.soft(consoleErrors.slice(c0), `${role} ${v.key} assistant/tour: console errors`).toEqual([]);
      } finally { await ctx.close(); }
    });
  }
});
