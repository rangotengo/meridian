import { expect, test } from "@playwright/test";
import { authFile } from "./fixtures";

/**
 * Debt payoff privacy (real UI, production build).
 *
 * Regression: LoanCard masked "Still owed", but PlanSummary always
 * rendered total interest / total paid, and the interest-saved sentence
 * rendered unmasked amounts. With privacy on, entering a monthly payment
 * revealed derived debt totals. The toggle is exercised AFTER a plan is
 * visible, and restored afterwards so other specs keep amounts visible.
 */

test.use({ storageState: authFile("admin") });

test("payoff summaries mask all amounts when privacy is toggled on", async ({ page }) => {
  await page.goto("/accounts/new");
  await page.getByText("Other liability", { exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("E2E Privacy Loan");
  await page.getByLabel("Opening balance owed").fill("1200.00");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);
  const accountId = page.url().split("/").pop()!;

  await page.goto("/debts");
  const card = page.locator(`[data-testid="loan-${accountId}"]`);
  await expect(card.getByText("E2E Privacy Loan")).toBeVisible();

  await card.getByLabel("Annual interest rate (%)").fill("12");
  await card.getByRole("button", { name: "Save rate" }).click();
  await expect(card.getByText("12.00% APR")).toBeVisible();

  await card.getByLabel(/Monthly payment/).fill("100");
  await card.getByLabel(/Extra per month/).fill("50");
  await expect(card.getByText("Current payment")).toBeVisible();
  await expect(card.getByText("With extra payment")).toBeVisible();

  const interestCells = card
    .locator("dt", { hasText: "Total interest" })
    .locator("xpath=following-sibling::dd");
  const paidCells = card
    .locator("dt", { hasText: "Total paid" })
    .locator("xpath=following-sibling::dd");
  const savings = card.getByText(/saves .* of interest/);
  await expect(interestCells.first()).not.toHaveText("••••");
  await expect(savings).toContainText("$");

  // Toggle privacy on while the plan is visible: every amount masks.
  await page.getByRole("button", { name: "Toggle privacy mode" }).click();
  await expect(interestCells.first()).toHaveText("••••");
  await expect(interestCells.nth(1)).toHaveText("••••");
  await expect(paidCells.first()).toHaveText("••••");
  await expect(paidCells.nth(1)).toHaveText("••••");
  await expect(savings).toContainText("••••");
  await expect(savings).not.toContainText("$");
  await expect(card.getByText("Still owed").locator("..")).toContainText("••••");

  // Restore amounts-visible for the other specs.
  await page.getByRole("button", { name: "Toggle privacy mode" }).click();
  await expect(interestCells.first()).not.toHaveText("••••");
  await expect(savings).toContainText("$");
});
