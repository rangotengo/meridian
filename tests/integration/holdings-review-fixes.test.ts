import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/server/db/schema";
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
import { accounts, meroShareAccounts } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import * as holdingsSvc from "@/server/domain/holdings";

import { importHoldingsCsv } from "@/server/domain/holdings-import";
import * as valuationsSvc from "@/server/domain/valuations";
import { recalculateAccount } from "@/server/domain/balances";
import {
  connectMeroShare,
  disconnectMeroShareConnection,
  syncMeroShareConnection
} from "@/server/domain/meroshare";
import * as exportsSvc from "@/server/domain/exports";
import { importFamilyExport, parseFamilyExport } from "@/server/domain/family-import";
import { todayIn } from "@/lib/datetime";

// connectMeroShare encrypts credentials with the runtime env key, which
// @/lib/env parses at import time — set a throwaway key before any module
// in this file's graph loads.
vi.hoisted(() => {
  process.env.MERO_SHARE_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function secondExecutor(): { exec: Executor; close: () => Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is missing in test environment");
  const pool = new Pool({ connectionString: url, max: 2 });
  const exec: Executor = drizzle(pool, { schema });
  return { exec, close: () => pool.end() };
}

function rawPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is missing in test environment");
  return new Pool({ connectionString: url, max: 2 });
}

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("finding 1: per-account serialization of holdings writers", () => {
  it("two concurrent buys on separate connections both land (quantity sums)", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);
    const { holdingId } = await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: 100_00,
      currentPriceMinor: null
    });

    // Hold the position row locked on a raw connection: both buys must
    // serialize behind the account lock instead of each reading 10.
    const pool = rawPool();
    const locker: PoolClient = await pool.connect();
    const exec2 = secondExecutor();
    const exec3 = secondExecutor();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM portfolio_holdings WHERE id = $1 FOR UPDATE", [holdingId]);

      const buy1 = holdingsSvc.adjustHolding(exec2.exec, actor, {
        accountId,
        ticker: "NABIL",
        side: "buy",
        quantity: "1",
        priceMinor: 100_00
      });
      const buy2 = holdingsSvc.adjustHolding(exec3.exec, actor, {
        accountId,
        ticker: "NABIL",
        side: "buy",
        quantity: "1",
        priceMinor: 100_00
      });
      // Let both buys get in flight and block (one on the row lock behind
      // the account lock, one on the account lock itself).
      await sleep(500);
      await locker.query("COMMIT");
      await Promise.all([buy1, buy2]);

      const rows = await holdingsSvc.listHoldings(db(), actor, accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.quantity).toBe("12");
      expect(await balance(accountId)).toBe(12 * 100_00);
    } finally {
      await locker.query("ROLLBACK").catch(() => {});
      locker.release();
      await pool.end();
      await exec2.close();
      await exec3.close();
    }
  });

  it("two concurrent reprices leave the balance equal to the final holdings total", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);
    await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "AAA",
      quantity: "1",
      averageCostMinor: null,
      currentPriceMinor: 1000
    });
    await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "BBB",
      quantity: "1",
      averageCostMinor: null,
      currentPriceMinor: 1000
    });
    expect(await balance(accountId)).toBe(2000);
    const rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    const aaa = rows.find((r) => r.ticker === "AAA")!;
    const bbb = rows.find((r) => r.ticker === "BBB")!;

    // Lock today's holdings valuation entry: each reprice's valuation
    // write must wait, and without account serialization the second
    // writer computes its total from the first writer's stale snapshot.
    const entryRes = await db().execute(sql`
      SELECT id FROM entries
      WHERE account_id = ${accountId}::uuid AND external_source = 'holdings'
      ORDER BY created_at DESC LIMIT 1
    `);
    const entryId = (entryRes.rows as { id: string }[])[0]!.id;

    const pool = rawPool();
    const locker: PoolClient = await pool.connect();
    const exec2 = secondExecutor();
    const exec3 = secondExecutor();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM entries WHERE id = $1 FOR UPDATE", [entryId]);

      const reprice1 = holdingsSvc.updateHolding(exec2.exec, actor, {
        accountId,
        holdingId: aaa.id,
        quantity: "1",
        averageCostMinor: null,
        currentPriceMinor: 2000
      });
      const reprice2 = holdingsSvc.updateHolding(exec3.exec, actor, {
        accountId,
        holdingId: bbb.id,
        quantity: "1",
        averageCostMinor: null,
        currentPriceMinor: 3000
      });
      await sleep(500);
      await locker.query("COMMIT");
      await Promise.all([reprice1, reprice2]);

      const after = await holdingsSvc.listHoldings(db(), actor, accountId);
      expect(holdingsSvc.summarizeHoldings(after).totalValueMinor).toBe(5000);
      expect(await balance(accountId)).toBe(5000);
    } finally {
      await locker.query("ROLLBACK").catch(() => {});
      locker.release();
      await pool.end();
      await exec2.close();
      await exec3.close();
    }
  });
});

describe("finding 2: same-day valuation precedence follows the active controller", () => {
  it("runs the reviewer's repro: holdings → manual → holdings keeps the holdings value", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);
    const today = todayIn("Etc/UTC");

    const { holdingId } = await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      quantity: "1",
      averageCostMinor: null,
      currentPriceMinor: 1000
    });
    expect(await balance(accountId)).toBe(1000);

    await holdingsSvc.deleteHolding(db(), actor, { accountId, holdingId });
    expect(await balance(accountId)).toBe(0);

    // Manual valuation recorded while holdings are inactive must win over
    // the stale zero holdings entry for today.
    await valuationsSvc.recordValuation(db(), actor, {
      accountId,
      date: today,
      amountDisplayMinor: 5000,
      kind: "current"
    });
    await recalculateAccount(db(), accountId, today);
    expect(await balance(accountId)).toBe(5000);

    // Re-adding the position re-activates holdings management: its write
    // for today must outrank the manual entry.
    const readded = await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      quantity: "1",
      averageCostMinor: null,
      currentPriceMinor: 1000
    });
    expect(await balance(accountId)).toBe(1000);

    // Removing it again writes zero for today, which likewise outranks
    // the earlier manual entry.
    await holdingsSvc.deleteHolding(db(), actor, { accountId, holdingId: readded.holdingId });
    expect(await balance(accountId)).toBe(0);

    // And a fresh manual valuation is authoritative again while inactive.
    await valuationsSvc.recordValuation(db(), actor, {
      accountId,
      date: today,
      amountDisplayMinor: 7000,
      kind: "current"
    });
    await recalculateAccount(db(), accountId, today);
    expect(await balance(accountId)).toBe(7000);
  });

  it("rejects entering holdings management while a future-dated manual valuation exists", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);
    const tomorrow = daysAgo(-1);

    const future = await valuationsSvc.recordValuation(db(), actor, {
      accountId,
      date: tomorrow,
      amountDisplayMinor: 5000,
      kind: "current"
    });

    await expect(
      holdingsSvc.addHolding(db(), actor, {
        accountId,
        ticker: "NABIL",
        quantity: "1",
        currentPriceMinor: 1000
      })
    ).rejects.toThrow(/in the future/);
    await expect(
      holdingsSvc.adjustHolding(db(), actor, {
        accountId,
        ticker: "NABIL",
        side: "buy",
        quantity: "1",
        priceMinor: 1000
      })
    ).rejects.toThrow(/in the future/);
    expect(await holdingsSvc.listHoldings(db(), actor, accountId)).toHaveLength(0);

    // Removing the future valuation unblocks activation.
    await valuationsSvc.deleteValuation(db(), actor, future.entryId);
    await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      quantity: "1",
      currentPriceMinor: 1000
    });
    expect(await balance(accountId)).toBe(1000);
  });
});

describe("finding 3: one valuation controller per account (MeroShare vs manual)", () => {
  const BOID = "1301000000000001";

  function installUpstream(): void {
    const fetchStub: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      void init;
      if (url.pathname.endsWith("/auth/")) {
        return new Response("{}", { status: 200, headers: { authorization: "Bearer test" } });
      }
      if (url.pathname.endsWith("/ownDetail/")) {
        return Response.json({ demat: BOID, clientCode: "CLIENT-1", name: "Asha Shrestha" });
      }
      if (url.pathname.endsWith("/myPortfolio/")) {
        return Response.json({
          totalItems: 1,
          totalValueOfLastTransPrice: "25062.50",
          meroShareMyPortfolio: [
            {
              script: "NABIL",
              scriptDesc: "Nabil Bank",
              currentBalance: "100",
              lastTransactionPrice: "250.625"
            }
          ]
        });
      }
      if (url.pathname.endsWith("/myTransaction/")) {
        return Response.json({ totalItems: 0, transactionView: [] });
      }
      if (url.pathname.endsWith("/waccReport/")) {
        return Response.json({
          waccReportResponse: [{ scrip: "NABIL", averageBuyRate: "250.625" }]
        });
      }
      return new Response("not found", { status: 404 });
    };
    vi.stubGlobal("fetch", fetchStub);
  }

  it("rejects manual holdings on a linked account, allows them after disconnect, and leaves manual accounts untouched by syncs", async () => {
    const user = await makeUser();
    const actor = actorOf(user);

    // A manual portfolio that exists before any MeroShare connection.
    const manualId = await makePortfolio(user, "Manual portfolio");
    await holdingsSvc.addHolding(db(), actor, {
      accountId: manualId,
      ticker: "HIDCL",
      quantity: "10",
      averageCostMinor: 100_00,
      currentPriceMinor: 120_00
    });
    expect(await balance(manualId)).toBe(120_000);

    installUpstream();
    const connected = await connectMeroShare(db(), actor, {
      clientId: 1,
      username: "demat-user",
      password: "pw",
      capital: { id: 1, code: "TEST", name: "Test Capital Ltd" }
    });
    const [meroAccount] = await db()
      .select()
      .from(meroShareAccounts)
      .where(eq(meroShareAccounts.connectionId, connected.connectionId));
    expect(meroAccount).toBeTruthy();
    const linkedId = meroAccount!.accountId;
    expect(await balance(linkedId)).toBe(2_506_250);

    // Manual mutations on the linked account are rejected, whichever path.
    await expect(
      holdingsSvc.addHolding(db(), actor, {
        accountId: linkedId,
        ticker: "API",
        quantity: "1",
        currentPriceMinor: 1000
      })
    ).rejects.toThrow(/linked to MeroShare/);
    await expect(
      holdingsSvc.adjustHolding(db(), actor, {
        accountId: linkedId,
        ticker: "API",
        side: "buy",
        quantity: "1",
        priceMinor: 1000
      })
    ).rejects.toThrow(/linked to MeroShare/);
    await expect(
      importHoldingsCsv(db(), actor, linkedId, "ticker,quantity,current_price\nAPI,1,10.00")
    ).rejects.toThrow(/linked to MeroShare/);

    // A later sync of the connection manages the linked account and does
    // not touch the manual portfolio.
    const synced = await syncMeroShareConnection(db(), actor, connected.connectionId);
    expect(synced.accounts).toBe(1);
    expect(await balance(linkedId)).toBe(2_506_250);
    expect(await balance(manualId)).toBe(120_000);
    const manualRows = await holdingsSvc.listHoldings(db(), actor, manualId);
    expect(manualRows).toHaveLength(1);
    expect(manualRows[0]).toMatchObject({ ticker: "HIDCL", quantity: "10" });

    // Disconnect removes the link; manual holdings are accepted again.
    await disconnectMeroShareConnection(db(), actor, connected.connectionId);
    await holdingsSvc.addHolding(db(), actor, {
      accountId: linkedId,
      ticker: "API",
      quantity: "1",
      currentPriceMinor: 1000
    });
    const linkedRows = await holdingsSvc.listHoldings(db(), actor, linkedId);
    expect(linkedRows).toHaveLength(1);
    expect(linkedRows[0]!.ticker).toBe("API");
  });
});

describe("finding 4: unknown cost stays unknown after a buy", () => {
  it("tracks the known-cost portion separately and clears partial only on explicit supply", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);

    await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      quantity: "100",
      averageCostMinor: null,
      currentPriceMinor: 500
    });
    let rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({ averageCostMinor: null, averageCostQuantity: "0" });
    let summary = holdingsSvc.summarizeHoldings(rows);
    expect(summary).toMatchObject({ totalCostMinor: null, partialCost: true });
    expect(summary.unrealizedGainMinor).toBeNull();

    // Buy 1 @ 200: the known portion becomes exactly that one share.
    await holdingsSvc.adjustHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      side: "buy",
      quantity: "1",
      priceMinor: 200
    });
    rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({
      quantity: "101",
      averageCostMinor: 200,
      averageCostQuantity: "1"
    });
    summary = holdingsSvc.summarizeHoldings(rows);
    expect(summary.totalValueMinor).toBe(101 * 500);
    expect(summary.totalCostMinor).toBe(200);
    expect(summary.partialCost).toBe(true);
    // Gain over the known share only: 500 − 200.
    expect(summary.unrealizedGainMinor).toBe(300);

    // Sells consume the unknown portion first: after selling 50, the one
    // known share remains; after selling 50 more, the position is exactly
    // the known share and is no longer partial.
    await holdingsSvc.adjustHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      side: "sell",
      quantity: "50",
      priceMinor: 500
    });
    rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({
      quantity: "51",
      averageCostMinor: 200,
      averageCostQuantity: "1"
    });
    await holdingsSvc.adjustHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      side: "sell",
      quantity: "50",
      priceMinor: 500
    });
    rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({
      quantity: "1",
      averageCostMinor: 200,
      averageCostQuantity: "1"
    });
    expect(holdingsSvc.summarizeHoldings(rows).partialCost).toBe(false);
  });

  it("an explicit whole-position cost on edit clears the partial state", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);

    await holdingsSvc.addHolding(db(), actor, {
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
    const rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(holdingsSvc.summarizeHoldings(rows).partialCost).toBe(true);

    await holdingsSvc.updateHolding(db(), actor, {
      accountId,
      holdingId: rows[0]!.id,
      quantity: "101",
      averageCostMinor: 300,
      currentPriceMinor: 500
    });
    const after = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(after[0]).toMatchObject({ averageCostMinor: 300, averageCostQuantity: "101" });
    const summary = holdingsSvc.summarizeHoldings(after);
    expect(summary.partialCost).toBe(false);
    expect(summary.totalCostMinor).toBe(101 * 300);
  });

  it("a first buy seeds cost for the whole new position", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);

    await holdingsSvc.adjustHolding(db(), actor, {
      accountId,
      ticker: "API",
      side: "buy",
      quantity: "10",
      priceMinor: 100
    });
    const rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({
      averageCostMinor: 100,
      averageCostQuantity: "10",
      currentPriceMinor: 100
    });
    expect(holdingsSvc.summarizeHoldings(rows).partialCost).toBe(false);
  });
});

describe("finding 5: an unpriceable position cannot publish a zero valuation", () => {
  it("rejects add with neither price and leaves the prior balance and manual control intact", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);

    await valuationsSvc.recordValuation(db(), actor, {
      accountId,
      date: daysAgo(1),
      amountDisplayMinor: 50_000,
      kind: "current"
    });
    await recalculateAccount(db(), accountId, daysAgo(1));
    expect(await balance(accountId)).toBe(50_000);

    await expect(
      holdingsSvc.addHolding(db(), actor, {
        accountId,
        ticker: "NABIL",
        quantity: "10",
        averageCostMinor: null,
        currentPriceMinor: null
      })
    ).rejects.toThrow(/at least one price/);
    expect(await holdingsSvc.listHoldings(db(), actor, accountId)).toHaveLength(0);
    expect(await balance(accountId)).toBe(50_000);

    // Manual valuations were not locked by the rejected mutation.
    await valuationsSvc.recordValuation(db(), actor, {
      accountId,
      date: daysAgo(0),
      amountDisplayMinor: 60_000,
      kind: "current"
    });
    await recalculateAccount(db(), accountId, daysAgo(0));
    expect(await balance(accountId)).toBe(60_000);
  });

  it("rejects an edit that would strip both prices, but accepts an explicit zero price", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);

    const { holdingId } = await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: 100_00,
      currentPriceMinor: null
    });
    await expect(
      holdingsSvc.updateHolding(db(), actor, {
        accountId,
        holdingId,
        quantity: "10",
        averageCostMinor: null,
        currentPriceMinor: null
      })
    ).rejects.toThrow(/at least one price/);
    const rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({ averageCostMinor: 100_00 });

    // An explicit zero is a real price: the position values at 0.
    await holdingsSvc.updateHolding(db(), actor, {
      accountId,
      holdingId,
      quantity: "10",
      averageCostMinor: null,
      currentPriceMinor: 0
    });
    expect(await balance(accountId)).toBe(0);
  });

  it("rejects a CSV row that would create a holding with neither price", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);

    const result = await importHoldingsCsv(db(), actor, accountId, "ticker,quantity\nZZZ,5");
    expect(result.created).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.row).toBe(2);
    expect(await holdingsSvc.listHoldings(db(), actor, accountId)).toHaveLength(0);
  });
});

describe("finding 6: sparse CSV updates preserve existing prices", () => {
  it("an omitted price column preserves prices; a blank cell clears only that price; clearing both is a row error", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);

    await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "ABC",
      quantity: "10",
      averageCostMinor: 1000,
      currentPriceMinor: 2000
    });
    expect(await balance(accountId)).toBe(20_000);

    // Sparse update: only the quantity is dictated. Prices are preserved;
    // the cost stays known for the original 10 shares only — a quantity
    // increase never fabricates cost basis for the extra shares.
    const sparse = await importHoldingsCsv(db(), actor, accountId, "ticker,quantity\nABC,20");
    expect(sparse).toMatchObject({ created: 0, updated: 1, errors: [] });
    let rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({
      quantity: "20",
      averageCostMinor: 1000,
      averageCostQuantity: "10",
      currentPriceMinor: 2000
    });
    expect(holdingsSvc.summarizeHoldings(rows).partialCost).toBe(true);
    expect(await balance(accountId)).toBe(40_000);

    // Blank average-cost cell clears just the cost; the price remains.
    const cleared = await importHoldingsCsv(
      db(),
      actor,
      accountId,
      "ticker,quantity,average_cost,current_price\nABC,20,,30.00"
    );
    expect(cleared).toMatchObject({ created: 0, updated: 1, errors: [] });
    rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({
      quantity: "20",
      averageCostMinor: null,
      averageCostQuantity: "0",
      currentPriceMinor: 3000
    });
    expect(await balance(accountId)).toBe(60_000);

    // Blanking both prices is a row error and changes nothing.
    const both = await importHoldingsCsv(
      db(),
      actor,
      accountId,
      "ticker,quantity,average_cost,current_price\nABC,25,,"
    );
    expect(both.updated).toBe(0);
    expect(both.errors).toHaveLength(1);
    expect(both.errors[0]!.row).toBe(2);
    rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({
      quantity: "20",
      averageCostMinor: null,
      currentPriceMinor: 3000
    });
    expect(await balance(accountId)).toBe(60_000);
  });

  it("a sparse quantity reduction clamps the known-cost quantity", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makePortfolio(user);

    await holdingsSvc.addHolding(db(), actor, {
      accountId,
      ticker: "DEF",
      quantity: "100",
      averageCostMinor: 500,
      currentPriceMinor: 600
    });
    const result = await importHoldingsCsv(db(), actor, accountId, "ticker,quantity\nDEF,40");
    expect(result).toMatchObject({ created: 0, updated: 1, errors: [] });
    const rows = await holdingsSvc.listHoldings(db(), actor, accountId);
    expect(rows[0]).toMatchObject({
      quantity: "40",
      averageCostMinor: 500,
      averageCostQuantity: "40",
      currentPriceMinor: 600
    });
    expect(await balance(accountId)).toBe(24_000);
    expect(holdingsSvc.summarizeHoldings(rows).partialCost).toBe(false);
  });
});

describe("finding 7: restore applies canonical holdings invariants", () => {
  function encode(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
  }

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

  async function familyAccountCount(familyId: string): Promise<number> {
    const res = await db().execute(sql`
      SELECT count(*)::text AS n FROM accounts WHERE family_id = ${familyId}::uuid
    `);
    return Number((res.rows as { n: string }[])[0]!.n);
  }

  async function buildTamperableExport(user: TestUser) {
    const actor = actorOf(user);
    const brokerage = await makeAccount(user, {
      name: "Restore Brokerage",
      type: "other_asset",
      openingBalanceDisplayMinor: 0
    });
    await holdingsSvc.addHolding(db(), actor, {
      accountId: brokerage,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: 100_00,
      currentPriceMinor: 120_00
    });
    const exported = await exportsSvc.buildFamilyExport(db(), actor);
    return JSON.parse(JSON.stringify(exported)) as {
      holdings: {
        id: string;
        accountId: string;
        ticker: string;
        quantity: string;
        averageCostQuantity?: string;
      }[];
    };
  }

  it("rejects a case-collision export atomically (ABC + abc)", async () => {
    const user = await makeUser({ familyName: "CaseCollisionFamily" });
    const actor = actorOf(user);
    const tampered = await buildTamperableExport(user);
    tampered.holdings.push({
      ...tampered.holdings[0]!,
      id: "00000000-0000-4000-8000-000000000001",
      ticker: "nabil"
    });
    await wipeFamilyData(user.familyId);
    await expect(
      importFamilyExport(db(), actor, parseFamilyExport(encode(tampered)))
    ).rejects.toThrow(/same ticker/);
    // Nothing committed: the destination household is still empty.
    expect(await familyAccountCount(user.familyId)).toBe(0);
  });

  it("rejects a zero-quantity holding and an over-precise quantity at parse time", async () => {
    const user = await makeUser({ familyName: "ZeroQuantityFamily" });
    const zeroed = await buildTamperableExport(user);
    zeroed.holdings[0]!.quantity = "0";
    expect(() => parseFamilyExport(encode(zeroed))).toThrow(/zero quantity/);

    const precise = await buildTamperableExport(user);
    precise.holdings[0]!.quantity = "1.0000001";
    expect(() => parseFamilyExport(encode(precise))).toThrow(/invalid quantity/);
  });

  it("derives cost provenance for exports written before the field existed", async () => {
    const user = await makeUser({ familyName: "LegacyExportFamily" });
    const actor = actorOf(user);
    const legacy = await buildTamperableExport(user);
    delete legacy.holdings[0]!.averageCostQuantity;
    await wipeFamilyData(user.familyId);
    const result = await importFamilyExport(db(), actor, parseFamilyExport(encode(legacy)));
    expect(result.holdings).toBe(1);
    const [restored] = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.familyId, user.familyId));
    const rows = await holdingsSvc.listHoldings(db(), actor, restored!.id);
    expect(rows[0]).toMatchObject({
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: 100_00,
      averageCostQuantity: "10"
    });
  });
});
