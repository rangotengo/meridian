import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { e2eEnv } from "../playwright.config";
import { assertSafeTestDatabase } from "../tests/setup/database-guard";

/**
 * Playwright global setup:
 *  1. Create the E2E database if it does not exist yet (the local embedded
 *     test cluster is shared with the vitest suites and is recreated from
 *     scratch from time to time, so the database cannot be assumed).
 *  2. Migrate + seed it by running e2e/seed.ts under tsx (the same runner
 *     the repo's bin/ scripts use, so tsconfig path aliases resolve exactly
 *     as they do for the app code).
 */
export default async function globalSetup(): Promise<void> {
  assertSafeTestDatabase(e2eEnv.DATABASE_URL, process.env.APP_DATABASE_URL);
  const url = new URL(e2eEnv.DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, "");
  if (!/^[a-zA-Z0-9_]{1,63}$/.test(dbName)) {
    throw new Error(`E2E database name "${dbName}" is not a safe identifier.`);
  }
  // Connect to the maintenance database on the same server/credentials.
  const adminUrl = new URL(e2eEnv.DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }

  execFileSync("npx", ["tsx", "e2e/seed.ts"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, ...e2eEnv }
  });
}
