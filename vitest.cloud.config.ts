import { defineConfig } from "vitest/config";

// These tests run against workerd's SQLite-backed Durable Objects. They never
// connect to or recreate a PostgreSQL database.
export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
    include: ["tests/unit/cloud-storage.test.ts", "tests/unit/cloud-ops.test.ts"]
  }
});
