import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/server/db/schema";
import { accounts } from "@/server/db/schema";
import type { Executor } from "@/server/db/client";
import {
  db,
  makeUser,
  makeAccount,
  truncateAll,
  actorOf,
  latestBalance,
  daysAgo,
  type TestUser
} from "../helpers";
import * as holdingsSvc from "@/server/domain/holdings";
import { importHoldingsCsv } from "@/server/domain/holdings-import";
import * as valuationsSvc from "@/server/domain/valuations";
import { recalculateAccount } from "@/server/domain/balances";
import * as exportsSvc from "@/server/domain/exports";
import { importFamilyExport, parseFamilyExport } from "@/server/domain/family-import";
import { todayIn } from "@/lib/datetime";

/**
 * Regression coverage for the three findings left open after the PR #16
 * round-1 fixes (GPT-6.1 re-review of 5dc8dea):
 *  A. same-day valuation precedence must follow lock-time write order,
 *     not the PostgreSQL transaction-start timestamp;
 *  B. a plain edit must not promote a partial average cost to full
 *     coverage — only an explicit apply-to-all assertion may;
 *  C. priceability is defined centrally and enforced before any
 *     portfolio valuation is published.
 */

async function makePortfolio(user: TestUser, name = "Brokerage"): Promise<string> {
  return makeAccount(user, {
    type: "other_asset",
    name,
    currency: "USD",
    openingBalanceDisplayMinor: 0,
    openedOn: daysAgo(30),
    joint: false
  });
}

async function balance(accountId: string): Promise<number> {
  return (await latestBalance(accountId))?.balanceMinor ?? 0;
}

beforeEach(async () => {
  await truncateAll();
});

/** A drizzle instance over a dedicated single-connection pool. */
function heldExecutor(): { exec: NodePgDatabase<typeof schema>; close: () => Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is missing in test environment");
  const pool = new Pool({ connectionString: url, max: 1 });
  return { exec: drizzle(pool, { schema }), close: () => pool.end() };
}

/**
 * Starts an OUTER transaction on `exec` and holds it open: the callback
 * fixes the transaction's start timestamp (SELECT now()) and signals
 * `entered`, then waits. The test performs the competing commit on
 * another executor, calls `release()`, and only then does `fn` run its
 * domain call inside the still-open transaction — the exact interleaving
 * of the reviewer's probes. Sequential calls on a root executor cannot
 * reproduce the finding because each gets a fresh transaction whose
 * start time is also its write time.
 */
function heldTransaction<T>(
  exec: NodePgDatabase<typeof schema>,
  fn: (tx: Executor) => Promise<T>
): { entered: Promise<void>; release: () => void; result: Promise<T> } {
  let release!: () => void;
  let markEntered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (markEntered = r));
  const result = exec.transaction(async (tx) => {
    await tx.execute(sql`SELECT now()`);
    markEntered();
    await gate;
    return fn(tx);
  });
  return { entered, release, result };
}

describe("round 2 finding A: precedence follows lock-time write order, not transaction start", () => {
  it("probe A: a holdings write from an earlier-started transaction beats a manual valuation committed in between", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);
    const today = todayIn("Etc/UTC");
    const a = heldExecutor();
    try {
      const held = heldTransaction(a.exec, (tx) =>
        holdingsSvc.addHolding(tx, actor, {
          accountId,
          ticker: "NABIL",
          quantity: "1",
          averageCostMinor: null,
          currentPriceMinor: 1000
        })
      );
      await held.entered;
      // The competing manual valuation commits while A's transaction —
      // started earlier — is still open.
      await valuationsSvc.recordValuation(db(), actor, {
        accountId,
        date: today,
        amountDisplayMinor: 5000,
        kind: "current"
      });
      await recalculateAccount(db(), accountId, today);
      expect(await balance(accountId)).toBe(5000);

      held.release();
      await held.result;
      // A wrote last (under the account lock), so the holdings value is
      // authoritative — A's entry is stamped at INSERT execution time,
      // not at A's stale transaction start.
      expect(await balance(accountId)).toBe(1000);
    } finally {
      await a.close();
    }
  });

  it("probe B: a manual valuation from an earlier-started transaction beats a zero holdings write committed in between", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);
    const today = todayIn("Etc/UTC");
    const a = heldExecutor();
    try {
      const held = heldTransaction(a.exec, (tx) =>
        valuationsSvc.recordValuation(tx, actor, {
          accountId,
          date: today,
          amountDisplayMinor: 5000,
          kind: "current"
        })
      );
      await held.entered;
      // In between: holdings are added and removed again, so B commits a
      // fresh zero holdings valuation for today.
      const { holdingId } = await holdingsSvc.addHolding(db(), actor, {
        accountId,
        ticker: "NABIL",
        quantity: "1",
        averageCostMinor: null,
        currentPriceMinor: 1000
      });
      await holdingsSvc.deleteHolding(db(), actor, { accountId, holdingId });
      expect(await balance(accountId)).toBe(0);

      held.release();
      await held.result;
      await recalculateAccount(db(), accountId, today);
      // A's manual insert executed after B's zero write, so it wins
      // despite A's transaction having started first.
      expect(await balance(accountId)).toBe(5000);
    } finally {
      await a.close();
    }
  });
});

describe("round 2 finding B: an edit preserves cost provenance unless coverage is asserted", () => {
  /** The reviewer's repro position: 101 shares, cost known for 1 @ 200, current price 500. */
  async function partialPosition(user: TestUser, actor: ReturnType<typeof actorOf>) {
    const accountId = await makePortfolio(user);
    const { holdingId } = await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      quantity: "100",
      averageCostMinor: null,
      currentPriceMinor: 500
    });
    await holdingsSvc.adjustHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      side: "buy",
      quantity: "1",
      priceMinor: 200
    });
    return { accountId, holdingId };
  }

  it("price-only and name-only edits keep the known portion at 1 of 101", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const { accountId, holdingId } = await partialPosition(user, actor);

    // The Edit form's normal payload: the prefilled average (200) is
    // resubmitted unchanged; only the current price changes.
    await holdingsSvc.updateHolding(db(), actor, {
      accountId,
      holdingId,
      quantity: "101",
      averageCostMinor: 200,
      currentPriceMinor: 600
    });
    let rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({
      averageCostMinor: 200,
      averageCostQuantity: "1",
      currentPriceMinor: 600
    });
    const summary = holdingsSvc.summarizeHoldings(rows);
    expect(summary.totalCostMinor).toBe(200);
    expect(summary.partialCost).toBe(true);
    // With a current price present, the position still values at it.
    expect(summary.totalValueMinor).toBe(101 * 600);
    expect(await balance(accountId)).toBe(101 * 600);

    // A company-name-only edit likewise leaves provenance untouched.
    await holdingsSvc.updateHolding(db(), actor, {
      accountId,
      holdingId,
      companyName: "Nabil Bank Limited",
      quantity: "101",
      averageCostMinor: 200,
      currentPriceMinor: 600
    });
    rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({
      companyName: "Nabil Bank Limited",
      averageCostQuantity: "1"
    });
    expect(holdingsSvc.summarizeHoldings(rows).totalCostMinor).toBe(200);
  });

  it("the explicit apply-to-all assertion extends coverage to the whole position", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const { accountId, holdingId } = await partialPosition(user, actor);

    await holdingsSvc.updateHolding(db(), actor, {
      accountId,
      holdingId,
      quantity: "101",
      averageCostMinor: 200,
      currentPriceMinor: 600,
      costCoversAllShares: true
    });
    const rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({ averageCostQuantity: "101" });
    const summary = holdingsSvc.summarizeHoldings(rows);
    expect(summary.partialCost).toBe(false);
    expect(summary.totalCostMinor).toBe(101 * 200);
  });

  it("a quantity reduction clamps the known portion; an increase leaves the added shares unknown", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);
    const { holdingId } = await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: 100,
      currentPriceMinor: null
    });

    await holdingsSvc.updateHolding(db(), actor, {
      accountId,
      holdingId,
      quantity: "4",
      averageCostMinor: 100,
      currentPriceMinor: null
    });
    let rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({ averageCostQuantity: "4" });
    expect(holdingsSvc.summarizeHoldings(rows).partialCost).toBe(false);

    // Growing back to 9 without the assertion: the 5 added shares have
    // unknown cost (a current price keeps the position priceable).
    await holdingsSvc.updateHolding(db(), actor, {
      accountId,
      holdingId,
      quantity: "9",
      averageCostMinor: 100,
      currentPriceMinor: 150
    });
    rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({ averageCostQuantity: "4" });
    expect(holdingsSvc.summarizeHoldings(rows).partialCost).toBe(true);
  });

  it("a cost supplied for an unknown-cost position without the assertion applies to zero shares", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);
    const { holdingId } = await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: null,
      currentPriceMinor: 500
    });

    await holdingsSvc.updateHolding(db(), actor, {
      accountId,
      holdingId,
      quantity: "10",
      averageCostMinor: 200,
      currentPriceMinor: 500
    });
    const rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    // The typed value is recorded, but it covers no shares until the
    // user asserts coverage — nothing is fabricated.
    expect(rows[0]).toMatchObject({ averageCostMinor: 200, averageCostQuantity: "0" });
    const summary = holdingsSvc.summarizeHoldings(rows);
    expect(summary.totalCostMinor).toBeNull();
    expect(summary.partialCost).toBe(true);
  });
});

describe("round 2 finding C: priceability is enforced before any valuation is published", () => {
  it("probe 1: a CSV clear that leaves only a partial average to extrapolate is a row error", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);
    await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "ABC",
      quantity: "100",
      averageCostMinor: null,
      currentPriceMinor: 500
    });
    await holdingsSvc.adjustHolding(db(), actor, {
      accountId,
      ticker: "ABC",
      side: "buy",
      quantity: "1",
      priceMinor: 200
    });
    expect(await balance(accountId)).toBe(101 * 500);

    // Clearing ONLY the current price would leave 101 shares priced by
    // an average that covers a single share.
    const result = await importHoldingsCsv(
      db(),
      actor,
      accountId,
      "ticker,quantity,current_price\nABC,101,\n"
    );
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.row).toBe(2);
    expect(result.errors[0]!.message).toMatch(/usable price/);

    const rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({ currentPriceMinor: 500, averageCostQuantity: "1" });
    expect(await balance(accountId)).toBe(101 * 500);
  });

  async function wipeFamilyData(familyId: string): Promise<void> {
    const exec = db();
    await exec.execute(
      sql`DELETE FROM transaction_tags WHERE transaction_id IN (SELECT t.id FROM transactions t JOIN entries e ON e.id = t.entry_id JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
    );
    await exec.execute(
      sql`DELETE FROM transfers WHERE outflow_entry_id IN (SELECT e.id FROM entries e JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
    );
    await exec.execute(
      sql`DELETE FROM transactions WHERE entry_id IN (SELECT e.id FROM entries e JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
    );
    await exec.execute(
      sql`DELETE FROM valuations WHERE entry_id IN (SELECT e.id FROM entries e JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
    );
    await exec.execute(
      sql`DELETE FROM entries WHERE account_id IN (SELECT id FROM accounts WHERE family_id = ${familyId}::uuid)`
    );
    await exec.execute(sql`DELETE FROM recurring_series WHERE family_id = ${familyId}::uuid`);
    await exec.execute(sql`DELETE FROM budgets WHERE family_id = ${familyId}::uuid`);
    await exec.execute(
      sql`DELETE FROM saved_filters WHERE user_id IN (SELECT id FROM users WHERE family_id = ${familyId}::uuid)`
    );
    await exec.execute(
      sql`DELETE FROM account_shares WHERE account_id IN (SELECT id FROM accounts WHERE family_id = ${familyId}::uuid)`
    );
    await exec.execute(
      sql`DELETE FROM balances WHERE account_id IN (SELECT id FROM accounts WHERE family_id = ${familyId}::uuid)`
    );
    await exec.execute(sql`DELETE FROM accounts WHERE family_id = ${familyId}::uuid`);
    await exec.execute(sql`DELETE FROM tags WHERE family_id = ${familyId}::uuid`);
    await exec.execute(sql`DELETE FROM categories WHERE family_id = ${familyId}::uuid`);
  }

  it("probe 2: a sell against a legacy restored unpriced position is rejected until it is priced", async () => {
    const user = await makeUser({ familyName: "LegacyUnpricedFamily" });
    const actor = actorOf(user);
    const brokerage = await makeAccount(user, {
      name: "Legacy Brokerage",
      type: "other_asset",
      openingBalanceDisplayMinor: 0
    });
    await holdingsSvc.addHolding(db(), actor, {
      accountId: brokerage,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: null,
      currentPriceMinor: 1000
    });
    // Tamper the export into the legacy shape restore deliberately
    // retains: the holding loses both prices, while its exported
    // valuation entry still carries the account value (10 × 1000).
    const exported = JSON.parse(
      JSON.stringify(await exportsSvc.buildFamilyExport(db(), actor))
    ) as {
      holdings: {
        averageCostMinor: number | null;
        currentPriceMinor: number | null;
        averageCostQuantity?: string;
      }[];
    };
    exported.holdings[0]!.averageCostMinor = null;
    exported.holdings[0]!.currentPriceMinor = null;
    exported.holdings[0]!.averageCostQuantity = "0";
    await wipeFamilyData(user.familyId);
    await importFamilyExport(
      db(),
      actor,
      parseFamilyExport(new TextEncoder().encode(JSON.stringify(exported)))
    );
    const [restored] = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.familyId, user.familyId));
    const restoredId = restored!.id;
    await recalculateAccount(db(), restoredId);
    expect(await balance(restoredId)).toBe(10_000);

    const rowsBefore = await holdingsSvc.listHoldings(db(), actor, restoredId);
    expect(rowsBefore[0]).toMatchObject({ averageCostMinor: null, currentPriceMinor: null });
    // Read paths flag the incompleteness instead of stating a value.
    const summary = holdingsSvc.summarizeHoldings(rowsBefore);
    expect(summary.valueComplete).toBe(false);
    expect(summary.totalValueMinor).toBe(0);

    // The sell would publish a fabricated zero valuation — rejected,
    // and the restored balance survives untouched.
    await expect(
      holdingsSvc.adjustHolding(db(), actor, {
        accountId: restoredId,
        ticker: "NABIL",
        side: "sell",
        quantity: "1",
        priceMinor: 1000
      })
    ).rejects.toThrow(/no usable price/);
    expect(await balance(restoredId)).toBe(10_000);
    expect(await holdingsSvc.listHoldings(db(), actor, restoredId)).toMatchObject([
      { quantity: "10" }
    ]);

    // Once the position is priced, the same sell succeeds and publishes
    // the true remaining value.
    await holdingsSvc.updateHolding(db(), actor, {
      accountId: restoredId,
      holdingId: rowsBefore[0]!.id,
      quantity: "10",
      averageCostMinor: null,
      currentPriceMinor: 1000
    });
    await holdingsSvc.adjustHolding(db(), actor, {
      accountId: restoredId,
      ticker: "NABIL",
      side: "sell",
      quantity: "1",
      priceMinor: 1000
    });
    expect(await balance(restoredId)).toBe(9_000);
  });
});
