import { expect, test, type Page } from "@playwright/test";
import { authFile, getData } from "./fixtures";

// Runs in the "mobile" project (390px-wide viewport, touch enabled).
test.use({ storageState: authFile("admin") });

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

test("dashboard renders at 390px without horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Net Worth").first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("transactions render at 390px without horizontal overflow", async ({ page }) => {
  await page.goto("/transactions");
  // The list renders twice in the DOM (desktop table + mobile stacked
  // list, one hidden per breakpoint), so assert on the visible instance.
  await expect(page.locator("a:visible", { hasText: getData().entry.name }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("accounts render the real balance at 390px without horizontal overflow", async ({ page }) => {
  await page.goto("/accounts");
  // Seeded E2E Checking: $0 opening + $120 expense = -$120.00. A $0.00
  // rendering here would be the reported zero-balance bug.
  await expect(
    page.locator("a:visible", { hasText: getData().accountA.name }).first()
  ).toContainText("-$120.00");
  await expectNoHorizontalOverflow(page);
});
