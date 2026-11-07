import fs from "node:fs";
import ExcelJS from "exceljs";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Financial reconciliation across surfaces. The same scenario must produce the same dollars on
 *   /app (Executive Command Center) · /app/finance (Financial Model) · /app/savings (ROI & Savings Center) · the Excel export.
 * KPI cards show compact values ($1.6M); their drill-downs and the finance/savings calculation trees show whole dollars,
 * so whole dollars are compared ("to the dollar shown"), and each compact card is checked against its whole-dollar value.
 */
const whole = (s: string) => { const m = s.match(/(-?)\$([\d,]+(?:\.\d+)?)/); if (!m) return NaN; return Number(m[2].replace(/,/g, "")) * (m[1] ? -1 : 1); };
const compact = (s: string) => { const m = s.match(/(-?)\$([\d.,]+)\s?([KMB])?/); if (!m) return NaN; const n = Number(m[2].replace(/,/g, "")) * (m[3] === "K" ? 1e3 : m[3] === "M" ? 1e6 : m[3] === "B" ? 1e9 : 1); return m[1] ? -n : n; };
/** A compact rendering like "$98.7K" or "$99K" is within half a unit of its last shown digit of the whole value. */
const compactMatches = (shown: string, value: number) => {
  const m = shown.match(/\$([\d.,]+)\s?([KMB])?/)!; const unit = m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "B" ? 1e9 : 1;
  const decimals = (m[1].split(".")[1] ?? "").length; const step = unit / 10 ** decimals;
  return Math.abs(compact(shown) - value) <= step / 2 + 0.5;
};

type AppNumbers = { labor: number; opportunity: number; net: number; verified: number; cards: Record<string, string> };

async function readCommandCenter(page: Page, query = ""): Promise<AppNumbers> {
  await page.goto(`/app${query}`);
  await expect(page.getByTestId("cmd-primary")).toBeVisible();
  const out: Partial<AppNumbers> & { cards: Record<string, string> } = { cards: {} };
  for (const k of ["labor", "opportunity", "net", "verified"] as const) {
    const card = page.getByTestId(`kpi-${k}`);
    out.cards[k] = (await card.locator(".font-display").first().innerText()).trim();
    await card.click();
    const drawer = page.getByTestId("drill-drawer");
    await expect(drawer).toBeVisible();
    const headline = (await drawer.locator(".font-display").first().innerText()).trim();
    // "Not yet measured" → the CalcTree root carries the (zero) value
    const v = headline.includes("$") ? whole(headline) : whole(await page.getByTestId("drill-tree").innerText());
    out[k] = v;
    await drawer.getByLabel("Close").click();
    await expect(drawer).toHaveCount(0);
  }
  return out as AppNumbers;
}

async function financeTile(page: Page, key: string) {
  await page.getByTestId(`finance-tile-${key}`).click();
  const modal = page.getByTestId("finance-calc-modal");
  await expect(modal).toBeVisible();
  const v = whole(await modal.innerText()); // root node is rendered first
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  return v;
}

async function readFinance(page: Page) {
  await expect(page.getByTestId("finance-page")).toBeVisible();
  const basis = await page.getByTestId("finance-basis").innerText();
  const labor = whole(basis.match(/\$[\d,]+ of loaded labor/)![0]);
  return { labor, gross: await financeTile(page, "gross"), realizable: await financeTile(page, "realizable"), net: await financeTile(page, "net") };
}

async function readSavings(page: Page) {
  await page.goto("/app/savings");
  await expect(page.getByTestId("tier-cards")).toBeVisible();
  const tiers: Record<string, number> = {};
  for (const k of ["potential", "approved", "verifiedTime", "capacityReleased", "costAvoidance", "realizedHard", "net"]) {
    tiers[k] = whole(await page.getByTestId(`tier-${k}`).locator(".font-display").first().innerText());
  }
  return tiers;
}

async function downloadWorkbook(page: Page, query = "") {
  await page.goto(`/app${query}`);
  await page.getByTestId("cmd-export").click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("cmd-export-xlsx").click()]);
  expect(dl.suggestedFilename()).toMatch(/executive-workbook-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync((await dl.path())!) as unknown as ArrayBuffer);
  const cell = (v: ExcelJS.CellValue) => (v && typeof v === "object" && "result" in v ? Number(v.result) : Number(v));
  const summary = new Map<string, number>();
  wb.getWorksheet("Summary")!.eachRow((r) => { const k = String(r.getCell(1).value ?? ""); if (k) summary.set(k, cell(r.getCell(2).value)); });
  const tiers = new Map<string, number>();
  wb.getWorksheet("Savings Tiers")!.eachRow((r, i) => { if (i >= 5 && i <= 11) tiers.set(String(r.getCell(1).value), cell(r.getCell(2).value)); });
  const totalRow = (sheet: string) => { let row: ExcelJS.Row | null = null; wb.getWorksheet(sheet)!.eachRow((r) => { if (r.getCell(1).value === "Total" || r.getCell(2).value === "Total") row = r; }); return row as unknown as ExcelJS.Row; };
  const header = (sheet: string) => (wb.getWorksheet(sheet)!.getRow(4).values as ExcelJS.CellValue[]).map((v) => String(v ?? ""));
  const col = (sheet: string, label: string) => { const r = totalRow(sheet); const idx = header(sheet).indexOf(label); expect(idx, `${sheet} has a '${label}' column`).toBeGreaterThan(0); return cell(r.getCell(idx).value); };
  return {
    labor: summary.get("Annual labor expense analyzed")!, gross: summary.get("Automation opportunity (gross annual savings)")!,
    realizable: summary.get("Projected realizable savings")!, net: summary.get("Projected net annual savings")!,
    tiers, deptLabor: col("Departments", "Labor / yr"), deptGross: col("Departments", "Gross / yr"), deptRealizable: col("Departments", "Realizable / yr"),
    oppGross: col("Opportunities", "Gross / yr"), oppRealizable: col("Opportunities", "Realizable / yr"),
  };
}

const TIER_SHEET_LABEL: Record<string, string> = { potential: "Potential savings", approved: "Approved savings", verifiedTime: "Verified time savings", capacityReleased: "Capacity released", costAvoidance: "Cost avoidance", realizedHard: "Realized hard savings", net: "Net savings" };

test.describe("Financial reconciliation", () => {
  test("saved model: the 4 command-center KPIs equal Financial Model and ROI & Savings Center, and the Excel export equals the UI", async ({ ownerPage: page }) => {
    const app = await readCommandCenter(page);
    for (const k of ["labor", "opportunity", "net"] as const) expect(app[k], `/app ${k}`).toBeGreaterThan(0);
    for (const k of ["labor", "opportunity", "net", "verified"] as const) {
      if (app.cards[k].includes("$")) expect(compactMatches(app.cards[k], app[k]), `/app ${k} card "${app.cards[k]}" rounds ${app[k]}`).toBe(true);
    }

    await page.goto("/app/finance");
    const fin = await readFinance(page);
    expect(fin.labor, "Annual Labor Expense = labor analyzed on /app/finance").toBe(app.labor);
    expect(fin.gross, "Automation Opportunity = Gross annual savings on /app/finance").toBe(app.opportunity);
    expect(fin.net, "Projected Net Savings = Net annual savings on /app/finance").toBe(app.net);

    const sav = await readSavings(page);
    expect(sav.verifiedTime, "Verified Savings = tier 3 (verified time) on /app/savings").toBe(app.verified);
    expect(sav.potential, "Savings potential tier = realizable on /app/finance").toBe(fin.realizable);

    const x = await downloadWorkbook(page);
    expect(Math.round(x.labor)).toBe(app.labor);
    expect(Math.round(x.gross)).toBe(app.opportunity);
    expect(Math.round(x.net)).toBe(app.net);
    expect(Math.round(x.realizable)).toBe(fin.realizable);
    expect(Math.round(x.tiers.get("Verified time savings")!)).toBe(app.verified);
    for (const [k, label] of Object.entries(TIER_SHEET_LABEL)) expect(Math.round(x.tiers.get(label)!), `Excel tier '${label}' = /app/savings`).toBe(sav[k]);
    // the workbook's own detail sheets add up to its summary (no double counting between sheets)
    expect(Math.round(x.deptLabor)).toBe(Math.round(x.labor));
    expect(Math.round(x.deptGross)).toBe(Math.round(x.gross));
    expect(Math.round(x.deptRealizable)).toBe(Math.round(x.realizable));
    expect(Math.round(x.oppGross)).toBe(Math.round(x.gross));
    expect(Math.round(x.oppRealizable)).toBe(Math.round(x.realizable));
  });

  test("conservative scenario: /app?scenario=conservative equals the Financial Model's Conservative preset and its export", async ({ ownerPage: page }) => {
    const app = await readCommandCenter(page, "?scenario=conservative");
    await page.goto("/app/finance");
    await page.getByTestId("finance-scenario-conservative").click();
    await expect(page.locator("main")).toContainText("Scenario: Conservative");
    await expect.poll(async () => financeTile(page, "net")).toBe(app.net);
    const fin = await readFinance(page);
    expect(fin.labor).toBe(app.labor); // observed labor never changes with the scenario
    expect(fin.gross).toBe(app.opportunity);
    expect(fin.net).toBe(app.net);
    const x = await downloadWorkbook(page, "?scenario=conservative");
    expect(Math.round(x.gross)).toBe(app.opportunity);
    expect(Math.round(x.net)).toBe(app.net);
  });

  test("custom saved assumptions: /app, /app/finance and the /app Excel export agree (regression: export applied the Expected preset)", async ({ ownerPage: page }) => {
    await page.goto("/app/finance");
    const adoption = page.getByTestId("finance-number-adoptionRate");
    const original = await adoption.inputValue();
    try {
      await adoption.fill(original === "50" ? "45" : "50");
      await expect(page.getByTestId("finance-save")).toBeEnabled();
      await page.getByTestId("finance-save").click(); // (the button is disabled while saving, so wait for the confirmation)
      await expect(page.getByTestId("finance-flash")).toContainText("Saved as the default financial model", { timeout: 20_000 });
      const app = await readCommandCenter(page);
      await page.goto("/app/finance");
      const fin = await readFinance(page);
      expect(fin.net).toBe(app.net);
      expect(fin.gross).toBe(app.opportunity);
      const x = await downloadWorkbook(page);
      expect(Math.round(x.net), "Excel downloaded from /app shows the same net savings as the page").toBe(app.net);
      expect(Math.round(x.realizable)).toBe(fin.realizable);
    } finally {
      await page.goto("/app/finance");
      if ((await adoption.inputValue()) !== original) {
        await adoption.fill(original);
        await page.getByTestId("finance-save").click();
        await expect(page.getByTestId("finance-flash")).toContainText("Saved as the default financial model", { timeout: 20_000 });
      }
    }
  });
});
