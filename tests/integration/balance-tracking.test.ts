import { describe, it, expect, beforeAll, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  addTxn,
  truncateAll,
  actorOf,
  latestBalance,
  joinFamily,
  daysAgo
} from "../helpers";
import * as accountsSvc from "@/server/domain/accounts";
import * as valuationsSvc from "@/server/domain/valuations";
import * as balancesSvc from "@/server/domain/balances";
import * as trackingSvc from "@/server/domain/balance-tracking";
import * as transfersSvc from "@/server/domain/transfers";
import * as holdingsSvc from "@/server/domain/holdings";
import * as orchestrate from "@/server/domain/orchestrate";
import * as exportsSvc from "@/server/domain/exports";
import * as reportsSvc from "@/server/domain/reports";
import * as splitsSvc from "@/server/domain/splits";
import * as backupsSvc from "@/server/domain/backups";
import { currentFamily } from "@/server/auth/context";
import { importFamilyExport, parseFamilyExport } from "@/server/domain/family-import";
import {
  accounts as accountsTable,
  auditEvents,
  balances as balancesTable,
  entries as entriesTable,
  families as familiesTable,
  meroShareAccounts,
  meroShareConnections,
  transfers as transfersTable
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

/** The materialized balance on one date, from the daily snapshots. */
async function balanceOn(accountId: string, date: string): Promise<number | undefined> {
  const [row] = await db()
    .select()
    .from(balancesTable)
    .where(and(eq(balancesTable.accountId, accountId), eq(balancesTable.asOf, date)));
  return row?.balanceMinor;
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
      to: "valuation",
      acknowledgeDataLoss: true
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

  it("rejects switching a holdings-managed account to transactions", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Holdings portfolio",
      currency: "NPR",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    await holdingsSvc.addHolding(db(), actorOf(user), {
      accountId,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: null,
      currentPriceMinor: 100
    });

    const preview = await trackingSvc.previewBalanceTracking(
      db(),
      actorOf(user),
      accountId,
      "transactions"
    );
    expect(preview.holdingsManaged).toBe(true);
    await expect(
      trackingSvc.switchBalanceTracking(db(), actorOf(user), {
        accountId,
        to: "transactions"
      })
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects managing holdings on a transaction-tracked account", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Loan from day one",
      currency: "NPR",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0,
      balanceTracking: "transactions"
    });
    await expect(
      holdingsSvc.addHolding(db(), actorOf(user), {
        accountId,
        ticker: "NABIL",
        quantity: "10",
        averageCostMinor: null,
        currentPriceMinor: 100
      })
    ).rejects.toMatchObject({ code: "validation.failed" });
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

describe("balance tracking: valuation precedence", () => {
  it("previews the same winner as the engine when timestamps tie", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makeAccount(user, {
      type: "other_asset",
      balanceTracking: "transactions",
      openingBalanceDisplayMinor: 0,
      openedOn: "2026-01-01"
    });
    // Model ignored valuation history carried by a restore. The later
    // insertion has the lower UUID, so ordering by UUID selects the wrong
    // winner, while the engine's write sequence correctly selects 2000.
    const first = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const second = "00000000-0000-4000-8000-000000000001";
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    await db()
      .insert(entriesTable)
      .values([
        {
          id: first,
          accountId,
          date: "2026-01-01",
          amountMinor: 1000,
          currency: "USD",
          name: "First",
          entryableType: "valuation",
          createdAt
        },
        {
          id: second,
          accountId,
          date: "2026-01-01",
          amountMinor: 2000,
          currency: "USD",
          name: "Second",
          entryableType: "valuation",
          createdAt
        }
      ]);
    await db().execute(sql`INSERT INTO valuations(entry_id, kind)
      VALUES (${first}, 'current'), (${second}, 'current')`);
    const preview = await trackingSvc.previewBalanceTracking(db(), actor, accountId, "valuation");
    const switched = await trackingSvc.switchBalanceTracking(db(), actor, {
      accountId,
      to: "valuation",
      acknowledgeDataLoss: true
    });
    expect(preview.resultingBalanceMinor).toBe(2000);
    expect(switched.resultingBalanceMinor).toBe(preview.resultingBalanceMinor);
  });
});

describe("balance tracking: normalized conversion (review round)", () => {
  it("does not double-count a nonzero opening balance that the valuation restates", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Restated opening",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 100_000
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: "2026-01-01",
      amountDisplayMinor: 100_000,
      kind: "opening",
      name: "Opening valuation"
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(100_000);

    const preview = await trackingSvc.previewBalanceTracking(
      db(),
      actorOf(user),
      accountId,
      "transactions"
    );
    // The opening balance already represents the valuation's 100,000, so
    // the conversion must add nothing: plug 0, balance unchanged.
    expect(preview.openingTransactionAmountMinor).toBe(0);
    expect(preview.resultingBalanceMinor).toBe(100_000);

    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(result.openingTransactionAmountMinor).toBe(0);
    expect(result.resultingBalanceMinor).toBe(100_000);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(100_000);

    const opening = (await entriesOf(accountId)).find((r) => r.name === "Opening valuation");
    expect(opening?.entryableType).toBe("transaction");
    expect(opening?.amountMinor).toBe(0);
    expect(opening?.externalSource).toBe("balance_tracking");
    expect(opening?.externalId).toBeNull();
  });

  it("absorbs pre-anchor transactions into the anchor; post-anchor activity keeps its full effect", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Loan with early activity",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    // Lent 500 BEFORE the valuation date: the valuation's absolute
    // 100,000 already includes it.
    await addTxn(user, accountId, {
      date: "2026-01-10",
      name: "Lent early",
      amountLedgerMinor: -50_000
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: "2026-02-01",
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Balance snapshot"
    });
    // Repaid 200 AFTER the anchor: counts in full.
    await addTxn(user, accountId, {
      date: "2026-03-01",
      name: "Repaid later",
      amountLedgerMinor: 20_000
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(100_000);

    const preview = await trackingSvc.previewBalanceTracking(
      db(),
      actorOf(user),
      accountId,
      "transactions"
    );
    // Plug: 0 − (−50,000 already represented) − 100,000 = −50,000.
    expect(preview.openingTransactionAmountMinor).toBe(-50_000);
    expect(preview.resultingBalanceMinor).toBe(80_000);

    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(result.openingTransactionAmountMinor).toBe(-50_000);
    expect(result.resultingBalanceMinor).toBe(80_000);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(80_000);
  });

  it("repeated mode round trips never re-add the principal", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Round trip loan",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: "2026-01-01",
      amountDisplayMinor: 100_000,
      kind: "opening",
      name: "Principal"
    });

    const first = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(first.openingTransactionAmountMinor).toBe(-100_000);
    expect(first.resultingBalanceMinor).toBe(100_000);

    // Two full round trips, each re-recording the same valuation: the
    // previously converted opening transaction already represents the
    // principal, so each new conversion must plug 0.
    for (const date of ["2026-02-01", "2026-03-01"]) {
      await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
        accountId,
        to: "valuation",
        acknowledgeDataLoss: true
      });
      await valuationsSvc.recordValuation(db(), actorOf(user), {
        accountId,
        date,
        amountDisplayMinor: 100_000,
        kind: "current",
        name: "Principal restated"
      });
      const preview = await trackingSvc.previewBalanceTracking(
        db(),
        actorOf(user),
        accountId,
        "transactions"
      );
      expect(preview.openingTransactionAmountMinor).toBe(0);
      expect(preview.resultingBalanceMinor).toBe(100_000);
      const again = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
        accountId,
        to: "transactions"
      });
      expect(again.openingTransactionAmountMinor).toBe(0);
      expect(again.resultingBalanceMinor).toBe(100_000);
      expect((await latestBalance(accountId))?.balanceMinor).toBe(100_000);
    }
  });

  it("liability: a restated nonzero opening balance is not doubled, and post-anchor activity counts fully", async () => {
    const user = await makeUser();
    const restatedId = await makeAccount(user, {
      type: "other_liability",
      name: "Restated liability",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 100_000
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId: restatedId,
      date: "2026-01-01",
      amountDisplayMinor: 100_000,
      kind: "opening",
      name: "Opening valuation"
    });
    const restated = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId: restatedId,
      to: "transactions"
    });
    expect(restated.openingTransactionAmountMinor).toBe(0);
    expect(restated.resultingBalanceMinor).toBe(-100_000);
    expect((await latestBalance(restatedId))?.balanceMinor).toBe(-100_000);

    const activeId = await makeAccount(user, {
      type: "other_liability",
      name: "Active liability",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId: activeId,
      date: "2026-01-01",
      amountDisplayMinor: 100_000,
      kind: "opening",
      name: "Amount owed"
    });
    // A payment after the anchor reduces the amount owed by 300.
    await addTxn(user, activeId, {
      date: "2026-02-01",
      name: "Payment",
      amountLedgerMinor: -30_000
    });
    const active = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId: activeId,
      to: "transactions"
    });
    expect(active.openingTransactionAmountMinor).toBe(100_000);
    expect(active.resultingBalanceMinor).toBe(-70_000);
    expect((await latestBalance(activeId))?.balanceMinor).toBe(-70_000);
  });
});

describe("balance tracking: report flows exclude the opening adjustment", () => {
  it("asset: the converted principal is not income, before or after a round trip, while real activity still counts", async () => {
    const user = await makeUser();
    const family = await currentFamily(actorOf(user));
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Report loan",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: daysAgo(0),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal"
    });
    await balancesSvc.recalculateAccount(db(), accountId);

    const before = await reportsSvc.dashboardSummary(db(), family, user.userId);
    expect(before.incomeThisMonthMinor).toBe(0);
    expect(before.netWorthMinor).toBe(100_000);

    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    // Genuine activity after the switch must still flow into reports —
    // only the bookkeeping adjustment is excluded.
    await addTxn(user, accountId, {
      date: daysAgo(0),
      name: "Interest received",
      amountLedgerMinor: -25_000
    });
    await balancesSvc.recalculateAccount(db(), accountId);

    const after = await reportsSvc.dashboardSummary(db(), family, user.userId);
    expect(after.incomeThisMonthMinor).toBe(25_000);
    expect(after.expenseThisMonthMinor).toBe(0);
    expect(after.netWorthMinor).toBe(125_000);

    const series = await reportsSvc.incomeExpenseSeries(db(), family, user.userId, 1);
    expect(series.flows[0]?.incomeMinor).toBe(25_000);
    expect(series.flows[0]?.expenseMinor).toBe(0);

    // Round trip: switch back, restate the valuation, switch again —
    // reports must still see only the genuine 25,000.
    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "valuation",
      acknowledgeDataLoss: true
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: daysAgo(0),
      amountDisplayMinor: 125_000,
      kind: "current",
      name: "Principal restated"
    });
    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    const roundTripped = await reportsSvc.dashboardSummary(db(), family, user.userId);
    expect(roundTripped.incomeThisMonthMinor).toBe(25_000);
    expect(roundTripped.expenseThisMonthMinor).toBe(0);
    expect(roundTripped.netWorthMinor).toBe(125_000);
  });

  it("liability: the converted principal is not an expense and not category spending", async () => {
    const user = await makeUser();
    const family = await currentFamily(actorOf(user));
    const accountId = await makeAccount(user, {
      type: "other_liability",
      name: "Report liability",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: daysAgo(0),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Amount owed"
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });

    const summary = await reportsSvc.dashboardSummary(db(), family, user.userId);
    expect(summary.expenseThisMonthMinor).toBe(0);
    expect(summary.incomeThisMonthMinor).toBe(0);
    expect(summary.topCategories).toHaveLength(0);
    // The balance contribution is fully retained.
    expect(summary.liabilitiesMinor).toBe(100_000);
    expect(summary.netWorthMinor).toBe(-100_000);

    const range = reportsSvc.currentMonthRange(family.timezone);
    const spending = await reportsSvc.spendingByCategory(db(), family, user.userId, range);
    expect(spending.categories).toHaveLength(0);
  });

  it("the opening adjustment cannot be split into ordinary transactions", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Unsplitable loan",
      currency: "USD",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: "2026-01-01",
      amountDisplayMinor: 100_000,
      kind: "opening",
      name: "Principal"
    });
    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    const opening = (await entriesOf(accountId)).find((r) => r.name === "Principal");
    await expect(
      splitsSvc.splitEntry(db(), actorOf(user), opening!.id, [
        { amountLedgerMinor: -60_000 },
        { amountLedgerMinor: -40_000 }
      ])
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("balance tracking: restore invariants (review round)", () => {
  it("household restore rejects holdings on a transaction-tracked account and commits nothing", async () => {
    const source = await makeUser();
    const accountId = await makeAccount(source, {
      type: "other_asset",
      name: "Holdings portfolio",
      currency: "NPR",
      openedOn: "2026-01-01",
      openingBalanceDisplayMinor: 0
    });
    await holdingsSvc.addHolding(db(), actorOf(source), {
      accountId,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: null,
      currentPriceMinor: 100
    });

    const exported = await exportsSvc.buildFamilyExport(db(), actorOf(source));
    const tampered = JSON.parse(JSON.stringify(exported)) as {
      accounts: Array<{ name?: string; balanceTracking?: string }>;
    };
    const exportedAccount = tampered.accounts.find((a) => a.name === "Holdings portfolio");
    expect(exportedAccount?.balanceTracking).toBe("valuation");
    exportedAccount!.balanceTracking = "transactions";

    const target = await makeUser();
    const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(tampered)))
    ).rejects.toMatchObject({ code: "validation.failed" });

    const targetAccounts = await db()
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.familyId, target.familyId));
    expect(targetAccounts).toHaveLength(0);
  });

  it("operator restore rejects holdings and MeroShare links on transaction-tracked accounts before inserting anything", async () => {
    const famId = "11111111-1111-4111-8111-111111111111";
    const accId = "22222222-2222-4222-8222-222222222222";
    const baseTables = {
      families: [
        {
          id: famId,
          name: "Archive family",
          currency: "USD",
          locale: "en-US",
          timezone: "UTC",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      accounts: [
        {
          id: accId,
          familyId: famId,
          ownerId: null,
          type: "other_asset",
          balanceTracking: "transactions",
          subtype: null,
          name: "Tampered loan",
          institution: null,
          currency: "USD",
          status: "active",
          includedInReports: true,
          openingBalanceMinor: 0,
          openedOn: "2026-01-01",
          externalSource: null,
          externalId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    };
    const familiesBefore = (await db().select({ id: familiesTable.id }).from(familiesTable)).length;

    const withHolding = {
      kind: "meridian-instance-export",
      version: 1,
      exportedAt: "2026-11-16T00:00:00.000Z",
      tables: {
        ...baseTables,
        portfolioHoldings: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            accountId: accId,
            ticker: "NABIL",
            companyName: null,
            quantity: "10",
            averageCostMinor: null,
            averageCostQuantity: "0",
            currentPriceMinor: 100,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        ]
      }
    } as unknown as backupsSvc.InstanceExport;
    await expect(backupsSvc.restoreInstanceExport(db(), withHolding)).rejects.toMatchObject({
      code: "validation.failed"
    });

    const withLink = {
      kind: "meridian-instance-export",
      version: 1,
      exportedAt: "2026-11-16T00:00:00.000Z",
      tables: {
        ...baseTables,
        meroShareAccounts: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            connectionId: "55555555-5555-4555-8555-555555555555",
            accountId: accId,
            boid: "1234567890123456",
            name: "Tampered loan",
            currency: "NPR",
            totalValueMinor: 1000,
            lastSyncedAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        ]
      }
    } as unknown as backupsSvc.InstanceExport;
    await expect(backupsSvc.restoreInstanceExport(db(), withLink)).rejects.toMatchObject({
      code: "validation.failed"
    });

    const familiesAfter = (await db().select({ id: familiesTable.id }).from(familiesTable)).length;
    expect(familiesAfter).toBe(familiesBefore);
    const archiveAccounts = await db()
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, accId));
    expect(archiveAccounts).toHaveLength(0);
  });
});

describe("balance tracking: backdated conversion after a round trip (review round 2)", () => {
  it("asset: a backdated anchor after a round trip keeps the balance ON the anchor date", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Backdated loan",
      currency: "USD",
      openedOn: daysAgo(5),
      openingBalanceDisplayMinor: 0
    });
    // Step 1: a 100,000 valuation dated yesterday, converted. The
    // source-marked opening adjustment is dated yesterday.
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: daysAgo(1),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal"
    });
    const first = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(first.openingTransactionAmountMinor).toBe(-100_000);
    expect(await balanceOn(accountId, daysAgo(2))).toBe(0);
    expect(await balanceOn(accountId, daysAgo(1))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(0))).toBe(100_000);

    // Step 2: back to valuations; record the same balance as a valuation
    // dated three days ago. In valuation mode both that date and today
    // show 100,000.
    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "valuation",
      acknowledgeDataLoss: true
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: daysAgo(3),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal restated"
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    expect(await balanceOn(accountId, daysAgo(3))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(0))).toBe(100_000);

    // Step 3: convert again, now anchored three days ago — BEFORE the
    // existing opening adjustment's date. The plan must be date-correct:
    // the later adjustment is restated, not treated as already
    // represented on a date before it exists.
    const preview = await trackingSvc.previewBalanceTracking(
      db(),
      actorOf(user),
      accountId,
      "transactions"
    );
    expect(preview.openingTransactionAmountMinor).toBe(-100_000);
    expect(preview.resultingBalanceMinor).toBe(100_000);
    expect(preview.restatedOpeningAdjustments).toBe(1);

    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(result.openingTransactionAmountMinor).toBe(-100_000);
    expect(result.resultingBalanceMinor).toBe(100_000);
    expect(result.restatedOpeningAdjustments).toBe(1);

    // The whole materialized series, not just today: the anchor date
    // shows the anchor valuation, and the restated adjustment does not
    // step the balance a second time when its own date arrives.
    expect(await balanceOn(accountId, daysAgo(4))).toBe(0);
    expect(await balanceOn(accountId, daysAgo(3))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(2))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(1))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(0))).toBe(100_000);

    // The earlier adjustment is restated to zero in place: same entry,
    // same date, and its durable source marker (provenance) intact.
    const rows = await entriesOf(accountId);
    const earlier = rows.find((r) => r.name === "Principal");
    expect(earlier?.entryableType).toBe("transaction");
    expect(earlier?.date).toBe(daysAgo(1));
    expect(earlier?.amountMinor).toBe(0);
    expect(earlier?.externalSource).toBe("balance_tracking");
    const converted = rows.find((r) => r.name === "Principal restated");
    expect(converted?.entryableType).toBe("transaction");
    expect(converted?.date).toBe(daysAgo(3));
    expect(converted?.amountMinor).toBe(-100_000);
    expect(converted?.externalSource).toBe("balance_tracking");

    // A third round trip must not drift either date.
    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "valuation",
      acknowledgeDataLoss: true
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: daysAgo(2),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal restated again"
    });
    const third = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(third.openingTransactionAmountMinor).toBe(0);
    expect(third.resultingBalanceMinor).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(3))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(2))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(1))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(0))).toBe(100_000);
  });

  it("liability: a backdated anchor after a round trip keeps the balance ON the anchor date", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_liability",
      name: "Backdated liability",
      currency: "USD",
      openedOn: daysAgo(5),
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: daysAgo(1),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Amount owed"
    });
    const first = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    // Liability valuations store negative ledger amounts, so the plug
    // that produces a −100,000 balance is +100,000.
    expect(first.openingTransactionAmountMinor).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(1))).toBe(-100_000);
    expect(await balanceOn(accountId, daysAgo(0))).toBe(-100_000);

    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "valuation",
      acknowledgeDataLoss: true
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: daysAgo(3),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Amount owed restated"
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    expect(await balanceOn(accountId, daysAgo(3))).toBe(-100_000);
    expect(await balanceOn(accountId, daysAgo(0))).toBe(-100_000);

    const preview = await trackingSvc.previewBalanceTracking(
      db(),
      actorOf(user),
      accountId,
      "transactions"
    );
    expect(preview.openingTransactionAmountMinor).toBe(100_000);
    expect(preview.resultingBalanceMinor).toBe(-100_000);
    expect(preview.restatedOpeningAdjustments).toBe(1);

    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(result.openingTransactionAmountMinor).toBe(100_000);
    expect(result.resultingBalanceMinor).toBe(-100_000);
    expect(result.restatedOpeningAdjustments).toBe(1);
    expect(await balanceOn(accountId, daysAgo(4))).toBe(0);
    expect(await balanceOn(accountId, daysAgo(3))).toBe(-100_000);
    expect(await balanceOn(accountId, daysAgo(2))).toBe(-100_000);
    expect(await balanceOn(accountId, daysAgo(1))).toBe(-100_000);
    expect(await balanceOn(accountId, daysAgo(0))).toBe(-100_000);

    const earlier = (await entriesOf(accountId)).find((r) => r.name === "Amount owed");
    expect(earlier?.amountMinor).toBe(0);
    expect(earlier?.externalSource).toBe("balance_tracking");
  });

  it("genuine activity dated between the backdated anchor and the restated adjustment keeps its full effect", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Backdated loan with activity",
      currency: "USD",
      openedOn: daysAgo(10),
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: daysAgo(2),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal"
    });
    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    // A genuine lend dated between the future anchor and the existing
    // opening adjustment: it is real activity, not representation, and
    // must survive the backdated conversion untouched.
    await addTxn(user, accountId, {
      date: daysAgo(5),
      name: "Lent more",
      amountLedgerMinor: -20_000
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    expect(await balanceOn(accountId, daysAgo(5))).toBe(20_000);
    expect(await balanceOn(accountId, daysAgo(2))).toBe(120_000);

    await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "valuation",
      acknowledgeDataLoss: true
    });
    await valuationsSvc.recordValuation(db(), actorOf(user), {
      accountId,
      date: daysAgo(7),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal restated"
    });
    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(user), {
      accountId,
      to: "transactions"
    });
    expect(result.openingTransactionAmountMinor).toBe(-100_000);
    expect(result.restatedOpeningAdjustments).toBe(1);
    expect(result.resultingBalanceMinor).toBe(120_000);
    // Anchor date: exactly the anchor valuation. From the genuine lend:
    // anchor + 20,000. The restated adjustment adds no second step when
    // its date arrives.
    expect(await balanceOn(accountId, daysAgo(7))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(6))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(5))).toBe(120_000);
    expect(await balanceOn(accountId, daysAgo(2))).toBe(120_000);
    expect(await balanceOn(accountId, daysAgo(0))).toBe(120_000);
  });

  it("the marker and the date-correct conversion survive a household export/restore round trip", async () => {
    const source = await makeUser();
    const accountId = await makeAccount(source, {
      type: "other_asset",
      name: "Restored backdated loan",
      currency: "USD",
      openedOn: daysAgo(5),
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actorOf(source), {
      accountId,
      date: daysAgo(1),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal"
    });
    await trackingSvc.switchBalanceTracking(db(), actorOf(source), {
      accountId,
      to: "transactions"
    });
    expect((await latestBalance(accountId))?.balanceMinor).toBe(100_000);

    const exported = await exportsSvc.buildFamilyExport(db(), actorOf(source));
    const target = await makeUser();
    const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    await importFamilyExport(
      db(),
      actorOf(target),
      parseFamilyExport(encode(JSON.parse(JSON.stringify(exported))))
    );

    const [restored] = await db()
      .select()
      .from(accountsTable)
      .where(
        and(
          eq(accountsTable.familyId, target.familyId),
          eq(accountsTable.name, "Restored backdated loan")
        )
      );
    expect(restored!.balanceTracking).toBe("transactions");
    expect((await latestBalance(restored!.id))?.balanceMinor).toBe(100_000);
    const restoredOpening = (await entriesOf(restored!.id)).find((r) => r.name === "Principal");
    expect(restoredOpening?.entryableType).toBe("transaction");
    expect(restoredOpening?.externalSource).toBe("balance_tracking");
    expect(restoredOpening?.amountMinor).toBe(-100_000);
    expect(restoredOpening?.date).toBe(daysAgo(1));

    // The backdated conversion in the restored family behaves exactly
    // as in the source family: the recognized marker keeps the
    // conversion date-correct after the round trip.
    await trackingSvc.switchBalanceTracking(db(), actorOf(target), {
      accountId: restored!.id,
      to: "valuation",
      acknowledgeDataLoss: true
    });
    await valuationsSvc.recordValuation(db(), actorOf(target), {
      accountId: restored!.id,
      date: daysAgo(3),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal restated"
    });
    const result = await trackingSvc.switchBalanceTracking(db(), actorOf(target), {
      accountId: restored!.id,
      to: "transactions"
    });
    expect(result.openingTransactionAmountMinor).toBe(-100_000);
    expect(result.restatedOpeningAdjustments).toBe(1);
    expect(result.resultingBalanceMinor).toBe(100_000);
    expect(await balanceOn(restored!.id, daysAgo(3))).toBe(100_000);
    expect(await balanceOn(restored!.id, daysAgo(1))).toBe(100_000);
    expect(await balanceOn(restored!.id, daysAgo(0))).toBe(100_000);
  });
});

describe("balance tracking: scheduled pre-anchor activity", () => {
  it.each(["other_asset", "other_liability"] as const)(
    "%s: normalizes a future anchor without double-counting scheduled activity",
    async (type) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
      try {
        const user = await makeUser({ timezone: "UTC" });
        const actor = actorOf(user);
        const direction = type === "other_asset" ? 1 : -1;
        const accountId = await makeAccount(user, {
          type,
          openedOn: "2026-11-15",
          openingBalanceDisplayMinor: 0
        });
        await addTxn(user, accountId, {
          date: "2026-11-17",
          name: "Scheduled principal",
          amountLedgerMinor: -200 * direction
        });
        await valuationsSvc.recordValuation(db(), actor, {
          accountId,
          date: "2026-11-18",
          amountDisplayMinor: 1000
        });
        const preview = await trackingSvc.previewBalanceTracking(
          db(),
          actor,
          accountId,
          "transactions"
        );
        expect(preview.openingTransactionAmountMinor).toBe(-800 * direction);
        expect(preview.resultingBalanceMinor).toBe(0);
        const switched = await trackingSvc.switchBalanceTracking(db(), actor, {
          accountId,
          to: "transactions"
        });
        expect(switched.resultingBalanceMinor).toBe(0);
        vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
        await balancesSvc.recalculateAccount(db(), accountId);
        expect((await latestBalance(accountId))?.balanceMinor).toBe(200 * direction);
        vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
        await balancesSvc.recalculateAccount(db(), accountId);
        expect((await latestBalance(accountId))?.balanceMinor).toBe(1000 * direction);
      } finally {
        vi.useRealTimers();
      }
    }
  );
});

describe("balance tracking: restatement must never unbalance a transfer (review round 3)", () => {
  /** Both legs of a transfer, read back from the entries table. */
  async function transferLegAmounts(transferId: string) {
    const [transfer] = await db()
      .select()
      .from(transfersTable)
      .where(eq(transfersTable.id, transferId));
    expect(transfer).toBeDefined();
    const [out] = await db()
      .select()
      .from(entriesTable)
      .where(eq(entriesTable.id, transfer!.outflowEntryId));
    const [inn] = await db()
      .select()
      .from(entriesTable)
      .where(eq(entriesTable.id, transfer!.inflowEntryId));
    return { out: out!, inn: inn!, transfer: transfer! };
  }

  /**
   * The reviewer's probe shape: an account whose converted opening
   * adjustment (dated yesterday) is one leg of a confirmed transfer of
   * 100,000, with the counterpart leg in a second account. Returns the
   * ids a backdated re-conversion would put at risk.
   */
  async function makeTransferLeggedAdjustment(
    user: Awaited<ReturnType<typeof makeUser>>,
    opts: { type: "other_asset" | "other_liability"; counterpartType: "depository" | "other_asset" }
  ) {
    const actor = actorOf(user);
    const accountId = await makeAccount(user, {
      type: opts.type,
      name: "Transfer-legged loan",
      currency: "USD",
      openedOn: daysAgo(5),
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actor, {
      accountId,
      date: daysAgo(1),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal"
    });
    const first = await trackingSvc.switchBalanceTracking(db(), actor, {
      accountId,
      to: "transactions"
    });
    const adjustment = (await entriesOf(accountId)).find((r) => r.name === "Principal")!;
    // Asset conversions store −100,000 (an inflow-shaped leg); liability
    // conversions store +100,000 (an outflow-shaped leg).
    expect(adjustment.amountMinor).toBe(opts.type === "other_asset" ? -100_000 : 100_000);
    expect(first.openingTransactionAmountMinor).toBe(adjustment.amountMinor);

    const counterpartId = await makeAccount(user, {
      type: opts.counterpartType,
      name: "Counterpart",
      currency: "USD",
      openedOn: daysAgo(5),
      openingBalanceDisplayMinor: 0
    });
    const counterpartEntryId = await addTxn(user, counterpartId, {
      date: daysAgo(1),
      name: "Counterpart leg",
      amountLedgerMinor: opts.type === "other_asset" ? 100_000 : -100_000
    });
    const { transferId } = await transfersSvc.createTransferFromTransactions(
      db(),
      actor,
      opts.type === "other_asset" ? counterpartEntryId : adjustment.id,
      opts.type === "other_asset" ? adjustment.id : counterpartEntryId
    );
    const legs = await transferLegAmounts(transferId);
    expect(legs.out.amountMinor + legs.inn.amountMinor).toBe(0);
    return {
      accountId,
      counterpartId,
      counterpartEntryId,
      adjustmentId: adjustment.id,
      transferId
    };
  }

  /** Round trip back to valuations and restate the balance at an earlier date. */
  async function backdateAnchor(
    user: Awaited<ReturnType<typeof makeUser>>,
    accountId: string,
    type: "other_asset" | "other_liability"
  ) {
    const actor = actorOf(user);
    await trackingSvc.switchBalanceTracking(db(), actor, {
      accountId,
      to: "valuation",
      acknowledgeDataLoss: true
    });
    await valuationsSvc.recordValuation(db(), actor, {
      accountId,
      date: daysAgo(3),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal restated"
    });
    await balancesSvc.recalculateAccount(db(), accountId);
    const direction = type === "other_asset" ? 1 : -1;
    expect(await balanceOn(accountId, daysAgo(3))).toBe(100_000 * direction);
    expect(await balanceOn(accountId, daysAgo(0))).toBe(100_000 * direction);
  }

  it.each(["other_asset", "other_liability"] as const)(
    "%s: a backdated switch that would restate a transfer leg is rejected before changing any rows",
    async (type) => {
      const user = await makeUser();
      const actor = actorOf(user);
      const { accountId, counterpartId, adjustmentId, transferId } =
        await makeTransferLeggedAdjustment(user, { type, counterpartType: "depository" });
      await backdateAnchor(user, accountId, type);

      // Both the preview and the switch refuse: restating the adjustment
      // to zero would leave the transfer's legs summing to ±100,000.
      await expect(
        trackingSvc.previewBalanceTracking(db(), actor, accountId, "transactions")
      ).rejects.toThrow(/transfer/i);
      await expect(
        trackingSvc.switchBalanceTracking(db(), actor, { accountId, to: "transactions" })
      ).rejects.toThrow(/transfer/i);

      // Nothing changed: the account is still valuation-tracked, both
      // legs keep their amounts, the transfer is intact, and the
      // materialized series is exactly the pre-attempt one.
      const [account] = await db()
        .select()
        .from(accountsTable)
        .where(eq(accountsTable.id, accountId));
      expect(account?.balanceTracking).toBe("valuation");
      const legs = await transferLegAmounts(transferId);
      expect(legs.out.amountMinor + legs.inn.amountMinor).toBe(0);
      expect(Math.abs(legs.out.amountMinor)).toBe(100_000);
      const adjustment = (await entriesOf(accountId)).find((r) => r.id === adjustmentId)!;
      expect(adjustment.amountMinor).toBe(type === "other_asset" ? -100_000 : 100_000);
      expect(adjustment.externalSource).toBe("balance_tracking");
      const direction = type === "other_asset" ? 1 : -1;
      expect(await balanceOn(accountId, daysAgo(3))).toBe(100_000 * direction);
      expect(await balanceOn(accountId, daysAgo(1))).toBe(100_000 * direction);
      expect(await balanceOn(accountId, daysAgo(0))).toBe(100_000 * direction);
      expect(await balanceOn(counterpartId, daysAgo(0))).toBe(-100_000 * direction);

      // The rejection is recoverable: unlink the transfer and the same
      // switch goes through with the restatement, exactly as round 2
      // specified for non-transfer adjustments.
      await transfersSvc.removeTransfer(db(), actor, transferId);
      const result = await trackingSvc.switchBalanceTracking(db(), actor, {
        accountId,
        to: "transactions"
      });
      expect(result.restatedOpeningAdjustments).toBe(1);
      expect(result.resultingBalanceMinor).toBe(100_000 * direction);
      const restated = (await entriesOf(accountId)).find((r) => r.id === adjustmentId)!;
      expect(restated.amountMinor).toBe(0);
      expect(restated.externalSource).toBe("balance_tracking");
      expect(await balanceOn(accountId, daysAgo(3))).toBe(100_000 * direction);
      expect(await balanceOn(accountId, daysAgo(1))).toBe(100_000 * direction);
      expect(await balanceOn(accountId, daysAgo(0))).toBe(100_000 * direction);
    }
  );

  it("switching the OTHER account leaves a transfer-legged adjustment and its pair untouched", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const { accountId, counterpartId, adjustmentId, transferId } =
      await makeTransferLeggedAdjustment(user, {
        type: "other_asset",
        counterpartType: "other_asset"
      });

    // The counterpart account does its own conversion, anchored three
    // days ago — before the transfer leg's date. Its leg is a genuine
    // transaction, not an opening adjustment, so nothing is restated
    // and the switch succeeds.
    await valuationsSvc.recordValuation(db(), actor, {
      accountId: counterpartId,
      date: daysAgo(3),
      amountDisplayMinor: 50_000,
      kind: "current",
      name: "Counterpart value"
    });
    const result = await trackingSvc.switchBalanceTracking(db(), actor, {
      accountId: counterpartId,
      to: "transactions"
    });
    expect(result.restatedOpeningAdjustments).toBe(0);
    // 50,000 anchor, then the 100,000 outflow leg on its own date.
    expect(await balanceOn(counterpartId, daysAgo(3))).toBe(50_000);
    expect(await balanceOn(counterpartId, daysAgo(1))).toBe(-50_000);
    expect(result.resultingBalanceMinor).toBe(-50_000);

    // The first account is completely unaffected: still transaction
    // tracked, its adjustment keeps its amount, and the transfer's
    // legs still balance exactly.
    const [account] = await db()
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, accountId));
    expect(account?.balanceTracking).toBe("transactions");
    const adjustment = (await entriesOf(accountId)).find((r) => r.id === adjustmentId)!;
    expect(adjustment.amountMinor).toBe(-100_000);
    const legs = await transferLegAmounts(transferId);
    expect(legs.out.amountMinor).toBe(100_000);
    expect(legs.inn.amountMinor).toBe(-100_000);
    expect(await balanceOn(accountId, daysAgo(0))).toBe(100_000);
  });

  it("a transfer-legged adjustment dated ON OR BEFORE the new anchor is absorbed, never rewritten", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makeAccount(user, {
      type: "other_asset",
      name: "Absorbed leg loan",
      currency: "USD",
      openedOn: daysAgo(5),
      openingBalanceDisplayMinor: 0
    });
    await valuationsSvc.recordValuation(db(), actor, {
      accountId,
      date: daysAgo(3),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal"
    });
    await trackingSvc.switchBalanceTracking(db(), actor, { accountId, to: "transactions" });
    const adjustment = (await entriesOf(accountId)).find((r) => r.name === "Principal")!;
    expect(adjustment.amountMinor).toBe(-100_000);

    const bankId = await makeAccount(user, {
      type: "depository",
      name: "Bank",
      currency: "USD",
      openedOn: daysAgo(5),
      openingBalanceDisplayMinor: 0
    });
    const bankEntryId = await addTxn(user, bankId, {
      date: daysAgo(3),
      name: "Counterpart leg",
      amountLedgerMinor: 100_000
    });
    const { transferId } = await transfersSvc.createTransferFromTransactions(
      db(),
      actor,
      bankEntryId,
      adjustment.id
    );

    // A later anchor: the leg is in-window, so the plug absorbs it —
    // the switch succeeds and the entry itself is never modified.
    await trackingSvc.switchBalanceTracking(db(), actor, {
      accountId,
      to: "valuation",
      acknowledgeDataLoss: true
    });
    await valuationsSvc.recordValuation(db(), actor, {
      accountId,
      date: daysAgo(1),
      amountDisplayMinor: 100_000,
      kind: "current",
      name: "Principal restated"
    });
    const result = await trackingSvc.switchBalanceTracking(db(), actor, {
      accountId,
      to: "transactions"
    });
    expect(result.restatedOpeningAdjustments).toBe(0);
    expect(result.openingTransactionAmountMinor).toBe(0);
    expect(result.resultingBalanceMinor).toBe(100_000);
    const legAfter = (await entriesOf(accountId)).find((r) => r.id === adjustment.id)!;
    expect(legAfter.amountMinor).toBe(-100_000);
    const legs = await transferLegAmounts(transferId);
    expect(legs.out.amountMinor + legs.inn.amountMinor).toBe(0);
    expect(await balanceOn(accountId, daysAgo(3))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(1))).toBe(100_000);
    expect(await balanceOn(accountId, daysAgo(0))).toBe(100_000);
  });
});
