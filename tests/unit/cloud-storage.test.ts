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
  it("tracks a loan by transactions after a balance-tracking switch in cloud DO", async () => {
    expect(await probe("balance-tracking")).toEqual({
      beforeBalance: 15000000,
      previewResulting: 16000000,
      afterBalance: 16000000,
      switchedResulting: 16000000,
      valuationDrivenAfter: false,
      valuationRejected: true
    });
  });
  it("keeps a backdated conversion date-correct after a round trip in cloud DO", async () => {
    expect(await probe("balance-tracking-backdated")).toEqual({
      valuationModeAnchorBalance: 100000,
      previewPlug: -100000,
      previewResulting: 100000,
      previewRestated: 1,
      switchedPlug: -100000,
      switchedRestated: 1,
      switchedResulting: 100000,
      balanceBeforeAnchor: 0,
      balanceOnAnchor: 100000,
      balanceOnAdjustment: 100000,
      balanceToday: 100000,
      earlierAdjustmentAmount: 0,
      earlierAdjustmentSource: "balance_tracking"
    });
  });
  it("rejects a backdated conversion that would restate a transfer leg in cloud DO", async () => {
    expect(await probe("balance-tracking-transfer-leg")).toEqual({
      previewRejected: true,
      switchRejected: true,
      adjustmentAmount: -100000,
      modeAfter: "valuation",
      legsSum: 0,
      balanceToday: 100000
    });
  });
  it("edits and deletes loan valuations with atomic balance repair in cloud DO", async () => {
    expect(await probe("valuation-edit")).toEqual({
      editedBalance: -22500,
      editedKind: "reconciliation",
      deletedBalance: -10000,
      deletedEntryAbsent: true
    });
  });
  it("runs manual holdings with serialized buys and honest cost provenance in cloud DO", async () => {
    expect(await probe("holdings")).toEqual({
      quantity: "103",
      averageCostMinor: 200,
      averageCostQuantity: "3",
      partialCost: true,
      totalCostMinor: 600,
      balance: 51500,
      valuationRejected: true,
      unpriceableRejected: true
    });
  });
  it("preserves same-day valuation precedence across export and restore in cloud DO", async () => {
    const result = await probe("export-restore-precedence");
    expect(result.sourceBalance).toBe(1000);
    expect(result.restoredBalance).toBe(1000);
    // A fresh buy must beat every restored valuation immediately, even
    // when a fast restore has more entries than elapsed milliseconds.
    expect(result.afterBuy).toBe(1100);
    // The export carries the per-account write order and the manual
    // valuation (written first) ranks below the holdings valuation.
    expect(result.todaysValuations).toEqual([
      { amountMinor: 5000, writeOrder: 0 },
      { amountMinor: 1000, writeOrder: 1 }
    ]);
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

  it("runs the MCP OAuth authorization flow (replay, rotation, concurrency, CIMD gate) in cloud DO", async () => {
    const result = await probe("mcp-oauth");
    expect(result).toEqual({
      resolved: true,
      codeReplayRejected: true,
      replayKillsTokens: true,
      concurrentExchangeSingleWinner: true,
      concurrentExchangeFamilyRevoked: true,
      refreshReuseRejected: true,
      refreshReuseKillsFamily: true,
      concurrentRefreshSingleWinner: true,
      householdMoveRejected: true,
      consentCsrfRejected: true,
      consentSingleUse: true,
      cimdBlockedWithoutAllowlist: true,
      cimdAllowedWithAllowlist: true,
      descendantRefreshRejected: true,
      descendantPairDead: true,
      resourceChangeRefreshRejected: true,
      resourceChangeAccessRejected: true,
      assertionFirstOk: true,
      assertionReplayRejected: true,
      assertionSkewReplayRejected: true,
      assertionFutureRejected: true,
      assertionMissingExpRejected: true
    });
  });

  it("enforces the CIMD allowlist on every redirect hop in cloud DO (P1-4)", async () => {
    const result = await probe("mcp-ssrf-redirect");
    expect(result).toEqual({
      redirectToUnapprovedBlocked: true,
      redirectWithinAllowlistAllowed: true
    });
  });

  it("serves the Stage 3 MCP tools (scopes, notes gating, isolation) in cloud DO", async () => {
    const result = await probe("mcp-tools");
    expect(result).toEqual({
      listAccountsOk: true,
      searchOk: true,
      notesExcludedWithoutScope: true,
      noteTextNotSearchable: true,
      notesIncludedWithScope: true,
      financeDeniedForTransactionsGrant: true,
      searchDeniedForFinanceGrant: true,
      crossHouseholdIsolated: true,
      breakdownMerchantOk: true,
      summaryOk: true,
      summaryExcludesCeilingAccount: true,
      netWorthPartialFlagged: true,
      ssisDeniedWithoutPermission: true,
      ssisSummaryOk: true,
      ssisCoveragePartial: true,
      ssisPurchasesOk: true,
      ssisDeniedAfterDisable: true
    });
  });

  it("serves the Stage 4 settings data and consent account picker in cloud DO", async () => {
    const result = await probe("mcp-settings");
    expect(result).toEqual({
      ceilingStored: true,
      selectionRejectsForeign: true,
      listShowsConnection: true,
      otherUserListEmpty: true,
      lastUsedAdvances: true,
      revokedStatusShown: true,
      revokeKillsAccess: true
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
  it("imports an SSIS snapshot and reads the insight back inside the Durable Object", async () => {
    const result = await probe("ssis");
    expect(result.counts).toEqual({ purchases: 1, statement: 1, navPoints: 1, skipped: 0 });
    expect(result.holderName).toBe("Cloud Holder");
    expect(result.totalUnits).toBe("100");
    expect(result.totalInvestedMinor).toBe(100000);
    expect(result.currentNavMinor).toBe(1050);
    expect(result.currentValueMinor).toBe(105000);
    expect(result.purchases).toBe(1);
    expect(result.statement).toBe(1);
  });
  it("binds SSIS data to the configured holder and validates upstream data in the Durable Object", async () => {
    const result = await probe("ssis-fixes");
    expect(result.switchRejected).toBe(true);
    expect(result.dataReset).toBe(true);
    expect(result.purchasesAfterSwitch).toBe(0);
    expect(result.holderAfterSwitch).toBeNull();
    expect(result.inflightRejected).toBe(true);
    expect(result.purchasesAfterInflight).toBe(0);
    expect(result.boMaskedAfterInflight).toBe("••••2222");
    expect(result.allErrorPayloadNull).toBe(true);
    expect(result.allErrorWarnings).toBe(4);
    expect(result.oversizedRejected).toBe(true);
    expect(result.faultMessage).toContain("Could not save the SSIS BO account configuration.");
    expect(result.faultChainHasBo).toBe(false);
  });
  it("closes the SSIS holder-binding and effective-bounds bypasses in the Durable Object", async () => {
    const result = await probe("ssis-round2");
    expect(result.bindKeptDataReset).toBe(false);
    expect(result.purchasesAfterBindKept).toBe(1);
    expect(result.bindResetDataReset).toBe(true);
    expect(result.purchasesAfterBindReset).toBe(0);
    expect(result.otherHolderRejected).toBe(true);
    expect(result.anonymousRejected).toBe(true);
    expect(result.purchasesAfterAnonymous).toBe(1);
    expect(result.combinedRejected).toBe(true);
    expect(result.purchasesAfterCombined).toBe(1);
    expect(result.totalInvestedAfterCombined).toBe(5000000000000000);
    expect(result.navOverflowRejected).toBe(true);
    expect(result.navAfterNavOverflow).toBe(100);
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
  it("commits balance-repair intent with each recurring occurrence on SQLite", async () => {
    const result = await probe("recurring-repair");
    expect(result.result).toEqual({ posted: 1, paused: 0, failed: 0 });
    expect(result.entries).toBe(2);
    // Both occurrences share one pending repair job (dedupe key per account).
    expect(result.repairJobsPending).toBe(1);
    expect(result.balanceMinor).toBe(-200);
    expect(result.again).toEqual({ posted: 0, paused: 0, failed: 0 });
  });
});
