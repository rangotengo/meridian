import { expect, test } from "@playwright/test";
import { authFile } from "./fixtures";

/**
 * Statement CSV import, finding (a) (real UI, production build).
 *
 * Regression: the mapping selects stayed editable after preview, but the
 * confirm form submitted the CURRENT mapping while the visible preview was
 * computed from the old one — swapping debit/credit after preview imported
 * reversed directions. Start over also cleared only local fields and left
 * the old parse/preview usable. The preview (and its Import button) must
 * now disappear the moment the mapping changes, until Preview is run again.
 */

test.use({ storageState: authFile("admin") });

const CSV = [
  "Date,Particulars,Debit,Credit,Balance",
  "01/11/2026,ATM Withdrawal,5000,,95000",
  "02/11/2026,Salary,,20000,115000"
].join("\n");

async function parseAndPreview(page: import("@playwright/test").Page) {
  await page.goto("/transactions/import-csv");
  await page.getByLabel("Or paste the CSV").fill(CSV);
  await page.getByRole("button", { name: "Parse statement" }).click();
  await expect(page.getByLabel("Debit column")).toBeVisible();
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByRole("button", { name: "Import 2 transactions" })).toBeVisible();
}

test("swapping debit/credit after preview hides the import until re-preview", async ({ page }) => {
  await parseAndPreview(page);

  const atmRow = page.getByRole("row", { name: /ATM Withdrawal/ });
  await expect(atmRow).toContainText("$5,000.00");
  await expect(atmRow).not.toContainText("-$5,000.00");

  // Swap the mapping: debit now reads the Credit column and vice versa.
  await page.getByLabel("Debit column").selectOption("3");
  await page.getByLabel("Credit column").selectOption("2");

  // The stale preview and its Import button must be gone, with a notice.
  await expect(page.getByRole("button", { name: /Import \d+ transactions?/ })).toHaveCount(0);
  await expect(page.getByText("The preview is out of date")).toBeVisible();
  await expect(page.getByRole("row", { name: /ATM Withdrawal/ })).toHaveCount(0);

  // Re-preview under the swapped mapping: directions are reversed.
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByRole("button", { name: "Import 2 transactions" })).toBeVisible();
  await expect(page.getByRole("row", { name: /ATM Withdrawal/ })).toContainText("-$5,000.00");
  await expect(page.getByRole("row", { name: /Salary/ })).toContainText("$20,000.00");
});

test("start over clears the parse and the preview", async ({ page }) => {
  await parseAndPreview(page);

  await page.getByRole("button", { name: "Start over" }).click();

  await expect(page.getByLabel("Debit column")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Import \d+ transactions?/ })).toHaveCount(0);
  await expect(page.getByText("The preview is out of date")).toHaveCount(0);
  await expect(page.getByLabel("Account")).toBeEnabled();
  await expect(page.getByLabel("Or paste the CSV")).toBeEmpty();
});
