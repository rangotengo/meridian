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
  await expect(page.getByText(getData().entry.name).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
