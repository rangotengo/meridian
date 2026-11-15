import { expect, test } from "@playwright/test";
import { INVITEE_PASSWORD, getData } from "./fixtures";

// Email delivery is out of scope: the seed creates a real family invitation
// through the domain layer and hands the raw token to this spec, which
// drives the acceptance URL directly, exactly as a link from the email
// would.
test("a family invitation link opens the acceptance page and joining works", async ({ page }) => {
  await page.goto(`/invitations/${getData().invitee.token}`);

  await expect(page.getByRole("heading", { name: /Join/ })).toBeVisible();
  await expect(page.getByText(getData().invitee.email)).toBeVisible();

  await page.locator("#name").fill("E2E Invitee");
  await page.locator("#password").fill(INVITEE_PASSWORD);
  await page.getByRole("button", { name: "Create account and join" }).click();

  // Accepting signs the new member in and lands on the dashboard.
  await expect(page.getByRole("link", { name: "Transactions" })).toBeVisible();
  await expect(page).toHaveURL("/");
});
