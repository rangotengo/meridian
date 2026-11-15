import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, data, login } from "./fixtures";

test.describe("login", () => {
  test("valid credentials reach the dashboard", async ({ page }) => {
    await login(page, data.admin.email, ADMIN_PASSWORD);
    await expect(page).toHaveURL("/");
    await expect(page.getByText("Net Worth").first()).toBeVisible();
  });

  test("wrong password shows an error and stays on the sign-in page", async ({ page }) => {
    await page.goto("/sign-in");
    await page.locator("#email").fill(data.admin.email);
    await page.locator("#password").fill("WrongPass123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Please sign in to continue.");
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
