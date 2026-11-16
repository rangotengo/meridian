import { describe, it, expect, beforeAll } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db, makeUser, makeAccount, truncateAll, actorOf, latestBalance } from "../helpers";
import * as valuationsSvc from "@/server/domain/valuations";
import * as trackingSvc from "@/server/domain/balance-tracking";
import * as holdingsSvc from "@/server/domain/holdings";
import {
  accounts as accountsTable,
  entries as entriesTable,
  portfolioHoldings as holdingsTable
} from "@/server/db/schema";

/**
 * Held-lock races between the balance-tracking switch and the writers it
 * serializes with (Finding: switches used a private advisory key while
 * holdings/valuation writers took holdings-account:<id>, and the writers'
 * mode guards ran before they queued on the lock — so a writer blocked
 * on the lock proceeded from a stale snapshot after a switch committed).
 *
 * Each test parks a third party on the account's advisory lock, starts
 * the writer and the switch so BOTH queue behind it, then releases.
 * Whichever acquires the lock first, the end state must be consistent:
 * the loser re-resolves the mode inside the lock and either converts
 * what the winner wrote (valuation writer) or is rejected (holdings
 * writer / switch). PostgreSQL only — the cloud backend serializes the
 * Durable Object instead of using advisory locks, and this file is not
 * part of the cloud suite.
 */

beforeAll(async () => {
  await truncateAll();
});

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is missing in test environment");

/** Hold the account's advisory lock on a dedicated session until released. */
async function holdAccountLock(accountId: string): Promise<() => Promise<void>> {
  const client = postgres(DATABASE_URL!, { max: 1 });
  const key = `holdings-account:${accountId}`;
  await client`SELECT pg_advisory_lock(hashtext(${key}))`;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await client`SELECT pg_advisory_unlock(hashtext(${key}))`;
    await client.end();
  };
}

const poller = postgres(DATABASE_URL, { max: 1 });

async function waitForBlockedWriters(count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await poller<{ n: string }[]>`
      SELECT CAST(count(*) AS TEXT) AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
    `;
    if (Number(rows[0]?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${count} blocked advisory lock request(s).`);
}

async function accountMode(accountId: string): Promise<string> {
  const [row] = await db()
    .select({ balanceTracking: accountsTable.balanceTracking })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));
  return row!.balanceTracking;
}

async function valuationCount(accountId: string): Promise<number> {
  const all = await db().select().from(entriesTable).where(eq(entriesTable.accountId, accountId));
  return all.filter((r) => r.entryableType === "valuation").length;
}

async function holdingCount(accountId: string): Promise<number> {
  const rows = await db()
    .select({ id: holdingsTable.id })
    .from(holdingsTable)
    .where(eq(holdingsTable.accountId, accountId));
  return rows.length;
}

describe("balance tracking: switch/writer lock races", () => {
  it("recordValuation queued first: a switch behind it converts the valuation or the write is rejected — never a valuation on a transaction-tracked account", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Race loan (valuation first)",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    const release = await holdAccountLock(accountId);
    try {
      const writer = valuationsSvc.recordValuation(db(), actorOf(user), {
        accountId,
        date: "2026-02-01",
        amountDisplayMinor: 100_000
      });
      void writer.catch(() => {});
      await waitForBlockedWriters(1);
      const switching = trackingSvc.switchBalanceTracking(db(), actorOf(user), {
        accountId,
        to: "transactions"
      });
      void switching.catch(() => {});
      await waitForBlockedWriters(2);
      await release();
      const [writerResult, switchResult] = await Promise.allSettled([writer, switching]);

      expect(switchResult.status).toBe("fulfilled");
      if (writerResult.status === "rejected") {
        expect(writerResult.reason).toMatchObject({ code: "validation.failed" });
      }
      expect(await accountMode(accountId)).toBe("transactions");
      expect(await valuationCount(accountId)).toBe(0);
      // If the valuation landed first, the switch converted it (balance
      // 100,000); if the switch won, the write was rejected (balance 0).
      expect((await latestBalance(accountId))?.balanceMinor).toBe(
        writerResult.status === "fulfilled" ? 100_000 : 0
      );
    } finally {
      await release().catch(() => {});
    }
  });

  it("recordValuation queued behind a blocked switch: the in-lock mode re-check rejects it", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Race loan (switch first)",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    const release = await holdAccountLock(accountId);
    try {
      const switching = trackingSvc.switchBalanceTracking(db(), actorOf(user), {
        accountId,
        to: "transactions"
      });
      void switching.catch(() => {});
      await waitForBlockedWriters(1);
      // The mode check outside the lock still passes — the account is
      // valuation-tracked until the switch commits — so this writer
      // queues behind the switch and must be stopped inside the lock.
      const writer = valuationsSvc.recordValuation(db(), actorOf(user), {
        accountId,
        date: "2026-02-01",
        amountDisplayMinor: 100_000
      });
      void writer.catch(() => {});
      await waitForBlockedWriters(2);
      await release();
      const [switchResult, writerResult] = await Promise.allSettled([switching, writer]);

      expect(switchResult.status).toBe("fulfilled");
      if (writerResult.status === "rejected") {
        expect(writerResult.reason).toMatchObject({ code: "validation.failed" });
      }
      expect(await accountMode(accountId)).toBe("transactions");
      expect(await valuationCount(accountId)).toBe(0);
      expect((await latestBalance(accountId))?.balanceMinor).toBe(
        writerResult.status === "fulfilled" ? 100_000 : 0
      );
    } finally {
      await release().catch(() => {});
    }
  });

  it("addHolding queued first: the switch must lose, and the account keeps exactly one controller", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Race portfolio (holding first)",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    const release = await holdAccountLock(accountId);
    try {
      const writer = holdingsSvc.addHolding(db(), actorOf(user), {
        accountId,
        ticker: "NABIL",
        quantity: "10",
        averageCostMinor: null,
        currentPriceMinor: 100
      });
      void writer.catch(() => {});
      await waitForBlockedWriters(1);
      const switching = trackingSvc.switchBalanceTracking(db(), actorOf(user), {
        accountId,
        to: "transactions"
      });
      void switching.catch(() => {});
      await waitForBlockedWriters(2);
      await release();
      const [writerResult, switchResult] = await Promise.allSettled([writer, switching]);

      // Exactly one of them may commit.
      expect(writerResult.status === "fulfilled").not.toBe(switchResult.status === "fulfilled");
      if (writerResult.status === "fulfilled") {
        expect(switchResult.status).toBe("rejected");
        if (switchResult.status === "rejected") {
          expect(switchResult.reason).toMatchObject({ code: "conflict" });
        }
        expect(await accountMode(accountId)).toBe("valuation");
        expect(await holdingCount(accountId)).toBe(1);
      } else {
        expect(writerResult.status).toBe("rejected");
        if (writerResult.status === "rejected") {
          expect(writerResult.reason).toMatchObject({ code: "validation.failed" });
        }
        expect(await accountMode(accountId)).toBe("transactions");
        expect(await holdingCount(accountId)).toBe(0);
      }
    } finally {
      await release().catch(() => {});
    }
  });

  it("addHolding queued behind a blocked switch: the in-lock re-check rejects it", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Race portfolio (switch first)",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    const release = await holdAccountLock(accountId);
    try {
      const switching = trackingSvc.switchBalanceTracking(db(), actorOf(user), {
        accountId,
        to: "transactions"
      });
      void switching.catch(() => {});
      await waitForBlockedWriters(1);
      const writer = holdingsSvc.addHolding(db(), actorOf(user), {
        accountId,
        ticker: "NABIL",
        quantity: "10",
        averageCostMinor: null,
        currentPriceMinor: 100
      });
      void writer.catch(() => {});
      await waitForBlockedWriters(2);
      await release();
      const [switchResult, writerResult] = await Promise.allSettled([switching, writer]);

      expect(switchResult.status === "fulfilled").not.toBe(writerResult.status === "fulfilled");
      if (switchResult.status === "fulfilled") {
        expect(writerResult.status).toBe("rejected");
        if (writerResult.status === "rejected") {
          expect(writerResult.reason).toMatchObject({ code: "validation.failed" });
        }
        expect(await accountMode(accountId)).toBe("transactions");
        expect(await holdingCount(accountId)).toBe(0);
        expect(await valuationCount(accountId)).toBe(0);
      } else {
        expect(switchResult.status).toBe("rejected");
        if (switchResult.status === "rejected") {
          expect(switchResult.reason).toMatchObject({ code: "conflict" });
        }
        expect(await accountMode(accountId)).toBe("valuation");
        expect(await holdingCount(accountId)).toBe(1);
      }
    } finally {
      await release().catch(() => {});
    }
  });
});
