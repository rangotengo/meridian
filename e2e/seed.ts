/**
 * E2E seed script — run by e2e/global-setup.ts as a child process via tsx
 * before the Playwright specs start.
 *
 * It migrates the dedicated E2E database, wipes it, and seeds one household
 * through the app's own domain functions and test helpers:
 *
 *   - a family admin (created by tests/helpers `makeUser`)
 *   - a read_write member and a read_only member (joined via real family
 *     invitations, then granted account shares on the checking account)
 *   - two accounts ("E2E Checking", "E2E Savings") and one expense entry
 *   - one unconsumed family invitation whose raw token the invitation
 *     acceptance spec drives in the browser
 *
 * It also mints real sessions for the admin / read_write / read_only users
 * and writes Playwright storage-state files (e2e/.auth/*.json) so specs do
 * not have to burn the login rate limit (5 attempts / 15 min / email+IP).
 * Everything the specs need is written to e2e/test-data.json.
 *
 * Environment is configured BEFORE any application module is imported,
 * because src/lib/env.ts validates process.env at import time. That is why
 * every app import below is dynamic.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertSafeTestDatabase } from "../tests/setup/database-guard";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://review_admin@127.0.0.1:55439/meridian_test_e2e";

process.env.DATABASE_URL = DATABASE_URL;
process.env.TEST_DATABASE_URL = DATABASE_URL;
process.env.APP_URL = process.env.APP_URL ?? "http://localhost:3100";
process.env.AUTH_MODE = "password";
process.env.MAIL_TRANSPORT = "console";
process.env.REQUIRE_EMAIL_VERIFICATION = "false";
process.env.LOG_LEVEL = "info";

/** Password for members who join via invitation (chosen here, not by helpers). */
const MEMBER_PASSWORD = "E2eMember!Pass1";

const ROOT = process.cwd();
const DATA_FILE = path.join(ROOT, "e2e", "test-data.json");
const AUTH_DIR = path.join(ROOT, "e2e", ".auth");

async function main(): Promise<void> {
  // Reject unsafe targets before migrations or any database writes, and
  // retain the caller's real application URL for the same-database guard.
  assertSafeTestDatabase(DATABASE_URL, process.env.APP_DATABASE_URL);
  const { migrateUp } = await import("../src/server/db/migrate");
  const { getDb, closeDb } = await import("../src/server/db/client");
  const helpers = await import("../tests/helpers");
  const invitations = await import("../src/server/domain/invitations");
  const accounts = await import("../src/server/domain/accounts");
  const { createSession } = await import("../src/server/security/session");

  const db = getDb();

  await migrateUp();
  await helpers.truncateAll();

  // --- Household -----------------------------------------------------------
  const admin = await helpers.makeUser({
    email: "admin@e2e.local",
    name: "E2E Admin",
    familyName: "E2E Family"
  });
  const adminActor = helpers.actorOf(admin);

  // joint: false makes the admin the accounts' owner. Ownerless (joint)
  // accounts grant every family member full control by design, which would
  // bypass the account shares the permission specs exercise.
  const accountAId = await helpers.makeAccount(admin, { name: "E2E Checking", joint: false });
  const accountBId = await helpers.makeAccount(admin, { name: "E2E Savings", joint: false });

  const entryId = await helpers.addTxn(admin, accountAId, {
    amountLedgerMinor: 12_000,
    name: "E2E Groceries"
  });

  // --- Members via real invitations ---------------------------------------
  async function joinViaInvitation(
    email: string,
    name: string
  ): Promise<{ userId: string; familyId: string; email: string }> {
    const { token } = await invitations.createInvitation(db, adminActor, {
      email,
      role: "member"
    });
    const res = await invitations.acceptInvitationWithNewAccount(db, token, {
      name,
      password: MEMBER_PASSWORD
    });
    return { userId: res.userId, familyId: res.familyId, email };
  }

  const rw = await joinViaInvitation("rw@e2e.local", "E2E ReadWrite");
  const ro = await joinViaInvitation("ro@e2e.local", "E2E ReadOnly");

  await accounts.shareAccount(db, adminActor, accountAId, rw.userId, "read_write");
  await accounts.shareAccount(db, adminActor, accountAId, ro.userId, "read_only");

  // --- Unconsumed invitation for the browser acceptance spec ---------------
  const invitee = await invitations.createInvitation(db, adminActor, {
    email: "invitee@e2e.local",
    role: "member"
  });

  // --- Sessions -> Playwright storage states --------------------------------
  mkdirSync(AUTH_DIR, { recursive: true });
  const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  async function writeStorageState(role: string, userId: string): Promise<void> {
    const { token } = await createSession(db, userId, {
      ip: "127.0.0.1",
      userAgent: "playwright-e2e-seed"
    });
    const state = {
      cookies: [
        {
          name: "meridian_session",
          value: token,
          domain: "localhost",
          path: "/",
          expires,
          httpOnly: true,
          secure: false,
          sameSite: "Lax"
        }
      ],
      origins: []
    };
    writeFileSync(path.join(AUTH_DIR, `${role}.json`), JSON.stringify(state, null, 2));
  }

  await writeStorageState("admin", admin.userId);
  await writeStorageState("rw", rw.userId);
  await writeStorageState("ro", ro.userId);

  // --- Test data for the specs ----------------------------------------------
  const data = {
    familyName: "E2E Family",
    admin: { userId: admin.userId, email: admin.email },
    rw: { userId: rw.userId, email: rw.email },
    ro: { userId: ro.userId, email: ro.email },
    invitee: { email: "invitee@e2e.local", token: invitee.token },
    accountA: { id: accountAId, name: "E2E Checking" },
    accountB: { id: accountBId, name: "E2E Savings" },
    entry: { id: entryId, name: "E2E Groceries" }
  };
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

  await closeDb();
  console.log(`[e2e seed] seeded ${DATABASE_URL.replace(/\/\/[^@]*@/, "//***@")}`);
  console.log(`[e2e seed] wrote ${DATA_FILE} and storage states in ${AUTH_DIR}`);
  // tests/helpers keeps its own raw client open, which would keep this
  // process alive forever; the seed is done, so exit explicitly.
  process.exit(0);
}

main().catch((error) => {
  console.error("[e2e seed] failed:", error);
  process.exit(1);
});
