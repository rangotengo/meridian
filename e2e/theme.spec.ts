import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ADMIN_PASSWORD, getData, login } from "./fixtures";

/**
 * Theme persistence (production build). The root layout renders explicit
 * preferences as the `dark` class in the initial server HTML; "system" is
 * resolved before paint by the nonce-protected bootstrap and kept in sync
 * with OS changes by the client listener. These tests exercise the paths
 * that used to reset the theme: hard reloads, navigation, server-action
 * refreshes (settings saves, privacy toggle), and dialog submissions.
 */

const SHOTS = path.join(process.cwd(), "e2e", "screenshots");
mkdirSync(SHOTS, { recursive: true });

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

const themeCookie = async (page: Page) =>
  (await page.context().cookies()).find((c) => c.name === "theme")?.value;

/** Remove only the theme cookie, keeping the session from the login. */
async function dropThemeCookie(page: Page) {
  const context = page.context();
  const cookies = await context.cookies();
  await context.clearCookies();
  await context.addCookies(cookies.filter((c) => c.name !== "theme"));
}

async function loginFresh(page: Page) {
  await login(page, getData().admin.email, ADMIN_PASSWORD);
  await dropThemeCookie(page);
}

test.describe("explicit dark", () => {
  test.use({ colorScheme: "light" });

  test("dark survives reload, navigation, settings saves, and a dialog submission", async ({
    page
  }) => {
    await loginFresh(page);
    await expect.poll(() => isDark(page)).toBe(false);

    // Choose dark explicitly via the header toggle (light OS preference).
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect.poll(() => isDark(page)).toBe(true);
    await expect.poll(() => themeCookie(page)).toBe("dark");

    // Hard reload.
    await page.reload();
    await expect(page.getByRole("link", { name: "Transactions" })).toBeVisible();
    await expect.poll(() => isDark(page)).toBe(true);

    // Client-side navigation.
    await page.getByRole("link", { name: "Transactions" }).click();
    await expect(page).toHaveURL(/\/transactions/);
    await expect.poll(() => isDark(page)).toBe(true);

    // A settings save (server action).
    await page.goto("/settings");
    await page.getByLabel("Display name").fill("E2E Admin");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect.poll(() => isDark(page)).toBe(true);

    // The privacy toggle revalidates the root layout itself.
    await page.getByRole("button", { name: /Turn (on|off)/ }).click();
    await page.waitForTimeout(500);
    await expect.poll(() => isDark(page)).toBe(true);
    // Restore privacy mode for other specs.
    await page.getByRole("button", { name: /Turn (on|off)/ }).click();
    await page.waitForTimeout(500);
    await expect.poll(() => isDark(page)).toBe(true);

    // A successful dialog submission (edit a valuation in its dialog).
    await page.goto("/accounts/new");
    await page.getByText("Other liability", { exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("E2E Theme Loan");
    await page.getByLabel("Opening balance owed").fill("100.00");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);
    await expect.poll(() => isDark(page)).toBe(true);
    const record = page.locator("#valuation");
    await record.getByLabel("Value (USD)").fill("250.50");
    await record.getByRole("button", { name: "Record valuation" }).click();
    const activity = page.getByRole("listitem").filter({ hasText: "Valuation update" });
    await activity.getByRole("button", { name: "Edit", exact: true }).click();
    const edit = page.locator("dialog[open]");
    await edit.getByLabel("Value (USD)").fill("150.25");
    await edit.getByRole("button", { name: "Save valuation", exact: true }).click();
    await expect(edit.getByText("Valuation saved.", { exact: true })).toBeVisible();
    await expect.poll(() => isDark(page)).toBe(true);
    await edit.getByRole("button", { name: "Close dialog" }).click();
    await expect.poll(() => isDark(page)).toBe(true);

    await page.goto("/");
    await page.screenshot({ path: path.join(SHOTS, "theme-dark-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(SHOTS, "theme-dark-mobile.png") });
  });

  test("the initial server HTML carries the dark class and a nonced bootstrap", async ({
    page
  }) => {
    await loginFresh(page);
    await page.context().addCookies([
      {
        name: "theme",
        value: "dark",
        url: new URL(page.url()).origin
      }
    ]);
    const response = await page.goto("/");
    const html = await response!.text();
    // Explicit dark is painted by the server, not by client-side repair.
    expect(html).toMatch(/<html[^>]*class="[^"]*\bdark\b/);
    const csp = response!.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src");
    const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
    expect(nonce, "bootstrap script carries a nonce").toBeTruthy();
    expect(csp).toContain(`'nonce-${nonce}'`);
    await expect.poll(() => isDark(page)).toBe(true);
  });

  test("a saved preference initializes a missing browser preference", async ({ page }) => {
    await loginFresh(page);
    // Persist dark as the saved (server-side) preference via the toggle.
    // The starting painted theme depends on the saved preference left by
    // earlier tests, so click until the cookie records dark (≤ 2 clicks).
    for (let i = 0; i < 2 && (await themeCookie(page)) !== "dark"; i++) {
      await page.getByRole("button", { name: "Toggle theme" }).click();
      await page.waitForTimeout(300);
    }
    await expect.poll(() => themeCookie(page)).toBe("dark");
    await expect.poll(() => isDark(page)).toBe(true);

    // Drop the browser preference; the saved one must take over.
    await dropThemeCookie(page);
    expect(await themeCookie(page)).toBeUndefined();
    await page.reload();
    await expect(page.getByRole("link", { name: "Transactions" })).toBeVisible();
    await expect.poll(() => isDark(page)).toBe(true);
  });
});

test.describe("explicit light with a dark OS preference", () => {
  test.use({ colorScheme: "dark" });

  test("light survives reload and a layout-revalidating save", async ({ page }) => {
    await loginFresh(page);
    // System mode paints dark under a dark OS; choose light explicitly.
    await expect.poll(() => isDark(page)).toBe(true);
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect.poll(() => isDark(page)).toBe(false);
    await expect.poll(() => themeCookie(page)).toBe("light");

    await page.reload();
    await expect(page.getByRole("link", { name: "Transactions" })).toBeVisible();
    await expect.poll(() => isDark(page)).toBe(false);

    await page.goto("/settings");
    await page.getByRole("button", { name: /Turn (on|off)/ }).click();
    await page.waitForTimeout(500);
    await expect.poll(() => isDark(page)).toBe(false);
    await page.getByRole("button", { name: /Turn (on|off)/ }).click();
    await page.waitForTimeout(500);
    await expect.poll(() => isDark(page)).toBe(false);
  });
});

test.describe("system mode", () => {
  test.use({ colorScheme: "dark" });

  test("system follows OS changes live and persists nothing", async ({ page }) => {
    await loginFresh(page);
    // No explicit choice anywhere: with the admin's saved preference left
    // at system by the previous test order, ensure we start from system
    // by choosing it in Settings if a saved value lingers.
    await page.goto("/settings");
    await page.locator("#s-theme").selectOption("system");
    await page.getByRole("button", { name: "Save appearance" }).click();
    await page.waitForTimeout(500);
    await dropThemeCookie(page);
    // Re-save via cookie only: emulate the browser preference = system.
    await page
      .context()
      .addCookies([{ name: "theme", value: "system", url: new URL(page.url()).origin }]);
    await page.reload();
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Transactions" })).toBeVisible();
    await expect.poll(() => isDark(page)).toBe(true);

    // OS flips to light: the painted theme follows without a reload.
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => isDark(page)).toBe(false);
    // OS flips back to dark.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => isDark(page)).toBe(true);

    // Rendering and OS changes never rewrite the stored preference.
    await expect.poll(() => themeCookie(page)).toBe("system");
  });
});
