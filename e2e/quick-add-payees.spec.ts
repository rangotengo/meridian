import { expect, test } from "@playwright/test";
import { authFile } from "./fixtures";

/**
 * Recent payee chips from descriptions (production build, real rendering).
 *
 * Regression (review #25 follow-up): Quick Add always saves
 * merchant:null, so recentPayees — derived from the stored merchant —
 * stayed empty for a Quick Add-only user and no payee chips ever
 * appeared. Payees now fall back to the entry description, and using a
 * chip refreshes that payee recency because the saved entry is the most
 * recent one carrying the name.
 */

test.use({ storageState: authFile("admin") });

test("Quick Add entries build recent payee chips from their descriptions", async ({ page }) => {
  await page.goto("/quick-add");
  const payees = page.getByLabel("Recent payees");
  await expect(payees).toBeVisible();
  // The seeded entry was saved by Quick Add-style input: a description
  // with no merchant. It must still produce a chip.
  await expect(payees.getByRole("button", { name: "E2E Groceries" })).toBeVisible();

  // Choosing the chip fills the description; saving refreshes recency.
  await payees.getByRole("button", { name: "E2E Groceries" }).click();
  await expect(page.locator('input[name="name"]')).toHaveValue("E2E Groceries");
  await page.locator('input[name="amount"]').fill("25.50");
  await page.getByRole("button", { name: "Save transaction" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  await page.reload();
  const chips = page.getByLabel("Recent payees").getByRole("button");
  await expect(chips.first()).toHaveText("E2E Groceries");

  // A brand-new Quick Add description becomes the first chip.
  await page.locator('input[name="name"]').fill("Corner Shop Test");
  await page.locator('input[name="amount"]').fill("10");
  await page.getByRole("button", { name: "Save transaction" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Recent payees").getByRole("button").first()).toHaveText(
    "Corner Shop Test"
  );
});
