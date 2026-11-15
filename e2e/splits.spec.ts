import { expect, test } from "@playwright/test";
import { authFile, data } from "./fixtures";

test.use({ storageState: authFile("admin") });

test("split a transaction into parts that total the original amount", async ({ page }) => {
  // Create the expense to split, through the real create form.
  await page.goto("/transactions/new");
  await page.locator("#accountId").selectOption(data.accountA.id);
  await page.locator("#amount").fill("100.00");
  await page.locator("#name").fill("E2E Split Me");
  await page.getByRole("button", { name: "Record expense" }).click();
  await expect(page).toHaveURL(/\/transactions$/);

  await page.getByRole("link", { name: "E2E Split Me" }).click();

  // Split it from the detail page dialog: 60 + 40 must total the 100.00.
  await page.getByText("Split into multiple items").click();
  await expect(page.getByRole("heading", { name: "Split transaction" })).toBeVisible();

  await page.locator("#part-0").fill("60");
  await page.locator("#part-name-0").fill("Split Part A");
  await page.locator("#part-1").fill("40");
  await page.locator("#part-name-1").fill("Split Part B");
  await expect(page.getByText(/Remaining:/)).toContainText("0.00");

  await page.getByRole("button", { name: "Create split" }).click();

  // The detail page now lists both split lines with their amounts.
  await expect(page.getByText("Split Part A")).toBeVisible();
  await expect(page.getByText("Split Part B")).toBeVisible();
  await expect(page.getByText("60.00")).toBeVisible();
  await expect(page.getByText("40.00")).toBeVisible();
});
