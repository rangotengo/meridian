import { expect, test } from "@playwright/test";
import { authFile, getData } from "./fixtures";

// Permission-dependent transaction UI (the behavior PR #1 implemented):
// access levels come from account shares — the seed shares the checking
// account with the read_write member as read_write and with the read_only
// member as read_only.

test.describe("read-only member", () => {
  test.use({ storageState: authFile("ro") });

  test("transaction edit controls are disabled on the detail page", async ({ page }) => {
    await page.goto(`/transactions/${getData().entry.id}`);

    await expect(
      page.getByText("Read-only access — you can view this transaction but not edit it.")
    ).toBeVisible();
    await expect(page.locator("#d-name")).toBeDisabled();
    await expect(page.locator("#d-date")).toBeDisabled();
    await expect(page.locator("#d-amount")).toBeDisabled();
    await expect(page.locator("#d-category")).toBeDisabled();
    await expect(page.locator("#d-notes")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    // Delete stays visible but disabled for non-full-control access.
    await expect(page.getByRole("button", { name: "Delete transaction" })).toBeDisabled();
  });

  test("cannot create transactions", async ({ page }) => {
    await page.goto("/transactions/new");
    // The read-only member has no full-control account, so the create form
    // has nothing to record against.
    await expect(page.getByText("Add an account first")).toBeVisible();
    await expect(page.getByRole("button", { name: /Record (expense|income)/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Move money" })).toHaveCount(0);
  });
});

test.describe("read-write member", () => {
  test.use({ storageState: authFile("rw") });

  test("can annotate a transaction but core fields stay locked", async ({ page }) => {
    await page.goto(`/transactions/${getData().entry.id}`);

    await expect(page.getByText("You can edit category, merchant and notes only.")).toBeVisible();
    await expect(page.locator("#d-name")).toBeDisabled();
    await expect(page.locator("#d-date")).toBeDisabled();
    await expect(page.locator("#d-amount")).toBeDisabled();

    const notes = page.locator("#d-notes");
    await expect(notes).toBeEnabled();
    await expect(page.locator("#d-category")).toBeEnabled();
    await expect(page.locator("#d-merchant")).toBeEnabled();

    const saved = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        res.url().includes(`/transactions/${getData().entry.id}`) &&
        res.ok()
    );
    await notes.fill("Annotated by the read-write member.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await saved;

    await page.reload();
    await expect(page.locator("#d-notes")).toHaveValue("Annotated by the read-write member.");
  });
});
