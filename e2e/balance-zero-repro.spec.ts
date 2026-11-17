import { expect, test } from "@playwright/test";
import { authFile, getData } from "./fixtures";

// Regression spec for the report that account balances display 0 after the
// UI polish. The seed gives E2E Checking a $0 opening balance and one
// $120 expense, so its real balance is -$120.00. If the accounts page (or
// dashboard) renders $0.00 for it, the balance read/render path is broken.
test.use({ storageState: authFile("admin") });

test("accounts page shows the real (nonzero) balance for E2E Checking", async ({ page }) => {
  await page.goto("/accounts");
  const card = page.locator("a", { hasText: getData().accountA.name }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("-$120.00");
  await page.screenshot({ path: "e2e/screenshots/balance-repro-accounts-desktop.png" });
  // Persisted refresh: the same balance must survive a reload.
  await page.reload();
  const reloaded = page.locator("a", { hasText: getData().accountA.name }).first();
  await expect(reloaded).toContainText("-$120.00");
});

test("dashboard net worth reflects the same nonzero balance", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Net Worth").first()).toBeVisible();
  await expect(page.locator("body")).toContainText("-$120.00");
});
