import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import { aiEmployeeByPersona } from "./db";

/** A realistic over-threshold vendor invoice: approved vendor + open PO from the Gulf Coast AI Brain demo content. */
export function overThresholdInvoice(invNo: string) {
  return [
    "Gulfline Electrical", "4410 Industrial Pkwy, Houston, TX 77029", "INVOICE",
    `Invoice Number: ${invNo}     Invoice Date: Nov 2, 2026`,
    "Purchase Order: PO-24-1194     Terms: Net 45     Due Date: Dec 17, 2026", "",
    "Description                         Qty   Unit Price      Amount",
    "200A main breaker panelboard          4    $1,285.00   $5,140.00",
    "THHN copper wire 500 ft spool        10      $250.00   $2,500.00", "",
    "Subtotal                                               $7,640.00",
    "Tax                                                       $0.00",
    "Total                                                  $7,640.00",
  ].join("\n");
}

/**
 * Makes sure Charlotte (Gulf Coast's AI AP specialist) is in Pilot at act_with_approval, through the real UI as the owner
 * (sandbox demo → Start pilot → raise permission twice with explicit confirmation). No-op when already there.
 */
export async function ensureCharlotteLive(owner: Page, orgId: string): Promise<string> {
  let e = (await aiEmployeeByPersona(orgId, "charlotte"))!;
  if (!["pilot", "active"].includes(e.status)) {
    await owner.goto(`/app/workforce/${e.id}?tab=demo`);
    await owner.getByTestId("demo-run").click();
    await expect(owner.getByTestId("demo-result")).toBeVisible({ timeout: 60_000 });
    await owner.goto(`/app/workforce/${e.id}?tab=customize`);
    if (e.status === "draft") { await owner.getByTestId("st-sandbox").click(); await expect(owner.locator("main")).toContainText("Status: sandbox"); }
    await owner.getByTestId("st-pilot").click();
    await expect(owner.locator("main")).toContainText("Status: pilot");
    e = (await aiEmployeeByPersona(orgId, "charlotte"))!;
  }
  const order = ["read_only", "draft_only", "act_with_approval"];
  for (const level of order.slice(order.indexOf(e.permissionLevel) + 1)) {
    await owner.goto(`/app/workforce/${e.id}?tab=customize`);
    await owner.getByTestId(`perm-${level}`).click();
    await owner.getByTestId("perm-confirm").check();
    await owner.getByTestId("perm-apply").click();
    await expect(owner.getByTestId(`perm-${level}`)).toHaveAttribute("aria-checked", "true");
  }
  return e.id;
}
