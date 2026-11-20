import { expect, test } from "@playwright/test";
import path from "node:path";
import { authFile } from "./fixtures";

/**
 * SSIS setup collapse: the large setup panel (refresh / snapshot import /
 * BO account number) collapses to a one-line summary once setup is
 * complete (BO account configured AND data present), and stays expanded
 * while setup is incomplete. The seeded household starts with no SSIS
 * data, so the first test sees the expanded panel and the second completes
 * setup through the real forms, then reloads to see the collapsed default.
 *
 * Tests in this file run in declaration order and share the seeded
 * household; no other spec touches SSIS state.
 */

test.use({ storageState: authFile("admin") });

const BO_ACCOUNT_NO = "1301000011112222";
const SNAPSHOT = path.join(process.cwd(), "e2e", "fixtures", "ssis-snapshot.json");

test("incomplete SSIS setup stays expanded with no collapse control", async ({ page }) => {
  await page.goto("/insights/ssis");

  await expect(
    page.getByRole("heading", { name: "Refresh from Siddhartha Capital" })
  ).toBeVisible();
  await expect(page.locator('input[name="boAccountNo"]')).toBeVisible();
  await expect(page.locator('input[name="snapshot"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit setup" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Collapse" })).toHaveCount(0);
  await expect(page.getByText("No SSIS data yet")).toBeVisible();
});

test("completed setup collapses to a summary row; Edit setup expands and Collapse collapses again", async ({
  page
}) => {
  await page.goto("/insights/ssis");

  // Configure the BO account through the real form.
  await page.locator('input[name="boAccountNo"]').fill(BO_ACCOUNT_NO);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Saved\./)).toBeVisible();

  // Import the snapshot through the real form (3 purchases, 2 statement
  // rows; the fixture's malformed rows are skipped by the importer).
  await page.locator('input[name="snapshot"]').setInputFiles(SNAPSHOT);
  await page.getByRole("button", { name: "Import snapshot" }).click();
  await expect(page.getByText(/Updated 3 purchases · 2 statement rows/)).toBeVisible();

  // The panel stays open for this visit so the confirmation stays visible;
  // the collapsed summary is the default on the next visit.
  await page.reload();

  const editSetup = page.getByRole("button", { name: "Edit setup" });
  await expect(editSetup).toBeVisible();
  await expect(editSetup).toHaveAttribute("aria-expanded", "false");
  // The collapsed panel keeps its container (hidden) so the toggle's
  // aria-controls resolves; the setup forms stay unmounted.
  await expect(editSetup).toHaveAttribute("aria-controls", "ssis-setup-panel");
  const panel = page.locator("#ssis-setup-panel");
  await expect(panel).toHaveCount(1);
  await expect(panel).toBeHidden();
  await expect(page.getByRole("heading", { name: "SSIS setup" })).toBeVisible();
  await expect(page.getByText(/BO account ••••2222/)).toBeVisible();
  await expect(page.getByText(/3 purchases · 2 statement rows/)).toBeVisible();
  await expect(page.locator('input[name="boAccountNo"]')).toHaveCount(0);
  // The insight itself is still on the page below the summary row.
  await expect(page.getByText("Total Units")).toBeVisible();

  // Keyboard: focus the toggle and open with Enter.
  await editSetup.focus();
  await page.keyboard.press("Enter");
  const collapse = page.getByRole("button", { name: "Collapse" });
  await expect(collapse).toBeVisible();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('input[name="boAccountNo"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh now" })).toBeVisible();
  await expect(page.locator("#ssis-setup-panel")).toBeVisible();

  // Collapse again; the summary row returns and the forms leave the page.
  await collapse.click();
  await expect(page.getByRole("button", { name: "Edit setup" })).toBeVisible();
  await expect(page.locator('input[name="boAccountNo"]')).toHaveCount(0);
  await expect(page.locator("#ssis-setup-panel")).toHaveCount(1);
  await expect(page.locator("#ssis-setup-panel")).toBeHidden();
  await expect(page.getByText("Total Units")).toBeVisible();
});
