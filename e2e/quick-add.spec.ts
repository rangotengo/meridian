import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { authFile } from "./fixtures";

/**
 * Quick Add control sizing (production build, real rendering).
 *
 * Regression: the shared ds controls fix their height (`h-8`) while
 * Quick Add added `py-3`, so the content box shrank below the text
 * line-height and the selected value was clipped. Quick Add now uses
 * the "comfortable" density (height, padding, and line-height set
 * together) and these tests measure the rendered controls — a build
 * passing is not evidence the text fits.
 */

test.use({ storageState: authFile("admin") });

const SHOTS = path.join(process.cwd(), "e2e", "screenshots");
mkdirSync(SHOTS, { recursive: true });

type Metrics = {
  height: number;
  contentBox: number;
  lineHeight: number;
  backgroundImage: string;
  opacity: string;
  selectedText: string;
};

async function metrics(locator: Locator): Promise<Metrics> {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el as HTMLElement);
    const rect = (el as HTMLElement).getBoundingClientRect();
    const contentBox = rect.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const select = el as HTMLSelectElement;
    return {
      height: rect.height,
      contentBox,
      lineHeight: parseFloat(cs.lineHeight),
      backgroundImage: cs.backgroundImage,
      opacity: cs.opacity,
      selectedText: select.selectedOptions?.[0]?.textContent?.trim() ?? ""
    };
  });
}

/** The core anti-clipping invariant: the content box fits the line box. */
async function expectUnclipped(locator: Locator) {
  const m = await metrics(locator);
  expect(m.height).toBeGreaterThanOrEqual(40); // comfortable density = 44px
  expect(m.contentBox).toBeGreaterThanOrEqual(m.lineHeight);
  return m;
}

async function expectQuickAddControls(page: Page) {
  const account = page.locator('select[name="accountId"]');
  const category = page.locator('select[name="categoryId"]');
  const description = page.locator('input[name="name"]');

  const accountMetrics = await expectUnclipped(account);
  // The default selection is the first listed account (list order is the
  // app's own; don't hardcode which account that is).
  const firstOption = await account.evaluate(
    (el) => (el as HTMLSelectElement).options[0]?.textContent?.trim() ?? ""
  );
  expect(firstOption.length).toBeGreaterThan(0);
  expect(accountMetrics.selectedText).toBe(firstOption);
  // Native selects show a visible dropdown indicator in both themes.
  expect(accountMetrics.backgroundImage).toContain("data:image/svg+xml");

  const categoryMetrics = await expectUnclipped(category);
  // A readable label, not an apparently blank field.
  expect(categoryMetrics.selectedText).toBe("Uncategorized");

  await expectUnclipped(description);
  return { account, category, description };
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => {
    document.cookie = `theme=${value}; path=/; max-age=31536000; samesite=lax`;
  }, theme);
  await page.reload();
  await expect(page.locator('select[name="accountId"]')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(theme === "dark");
}

test("quick add selects render fully in light and dark, desktop and mobile", async ({ page }) => {
  await page.goto("/quick-add");

  await expectQuickAddControls(page);
  await page.screenshot({ path: path.join(SHOTS, "quick-add-light-desktop.png") });

  await setTheme(page, "dark");
  await expectQuickAddControls(page);
  await page.screenshot({ path: path.join(SHOTS, "quick-add-dark-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await expectQuickAddControls(page);
  await page.screenshot({ path: path.join(SHOTS, "quick-add-dark-mobile.png") });

  await setTheme(page, "light");
  await expectQuickAddControls(page);
  await page.screenshot({ path: path.join(SHOTS, "quick-add-light-mobile.png") });
});

test("a long account name stays vertically readable in the comfortable select", async ({
  page
}) => {
  await page.goto("/quick-add");
  const account = page.locator('select[name="accountId"]');
  // Exercise the control's rendering with a long value (layout check,
  // not app data): the line box must still fit the content box.
  await account.evaluate((el) => {
    const select = el as HTMLSelectElement;
    const option = document.createElement("option");
    option.value = "long";
    option.textContent = "A Very Long Joint Family Account Name — Kathmandu Branch 0042";
    select.appendChild(option);
    select.value = "long";
  });
  const m = await expectUnclipped(account);
  expect(m.selectedText).toContain("Very Long Joint Family Account");
  await page.screenshot({ path: path.join(SHOTS, "quick-add-long-name.png") });
});

test("keyboard selection and disabled styling on the shared controls", async ({ page }) => {
  await page.goto("/quick-add");
  const account = page.locator('select[name="accountId"]');
  await expect(account).toHaveValue(/.+/);

  // Keyboard: focus the select and use type-ahead to reach "E2E Savings".
  await account.focus();
  await page.keyboard.type("E2E S");
  await expect
    .poll(() =>
      account.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim())
    )
    .toBe("E2E Savings");

  // Disabled controls keep the shared muted styling and their full height.
  await account.evaluate((el) => ((el as HTMLSelectElement).disabled = true));
  const m = await metrics(account);
  expect(Number(m.opacity)).toBeLessThan(1);
  expect(m.height).toBeGreaterThanOrEqual(40);
  await page.screenshot({ path: path.join(SHOTS, "quick-add-disabled.png") });
});

test("compact settings selects keep their 32px dimensions", async ({ page }) => {
  // The density audit: settings forms stay on the compact variant.
  await page.goto("/settings");
  const box = await page.locator("#s-theme").boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.height)).toBe(32);
});
