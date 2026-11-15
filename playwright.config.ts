import { defineConfig } from "@playwright/test";

/**
 * Browser acceptance (E2E) configuration.
 *
 * The suite runs against the production build of the app (`next build` +
 * `next start`) served on a dedicated port, backed by a dedicated PostgreSQL
 * test database (`meridian_test_e2e` by default). Seeding happens in
 * `e2e/global-setup.ts`, which shells out to `e2e/seed.ts`.
 *
 * Override the database with E2E_DATABASE_URL and the port with E2E_PORT.
 * See e2e/README.md for details.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://review_admin@127.0.0.1:55439/meridian_test_e2e";

export const e2eEnv = {
  DATABASE_URL: E2E_DATABASE_URL,
  TEST_DATABASE_URL: E2E_DATABASE_URL,
  APP_URL: BASE_URL,
  AUTH_MODE: "password",
  MAIL_TRANSPORT: "console",
  REQUIRE_EMAIL_VERIFICATION: "false",
  LOG_LEVEL: "info"
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The specs share one seeded household and some mutate it (notes edits,
  // transfers, splits), so they must run serially in a single worker.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "**/mobile.spec.ts",
      use: { viewport: { width: 1280, height: 800 } }
    },
    {
      name: "mobile",
      testMatch: "**/mobile.spec.ts",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36"
      }
    }
  ],
  webServer: {
    command: "npm run build:next && npm run start -- -p " + PORT,
    url: BASE_URL,
    // A cold production build takes minutes; allow generous startup time.
    timeout: 900_000,
    reuseExistingServer: !process.env.CI,
    env: e2eEnv
  }
});
