import { beforeEach, describe, expect, it } from "vitest";
import { db, makeAccount, makeUser, truncateAll, actorOf } from "../helpers";
import { listAccountsForActor, updateAccount } from "@/server/domain/accounts";
import { ledgerToDisplayBalance } from "@/lib/money";
import { planPayoff } from "@/lib/payoff";

describe("debt payoff", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("stores a loan rate on the account and plans from its live balance", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const loanId = await makeAccount(user, {
      type: "other_liability",
      name: "Car loan",
      currency: "NPR",
      openingBalanceDisplayMinor: 1_200_000,
      balanceTracking: "transactions"
    });

    const listed = await listAccountsForActor(db(), actor);
    const loan = listed.find((a) => a.id === loanId);
    expect(loan).toBeDefined();
    // listAccountsForActor returns the ledger balance (negative for a
    // liability); the planner reads the display balance (amount owed).
    expect(loan!.displayBalanceMinor).toBe(-1_200_000);
    expect(ledgerToDisplayBalance(loan!.displayBalanceMinor, loan!.type)).toBe(1_200_000);
    expect(loan!.interestRateBps).toBeNull();

    await updateAccount(db(), actor, loanId, { interestRateBps: 1200 });
    const relisted = await listAccountsForActor(db(), actor);
    expect(relisted.find((a) => a.id === loanId)!.interestRateBps).toBe(1200);

    const comparison = planPayoff({
      balanceMinor: ledgerToDisplayBalance(loan!.displayBalanceMinor, loan!.type),
      annualRateBps: 1200,
      monthlyPaymentMinor: 100_000,
      extraMonthlyPaymentMinor: 50_000,
      fromMonth: "2026-11"
    });
    expect(comparison.base.payoffMonths).toBe(13);
    expect(comparison.interestSavedMinor).toBe(27_636);
  });

  it("rejects out-of-range rates and clears a rate with null", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const loanId = await makeAccount(user, {
      type: "other_liability",
      name: "Car loan",
      currency: "NPR",
      openingBalanceDisplayMinor: 100_000,
      balanceTracking: "transactions"
    });

    await expect(updateAccount(db(), actor, loanId, { interestRateBps: 100001 })).rejects.toThrow();
    await expect(updateAccount(db(), actor, loanId, { interestRateBps: -1 })).rejects.toThrow();
    await expect(updateAccount(db(), actor, loanId, { interestRateBps: 12.5 })).rejects.toThrow();

    await updateAccount(db(), actor, loanId, { interestRateBps: 1250 });
    await updateAccount(db(), actor, loanId, { interestRateBps: null });
    const relisted = await listAccountsForActor(db(), actor);
    expect(relisted.find((a) => a.id === loanId)!.interestRateBps).toBeNull();
  });

  it("excludes non-loan accounts from the loan list", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    await makeAccount(user, { type: "depository", name: "Savings", currency: "NPR" });
    const loanId = await makeAccount(user, {
      type: "other_liability",
      name: "Car loan",
      currency: "NPR",
      openingBalanceDisplayMinor: 500_000,
      balanceTracking: "transactions"
    });
    const loans = (await listAccountsForActor(db(), actor)).filter(
      (a) => a.type === "other_liability" && a.status === "active"
    );
    expect(loans.map((a) => a.id)).toEqual([loanId]);
  });
});
