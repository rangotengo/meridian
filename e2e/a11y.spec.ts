import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { authFile } from "./fixtures";

// Accessibility smoke: axe-core must report no *critical* violations on the
// covered pages. Other impacts are left in the report for triage without
// failing the suite.
async function expectNoCriticalViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const critical = results.violations.filter((v) => v.impact === "critical");
  expect(critical.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("sign-in page has no critical accessibility violations", async ({ page }) => {
  await page.goto("/sign-in");
  // The sign-in form itself: inputs are labelled and the button has a name.
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expectNoCriticalViolations(page);
});

test.describe("dashboard", () => {
  test.use({ storageState: authFile("admin") });

  test("dashboard has no critical accessibility violations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Net Worth").first()).toBeVisible();
    await expectNoCriticalViolations(page);
  });
});
