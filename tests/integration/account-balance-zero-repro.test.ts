import { describe, it, expect, beforeAll } from "vitest";
import {
  db,
  makeUser,
  makeAccount,
  addTxn,
  truncateAll,
  actorOf,
  latestBalance,
  daysAgo
} from "../helpers";
import * as accountsSvc from "@/server/domain/accounts";
import * as valuationsSvc from "@/server/domain/valuations";
import { recalculateAccount } from "@/server/domain/balances";

beforeAll(async () => {
  await truncateAll();
});

describe("account balances after UI polish (zero-balance report)", () => {
  it("depository with nonzero opening balance plus transactions shows opening minus net outflow", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "depository",
      name: "NPR Checking",
      currency: "NPR",
      openedOn: daysAgo(30),
      openingBalanceDisplayMinor: 50_000_000 // NPR 500,000
    });
    // NPR 120,000 expense (outflow-positive) yesterday.
    await addTxn(user, accountId, {
      date: daysAgo(1),
      name: "Groceries",
      amountLedgerMinor: 12_000_000
    });
    // NPR 50,000 income today.
    await addTxn(user, accountId, {
      date: daysAgo(0),
      name: "Salary",
      amountLedgerMinor: -5_000_000
    });

    // Expected: 50,000,000 - 12,000,000 - (-5,000,000) = 43,000,000 (NPR 430,000).
    const latest = await latestBalance(accountId);
    expect(latest?.balanceMinor).toBe(43_000_000);

    const items = await accountsSvc.listAccountsForActor(db(), actorOf(user));
    const item = items.find((a) => a.id === accountId);
    expect(item?.displayBalanceMinor).toBe(43_000_000);
  });

  it("credit card with nonzero opening balance plus a payment shows the reduced balance", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "credit_card",
      name: "NPR Card",
      currency: "NPR",
      openedOn: daysAgo(30),
      openingBalanceDisplayMinor: 20_000_000 // NPR 200,000 owed
    });
    await addTxn(user, accountId, {
      date: daysAgo(1),
      name: "Card payment",
      amountLedgerMinor: -8_000_000 // NPR 80,000 paid in
    });
    // Liability sign convention: the opening display balance of NPR 200,000
    // owed stores as -20,000,000 ledger minor; the NPR 80,000 payment
    // (-8,000,000 ledger) reduces what is owed to -12,000,000.
    const items = await accountsSvc.listAccountsForActor(db(), actorOf(user));
    expect(items.find((a) => a.id === accountId)?.displayBalanceMinor).toBe(-12_000_000);
  });

  it("valuation-tracked loan account shows its latest valuation", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Loan",
      currency: "NPR",
      openedOn: "2025-09-25",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: "2025-09-25",
      amountDisplayMinor: 15_000_000,
      kind: "opening",
      name: "Principal"
    });
    // The app server action recalculates after recording a valuation; the
    // domain writer alone does not, so mirror the action layer here.
    await recalculateAccount(db(), accountId, "2025-09-25");
    const items = await accountsSvc.listAccountsForActor(db(), actorOf(user));
    expect(items.find((a) => a.id === accountId)?.displayBalanceMinor).toBe(15_000_000);
  });
});
