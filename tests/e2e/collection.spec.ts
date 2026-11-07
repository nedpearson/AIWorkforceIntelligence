import { test, expect, uniq } from "./fixtures";
import type { Page } from "@playwright/test";

/** Completes running campaigns created by earlier (possibly aborted) runs of this spec. Only touches rows it named. */
async function completeLeftoverE2eCampaigns(page: Page) {
  const leftovers = page.locator("tr[data-testid^='campaign-row-']").filter({ hasText: /^(E2E campaign coll-|Default-dates campaign coll-default-)/ }).filter({ hasText: "running" });
  for (let i = 0; i < 20 && (await leftovers.count()); i++) {
    const id = (await leftovers.first().getAttribute("data-testid"))!.replace("campaign-row-", "");
    await page.getByTestId(`campaign-complete-${id}`).click();
    await expect(page.getByTestId(`campaign-row-${id}`)).toContainText("completed");
  }
}

/**
 * Data-collection workflow as the client owner, then the collector wire protocol driven directly
 * against /api/collect/* (what the desktop collector does), then back to the UI to see the results.
 */
test.describe("Data collection", () => {
  test("authorization → notice → campaign → enrollment code → collector enrolls, consents and ships 20 events → pause/resume → run analysis", async ({ ownerPage: page, request }) => {
    test.setTimeout(180_000);
    const tag = uniq("coll");

    // ---- Authorization (seeded for Gulf Coast; record one if a fresh org lacks it) ----
    await page.goto("/app/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Data Collection" })).toBeVisible();
    await page.getByTestId("tab-authorization").click();
    if (await page.getByTestId("authorization-form").isVisible().catch(() => false)) {
      await page.getByTestId("auth-signer-name").fill("Patricia Guidry");
      await page.getByTestId("auth-signer-title").fill("Chief Executive Officer");
      await page.getByTestId("auth-submit").click();
    }
    await expect(page.getByTestId("authorization-card")).toBeVisible();
    await expect(page.getByTestId("authorization-card")).toContainText("Authorized");
    await expect(page.getByTestId("auth-signer")).not.toBeEmpty();

    // ---- Notice: publish an updated notice text (kept on the same version so seeded acknowledgements stay valid) ----
    await page.getByTestId("tab-consent").click();
    const notice = page.getByTestId("notice-text");
    const base = (await notice.inputValue()).replace(/\n\n\[e2e [^\]]*\]$/s, "");
    const marker = `[e2e ${tag}]`;
    await notice.fill(`${base}\n\n${marker}`);
    await page.getByTestId("notice-bump").uncheck();
    await expect(page.getByTestId("notice-save")).toBeEnabled();
    await page.getByTestId("notice-save").click();
    await expect(page.getByTestId("notice-save")).toBeDisabled({ timeout: 20_000 }); // text === saved text again after refresh
    await page.reload();
    await page.getByTestId("tab-consent").click();
    await expect(page.getByTestId("notice-text")).toHaveValue(new RegExp(marker.replace(/[[\]]/g, "\\$&")));
    await expect(page.locator("tr[data-testid^='consent-row-']").first()).toBeVisible();

    // ---- Campaign: create one covering today (no daily schedule, whole organization) and start it ----
    await page.getByTestId("tab-campaigns").click();
    await completeLeftoverE2eCampaigns(page); // events go to the first matching running campaign; earlier aborted runs must not capture them
    await page.getByTestId("campaign-create").click();
    const form = page.getByTestId("campaign-form");
    await expect(form).toBeVisible();
    const campaignName = `E2E campaign ${tag}`;
    await page.getByTestId("campaign-name").fill(campaignName);
    await page.getByTestId("campaign-description").fill("Created by the Playwright acceptance suite.");
    await page.getByTestId("campaign-use-schedule").uncheck();
    // Dates are interpreted in the browser's local time zone; start yesterday so "now" is inside the window
    // regardless of the hour (the form's default start is derived from the UTC date — see FINDINGS.md #2).
    const localDate = (offsetDays: number) => page.evaluate((o) => { const d = new Date(); d.setDate(d.getDate() + o); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }, offsetDays);
    await page.getByTestId("campaign-starts").fill(await localDate(-1));
    await page.getByTestId("campaign-ends").fill(await localDate(14));
    await page.getByTestId("campaign-submit").click();
    await expect(form).toBeHidden();
    const row = page.locator("tr[data-testid^='campaign-row-']", { hasText: campaignName });
    await expect(row).toBeVisible();
    await expect(row).toContainText("draft");
    const campaignId = (await row.getAttribute("data-testid"))!.replace("campaign-row-", "");
    await page.getByTestId(`campaign-start-${campaignId}`).click();
    await expect(row).toContainText("running");

    // ---- Enrollment code for the first employee ----
    await page.getByTestId("tab-collectors").click();
    await page.getByTestId("collector-create-code").click();
    await expect(page.getByTestId("enrollment-form")).toBeVisible();
    const employeeSelect = page.getByTestId("enrollment-employee");
    const employeeName = (await employeeSelect.locator("option").first().innerText()).replace(/\s*\(consent:.*\)$/, "").trim();
    await employeeSelect.selectOption({ index: 0 });
    const deviceName = `E2E laptop ${tag}`;
    await page.getByTestId("enrollment-name").fill(deviceName);
    await page.getByTestId("enrollment-submit").click();
    await expect(page.getByTestId("enrollment-issued")).toBeVisible();
    const code = (await page.getByTestId("enrollment-code").innerText()).trim();
    expect(code).toMatch(/^BB-[A-Z0-9]{8,12}$/);
    await expect(page.getByTestId("install-cmd-macos")).toContainText(code);
    await page.getByTestId("enrollment-done").click();
    const pendingRow = page.locator("tr[data-testid^='collector-row-']", { hasText: deviceName });
    await expect(pendingRow).toContainText("pending");

    // ---- Collector protocol (unauthenticated API context, exactly like the desktop agent) ----
    const enroll = await request.post("/api/collect/enroll", { data: { enrollmentCode: code, platform: "linux", hostname: `e2e-${tag}`, version: "0.1.0-e2e" } });
    expect(enroll.status(), await enroll.text()).toBe(200);
    const e = (await enroll.json()) as { collectorId: string; token: string; notice: { version: string }; config: { blockedApps: string[] } };
    expect(e.token.length).toBeGreaterThanOrEqual(32);
    expect(e.config.blockedApps).toContain("1password");
    const auth = { authorization: `Bearer ${e.token}` };
    // the code is single-use
    const again = await request.post("/api/collect/enroll", { data: { enrollmentCode: code, platform: "linux", hostname: "x", version: "0.1.0" } });
    expect(again.status()).toBe(401);

    const consent = await request.post("/api/collect/consent", { headers: auth, data: { collectorId: e.collectorId, noticeVersion: e.notice.version } });
    expect(consent.status(), await consent.text()).toBe(200);
    expect(await consent.json()).toMatchObject({ ok: true, consent: "acknowledged" });

    // 20 metadata-only events inside the running campaign window; a meta key that could carry content is refused by the schema
    const now = Date.now();
    const apps = ["Excel", "QuickBooks", "Outlook", "Chrome", "ERP"];
    const events = Array.from({ length: 20 }, (_, i) => ({ ts: new Date(now - (20 - i) * 3000).toISOString(), type: i % 4 === 0 ? "app_focus" : i % 4 === 1 ? "data_entry" : i % 4 === 2 ? "copy_paste" : "document_save", app: apps[i % apps.length], appCategory: "office", titleCategory: "invoice", titleHash: `h${i}`, durationMs: 2500 + i * 10, meta: { fieldsCount: i, keysCount: 12 } }));
    const bad = await request.post("/api/collect/events", { headers: auth, data: { collectorId: e.collectorId, events: [{ ...events[0], meta: { windowTitle: "secret" } }] } });
    expect(bad.status()).toBe(400);
    const batch = await request.post("/api/collect/events", { headers: auth, data: { collectorId: e.collectorId, events } });
    expect(batch.status(), await batch.text()).toBe(200);
    const b = (await batch.json()) as { accepted: number; dropped: number; reasons: Record<string, number> };
    expect(b, JSON.stringify(b)).toMatchObject({ accepted: 20, dropped: 0 });

    // ---- UI reflects it: collector active with 20 events ----
    await page.reload();
    await page.getByTestId("tab-collectors").click();
    const crow = page.getByTestId(`collector-row-${e.collectorId}`);
    await expect(crow).toContainText(deviceName);
    await expect(crow).toContainText(employeeName);
    await expect(crow).toContainText("active");
    await expect(crow).toContainText("linux");
    await expect(crow.locator("td").nth(6)).toHaveText("20");
    await expect(page.getByTestId("health-events-24h")).toContainText(/\d/);

    // ---- Pause / resume: the server refuses events while paused ----
    await page.getByTestId(`collector-pause-${e.collectorId}`).click();
    await expect(crow).toContainText("paused");
    const whilePaused = await request.post("/api/collect/events", { headers: auth, data: { collectorId: e.collectorId, events: events.slice(0, 2) } });
    expect(await whilePaused.json()).toMatchObject({ accepted: 0, reasons: { collector_paused: 2 } });
    await page.getByTestId(`collector-resume-${e.collectorId}`).click();
    await expect(crow).toContainText("active");
    await expect(crow).not.toContainText("paused");

    // ---- Run analysis: enqueues a job; the row reports the queued/pending state until a worker picks it up ----
    await page.getByTestId("tab-campaigns").click();
    await expect(row.locator("td").nth(6)).toHaveText("20"); // events counted on the campaign
    await page.getByTestId(`campaign-analyze-${campaignId}`).click();
    await expect(page.getByTestId(`campaign-analysis-${campaignId}`)).toContainText(/job (queued|running)|done/);
    // the monitoring card (moved from the executive page to Desktop Collectors in the Phase A redesign) counts the new activity
    await page.goto("/app/collection?tab=collectors");
    const ev24 = page.getByTestId("health-events-24h");
    await expect(ev24).toContainText(/\d/);
    expect(Number((await ev24.locator("span").first().innerText()).replace(/,/g, "")), "events in the last 24h include the 20 just sent").toBeGreaterThanOrEqual(20);
    // leave the org tidy: finish the e2e campaign so it does not stay "running" for other specs
    await page.goto("/app/collection?tab=campaigns");
    await page.getByTestId(`campaign-complete-${campaignId}`).click();
    await expect(page.getByTestId(`campaign-row-${campaignId}`)).toContainText("completed");
  });

  // FINDINGS.md #2 — the "New campaign" form defaults "Starts" to the UTC calendar date, then stores it as local midnight.
  // In the org's time zone (America/Chicago) between 18:00 and 24:00 the default start is *tomorrow*, so a campaign
  // created and started with the defaults silently drops every event (outside_campaign_window) until local midnight.
  test("a campaign created with the form's default dates accepts events immediately after it is started (FINDINGS.md #2)", async ({ ownerPage: page, request }) => {
    const tag = uniq("coll-default");
    await page.goto("/app/collection?tab=campaigns");
    await page.getByTestId("campaign-create").click();
    await page.getByTestId("campaign-name").fill(`Default-dates campaign ${tag}`);
    await page.getByTestId("campaign-use-schedule").uncheck();
    await page.getByTestId("campaign-submit").click(); // keep the default Starts / Ends
    const row = page.locator("tr[data-testid^='campaign-row-']", { hasText: tag });
    const campaignId = (await row.getAttribute("data-testid"))!.replace("campaign-row-", "");
    await page.getByTestId(`campaign-start-${campaignId}`).click();
    await expect(row).toContainText("running");
    await page.goto("/app/collection?tab=collectors");
    await page.getByTestId("collector-create-code").click();
    await page.getByTestId("enrollment-name").fill(`Default laptop ${tag}`);
    await page.getByTestId("enrollment-submit").click();
    const code = (await page.getByTestId("enrollment-code").innerText()).trim();
    const e = (await (await request.post("/api/collect/enroll", { data: { enrollmentCode: code, platform: "linux", hostname: tag, version: "0.1.0-e2e" } })).json()) as { collectorId: string; token: string; notice: { version: string } };
    await request.post("/api/collect/consent", { headers: { authorization: `Bearer ${e.token}` }, data: { collectorId: e.collectorId, noticeVersion: e.notice.version } });
    const batch = await request.post("/api/collect/events", { headers: { authorization: `Bearer ${e.token}` }, data: { collectorId: e.collectorId, events: [{ ts: new Date().toISOString(), type: "app_focus", app: "Excel", durationMs: 1000 }] } });
    expect(await batch.json(), "an event sent right after starting a default-dated campaign must be accepted").toMatchObject({ accepted: 1 });
    // tidy: finish the campaign so it does not capture events sent by later runs of the main collection test
    await page.goto("/app/collection?tab=campaigns");
    await page.getByTestId(`campaign-complete-${campaignId}`).click();
    await expect(page.getByTestId(`campaign-row-${campaignId}`)).toContainText("completed");
  });
});
