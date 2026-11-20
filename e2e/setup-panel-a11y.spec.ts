import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { authFile } from "./fixtures";

/**
 * SetupPanel aria-controls always resolves (production build, real UI).
 *
 * Regression (review #27 follow-up): while collapsed, the toggle
 * button's aria-controls pointed at the panel id, but the panel
 * container was only rendered when expanded — the id did not exist in
 * the document. The container now stays in the DOM while collapsed
 * (hidden and empty); the setup form itself still unmounts on collapse.
 *
 * The recurring settings page exercises the shared SetupPanel. The
 * panel may already be collapsed on arrival if another spec created a
 * series first, so the test expands it before using the create form.
 */

test.use({ storageState: authFile("admin") });

test("collapsed SetupPanel keeps its container so aria-controls resolves", async ({ page }) => {
  await page.goto("/settings/recurring");
  const editSetup = page.getByRole("button", { name: "Edit setup" });
  if ((await editSetup.count()) > 0) {
    await editSetup.click();
  }
  await expect(page.locator("#recurring-name")).toBeVisible();

  await page.locator("#recurring-name").fill("A11y Rent");
  await page.locator("#recurring-amount").fill("100");
  await page.locator("#recurring-next-due").fill("2026-12-10");
  await page.getByRole("button", { name: "Create series" }).click();
  await expect(page.getByText("A11y Rent").first()).toBeVisible();

  // The summary row is the default on the next visit: collapsed.
  await page.reload();

  const panel = page.locator("#recurring-setup-panel");
  await expect(panel).toHaveCount(1);
  await expect(panel).toBeHidden();
  await expect(editSetup).toBeVisible();
  await expect(editSetup).toHaveAttribute("aria-controls", "recurring-setup-panel");
  await expect(editSetup).toHaveAttribute("aria-expanded", "false");

  // axe must not report the dangling aria-controls reference.
  const results = await new AxeBuilder({ page }).analyze();
  const dangling = results.violations.filter((v) => v.id === "aria-valid-attr-value");
  expect(dangling.map((v) => v.nodes.map((n) => n.html))).toEqual([]);

  // Expand and collapse again: the same container is reused.
  await editSetup.click();
  await expect(panel).toBeVisible();
  const collapse = page.getByRole("button", { name: "Collapse" });
  await expect(collapse).toBeVisible();
  await expect(collapse).toHaveAttribute("aria-controls", "recurring-setup-panel");
  await expect(collapse).toHaveAttribute("aria-expanded", "true");

  await collapse.click();
  await expect(panel).toHaveCount(1);
  await expect(panel).toBeHidden();
  await expect(editSetup).toBeVisible();
});
