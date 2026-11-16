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
  // Focus returns to the triggering shortcut itself (the styled span is
  // the dialog's trigger control — a real tab stop, not a wrapper).
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

async function createCategoryViaUi(
  page: import("@playwright/test").Page,
  name: string
): Promise<void> {
  await page.goto("/settings/categories");
  await page.locator("#cat-name").fill(name);
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page.locator("li", { hasText: name }).first()).toBeVisible();
}

async function createTagViaUi(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.goto("/settings/tags");
  await page.locator("#tag-name").fill(name);
  await page.getByRole("button", { name: "Create tag" }).click();
  await expect(page.locator("li", { hasText: `#${name}` }).first()).toBeVisible();
}

test("dialog validation error preserves the whole expense draft", async ({ page }) => {
  const { accountA, accountB } = getData();
  await createCategoryViaUi(page, "Draft Category");
  await createTagViaUi(page, "drafttag");

  await page.goto(`/accounts/${accountA.id}`);
  await page.getByRole("button", { name: "+ New transaction" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();

  await dialog.locator("#account-txn-entry-account").selectOption(accountB.id);
  await dialog.locator("#account-txn-entry-date").fill("2026-01-15");
  // Over-precise for USD: passes HTML validation, the server rejects it.
  await dialog.locator("#account-txn-entry-amount").fill("123.456");
  await dialog.locator("#account-txn-entry-name").fill("Draft Keeper");
  await dialog.locator("#account-txn-entry-category").selectOption({ label: "Draft Category" });
  const categoryValue = await dialog.locator("#account-txn-entry-category").inputValue();
  expect(categoryValue).not.toBe("");
  await dialog.locator("#account-txn-entry-merchant").fill("Draft Merchant");
  await dialog.locator("#account-txn-entry-notes").fill("Draft notes survive");
  await dialog.getByRole("checkbox", { name: "drafttag" }).check();

  await dialog.getByRole("button", { name: "Record expense" }).click();

  // The server's refusal is shown and the dialog stays open…
  await expect(dialog.getByRole("alert")).toContainText(/precision/);
  await expect(dialog).toBeVisible();
  // …with EVERY entered field exactly as typed.
  await expect(dialog.locator("#account-txn-entry-account")).toHaveValue(accountB.id);
  await expect(dialog.locator("#account-txn-entry-date")).toHaveValue("2026-01-15");
  await expect(dialog.locator("#account-txn-entry-amount")).toHaveValue("123.456");
  await expect(dialog.locator("#account-txn-entry-name")).toHaveValue("Draft Keeper");
  await expect(dialog.locator("#account-txn-entry-category")).toHaveValue(categoryValue);
  await expect(dialog.locator("#account-txn-entry-merchant")).toHaveValue("Draft Merchant");
  await expect(dialog.locator("#account-txn-entry-notes")).toHaveValue("Draft notes survive");
  await expect(dialog.getByRole("checkbox", { name: "drafttag" })).toBeChecked();

  // Nothing was recorded.
  await page.keyboard.press("Escape");
  await expect(page.getByText("Draft Keeper")).toHaveCount(0);
});

test("dialog validation error preserves the whole transfer draft", async ({ page }) => {
  const { accountA, accountB } = getData();
  await page.goto(`/accounts/${accountA.id}`);
  await page.getByRole("button", { name: "Move money", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();

  await dialog.locator("#account-transfer-transfer-from").selectOption(accountB.id);
  await expect(dialog.locator("#account-transfer-transfer-to")).toHaveValue(accountA.id);
  await dialog.locator("#account-transfer-transfer-date").fill("2026-02-20");
  await dialog.locator("#account-transfer-transfer-amount").fill("99.999");
  await dialog.locator("#account-transfer-transfer-name").fill("Draft Transfer Note");

  await dialog.getByRole("button", { name: "Move money" }).click();

  await expect(dialog.getByRole("alert")).toContainText(/precision/);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#account-transfer-transfer-from")).toHaveValue(accountB.id);
  await expect(dialog.locator("#account-transfer-transfer-to")).toHaveValue(accountA.id);
  await expect(dialog.locator("#account-transfer-transfer-date")).toHaveValue("2026-02-20");
  await expect(dialog.locator("#account-transfer-transfer-amount")).toHaveValue("99.999");
  await expect(dialog.locator("#account-transfer-transfer-name")).toHaveValue(
    "Draft Transfer Note"
  );

  await page.keyboard.press("Escape");
  await expect(page.getByText("Draft Transfer Note")).toHaveCount(0);
});

test("dialog shortcut is Tab-reachable, opens with Enter and Space, focus returns on Escape", async ({
  page
}) => {
  const { accountA } = getData();
  await page.goto(`/accounts/${accountA.id}`);
  const trigger = page.getByRole("button", { name: "+ New transaction" });

  // Walk the tab order from the top of the page until the shortcut has
  // focus — it must be a real tab stop, not just programmatically
  // focusable.
  let reached = false;
  for (let i = 0; i < 120 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await trigger.evaluate((el) => el === document.activeElement).catch(() => false);
  }
  expect(reached).toBe(true);

  const dialog = page.locator("dialog[open]");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press(" ");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("dashboard: Quick add opens in a dialog and saves without leaving the dashboard", async ({
  page
}) => {
  const { accountA } = getData();
  await page.goto("/");
  const urlBefore = page.url();

  await page.getByRole("button", { name: /Quick add/ }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Amount").fill("11.25");
  await dialog.getByLabel("Description").fill("Quick Dialog Snack");
  await dialog.getByLabel("Account").selectOption(accountA.id);
  await dialog.getByRole("button", { name: "Save transaction" }).click();

  // Saved in place: dialog closed, still on the dashboard, entry visible.
  await expect(dialog).toBeHidden();
  expect(page.url()).toBe(urlBefore);
  await expect(page.getByText("Quick Dialog Snack").first()).toBeVisible();
});

test("dashboard: Quick add validation error preserves the whole draft", async ({ page }) => {
  const { accountB } = getData();
  await createCategoryViaUi(page, "Quick Draft Category");
  await createTagViaUi(page, "quickdrafttag");

  await page.goto("/");
  await page.getByRole("button", { name: /Quick add/ }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Account").selectOption(accountB.id);
  // Over-precise for USD: passes HTML validation, the server rejects it.
  await dialog.getByLabel("Amount").fill("123.456");
  await dialog.getByLabel("Description").fill("Quick Draft Keeper");
  await dialog.getByLabel(/Category/).selectOption({ label: "Quick Draft Category" });
  const categoryValue = await dialog.getByLabel(/Category/).inputValue();
  expect(categoryValue).not.toBe("");
  await dialog.getByRole("checkbox", { name: "quickdrafttag" }).check();

  await dialog.getByRole("button", { name: "Save transaction" }).click();

  // The server's refusal is shown and the dialog stays open…
  await expect(dialog.getByRole("alert")).toContainText(/precision/);
  await expect(dialog).toBeVisible();
  // …with EVERY entered field exactly as typed (the form is controlled;
  // an uncontrolled form would be reset by React when the action
  // resolves — account back to A, amount/name/category/tags cleared).
  await expect(dialog.getByLabel("Account")).toHaveValue(accountB.id);
  await expect(dialog.getByLabel("Amount")).toHaveValue("123.456");
  await expect(dialog.getByLabel("Description")).toHaveValue("Quick Draft Keeper");
  await expect(dialog.getByLabel(/Category/)).toHaveValue(categoryValue);
  await expect(dialog.getByRole("checkbox", { name: "quickdrafttag" })).toBeChecked();

  // Nothing was recorded.
  await page.keyboard.press("Escape");
  await expect(page.getByText("Quick Draft Keeper")).toHaveCount(0);
});

test("standalone Quick add: refusal preserves the draft, success resets for rapid entry", async ({
  page
}) => {
  const { accountB } = getData();
  await page.goto("/quick-add");

  await page.getByLabel("Account").selectOption(accountB.id);
  await page.getByLabel("Amount").fill("123.456");
  await page.getByLabel("Description").fill("Standalone Draft Keeper");
  await page.getByRole("button", { name: "Save transaction" }).click();

  // Scoped to the form's error paragraph: an unscoped getByRole("alert")
  // also matches Next's route announcer.
  await expect(page.locator("p[role='alert']")).toContainText(/precision/);
  await expect(page.getByLabel("Account")).toHaveValue(accountB.id);
  await expect(page.getByLabel("Amount")).toHaveValue("123.456");
  await expect(page.getByLabel("Description")).toHaveValue("Standalone Draft Keeper");

  // Correcting the amount and saving succeeds — and the rapid-entry
  // reset still clears the draft for the next entry.
  await page.getByLabel("Amount").fill("12.34");
  await page.getByRole("button", { name: "Save transaction" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Amount")).toHaveValue("");
  await expect(page.getByLabel("Description")).toHaveValue("");
  await expect(page).toHaveURL(/\/quick-add$/);
});

test("dashboard: cancelling Quick add writes nothing; the sidebar still opens the standalone page", async ({
  page
}) => {
  await page.goto("/");
  const urlBefore = page.url();

  await page.getByRole("button", { name: /Quick add/ }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Amount").fill("5.00");
  await dialog.getByLabel("Description").fill("Quick Cancel Ghost");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(page.url()).toBe(urlBefore);
  await expect(page.getByText("Quick Cancel Ghost")).toHaveCount(0);

  // The sidebar navigation item keeps opening the standalone page, whose
  // save flow still works as before (Saved flash, stays on /quick-add).
  await page.getByRole("link", { name: "Quick add" }).first().click();
  await expect(page).toHaveURL(/\/quick-add$/);
  await page.getByLabel("Amount").fill("3.50");
  await page.getByLabel("Description").fill("Standalone Snack");
  await page.getByRole("button", { name: "Save transaction" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/quick-add$/);
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
