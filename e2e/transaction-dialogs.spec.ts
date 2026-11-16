import { expect, test } from "@playwright/test";
import { authFile, getData } from "./fixtures";

/**
 * Contextual transaction dialogs (PR B): the account-page and dashboard
 * shortcuts open the shared composer in a dialog on the SAME page, the
 * transfer form only offers compatible destinations, and the sharing UI
 * is hidden. The seeded household has two USD accounts (A, B); extra
 * accounts these specs need are created through the UI so the shared
 * seed stays untouched.
 */

test.use({ storageState: authFile("admin") });

async function createAccountViaUi(
  page: import("@playwright/test").Page,
  name: string,
  currency: string
): Promise<string> {
  await page.goto("/accounts/new");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.locator("#currency").selectOption(currency);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);
  return page.url().split("/").pop()!;
}

test("account page: New transaction dialog records an expense without navigating away", async ({
  page
}) => {
  const { accountA } = getData();
  await page.goto(`/accounts/${accountA.id}`);
  const urlBefore = page.url();
  const balanceBefore = await page.locator("p.text-3xl").innerText();

  await page.getByRole("button", { name: "+ New transaction" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "New transaction" })).toBeVisible();
  // The account is preselected.
  await expect(dialog.locator("#account-txn-entry-account")).toHaveValue(accountA.id);

  await dialog.locator("#account-txn-entry-amount").fill("10.00");
  await dialog.locator("#account-txn-entry-name").fill("Dialog Groceries");
  await dialog.getByRole("button", { name: "Record expense" }).click();

  // Dialog closed, same page, balance and activity updated in place.
  await expect(dialog).toBeHidden();
  expect(page.url()).toBe(urlBefore);
  await expect(page.getByText("Dialog Groceries")).toBeVisible();
  await expect(page.locator("p.text-3xl")).not.toHaveText(balanceBefore);
});

test("account page: Move money opens transfer mode with this account as From", async ({ page }) => {
  const { accountA, accountB } = getData();
  await page.goto(`/accounts/${accountA.id}`);
  const urlBefore = page.url();

  await page.getByRole("button", { name: "Move money", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "transfer" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(dialog.locator("#account-transfer-transfer-from")).toHaveValue(accountA.id);
  await expect(dialog.locator("#account-transfer-transfer-to")).toHaveValue(accountB.id);

  await dialog.locator("#account-transfer-transfer-amount").fill("15.00");
  await dialog.locator("#account-transfer-transfer-name").fill("Dialog Transfer");
  await dialog.getByRole("button", { name: "Move money" }).click();

  await expect(dialog).toBeHidden();
  expect(page.url()).toBe(urlBefore);
  await expect(page.getByText("Dialog Transfer").first()).toBeVisible();

  // The other leg landed on the destination account (atomic pair).
  await page.goto(`/accounts/${accountB.id}`);
  await expect(page.getByText("Dialog Transfer").first()).toBeVisible();
});

test("account page: Escape and Cancel write nothing and reset the form", async ({ page }) => {
  const { accountA } = getData();
  await page.goto(`/accounts/${accountA.id}`);

  await page.getByRole("button", { name: "+ New transaction" }).click();
  let dialog = page.locator("dialog[open]");
  await dialog.locator("#account-txn-entry-amount").fill("99.00");
  await dialog.locator("#account-txn-entry-name").fill("Escape Ghost");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Escape Ghost")).toHaveCount(0);
  // Focus returns to the triggering shortcut (its content element — the
  // display:contents wrapper button is unfocusable in Chromium).
  await expect(page.locator("span", { hasText: "+ New transaction" })).toBeFocused();

  await page.getByRole("button", { name: "+ New transaction" }).click();
  dialog = page.locator("dialog[open]");
  // Reopening resets stale values from the abandoned attempt.
  await expect(dialog.locator("#account-txn-entry-amount")).toHaveValue("");
  await dialog.locator("#account-txn-entry-amount").fill("98.00");
  await dialog.locator("#account-txn-entry-name").fill("Cancel Ghost");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Cancel Ghost")).toHaveCount(0);
});

test("transfer destinations follow the source currency and never degrade to an expense", async ({
  page
}) => {
  const { accountA, accountB } = getData();
  const euroId = await createAccountViaUi(page, "E2E Euro Wallet", "EUR");

  await page.goto(`/accounts/${accountA.id}`);
  await page.getByRole("button", { name: "Move money", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  const from = dialog.locator("#account-transfer-transfer-from");
  const to = dialog.locator("#account-transfer-transfer-to");

  // From A (USD): destinations are USD accounts other than A — B only,
  // never the EUR account and never A itself.
  const optionValues = await to
    .locator("option")
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  expect(optionValues).toContain(accountB.id);
  expect(optionValues).not.toContain(euroId);
  expect(optionValues).not.toContain(accountA.id);

  // Switch the source to the EUR account: no compatible destination
  // exists, the form explains why, submission is disabled, and the mode
  // stays Transfer (it must not silently become an expense).
  await from.selectOption(euroId);
  await expect(dialog.getByText("No compatible destination")).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "transfer" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(dialog.getByRole("button", { name: "Move money" })).toBeDisabled();

  // Switching back restores the compatible destination.
  await from.selectOption(accountA.id);
  await expect(dialog.locator("#account-transfer-transfer-to")).toHaveValue(accountB.id);
  await page.keyboard.press("Escape");
});

test("dashboard: Ledger entry dialog records a transaction in place", async ({ page }) => {
  const { accountA } = getData();
  await page.goto("/");
  const urlBefore = page.url();

  await page.getByRole("button", { name: /Ledger entry/ }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await dialog.locator("#dashboard-txn-entry-account").selectOption(accountA.id);
  await dialog.locator("#dashboard-txn-entry-amount").fill("7.50");
  await dialog.locator("#dashboard-txn-entry-name").fill("Dashboard Snack");
  await dialog.getByRole("button", { name: "Record expense" }).click();

  await expect(dialog).toBeHidden();
  expect(page.url()).toBe(urlBefore);
  await expect(page.getByText("Dashboard Snack").first()).toBeVisible();
});

test("direct entry URL still works and validates its parameters", async ({ page }) => {
  const { accountB } = getData();
  await page.goto(`/transactions/new?account=${accountB.id}&kind=transfer`);
  await expect(page.getByRole("tab", { name: "transfer" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.locator("#new-txn-transfer-from")).toHaveValue(accountB.id);

  // Garbage parameters fall back safely: expense mode, page renders.
  await page.goto("/transactions/new?account=not-a-uuid&kind=bogus");
  await expect(page.getByRole("heading", { name: "New transaction" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "expense" })).toHaveAttribute("aria-selected", "true");
});

test("account page shows no sharing UI while permissions keep working", async ({ page }) => {
  const { accountA } = getData();
  await page.goto(`/accounts/${accountA.id}`);
  await expect(page.getByRole("heading", { name: "Sharing" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
});

test("closed accounts hide the creation shortcuts", async ({ page }) => {
  const id = await createAccountViaUi(page, "E2E Closable", "USD");
  await page.getByText("Close account", { exact: true }).first().click();
  const confirm = page.locator("dialog[open]");
  await confirm.getByRole("button", { name: "Close account" }).click();
  await expect(page.getByRole("button", { name: "Reopen account" })).toBeVisible();

  await page.goto(`/accounts/${id}`);
  await expect(page.getByRole("button", { name: "+ New transaction" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move money", exact: true })).toHaveCount(0);
});

test.describe("read-only member", () => {
  test.use({ storageState: authFile("ro") });

  test("creation shortcuts and sharing UI are hidden", async ({ page }) => {
    const { accountA } = getData();
    await page.goto(`/accounts/${accountA.id}`);
    await expect(page.getByText("You have view-only access.")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New transaction" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Move money", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Sharing" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
  });
});
