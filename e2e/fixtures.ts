import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

/**
 * Shared data and helpers for the E2E specs. The seed script
 * (e2e/seed.ts, run from global setup) writes test-data.json and the
 * per-role storage-state files under e2e/.auth/.
 */

export type E2EData = {
  familyName: string;
  admin: { userId: string; email: string };
  rw: { userId: string; email: string };
  ro: { userId: string; email: string };
  invitee: { email: string; token: string };
  accountA: { id: string; name: string };
  accountB: { id: string; name: string };
  entry: { id: string; name: string };
};

/** Read after global setup; test discovery must work before seeding. */
export function getData(): E2EData {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "e2e", "test-data.json"), "utf8")
  ) as E2EData;
}

/** tests/helpers `makeUser` registers the admin with this fixed password. */
export const ADMIN_PASSWORD = "Sup3rSecure!Pass";
/** Password the seed assigns to members who join via invitation. */
export const MEMBER_PASSWORD = "E2eMember!Pass1";
/** Password the invitation spec chooses when accepting in the browser. */
export const INVITEE_PASSWORD = "E2eInvitee!Pass1";

export function authFile(role: "admin" | "rw" | "ro"): string {
  return path.join(process.cwd(), "e2e", ".auth", `${role}.json`);
}

/** Drive the real sign-in form and wait until the app shell is up. */
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/sign-in");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Transactions" })).toBeVisible();
}
