import { expect, test } from "@playwright/test";
import { authFile } from "./fixtures";

/**
 * SMS import preview staleness (real UI, production build).
 *
 * Regression: the preview card stayed on screen after the SMS text was
 * edited, while the confirm form submitted the edited text together with
 * the old preview's values — so an expense preview could record an
 * income SMS. The preview (and its record button) must disappear the
 * moment the text or sender changes, until the SMS is parsed again.
 */

test.use({ storageState: authFile("admin") });

const EXPENSE_SMS = "Your account XX1234 debited NPR 100.00 at Store";
const INCOME_SMS = "Your account XX1234 credited NPR 200.00 from Salary";

test("editing the SMS after preview hides the record button until re-parse", async ({ page }) => {
  await page.goto("/transactions/import-sms");
  await page.locator('textarea[name="rawSms"]').fill(EXPENSE_SMS);
  await page.getByRole("button", { name: "Parse SMS" }).click();

  await expect(page.getByRole("heading", { name: "Parsed SMS" })).toBeVisible();
  await expect(page.getByText("Money out")).toBeVisible();
  await expect(page.getByRole("button", { name: "Record transaction" })).toBeVisible();

  // Edit the text: the stale preview and its record button must go, and a
  // re-parse notice must appear instead.
  await page.locator('textarea[name="rawSms"]').fill(INCOME_SMS);
  await expect(page.getByText("The SMS text changed since this preview.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Parsed SMS" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Record transaction" })).toHaveCount(0);

  // Re-parse: the preview refreshes to the income SMS and recording returns.
  await page.getByRole("button", { name: "Parse SMS" }).click();
  await expect(page.getByRole("heading", { name: "Parsed SMS" })).toBeVisible();
  await expect(page.getByText("Money in")).toBeVisible();
  await expect(page.getByRole("button", { name: "Record transaction" })).toBeVisible();
});

test("re-parse keeps Record hidden until the new response arrives", async ({ page }) => {
  await page.goto("/transactions/import-sms");
  await page.locator('textarea[name="rawSms"]').fill(EXPENSE_SMS);
  await page.getByRole("button", { name: "Parse SMS" }).click();
  await expect(page.getByText("Money out")).toBeVisible();
  await page.locator('textarea[name="rawSms"]').fill(INCOME_SMS);
  let release = () => {};
  let received = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route("**/transactions/import-sms", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "Parse SMS" }).click();
    await arrived;
    await expect(page.getByRole("button", { name: "Record transaction" })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByText("Money in")).toBeVisible();
});
