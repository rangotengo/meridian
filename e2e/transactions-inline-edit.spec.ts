import { expect, test, type Page } from "@playwright/test";
import { authFile, getData } from "./fixtures";

/**
 * Transactions list: inline edit and bulk recategorise. Rows are created
 * through the account-page dialog so the shared seed stays untouched, and
 * each test uses its own names — tests in this file share one database and
 * run in order, so a rename in one test must not break the next. Names are
 * also unique per run: the e2e database is shared across runs, so a fixed
 * name would match rows created by an earlier run.
 */

test.use({ storageState: authFile("admin") });

async function ensureCategory(page: Page, name: string): Promise<void> {
  await page.goto("/settings/categories");
  if ((await page.locator("ul li", { hasText: name }).count()) === 0) {
    await page.locator("#cat-name").fill(name);
    await page.getByRole("button", { name: "Create category", exact: true }).click();
  }
  await expect(page.locator("ul li", { hasText: name }).first()).toBeVisible();
}

async function createTxnViaUi(page: Page, name: string): Promise<void> {
  const { accountA } = getData();
  await page.goto(`/accounts/${accountA.id}`);
  await page.getByRole("button", { name: "+ New transaction" }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.locator("#account-txn-entry-amount").fill("10.00");
  await dialog.locator("#account-txn-entry-name").fill(name);
  await dialog.getByRole("button", { name: "Record expense" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(name)).toBeVisible();
}

test("inline edit updates description, category and merchant in place", async ({ page }) => {
  const stamp = Math.random().toString(36).slice(2, 8);
  const before = `Inline Edit One ${stamp}`;
  const after = `Inline Edit Renamed ${stamp}`;
  await ensureCategory(page, "Inline Groceries");
  await createTxnViaUi(page, before);

  await page.goto("/transactions");
  await page.getByRole("button", { name: `Edit ${before}`, exact: true }).click();

  // The inline form is the only form with a Save button on this page.
  const form = page.locator("form", {
    has: page.getByRole("button", { name: "Save", exact: true })
  });
  await form.getByLabel("Description").fill(after);
  await form.getByLabel("Category").selectOption({ label: "Inline Groceries" });
  await form.getByLabel("Merchant").fill("Corner Shop");
  await form.getByRole("button", { name: "Save", exact: true }).click();

  // The form closes on success and the row shows the new values.
  await expect(form).toBeHidden();
  await expect(page.getByText(before, { exact: true })).toHaveCount(0);
  const row = page.locator("tr", { hasText: after });
  await expect(row.getByText("Inline Groceries")).toBeVisible();
  await expect(row.getByText("Corner Shop")).toBeVisible();
});

test("bulk recategorise applies a category to the selected rows", async ({ page }) => {
  const stamp = Math.random().toString(36).slice(2, 8);
  const first = `Inline Bulk One ${stamp}`;
  const second = `Inline Bulk Two ${stamp}`;
  await ensureCategory(page, "Inline Groceries");
  await createTxnViaUi(page, first);
  await createTxnViaUi(page, second);

  await page.goto("/transactions");
  // Rows render twice on this page (desktop table + hidden mobile list),
  // so scope the checkboxes to the table to get exactly one match.
  const table = page.locator("table");
  await table.getByLabel(`Select ${first}`).check();
  await table.getByLabel(`Select ${second}`).check();
  await expect(page.getByText("2 selected on this page")).toBeVisible();

  await page
    .getByLabel("Category for selected transactions")
    .selectOption({ label: "Inline Groceries" });
  await page.getByRole("button", { name: "Apply to 2", exact: true }).click();

  await expect(page.getByText("Updated 2 transactions.")).toBeVisible();
  const rowA = page.locator("tr", { hasText: first });
  const rowB = page.locator("tr", { hasText: second });
  await expect(rowA.getByText("Inline Groceries")).toBeVisible();
  await expect(rowB.getByText("Inline Groceries")).toBeVisible();
});

test.describe("read-only member", () => {
  test.use({ storageState: authFile("ro") });

  test("no inline Edit buttons on rows the member cannot annotate", async ({ page }) => {
    await page.goto("/transactions");
    await expect(page.getByRole("link", { name: "E2E Groceries" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
  });
});
