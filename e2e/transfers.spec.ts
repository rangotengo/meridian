import { expect, test } from "@playwright/test";
import { authFile, getData } from "./fixtures";

test.use({ storageState: authFile("admin") });

test("create a transfer between two accounts and see both legs linked", async ({ page }) => {
  await page.goto("/transactions/new");

  await page.getByRole("tab", { name: "transfer" }).click();
  await page.locator("#fromAccountId").selectOption(getData().accountA.id);
  await page.locator("#toAccountId").selectOption(getData().accountB.id);
  await page.locator("#t-amount").fill("25.00");
  await page.locator("#t-name").fill("E2E Transfer");
  await page.getByRole("button", { name: "Move money" }).click();

  await expect(page).toHaveURL(/\/transactions$/);

  // Both legs of the transfer appear in the list under the same name.
  const legs = page.getByRole("link", { name: "E2E Transfer" });
  await expect(legs).toHaveCount(2);

  // Opening one leg shows it linked to the other account.
  await legs.first().click();
  await expect(page.getByText(/Linked with/)).toBeVisible();
  await expect(page.getByText(/E2E (Checking|Savings)/).first()).toBeVisible();
  // Date and amount are locked while the entry is linked.
  await expect(page.locator("#d-amount")).toBeDisabled();
});
