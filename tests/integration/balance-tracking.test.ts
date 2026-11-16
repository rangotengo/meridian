import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  addTxn,
  truncateAll,
  actorOf,
  latestBalance,
  joinFamily
} from "../helpers";
import * as accountsSvc from "@/server/domain/accounts";
import * as valuationsSvc from "@/server/domain/valuations";
import * as balancesSvc from "@/server/domain/balances";
import * as trackingSvc from "@/server/domain/balance-tracking";
import * as orchestrate from "@/server/domain/orchestrate";
import * as exportsSvc from "@/server/domain/exports";
import { importFamilyExport, parseFamilyExport } from "@/server/domain/family-import";
import {
  accounts as accountsTable,
  auditEvents,
  entries as entriesTable,
  meroShareAccounts,
  meroShareConnections
} from "@/server/db/schema";

beforeAll(async () => {
  await truncateAll();
});

/**
 * The production shape that motivated this feature (amounts in NPR minor
 * units): a Sure-imported loan whose principal is a valuation and whose
 * lending/repayment history is ordinary transactions. Ledger amounts are
 * outflow-positive, so "Lent" (balance impact +60,000) stores −6,000,000.
 */
async function makeIshowerLoan(user: Awaited<ReturnType<typeof makeUser>>): Promise<string> {
  const accountId = await makeAccount(user, {
    type: "other_asset",
    name: "Ishower da",
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
  await addTxn(user, accountId, {
    date: "2025-12-18",
    name: "Repayed",
    amountLedgerMinor: 5_000_000
  });
  await addTxn(user, accountId, {
    date: "2026-04-24",
    name: "Lent",
    amountLedgerMinor: -6_000_000
  });
  await addTxn(user, accountId, {
    date: "2026-06-27",
    name: "Pokhara expense",
    amountLedgerMinor: -3_755_000
  });
  await addTxn(user, accountId, {
    date: "2026-09-18",
    name: "expense",
    amountLedgerMinor: -245_000
  });
  await balancesSvc.recalculateAccount(db(), accountId);
  return accountId;
}

async function entriesOf(accountId: string) {
  return db()
    .select()
    .from(entriesTable)
    .where(eq(entriesTable.accountId, accountId))
    .orderBy(entriesTable.date, entriesTable.createdAt);
}

describe("balance tracking: engine modes", () => {
  it("valuation mode ignores transactions; transaction mode sums them", async () => {
    const user = await makeUser();
    const accountId = await makeIshowerLoan(user);

    // Frozen at the principal valuation, exactly as production showed.
    expect((await latestBalance(accountId))?.balanceMinor).toBe(15_000_000);

    const preview = await trackingSvc.previewBalanceTracking(
      db(),
      actorOf(user),
      accountId,
      "transactions"
    );
    expect(preview.currentBalanceMinor).toBe(15_000_000);
    expect(preview.resultingBalanceMinor).toBe(20_000_000);
    expect(preview.valuationCount).toBe(1);
    expect(preview.earliestValuationDate).toBe("2025-09-25");
    expect(preview.meroshareLinked).toBe(false);

    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(result.resultingBalanceMinor).toBe(20_000_000);
    expect(result.convertedValuationDate).toBe("2025-09-25");
    expect(result.removedValuations).toBe(0);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(20_000_000);

    const rows = await entriesOf(accountId);
    const valuations = rows.filter((r) => r.entryableType === "valuation");
    expect(valuations).toHaveLength(0);
    const opening = rows.find((r) => r.name === "Original principal");
    expect(opening?.entryableType).toBe("transaction");
    expect(opening?.date).toBe("2025-09-25");
    // Stored as the negated valuation amount: its balance impact is +150,000.
    expect(opening?.amountMinor).toBe(-15_000_000);

    const overview = await accountsSvc.getAccountOverview(db(), actorOf(user), accountId);
    expect(overview.valuationDriven).toBe(false);
    expect(overview.displayBalanceMinor).toBe(20_000_000);
  });

  it("a settling transfer zeroes the loan after the switch (Dawa shape)", async () => {
    const user = await makeUser();
    const loanId = await makeAccount(user, {
      type: "other_asset",
      name: "Dawa dai",
      currency: "NPR",
      openedOn: "2026-07-06",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId: loanId,
      date: "2026-07-06",
      amountDisplayMinor: 3_000_000,
      kind: "opening",
      name: "Original principal"
    });
    const nabilId = await makeAccount(user, {
      type: "depository",
      name: "Nabil Bank",
      currency: "NPR",
      openedOn: "2026-07-06"
    });
    await orchestrate.makeTransferWithEntries(db(), actorOf(user), {
      fromAccountId: loanId,
      toAccountId: nabilId,
      amountDisplayMinor: 3_000_000,
      date: "2026-09-07"
    });
    // The transfer is recorded but the valuation-driven balance ignores it.
    expect((await latestBalance(loanId))?.balanceMinor).toBe(3_000_000);

    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId: loanId,
      to: "transactions"
    });
    expect(result.resultingBalanceMinor).toBe(0);
    expect((await latestBalance(loanId))?.balanceMinor).toBe(0);
  });
});

describe("balance tracking: the switch", () => {
  it("flips an account with no valuations cleanly", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Receivable",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    await addTxn(user, accountId, {
      date: "2026-02-01",
      name: "Lent",
      amountLedgerMinor: -500_000
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(0);

    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(result.convertedValuationDate).toBeNull();
    expect(result.removedValuations).toBe(0);
    expect(result.resultingBalanceMinor).toBe(500_000);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(500_000);
  });

  it("converts the earliest valuation, removes the later ones, and audits the switch", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Property with history",
      currency: "USD",
      openedOn: "2025-01-01",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: "2025-01-01",
      amountDisplayMinor: 10_000_000,
      kind: "opening",
      name: "Original principal"
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: "2025-06-01",
      amountDisplayMinor: 12_000_000,
      kind: "current"
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: "2026-01-01",
      amountDisplayMinor: 11_000_000,
      kind: "current"
    });
    await addTxn(user, accountId, {
      date: "2026-02-01",
      name: "Lent",
      amountLedgerMinor: -100_000
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(11_000_000);

    const preview = await trackingSvc.previewBalanceTracking(
      db(),
      actorOf(user),
      accountId,
      "transactions"
    );
    expect(preview.valuationCount).toBe(3);
    expect(preview.resultingBalanceMinor).toBe(10_100_000);

    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(result.convertedValuationDate).toBe("2025-01-01");
    expect(result.removedValuations).toBe(2);
    expect(result.resultingBalanceMinor).toBe(10_100_000);

    const rows = await entriesOf(accountId);
    expect(rows.filter((r) => r.entryableType === "valuation")).toHaveLength(0);

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
      convertedValuationDate: "2025-01-01",
      removedValuations: 2,
      resultingBalanceMinor: 10_100_000
    });
  });

  it("switching back flips only: transactions stop counting, balance returns to the opening balance", async () => {
    const user = await makeUser();
    const accountId = await makeIshowerLoan(user);
    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect((await latestBalance(accountId))?.balanceMinor).toBe(20_000_000);

    const preview = await trackingSvc.previewBalanceTracking(
      db(),
      actorOf(user),
      accountId,
      "valuation"
    );
    expect(preview.resultingBalanceMinor).toBe(0);

    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "valuation"
    });
    expect(result.resultingBalanceMinor).toBe(0);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(0);

    // The transactions themselves are untouched — they just stop counting.
    const rows = await entriesOf(accountId);
    expect(rows.filter((r) => r.entryableType === "transaction")).toHaveLength(5);

    // And valuations can be recorded again.
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: "2026-10-01",
      amountDisplayMinor: 19_000_000,
      kind: "current"
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(19_000_000);
  });

  it("rejects switching a MeroShare-linked account to transactions", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "MeroShare portfolio",
      currency: "NPR",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    const [connection] = await db()
      .insert(meroShareConnections)
      .values({
        familyId: user.familyId,
        userId: user.userId,
        name: "DP account",
        clientId: 123,
        dpCode: "12300",
        dpName: "Test DP",
        usernameEncrypted: "encrypted",
        passwordEncrypted: "encrypted"
      })
      .returning({ id: meroShareConnections.id });
    await db().insert(meroShareAccounts).values({
      connectionId: connection!.id,
      accountId,
      boid: "1234567890123456",
      name: "MeroShare portfolio"
    });

    const preview = await trackingSvc.previewBalanceTracking(
      db(),
      actorOf(user),
      accountId,
      "transactions"
    );
    expect(preview.meroshareLinked).toBe(true);
    await expect(
      trackingSvc.switchBalanceTracking(db(), actorOf(user), {
        accountId,
        to: "transactions"
      })
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects switches by read_write members and on closed accounts", async () => {
    const owner = await makeUser();
    const accountId = await makeAccount(owner, {
      type: "other_asset",
      name: "Shared loan",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0,
      joint: false
    });
    const member = await makeUser();
    await joinFamily(member, owner.familyId);
    await accountsSvc.shareAccount(db(), actorOf(owner), accountId, member.userId, "read_write");
    await expect(
      trackingSvc.switchBalanceTracking(db(), actorOf(member), {
        accountId,
        to: "transactions"
      })
    ).rejects.toMatchObject({ code: "access.denied" });
    await expect(
      trackingSvc.previewBalanceTracking(db(), actorOf(member), accountId, "transactions")
    ).rejects.toMatchObject({ code: "access.denied" });

    await accountsSvc.setAccountStatus(db(), actorOf(owner), accountId, "disabled");
    await expect(
      trackingSvc.switchBalanceTracking(db(), actorOf(owner), {
        accountId,
        to: "transactions"
      })
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects recording a valuation on a transaction-tracked account", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Loan from day one",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0,
      balanceTracking: "transactions"
    });
    await expect(
      valuationsSvc.recordValuation(db(), actorOf(user), {
        accountId,
        date: "2026-02-01",
        amountDisplayMinor: 100_000
      })
    ).rejects.toMatchObject({ code: "validation.failed" });
  });

  it("enforces the creation defaults: depository is always transaction-tracked", async () => {
    const user = await makeUser();
    const sneaky = await makeAccount(user, {
      type: "depository",
      name: "Cash",
      balanceTracking: "valuation"
    });
    const [cashRow] = await db().select().from(accountsTable).where(eq(accountsTable.id, sneaky));
    expect(cashRow!.balanceTracking).toBe("transactions");

    const asset = await makeAccount(user, { type: "other_asset", name: "Asset" });
    const [assetRow] = await db().select().from(accountsTable).where(eq(accountsTable.id, asset));
    expect(assetRow!.balanceTracking).toBe("valuation");
  });
});

describe("balance tracking: export / restore", () => {
  it("round-trips transaction tracking; the restored loan still follows its transactions", async () => {
    const source = await makeUser();
    const accountId = await makeIshowerLoan(source);
    await trackingSvc.switchBalanceTracking(db(), actorOf(source), {
      accountId,
      to: "transactions"
    });
    await addTxn(source, accountId, {
      date: "2026-10-05",
      name: "Repayed",
      amountLedgerMinor: 5_000_000
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(15_000_000);

    const exported = await exportsSvc.buildFamilyExport(db(), actorOf(source));
    const exportedAccounts = exported.accounts as Array<{
      name?: string;
      balanceTracking?: string;
    }>;
    const exportedAccount = exportedAccounts.find((a) => a.name === "Ishower da");
    expect(exportedAccount?.balanceTracking).toBe("transactions");

    const target = await makeUser();
    const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    const result = await importFamilyExport(
      db(),
      actorOf(target),
      parseFamilyExport(encode(JSON.parse(JSON.stringify(exported))))
    );
    expect(result.accounts).toBeGreaterThanOrEqual(1);

    const [restored] = await db()
      .select()
      .from(accountsTable)
      .where(
        and(eq(accountsTable.familyId, target.familyId), eq(accountsTable.name, "Ishower da"))
      );
    expect(restored!.balanceTracking).toBe("transactions");
    expect((await latestBalance(restored!.id))?.balanceMinor).toBe(15_000_000);

    // New activity moves the restored balance — it is not frozen at a valuation.
    await addTxn(target, restored!.id, {
      date: "2026-11-01",
      name: "Lent",
      amountLedgerMinor: -1_000_000
    });
    await balancesSvc.recalculateAccount(db(), restored!.id);
    expect((await latestBalance(restored!.id))?.balanceMinor).toBe(16_000_000);
  });
});
