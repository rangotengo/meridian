import { describe, it, expect, beforeAll } from "vitest";
import { db, makeUser, makeAccount, addTxn, truncateAll, actorOf, latestBalance } from "../helpers";
import * as accountsSvc from "@/server/domain/accounts";
import * as valuationsSvc from "@/server/domain/valuations";
import * as trackingSvc from "@/server/domain/balance-tracking";
import { recalculateAccount } from "@/server/domain/balances";

beforeAll(async () => {
  await truncateAll();
});

async function displayOf(user: Awaited<ReturnType<typeof makeUser>>, accountId: string) {
  const items = await accountsSvc.listAccountsForActor(db(), actorOf(user));
  return items.find((a) => a.id === accountId)?.displayBalanceMinor;
}

/**
 * Regression: entries dated before an account's openedOn were silently
 * dropped by full rebuilds (recalculateAccount with no fromDate starts at
 * openedOn), while write-path recalcs (which pass fromDate) counted them.
 * The displayed balance therefore flipped between correct and zero
 * depending on which recalc ran last — the nightly rebuild zeroed every
 * flipped Sure loan, whose history predates its Meridian opening date.
 * The recalc window is now anchored at the account's earliest entry, and
 * the flip plan / preview count the same history.
 */
describe("balances: entries predating openedOn", () => {
  it("a pre-openedOn transaction survives a full rebuild", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Pre-opened txn",
      currency: "NPR",
      openedOn: "2026-08-11",
      openingBalanceDisplayMinor: 0,
      balanceTracking: "transactions"
    });
    await addTxn(user, accountId, {
      date: "2026-05-27",
      name: "Original principal",
      amountLedgerMinor: -600_000
    });
    expect(await displayOf(user, accountId)).toBe(600_000);
    // Nightly shape: full rebuild with no fromDate.
    await recalculateAccount(db(), accountId);
    expect(await displayOf(user, accountId)).toBe(600_000);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(600_000);
  });

  it("one +6,000 inflow on the opening date shows 6,000 after a full rebuild", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Screenshot shape",
      currency: "NPR",
      openedOn: "2026-05-27",
      openingBalanceDisplayMinor: 0,
      balanceTracking: "transactions"
    });
    await addTxn(user, accountId, {
      date: "2026-05-27",
      name: "Original principal",
      amountLedgerMinor: -600_000
    });
    await recalculateAccount(db(), accountId);
    expect(await displayOf(user, accountId)).toBe(600_000);
  });

  it("flipping a loan with pre-openedOn history converts the right plug and balance", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Pre-opened flip",
      currency: "NPR",
      openedOn: "2026-08-11",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: "2026-05-27",
      amountDisplayMinor: 1_300_000,
      kind: "opening",
      name: "Original principal"
    });
    await addTxn(user, accountId, {
      date: "2026-04-01",
      name: "Earlier inflow",
      amountLedgerMinor: -700_000
    });
    const preview = await trackingSvc.previewBalanceTracking(
      db(),
      actorOf(user),
      accountId,
      "transactions"
    );
    expect(preview.openingTransactionAmountMinor).toBe(-600_000);
    expect(preview.resultingBalanceMinor).toBe(1_300_000);
    const res = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(res.openingTransactionAmountMinor).toBe(-600_000);
    expect(res.resultingBalanceMinor).toBe(1_300_000);
    // And the nightly full rebuild must not move it.
    await recalculateAccount(db(), accountId);
    expect(await displayOf(user, accountId)).toBe(1_300_000);
  });
});
