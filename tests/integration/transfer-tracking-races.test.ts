import { beforeEach, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { actorOf, addTxn, daysAgo, db, makeAccount, makeUser, truncateAll } from "../helpers";
import { recordValuation } from "@/server/domain/valuations";
import { recalculateAccount } from "@/server/domain/balances";
import { switchBalanceTracking } from "@/server/domain/balance-tracking";
import { createTransferFromTransactions } from "@/server/domain/transfers";

beforeEach(async () => truncateAll());

async function waitForQueued(count: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await db().execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event='advisory'
    `);
    if (Number(result.rows[0]!.n) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${count} writers to reach the account lock`);
}

it.each(["link", "switch"] as const)(
  "keeps transfer legs balanced when %s queues first",
  async (first) => {
    const user = await makeUser({ timezone: "UTC" });
    const actor = actorOf(user);
    const loan = await makeAccount(user, {
      type: "other_asset",
      openedOn: daysAgo(5),
      openingBalanceDisplayMinor: 0
    });
    const bank = await makeAccount(user, {
      type: "depository",
      openedOn: daysAgo(5),
      openingBalanceDisplayMinor: 1000
    });
    const old = await recordValuation(db(), actor, {
      accountId: loan,
      date: daysAgo(1),
      amountDisplayMinor: 1000
    });
    await switchBalanceTracking(db(), actor, { accountId: loan, to: "transactions" });
    const out = await addTxn(user, bank, {
      date: daysAgo(1),
      name: "Funding",
      amountLedgerMinor: 1000
    });
    await switchBalanceTracking(db(), actor, {
      accountId: loan,
      to: "valuation",
      acknowledgeDataLoss: true
    });
    await recordValuation(db(), actor, {
      accountId: loan,
      date: daysAgo(3),
      amountDisplayMinor: 1000
    });
    await recalculateAccount(db(), loan);

    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const locker = await pool.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`holdings-account:${loan}`]);
    let released = false;
    const release = async () => {
      if (!released) {
        released = true;
        await locker.query("ROLLBACK");
      }
    };
    const pending: Promise<unknown>[] = [];
    const start = (operation: typeof first) => {
      const promise =
        operation === "link"
          ? createTransferFromTransactions(db(), actor, out, old.entryId)
          : switchBalanceTracking(db(), actor, { accountId: loan, to: "transactions" });
      void promise.catch(() => {});
      pending.push(promise);
      return promise;
    };
    try {
      const one = start(first);
      await waitForQueued(1);
      const two = start(first === "link" ? "switch" : "link");
      await waitForQueued(2);
      await release();
      const results = await Promise.allSettled([one, two]);
      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      const transfers = await db().execute<{ sum_minor: string }>(sql`
      SELECT (a.amount_minor+b.amount_minor)::text AS sum_minor FROM transfers t
      JOIN entries a ON a.id=t.outflow_entry_id JOIN entries b ON b.id=t.inflow_entry_id
    `);
      expect(transfers.rows).toHaveLength(first === "link" ? 1 : 0);
      for (const row of transfers.rows) expect(Number(row.sum_minor)).toBe(0);
      const legs = await db().execute<{ id: string; amount_minor: string }>(sql`
      SELECT id, amount_minor::text AS amount_minor FROM entries WHERE id IN (${out},${old.entryId})
    `);
      expect(Number(legs.rows.find((row) => row.id === out)!.amount_minor)).toBe(1000);
      expect(Number(legs.rows.find((row) => row.id === old.entryId)!.amount_minor)).toBe(
        first === "link" ? -1000 : 0
      );
    } finally {
      await release();
      await Promise.allSettled(pending);
      locker.release();
      await pool.end();
    }
  }
);
