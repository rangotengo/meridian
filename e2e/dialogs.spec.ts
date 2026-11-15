import { expect, test } from "@playwright/test";
import { authFile, getData } from "./fixtures";

test.use({ storageState: authFile("admin") });

test("modal dialogs render centered in the viewport", async ({ page }) => {
  // Regression: Tailwind v4's preflight resets the native <dialog> element's
  // UA `margin: auto`, which pinned modal dialogs to the top-left corner.
  // The shared ds Dialog restores centering with the `m-auto` utility.
  await page.goto(`/accounts/${getData().accountA.id}`);

  await page.getByText("Close account", { exact: true }).first().click();

  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("heading", { name: "Close this account?" })).toBeVisible();

  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();

  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;
  expect(Math.abs(centerX - viewport!.width / 2)).toBeLessThan(24);
  expect(Math.abs(centerY - viewport!.height / 2)).toBeLessThan(24);
});
