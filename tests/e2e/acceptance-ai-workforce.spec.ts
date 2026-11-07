import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, USD_ANYWHERE, statePath } from "./fixtures";
import { EXEC_H1 } from "./nav-map";
import { closeDb, orgIdBySlug, aiEmployeeByPersona, skillRunCount, agentRunsForSkillRun, auditCount, GULF_SLUG } from "./db";

/**
 * Final acceptance scenario — "an owner meets, tests, pilots and proves an AI employee", fully end to end, no mocks:
 * real UI for every step (API / read-only DB only to read back and verify), real Postgres, production build.
 *
 *  1 Command Center + five-entry-point band   2 Charlotte recommended from the bill-entry workflow's real numbers
 *  3 Meet Charlotte (AI designation, AI intro, monogram)   4 Talk: AI identity + citation, start-demo action
 *  5 Sandbox demo on the over-threshold sample (10 steps, Synthetic sample, manual-vs-automated)
 *  6 Manual-vs-automated financial calculator   7 Approve a limited pilot (gated by the sandbox run)
 *  8 Permission read_only → draft_only → act_with_approval with explicit confirmation; accounting connectors honestly not built
 *  9 Live process_invoice on a real-looking invoice (approved vendor + open PO from the AI Brain, over the $5,000 policy
 *    threshold) → awaiting_approval → owner approves → succeeded, posted to the BridgeBox AP queue, no accounting system
 * 10 View my work shows the live run with its steps and approval
 * 11 Verified savings: pilot linked a runtime agent → record a run-ledger measurement → /app/savings + /app verified > $0;
 *    the sandbox run contributed $0
 * 12 Executive ROI PDF from /app/reports
 *
 * Re-runnable: Charlotte is reset through the UI (pause + lower permission) when a previous run left her in pilot; every
 * live invoice gets a unique number so the duplicate check never holds it.
 */
const SHOTS = path.join(process.cwd(), "test-results", "acceptance");
const num = (s: string) => Number(s.replace(/[^\d.]/g, ""));
const dollars = (s: string) => { const m = s.match(/-?\$([\d.,]+)\s?([KMB])?/); if (!m) return NaN; const n = Number(m[1].replace(/,/g, "")); return n * (m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "B" ? 1e9 : 1); };
const firstSentence = (s: string) => s.trim().split(/(?<=[.!?])\s/)[0] ?? "";
async function shot(page: Page, name: string) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); }

test.use({ trace: "on" });

test.describe("Acceptance — AI Workforce end to end", () => {
  test.afterAll(async () => { await closeDb(); });

  test("owner: recommendation → meet → talk → demo → financials → pilot → permissions → live approved task → history → verified savings → executive report", async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    // own context at 1440; the trace (always on, see test.use above) lands in this test's test-results folder
    const context = await browser.newContext({ storageState: statePath("owner"), viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    try {
    const orgId = await orgIdBySlug(GULF_SLUG);
    const seeded = await aiEmployeeByPersona(orgId, "charlotte");
    expect(seeded, "Charlotte is seeded for Gulf Coast").not.toBeNull();
    const charlotteId = seeded!.id;

    // ---- re-run hygiene (real UI): a previous run may have left Charlotte piloting with elevated permission
    if (["pilot", "active"].includes(seeded!.status) || seeded!.permissionLevel !== "read_only") {
      await page.goto(`/app/workforce/${charlotteId}?tab=customize`);
      if (["pilot", "active"].includes(seeded!.status)) { await page.getByTestId("st-pause").click(); await expect(page.locator("main")).toContainText("Status: paused"); }
      if (seeded!.permissionLevel !== "read_only") { await page.getByTestId("perm-read_only").click(); await expect(page.locator("main")).toContainText("Permission set to Read only"); }
    }

    // ---- 1. Command Center + five entry points with live numbers
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1, name: EXEC_H1 })).toBeVisible();
    const band = page.getByTestId("home-band");
    await expect(band).toBeVisible();
    for (const t of ["entry-business", "entry-team", "entry-demo", "entry-work", "entry-savings"]) {
      await expect(band.getByTestId(t), `${t} shows a live number`).toContainText(/\d/);
    }
    expect(num((await band.getByTestId("entry-business").locator(".font-display").innerText()))).toBeGreaterThan(0);
    expect(num((await band.getByTestId("entry-team").locator(".font-display").innerText()))).toBeGreaterThanOrEqual(8);
    for (const t of ["kpi-labor", "kpi-opportunity"]) {
      const k = page.getByTestId(t);
      await expect(k).toContainText(USD_ANYWHERE);
      expect(dollars(await k.innerText()), `${t} > $0`).toBeGreaterThan(0);
    }

    // ---- 2. BridgeBox recommends Charlotte with the bill-entry workflow's real numbers
    await band.getByTestId("entry-team").click();
    await page.waitForURL((u) => u.pathname === "/app/experience");
    const rec = page.getByTestId("rec-charlotte");
    await expect(rec).toBeVisible();
    await expect(rec).toContainText("AI Accounts Payable Specialist");
    const quote = (await page.getByTestId("rec-quote-charlotte").innerText()).trim();
    expect(firstSentence(quote.replace(/^“/, ""))).toMatch(/I'm Charlotte, an AI agent\./);
    const qm = quote.match(/~([\d.,]+) hours\/week on ([a-z ]+)\./);
    expect(qm, `quote has an observed hours/week figure: ${quote}`).not.toBeNull();
    const quotedHours = Number(qm![1].replace(/,/g, "")); const wfLabel = qm![2].trim();
    expect(wfLabel).toBe("bill entry");
    expect(quote).toMatch(/\$[\d,.]+[KM]? a year in recovered capacity \(estimated\)/);
    await rec.scrollIntoViewIfNeeded();
    await shot(page, "step-02-recommendation");
    // pilot gate: without a successful sandbox run, "Start pilot" routes to the demonstration instead (fresh DB only —
    // a re-run already has sandbox history)
    if ((await skillRunCount(charlotteId, "sandbox")) === 0) {
      await page.getByTestId("rec-pilot-charlotte").click();
      await expect(page.getByTestId("xp-msg")).toContainText("Watch Charlotte's sandbox demonstration first");
      expect((await aiEmployeeByPersona(orgId, "charlotte"))!.status).not.toBe("pilot");
    }
    // the number is the workflow's own observed hours/week
    await page.goto("/app/workflows");
    const wfRow = page.locator("tr[data-testid^='wf-row-']").filter({ hasText: /Bill entry/ }).first();
    await wfRow.getByRole("link").first().click();
    await page.waitForURL(/\/app\/workflows\/[0-9a-f-]{36}$/);
    const wfHours = num(await page.getByTestId("kpi-wf-hours").locator(".tabular, .font-display").first().innerText().catch(async () => page.getByTestId("kpi-wf-hours").innerText()));
    expect(Math.round(quotedHours), `rec quote hours (${quotedHours}) = workflow hours/week (${wfHours}) rounded`).toBe(Math.round(wfHours));

    // ---- 3. Meet Charlotte → profile: AI designation, AI intro, AI-generated portrait (or monogram if none)
    await page.goto("/app/experience");
    await page.getByTestId("rec-meet-charlotte").click();
    await page.waitForURL((u) => u.pathname === `/app/workforce/${charlotteId}`);
    const hero = page.getByTestId("profile-hero");
    await expect(hero.getByTestId("ai-badge")).toHaveText(/AI Agent/);
    await expect(hero).toContainText("AI agent, not a person");
    await expect(page.getByRole("heading", { level: 1, name: "Meet Charlotte" })).toBeVisible();
    const intro = await page.getByTestId("profile-intro").innerText();
    expect(firstSentence(intro), "intro's first sentence says she is an AI agent").toMatch(/\bAI agent\b/);
    const avatar = hero.locator("[role='img'][aria-label^='Charlotte, AI agent']").first();
    await expect(avatar).toBeVisible();
    if (seeded!.portraitUrl) await expect(hero).toContainText(/AI-generated portrait|Licensed portrait/);
    else { await expect(avatar.locator("img")).toHaveCount(0); await expect(avatar).toContainText("C"); await expect(avatar).toHaveAttribute("title", /monogram/); }
    await shot(page, "step-03-profile");

    // ---- 4. Talk to Charlotte (retrieval mode: cited, says it is AI) and get a start-demo action
    const chat = page.getByTestId("chat");
    const aiTexts = chat.getByTestId("chat-messages").locator("p.whitespace-pre-line");
    const before = await aiTexts.count();
    await chat.getByTestId("chat-input").fill("What can you do for my company?");
    await chat.getByTestId("chat-send").click();
    await expect(aiTexts).toHaveCount(before + 1, { timeout: 45_000 });
    const answer1 = await aiTexts.nth(before).innerText();
    expect(firstSentence(answer1), `answer states AI identity: ${answer1.slice(0, 160)}`).toMatch(/\bAI agent\b/);
    const lastBubbleCites = chat.getByTestId("chat-citations").last();
    await expect(lastBubbleCites).toBeVisible();
    expect(await lastBubbleCites.locator("a").count(), "≥1 citation").toBeGreaterThanOrEqual(1);
    await expect(chat.getByTestId("chat-mode").last()).toHaveText(/Retrieval mode|AI model/);
    await chat.getByTestId("chat-input").fill("Can you demonstrate how you process an invoice?");
    await chat.getByTestId("chat-send").click();
    await expect(aiTexts).toHaveCount(before + 2, { timeout: 45_000 });
    const startDemo = chat.getByTestId("chat-action-start_demo").last();
    await expect(startDemo).toBeVisible();
    await startDemo.click();
    await expect(page.getByTestId("profile-tab-demo")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("demo-result")).toBeVisible({ timeout: 60_000 }); // the chat action auto-starts the sandbox demo
    await expect(page.getByTestId("demo-synthetic")).toContainText("Synthetic sample");

    // ---- 5. Watch a demonstration: sandbox process_invoice on the over-threshold sample, all 10 steps
    await page.getByTestId("action-assign").click();
    const runner = page.getByTestId("assign-runner");
    await expect(runner).toBeVisible();
    await runner.getByTestId("assign-runner-mode-sandbox").click();
    await runner.getByTestId("assign-runner-source-sample").click();
    await runner.getByTestId("assign-runner-sample-over_threshold").click();
    const [sbRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/skills/run") && r.request().method() === "POST", { timeout: 60_000 }),
      runner.getByTestId("assign-runner-run").click(),
    ]);
    const sandbox = await sbRes.json() as { skillRunId: string; status: string; synthetic: boolean; steps: { key: string; status: string }[] };
    expect(sandbox.synthetic).toBe(true);
    expect(sandbox.status).toBe("succeeded");
    const player = page.getByTestId("assign-runner-player");
    await expect(player.getByTestId("assign-runner-player-summary")).toBeVisible({ timeout: 30_000 });
    const stepKeys = ["receive", "extract", "validate", "duplicate_check", "po_match", "prepare_entry", "request_approval", "update_accounting", "record_time", "savings"];
    expect(sandbox.steps.map((s) => s.key)).toEqual(stepKeys);
    for (const k of stepKeys) await expect(player.getByTestId(`assign-runner-player-step-${k}`)).toHaveAttribute("data-status", "done");
    await expect(player.getByText("Synthetic sample", { exact: true })).toBeVisible(); // ribbon
    await expect(player).toContainText("Sandbox · synthetic");
    await expect(player.getByTestId("assign-runner-player-summary")).toContainText(/over the \$5,000\.00 approval threshold|Synthetic sample/);
    const cmp = player.getByTestId("demo-player-comparison");
    await expect(cmp).toBeVisible();
    await expect(cmp).toContainText("Manual vs. with the AI agent");
    await expect(cmp).toContainText(/saved/);
    await expect(cmp).toContainText("Synthetic sample — never counted in savings.");
    await player.scrollIntoViewIfNeeded();
    await shot(page, "step-05-sandbox-demo");
    expect(await skillRunCount(charlotteId, "sandbox")).toBeGreaterThanOrEqual(1);

    // ---- 6. Financial analysis: manual vs automated (Experience calculator)
    await page.goto("/app/experience");
    await page.getByTestId("rec-calc-charlotte").click();
    const calc = page.getByTestId("xp-calc");
    await expect(calc).toBeVisible();
    await expect(calc).toContainText("Today (manual, observed)");
    await expect(calc).toContainText("With Charlotte (estimated)");
    await expect(calc).toContainText(`${quotedHours.toFixed(1)} h/wk`);
    await expect(calc).toContainText(USD_ANYWHERE);
    await expect(calc).toContainText("not a payroll reduction");
    await calc.getByTestId("xp-calc-tree").click();
    await expect(calc).toContainText(/Realizable|realizable/);
    await page.keyboard.press("Escape");
    await expect(calc).toHaveCount(0);

    // ---- 7. Owner approves a limited pilot (gate: a successful sandbox run exists)
    await page.getByTestId("rec-pilot-charlotte").click();
    await expect(page.getByTestId("xp-msg")).toContainText("Charlotte is now in Pilot at read only permission.");
    await expect(page.getByTestId("rec-pilot-charlotte")).toHaveText(/Piloting/);
    const piloted = await aiEmployeeByPersona(orgId, "charlotte");
    expect(piloted!.status).toBe("pilot");
    expect(piloted!.permissionLevel, "a pilot never raises permission").toBe("read_only");

    // ---- 8. Authorize: raise permission one level at a time with explicit confirmation; tools honestly not built
    await page.goto(`/app/workforce/${charlotteId}?tab=customize`);
    for (const [level, label] of [["draft_only", "Draft only"], ["act_with_approval", "Act with approval"]] as const) {
      await page.getByTestId(`perm-${level}`).click();
      const dlg = page.getByRole("dialog");
      await expect(dlg).toContainText(`Raise permission to ${label}?`);
      await expect(dlg.getByTestId("perm-apply")).toBeDisabled(); // explicit confirmation required
      await dlg.getByTestId("perm-confirm").check();
      await dlg.getByTestId("perm-apply").click();
      await expect(page.locator("main")).toContainText(`Permission set to ${label}.`);
      await expect(page.getByTestId(`perm-${level}`)).toHaveAttribute("aria-checked", "true");
    }
    expect(await auditCount(orgId, "ai_employee.permission", charlotteId)).toBeGreaterThanOrEqual(2);
    await page.getByTestId("action-connect").click();
    for (const k of ["quickbooks", "netsuite"]) {
      const c = page.getByTestId(`conn-${k}`);
      await expect(c).toBeVisible();
      await expect(c).toContainText(/not.built/i);
      await expect(c).toContainText("Required by a skill");
    }

    // ---- 9. The agent executes an actual approved task: live process_invoice on a pasted invoice
    const invNo = `GLE-${Date.now().toString().slice(-7)}`;
    const invoice = [
      "Gulfline Electrical",
      "4410 Industrial Pkwy, Houston, TX 77029",
      "INVOICE",
      `Invoice Number: ${invNo}     Invoice Date: Nov 2, 2026`,
      "Purchase Order: PO-24-1194     Terms: Net 45     Due Date: Dec 17, 2026",
      "",
      "Description                         Qty   Unit Price      Amount",
      "200A main breaker panelboard          4    $1,285.00   $5,140.00",
      "THHN copper wire 500 ft spool        10      $250.00   $2,500.00",
      "",
      "Subtotal                                               $7,640.00",
      "Tax                                                       $0.00",
      "Total                                                  $7,640.00",
    ].join("\n");
    await page.reload(); // fresh server props: pilot + act_with_approval unlock live mode
    await page.getByTestId("action-assign").click();
    await runner.getByTestId("assign-runner-mode-live").click();
    await expect(runner.getByTestId("assign-runner-mode-live")).toHaveAttribute("aria-checked", "true");
    await runner.getByTestId("assign-runner-input").fill(invoice);
    const [liveRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/skills/run") && r.request().method() === "POST", { timeout: 60_000 }),
      runner.getByTestId("assign-runner-run").click(),
    ]);
    const live = await liveRes.json() as { skillRunId: string; status: string; synthetic: boolean; output: { invoice: { vendor: string; total: number; poNumber: string }; poMatch: { status: string } } };
    expect(live.synthetic).toBe(false);
    expect(live.status).toBe("awaiting_approval");
    expect(live.output.invoice.vendor).toMatch(/Gulfline Electrical/);
    expect(live.output.invoice.total).toBe(7640);
    expect(live.output.poMatch.status, "PO-24-1194 from the AI Brain PO register matches").toBe("matched");
    const approval = page.getByTestId("assign-runner-approval");
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval).toContainText(/over the \$5,000\.00 approval threshold/);
    await expect(approval).toContainText("owner or admin only");
    await expect(player).toContainText("Live data");
    await expect(player.getByText("Synthetic sample", { exact: true })).toHaveCount(0);
    await approval.getByTestId("assign-runner-approval-approve").isDisabled().then((d) => expect(d, "approve needs the review checkbox").toBe(true));
    await approval.getByTestId("assign-runner-approval-confirm").check();
    const [decRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/skills/decide") && r.request().method() === "POST"),
      approval.getByTestId("assign-runner-approval-approve").click(),
    ]);
    expect(decRes.status()).toBe(200);
    const decided = await decRes.json() as { status: string; summary: string };
    expect(decided.status).toBe("succeeded");
    const summary = player.getByTestId("assign-runner-player-summary");
    await expect(summary).toContainText("Approved by an owner and completed.");
    await expect(summary).toContainText("posted to BridgeBox AP queue");
    await expect(summary).toContainText("no accounting system connected");
    await expect(player.getByTestId("assign-runner-player-step-update_accounting")).toContainText(/BridgeBox AP queue — no accounting system connected/);
    await expect(player.getByTestId("assign-runner-player-step-update_accounting")).toHaveAttribute("data-status", "done");
    await player.scrollIntoViewIfNeeded();
    await shot(page, "step-09-live-approved");
    const readBack = await (await page.request.get(`/api/skills/run?id=${live.skillRunId}`)).json() as { status: string; output: { apQueue?: { status: string; externalSystem: null } } };
    expect(readBack.status).toBe("succeeded");
    expect(readBack.output.apQueue).toMatchObject({ status: "approved_for_posting", externalSystem: null });

    // ---- 10. Execution history: View my work
    await page.getByTestId("action-work").click();
    const row = page.getByTestId(`run-${live.skillRunId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Live");
    await expect(row).toContainText("succeeded");
    await expect(row).toContainText(invNo);
    await expect(page.getByTestId(`run-approval-${live.skillRunId}`)).toContainText("approved by owner");
    await page.getByTestId(`run-steps-${live.skillRunId}`).locator("summary").click();
    await expect(page.getByTestId(`run-steps-${live.skillRunId}`)).toContainText("10 steps");
    await expect(page.getByTestId(`run-steps-${live.skillRunId}`).getByTestId("run-step-request_approval")).toContainText("done");
    await expect(page.getByTestId(`run-${sandbox.skillRunId}`)).toContainText("Synthetic sample");

    // ---- 11. Finance updates from verified results only
    const linked = await aiEmployeeByPersona(orgId, "charlotte");
    expect(linked!.agentId, "starting the pilot linked a runtime agent").not.toBeNull();
    const liveMirror = await agentRunsForSkillRun(live.skillRunId);
    expect(liveMirror).toHaveLength(1);
    expect(liveMirror[0].agentId).toBe(linked!.agentId);
    expect(liveMirror[0].minutesSaved).toBeGreaterThan(0);
    expect(await agentRunsForSkillRun(sandbox.skillRunId), "sandbox runs never reach the run ledger").toHaveLength(0);
    await page.goto("/app/savings");
    const tierAmount = async () => num(await page.getByTestId("tier-verifiedTime").locator(".tabular").first().innerText());
    const verifiedBefore = await tierAmount();
    await page.goto(`/app/workforce/${charlotteId}?tab=savings`);
    await expect(page.getByTestId("sv-tasks")).toContainText(/sandbox excluded/);
    expect(num(await page.getByTestId("sv-hours").locator(".font-display, .tabular").first().innerText())).toBeGreaterThan(0);
    await page.getByTestId("sv-agent-link").click();
    await page.waitForURL((u) => u.pathname === `/app/agents/${linked!.agentId}`);
    await expect(page.locator("main")).toContainText("deployed");
    await page.getByTestId("measure-record").click();
    await expect(page.getByTestId("agent-flash")).toHaveText("Measurement recorded");
    const m = page.locator("[data-testid^='measurement-']").first();
    await expect(m).toContainText(USD_ANYWHERE);
    await page.goto("/app/savings");
    const verifiedAfter = await tierAmount();
    expect(verifiedAfter, "verified-time tier > $0").toBeGreaterThan(0);
    expect(verifiedAfter, "Charlotte's measured live run raised the verified tier").toBeGreaterThan(verifiedBefore);
    await page.getByTestId("tier-verifiedTime").scrollIntoViewIfNeeded();
    await shot(page, "step-11-verified-savings");
    await page.goto("/app");
    const vk = page.getByTestId("kpi-verified");
    await expect(vk).toContainText(USD_ANYWHERE);
    expect(dollars(await vk.innerText())).toBeGreaterThan(0);
    expect(await auditCount(orgId, "ai_employee.agent_linked", charlotteId) + (seeded!.agentId ? 1 : 0)).toBeGreaterThanOrEqual(1);

    // ---- 12. Executive ROI report (PDF) from /app/reports
    await page.goto("/app/reports");
    await page.getByTestId("reports-preview-generate-executive_roi").click();
    await expect(page.getByTestId("reports-kind")).toHaveValue("executive_roi");
    await page.getByTestId("reports-generate-confirm").click();
    await expect(page.getByTestId("reports-flash")).toContainText("Report generated", { timeout: 60_000 });
    const newest = page.locator("tr[data-testid^='reports-row-']").first();
    await expect(newest).toContainText("Executive ROI");
    const link = newest.locator("a[data-testid^='reports-download-']");
    const href = (await link.getAttribute("href"))!;
    const pdf = await page.request.get(href);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    const body = await pdf.body();
    expect(body.length).toBeGreaterThan(10 * 1024);
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    const [dl] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(dl.suggestedFilename()).toMatch(/executive_roi-.*\.pdf$/);
    } finally {
      await context.close();
    }
  });
});
