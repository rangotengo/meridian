import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

describe("Cloudflare SQLite storage", () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const result = await build({
      entryPoints: ["tests/cloud/storage-worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      external: ["node:*", "cloudflare:*"],
      loader: { ".sql": "text" },
      conditions: ["workerd", "node"],
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire("/bundle/script-0.mjs");'
      },
      define: { "process.env.DATABASE_BACKEND": '"cloud-sqlite"', "process.env.NODE_ENV": '"test"' }
    });
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: result.outputFiles![0]!.text,
        compatibilityDate: "2026-08-20",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          DATABASE_BACKEND: "cloud-sqlite",
          NODE_ENV: "test",
          MERO_SHARE_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        },
        durableObjects: { PROBE: { className: "StorageProbe", useSQLite: true } }
      })
    );
  });
  afterAll(async () => {
    await runtime?.dispose();
  });

  async function probe(path: string) {
    const response = await runtime.dispatchFetch(`http://localhost/${path}`);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    return JSON.parse(body);
  }
  it("round-trips identities, dates, JSON, booleans and exact money", async () => {
    expect(await probe("roundtrip")).toEqual({
      validId: true,
      date: true,
      json: { privacy_mode: true },
      amount: Number.MAX_SAFE_INTEGER,
      included: true
    });
  });
  it("rolls back earlier writes when a foreign key fails after an await", async () => {
    expect(await probe("rollback")).toEqual({ rejected: true, remaining: 0 });
  });
  it("does not expose uncommitted writes to concurrent readers", async () => {
    expect(await probe("concurrency")).toEqual({ observed: "original" });
  });
  it("rolls back a nested transaction without discarding the outer write", async () => {
    expect(await probe("nested")).toEqual([{ name: "outer" }]);
  });
  it("rejects invalid and unsafe monetary values at the storage boundary", async () => {
    expect(await probe("storage-guards")).toEqual({ rejected: 3 });
  });
  it("handles API keys, SMS parsing, account matching and deduplication in cloud DO", async () => {
    const result = await probe("api-keys-and-sms");
    expect(result).toEqual({
      keyCreated: true,
      keyVerified: true,
      laxmiMatched: true,
      laxmiIncomeLogged: true,
      nabilMatched: true,
      nabilExpenseLogged: true,
      nabilDuplicated: true,
      revokedBlocked: true
    });
  });

  it("recalculates 500+ days of balances and bulk Sure imports on workerd", async () => {
    const result = await probe("bulk-history");
    expect(result.longHistoryDays).toBeGreaterThanOrEqual(400);
    expect(result.imported).toMatchObject({
      accounts: 1,
      categories: 1,
      tags: 3,
      transactions: 320,
      transfers: 0,
      valuations: 0
    });
    expect(result.importBalanceDays).toBeGreaterThanOrEqual(400);
    expect(result.latestImportBalanceMinor).toBe(10000);
  }, 60000);
  it("imports a fresh household and persists encrypted MeroShare snapshots", async () => {
    const result = await probe("import-meroshare");
    expect(result.imported).toMatchObject({ accounts: 1, transactions: 1 });
    expect(result.repeatedImportRejected).toBe(true);
    expect(result.connected).toBe(1);
    expect(result.synced).toBe(1);
    expect(result.encrypted).toBe(true);
  });
  it("runs household, ledger, splits, transfers, reports and queue services", async () => {
    const result = await probe("ledger");
    expect(result.duplicate).toBe(true);
    expect(result.entries).toBeGreaterThan(0);
    expect(result.payload).toEqual({ valid: true });
    expect(result.report.netWorthMinor).toBe(9000);
    expect(result.monthly[0].expenseMinor).toBe(1000);
    expect(Number(result.inverseRate)).toBe(0.01);
    expect(result.denied).toBe(true);
    expect(result.cronFired).toBe(1);
    expect(result.cronAgain).toBe(0);
    expect(result.cronPayload).toEqual({ cron: true });
    expect(result.recurring).toEqual({ posted: 1, paused: 0, failed: 0 });
    expect(result.recurringAgain).toEqual({ posted: 0, paused: 0, failed: 0 });
  });
});
