import { test, expect, uniq, USD_ANYWHERE } from "./fixtures";
import { startMockApi } from "./mock-api";

/**
 * Opportunity → agent → deploy → run → human approval → verified measurement → executive KPI.
 * The agent's "target system API" is a local HTTP stub started by the test, attached through a real
 * http_bearer credential, so the post-approval step performs a genuine outbound call.
 */
test.describe("AI agents", () => {
  test("automate an opportunity end to end and see verified savings on the executive dashboard", async ({ ownerPage: page }) => {
    test.setTimeout(180_000);
    const mock = await startMockApi();
    const tag = uniq("agent");
    try {
      // ---- From an opportunity that has no agent yet (take the lowest-ranked one so rank 1 stays free for other specs) ----
      await page.goto("/app/opportunities");
      // NOTE: link-style <Button href> drops data-testid (see FINDINGS.md #1), so "Automate this" is located by its accessible name.
      await expect(page.getByTestId("opp-list").locator("[data-testid^='opp-card-']").first()).toBeVisible();
      const automatable = page.getByTestId("opp-list").locator("[data-testid^='opp-card-']").filter({ has: page.getByRole("link", { name: "Automate this" }) });
      const count = await automatable.count();
      expect(count, "an opportunity without an agent is available").toBeGreaterThan(0);
      const oppId = (await automatable.nth(count - 1).getAttribute("data-testid"))!.replace("opp-card-", "");
      const oppTitle = (await page.getByTestId(`opp-card-${oppId}`).locator("a[href^='/app/opportunities/']").first().innerText()).trim();
      await page.goto(`/app/opportunities/${oppId}`);
      await page.getByRole("link", { name: "Automate this" }).first().click();
      await page.waitForURL(new RegExp(`/app/agents/new\\?opportunityId=${oppId}`));

      // ---- Template picker: the recommended template is preselected; the picker marks it "Recommended" ----
      await expect(page.getByRole("heading", { level: 1, name: /^Configure: / })).toBeVisible();
      await page.getByTestId("template-back").click();
      await expect(page.getByRole("heading", { level: 1, name: "New agent" })).toBeVisible();
      const recommended = page.locator("button[data-testid^='template-']", { hasText: "Recommended" });
      await expect(recommended).toHaveCount(1);
      await expect(recommended).toHaveClass(/border-brand/);
      // Pick the social-post drafter: LLM step is skipped without ANTHROPIC_API_KEY, then approval, then an HTTP call to the client's API
      await page.getByTestId("template-marketing_social_drafts").click();
      await expect(page.getByRole("heading", { level: 1, name: /Configure: Social post drafter/ })).toBeVisible();

      // ---- Configure: name, linked opportunity preselected, inline credential, approval policy "all" ----
      const agentName = `E2E social drafter ${tag}`;
      await page.getByTestId("agent-name").fill(agentName);
      await expect(page.getByTestId("agent-opportunity")).toHaveValue(oppId);
      await page.getByTestId("cred-create-http_bearer").click();
      await page.getByTestId("cred-name").fill(`E2E scheduling API ${tag}`);
      await page.getByTestId("cred-field-baseUrl").fill(mock.baseUrl);
      await page.getByTestId("cred-field-token").fill(`tok-${tag}`);
      await page.getByTestId("cred-save").click();
      await expect(page.getByTestId("cred-select-http_bearer")).toContainText(`E2E scheduling API ${tag}`);
      expect(await page.getByTestId("cred-select-http_bearer").inputValue()).toMatch(/[0-9a-f-]{36}/);
      await expect(page.locator("main")).not.toContainText("Missing:");
      await page.getByTestId("agent-approval-mode").selectOption("all");
      await page.getByTestId("agent-approver").selectOption("manager");
      await expect(page.getByTestId("runtime-internal")).toBeChecked();
      await expect(page.getByTestId("runtime-n8n")).toBeDisabled(); // n8n not configured → honestly disabled
      await page.getByTestId("agent-create").click();
      await page.waitForURL(/\/app\/agents\/[0-9a-f-]{36}$/);
      const agentId = page.url().split("/").pop()!;
      await expect(page.getByRole("heading", { level: 1 })).toContainText(agentName);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("configured");
      await expect(page.locator("main")).toContainText(oppTitle);

      // ---- Deploy ----
      await page.getByTestId("agent-deploy").click();
      await expect(page.getByTestId("agent-flash")).toHaveText(/^Deployed/); // "Deployed — version recorded"
      await expect(page.getByRole("heading", { level: 1 })).toContainText("deployed");
      await expect(page.getByTestId("agent-pause")).toBeVisible();

      // ---- Run now with JSON input → pauses at the approval step ----
      await page.getByTestId("agent-run-now").click();
      const input = { topic: `E2E launch ${tag}`, url: "https://example.com/blog/e2e", tone: "friendly" };
      await page.getByTestId("run-input").fill(JSON.stringify(input, null, 2));
      await page.getByTestId("run-submit").click();
      await expect(page.getByTestId("agent-flash")).toHaveText("Run awaiting approval");
      const drawer = page.getByTestId("run-drawer");
      await expect(drawer).toBeVisible();
      await expect(page.getByRole("dialog")).toContainText("awaiting approval");
      await expect(page.getByTestId("run-approval")).toContainText(`Queue 3 social posts about ${input.topic}`);
      await expect(page.getByTestId("run-logs")).toContainText("Waiting for approval");
      expect(mock.hits.length, "nothing is sent to the client's API before approval").toBe(0);
      await page.getByRole("dialog").getByLabel("Close").click();

      // ---- Approve in the Approvals tab → run resumes and succeeds ----
      await page.getByTestId("tab-approvals").click();
      const approval = page.locator("[data-testid^='approval-']").filter({ hasText: input.topic }).first();
      await expect(approval).toBeVisible();
      const approvalId = (await approval.getAttribute("data-testid"))!.replace("approval-", "");
      await page.getByTestId(`approval-note-${approvalId}`).fill("Looks good — ship it");
      await page.getByTestId(`approval-approve-${approvalId}`).click();
      await expect(page.getByTestId("agent-flash")).toHaveText("Approved — run resumed");
      await expect(page.locator("tbody")).toContainText("approved");
      await expect(page.locator("tbody")).toContainText("Looks good — ship it");
      // the post-approval HTTP step really hit the client's API with the bearer token
      await expect.poll(() => mock.hits.length).toBeGreaterThanOrEqual(1);
      expect(mock.hits[0]).toMatchObject({ method: "POST", url: "/posts", authorization: `Bearer tok-${tag}` });

      await page.getByTestId("tab-runs").click();
      const runRow = page.locator("tr[data-testid^='run-row-']").first();
      await expect(runRow).toContainText("succeeded");
      await expect(runRow.locator("td").nth(4)).toHaveText(/^\d+(\.\d+)?$/); // minutes saved
      const minutesSaved = Number(await runRow.locator("td").nth(4).innerText());
      expect(minutesSaved).toBeGreaterThan(0);
      await runRow.click();
      await expect(page.getByRole("dialog")).toContainText("succeeded");
      await expect(page.getByTestId("run-logs")).toContainText("Queue posts ok");
      await expect(page.getByTestId("run-logs")).toContainText("Approval approved");
      await page.getByRole("dialog").getByLabel("Close").click();

      // ---- Results: record a measurement for the current period ----
      await page.getByTestId("tab-results").click();
      await expect(page.locator("main")).toContainText("Successful runs");
      await page.getByTestId("measure-record").click();
      await expect(page.getByTestId("agent-flash")).toHaveText("Measurement recorded");
      const measurement = page.locator("[data-testid^='measurement-']").first();
      await expect(measurement).toBeVisible();
      await expect(measurement).toContainText(/\d+(\.\d+)? h/);
      await expect(measurement).toContainText(USD_ANYWHERE);
      await expect(measurement).toContainText(/\d+ runs/);
      await expect(measurement).toContainText(/observed|estimated|assumed/);

      // ---- Executive Command Center: "Verified Savings" is now a measured dollar amount ----
      await page.goto("/app");
      const verified = page.getByTestId("kpi-verified");
      await expect(verified).toContainText(USD_ANYWHERE);
      await expect(verified).toContainText(/\d+ measurements?/);
      const dollars = Number((await verified.innerText()).match(/\$([\d,.]+)/)![1].replace(/,/g, ""));
      expect(dollars).toBeGreaterThan(0);
      await verified.click();
      const drill = page.getByTestId("drill-drawer");
      await expect(drill.getByRole("heading", { level: 2 })).toHaveText("Verified savings");
      await expect(drill).toContainText(/Measured after deployment from \d+ measurements?/);
      expect(await page.getByTestId("drill-lineage").locator("li").count(), "verified savings trace back to measurements").toBeGreaterThan(0);
      await drill.getByLabel("Close").click();
      // ROI & Savings Center shows the same verified tier as a non-zero observed amount
      await page.goto("/app/savings");
      const tier = page.getByTestId("tier-verifiedTime").locator(".tabular").first();
      await expect(tier).toContainText(USD_ANYWHERE);
      expect(Number((await tier.innerText()).replace(/[^\d.]/g, ""))).toBeGreaterThan(0);

      // the opportunity is now marked deployed and links to the agent
      await page.goto(`/app/opportunities/${oppId}`);
      await expect(page.getByTestId("opp-agent")).toContainText(agentName);
      await expect(page.locator("main")).toContainText("Managed by its agent");
      await page.goto("/app/agents");
      await expect(page.getByTestId(`agent-row-${agentId}`)).toContainText("deployed");
    } finally { await mock.close(); }
  });
});
