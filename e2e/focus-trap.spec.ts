import { expect, test, type Page } from "@playwright/test";
import { authFile, getData } from "./fixtures";

test.use({ storageState: authFile("admin") });

/**
 * Focus traps and visible keyboard focus:
 * - the command palette (Base UI dialog) must keep Tab inside it and
 *   focus its search input on open;
 * - the shared ds Dialog (native <dialog>) must keep Tab inside it and
 *   return focus to its trigger on Escape;
 * - raw form controls with no component-level focus style (the Sure
 *   export file input) must show the base :focus-visible ring.
 */

async function activeElementInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    return !!root && root.contains(document.activeElement);
  }, selector);
}

/**
 * The dashboard renders server-side before React hydrates, so a keypress
 * or click issued right after the first paint can land before the client
 * handlers are attached. Retry the open action until it takes effect
 * instead of assuming hydration is done.
 */
async function openPalette(page: Page) {
  const input = page.getByPlaceholder("Type a command or search...");
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Control+k");
    if (await input.isVisible().catch(() => false)) return input;
    await page.waitForTimeout(400);
  }
  await expect(input).toBeVisible();
  return input;
}

async function openCloseAccountDialog(page: Page) {
  const trigger = page.getByText("Close account", { exact: true }).first();
  const dialog = page.locator("dialog[open]");
  for (let i = 0; i < 4; i++) {
    await trigger.click();
    if (await dialog.isVisible().catch(() => false)) return { trigger, dialog };
    await page.waitForTimeout(400);
  }
  await expect(dialog).toBeVisible();
  return { trigger, dialog };
}

test("command palette traps Tab focus and focuses its search input", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Net Worth").first()).toBeVisible();

  const input = await openPalette(page);
  await expect(input).toBeFocused();

  // Base UI's focus manager bounces Tab off a sentinel span placed
  // outside the popup and back inside; assert the settled state, not
  // the transient sentinel stop.
  const settledInside = async () => {
    await expect
      .poll(() => activeElementInside(page, '[role="dialog"]'), {
        timeout: 1000
      })
      .toBe(true);
  };
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    await settledInside();
  }
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Shift+Tab");
    await settledInside();
  }

  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
});

test("native dialog traps Tab focus and returns focus to its trigger", async ({ page }) => {
  await page.goto(`/accounts/${getData().accountA.id}`);
  await page.waitForLoadState("networkidle");

  const { trigger, dialog } = await openCloseAccountDialog(page);
  await expect(page.getByRole("heading", { name: "Close this account?" })).toBeVisible();

  expect(await activeElementInside(page, "dialog[open]")).toBe(true);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await activeElementInside(page, "dialog[open]")).toBe(true);
  }
  // Reverse wrap: Shift+Tab from the first stop lands on the last.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await activeElementInside(page, "dialog[open]")).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("raw file input shows a visible focus ring on keyboard focus", async ({ page }) => {
  await page.goto("/settings/data");
  await page.waitForLoadState("networkidle");
  const fileInput = page.locator('input[name="sureExport"]');
  await expect(fileInput).toBeVisible();

  // Tab from the top until it is focused: keyboard modality is what
  // makes :focus-visible apply, so a programmatic .focus() would not
  // exercise the rule.
  for (let i = 0; i < 80; i++) {
    if (await fileInput.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(fileInput).toBeFocused();

  const outline = await fileInput.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: cs.outlineWidth, style: cs.outlineStyle };
  });
  expect(outline.style).toBe("solid");
  expect(parseFloat(outline.width)).toBeGreaterThan(0);
});
