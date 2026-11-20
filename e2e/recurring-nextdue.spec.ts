import { expect, test, type Page } from "@playwright/test";
import { authFile } from "./fixtures";

/**
 * Recurring summary prefers active series (production build, real UI).
 *
 * Regression (review #27 follow-up): the summary took the earliest
 * nextDue across ALL series, so a paused series with an early frozen
 * date presented itself as the next scheduled occurrence. Only active
 * series can supply the next scheduled occurrence.
 */

test.use({ storageState: authFile("admin") });

async function createSeries(
  page: Page,
  name: string,
  amount: string,
  nextDue: string
): Promise<void> {
  await page.locator("#recurring-name").fill(name);
  await page.locator("#recurring-amount").fill(amount);
  await page.locator("#recurring-next-due").fill(nextDue);
  await page.getByRole("button", { name: "Create series" }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}

test("recurring summary shows the next due date of the earliest active series", async ({
  page
}) => {
  await page.goto("/settings/recurring");
  await expect(page.locator("#recurring-name")).toBeVisible();

  await createSeries(page, "Active Rent", "100", "2026-12-05");
  await createSeries(page, "Paused Sub", "50", "2026-11-25");

  // Pause the earlier-dated series: its frozen date must stop counting.
  await page
    .locator("li", { hasText: "Paused Sub" })
    .getByRole("button", { name: "Pause" })
    .click();
  await expect(
    page.locator("li", { hasText: "Paused Sub" }).getByText("paused", { exact: true })
  ).toBeVisible();

  // The summary only renders once collapsed, on the next visit.
  await page.reload();
  await expect(page.getByText("next due 2026-12-05")).toBeVisible();
  await expect(page.getByText("next due 2026-11-25")).toHaveCount(0);
});
