import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, makeUser, makeAccount, addTxn, truncateAll, actorOf, latestBalance } from "../helpers";
import * as valuationsSvc from "@/server/domain/valuations";
import * as balancesSvc from "@/server/domain/balances";
import * as trackingSvc from "@/server/domain/balance-tracking";
import { accounts as accountsTable, auditEvents } from "@/server/db/schema";

beforeAll(async () => {
  await truncateAll();
});

// A loan with two valuations: the 150,000 anchor and a 200,000 current
// value. Flipping to transactions preserves the 200,000 balance; flipping
// back without acknowledgement must be rejected because the flip removed
// the valuations and the balance would fall back to the opening balance.
async function makeTwoValuationLoan(user: Awaited<ReturnType<typeof makeUser>>): Promise<string> {
  const accountId = await makeAccount(user, {
    type: "other_asset",
    name: "Guard loan",
    currency: "NPR",
    openedOn: "2025-09-25",
    openingBalanceDisplayMinor: 0
  });
  await valuationsSvc.recordValuation(db(), actorOf(user), {
    accountId,
    date: "2025-09-25",
    amountDisplayMinor: 15_000_000,
    kind: "opening",
    name: "Original principal"
  });
  await valuationsSvc.recordValuation(db(), actorOf(user), {
    accountId,
    date: "2026-06-27",
    amountDisplayMinor: 20_000_000,
    kind: "current",
    name: "Current value"
  });
  // A post-anchor lend: the flip converts the 150,000 anchor into the
  // opening transaction, and this transaction carries the extra 50,000,
  // so the flip preserves the 200,000 balance. (Without it the flip
  // would land on the anchor's 150,000 — the later valuation's increase
  // has no transaction to represent it.)
  await addTxn(user, accountId, {
    date: "2026-01-15",
    name: "Lent",
    amountLedgerMinor: -5_000_000
  });
  await balancesSvc.recalculateAccount(db(), accountId);
  expect((await latestBalance(accountId))?.balanceMinor).toBe(20_000_000);
  await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
    accountId,
    to: "transactions"
  });
  expect((await latestBalance(accountId))?.balanceMinor).toBe(20_000_000);
  return accountId;
}

async function trackingMode(accountId: string): Promise<string | null> {
  const [row] = await db()
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId))
    .limit(1);
  return row?.balanceTracking ?? null;
}

describe("balance tracking: destructive flip-back requires acknowledgement", () => {
  it("rejects switching back with no valuations left and a nonzero balance", async () => {
    const user = await makeUser();
    const accountId = await makeTwoValuationLoan(user);
    await expect(
      trackingSvc.switchBalanceTracking(db(), actorOf(user), {
        accountId,
        to: "valuation"
      })
    ).rejects.toThrow(/no valuations left/);
    // Nothing changed: still transaction-tracked at the preserved balance.
    expect(await trackingMode(accountId)).toBe("transactions");
    expect((await latestBalance(accountId))?.balanceMinor).toBe(20_000_000);
  });

  it("allows the same switch with an explicit acknowledgement, then a new valuation restores the balance", async () => {
    const user = await makeUser();
    const accountId = await makeTwoValuationLoan(user);
    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "valuation",
      acknowledgeDataLoss: true
    });
    expect(result.resultingBalanceMinor).toBe(0);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(0);
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: "2026-10-01",
      amountDisplayMinor: 19_000_000,
      kind: "current",
      name: "Restated value"
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(19_000_000);
  });

  it("allows switching back without acknowledgement when the balance is already zero", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Empty loan",
      currency: "NPR",
      openedOn: "2025-09-25",
      openingBalanceDisplayMinor: 0
    });
    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect((await latestBalance(accountId))?.balanceMinor).toBe(0);
    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "valuation"
    });
    expect(result.resultingBalanceMinor).toBe(0);
    expect(await trackingMode(accountId)).toBe("valuation");
  });

  it("preserves the removed valuations in the flip's audit event", async () => {
    const user = await makeUser();
    const accountId = await makeTwoValuationLoan(user);
    const audits = await db()
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "account.balance_tracking_changed"),
          eq(auditEvents.entityId, accountId)
        )
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      from: "valuation",
      to: "transactions",
      removedValuations: 1,
      convertedValuation: {
        date: "2025-09-25",
        amountMinor: 15_000_000,
        name: "Original principal",
        kind: "opening"
      },
      removedValuationsDetail: [
        {
          date: "2026-06-27",
          amountMinor: 20_000_000,
          name: "Current value",
          kind: "current"
        }
      ]
    });
  });
});
