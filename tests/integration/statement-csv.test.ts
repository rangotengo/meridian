import { beforeEach, describe, expect, it, vi } from "vitest";

// Injected recalculation failure for the rollback test below: the mock
// delegates to the real module and only throws while the flag is set.
const recalcCtl = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/domain/balances", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/domain/balances")>();
  return {
    ...mod,
    recalculateAccount: async (...args: Parameters<typeof mod.recalculateAccount>) => {
      if (recalcCtl.fail) throw new Error("injected recalculation failure");
      return mod.recalculateAccount(...args);
    }
  };
});
import { eq } from "drizzle-orm";
import {
  addTxn,
  actorOf,
  daysAgo,
  db,
  joinFamily,
  latestBalance,
  makeAccount,
  makeUser,
  truncateAll
} from "../helpers";
import { entries } from "@/server/db/schema";
import {
  confirmStatementImport,
  detectStatementMapping,
  previewStatementImport
} from "@/server/domain/statement-csv";

/** ISO date -> DD/MM/YYYY, the Nepali statement convention. */
function dmy(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

async function entryCount(accountId: string): Promise<number> {
  const rows = await db()
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.accountId, accountId));
  return rows.length;
}

async function entriesFor(accountId: string) {
  return db()
    .select({
      date: entries.date,
      amountMinor: entries.amountMinor,
      name: entries.name,
      externalSource: entries.externalSource,
      externalId: entries.externalId
    })
    .from(entries)
    .where(eq(entries.accountId, accountId));
}

describe("statement CSV import", () => {
  beforeEach(async () => {
    recalcCtl.fail = false;
    await truncateAll();
  });

  it("imports a Nepali bank statement and never records it twice", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const accountId = await makeAccount(user, {
      type: "depository",
      name: "Nabil Savings",
      currency: "NPR",
      openingBalanceDisplayMinor: 0
    });
    const csv = [
      "Date,Particulars,Debit,Credit,Balance",
      `${dmy(daysAgo(5))},ATM Withdrawal,5000,,95000`,
      `${dmy(daysAgo(4))},Salary,,20000,115000`,
      `${dmy(daysAgo(3))},Grocery Store,1250.50,,113749.50`
    ].join("\n");
    const mapping = detectStatementMapping(["Date", "Particulars", "Debit", "Credit", "Balance"]);

    const preview = await previewStatementImport(db(), actor, { accountId, text: csv, mapping });
    expect(preview.totalRows).toBe(3);
    expect(preview.importableCount).toBe(3);
    expect(preview.duplicateCount).toBe(0);
    expect(preview.errorCount).toBe(0);

    const first = await confirmStatementImport(db(), actor, { accountId, text: csv, mapping });
    expect(first).toEqual({ imported: 3, skippedDuplicates: 0, skippedErrors: 0, totalRows: 3 });
    expect(await entryCount(accountId)).toBe(3);
    const rows = await entriesFor(accountId);
    expect(rows.map((r) => [r.date.slice(0, 10), r.amountMinor, r.name])).toContainEqual([
      daysAgo(5),
      500000,
      "ATM Withdrawal"
    ]);
    expect(rows.map((r) => [r.date.slice(0, 10), r.amountMinor, r.name])).toContainEqual([
      daysAgo(4),
      -2000000,
      "Salary"
    ]);
    expect(rows.every((r) => r.externalSource === "statement_csv")).toBe(true);
    expect(rows.every((r) => r.externalId?.startsWith("csv_"))).toBe(true);
    // Balance = opening - sum(ledger): 0 - (500,000 - 2,000,000 + 125,050).
    expect((await latestBalance(accountId))?.balanceMinor).toBe(1374950);

    // The same file again: everything is a duplicate, nothing new is recorded.
    const again = await previewStatementImport(db(), actor, { accountId, text: csv, mapping });
    expect(again.importableCount).toBe(0);
    expect(again.duplicateCount).toBe(3);
    const second = await confirmStatementImport(db(), actor, { accountId, text: csv, mapping });
    expect(second).toEqual({ imported: 0, skippedDuplicates: 3, skippedErrors: 0, totalRows: 3 });
    expect(await entryCount(accountId)).toBe(3);
  });

  it("flags a hand-entered transaction as a duplicate and skips within-file repeats", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const accountId = await makeAccount(user, {
      type: "depository",
      name: "Nabil Savings",
      currency: "NPR",
      openingBalanceDisplayMinor: 0
    });
    await addTxn(user, accountId, {
      date: daysAgo(5),
      name: "ATM Withdrawal",
      amountLedgerMinor: 500000
    });
    const csv = [
      "Date,Particulars,Debit,Credit,Balance",
      `${dmy(daysAgo(5))},ATM Withdrawal,5000,,95000`,
      `${dmy(daysAgo(4))},Grocery Store,1250.50,,113749.50`,
      `${dmy(daysAgo(4))},Grocery Store,1250.50,,113749.50`
    ].join("\n");
    const mapping = detectStatementMapping(["Date", "Particulars", "Debit", "Credit", "Balance"]);

    const preview = await previewStatementImport(db(), actor, { accountId, text: csv, mapping });
    expect(preview.importableCount).toBe(1);
    expect(preview.duplicateCount).toBe(2);
    expect(preview.rows[0]?.duplicate).toBe(true);
    expect(preview.rows[0]?.duplicateEntryId).not.toBeNull();
    expect(preview.rows[2]?.duplicate).toBe(true);
    expect(preview.rows[2]?.duplicateEntryId).toBeNull();

    const result = await confirmStatementImport(db(), actor, { accountId, text: csv, mapping });
    expect(result).toEqual({ imported: 1, skippedDuplicates: 2, skippedErrors: 0, totalRows: 3 });
    expect(await entryCount(accountId)).toBe(2);
  });

  it("imports valid rows and reports bad rows instead of recording zero", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const accountId = await makeAccount(user, {
      type: "depository",
      name: "Nabil Savings",
      currency: "NPR",
      openingBalanceDisplayMinor: 0
    });
    const csv = [
      "Date,Particulars,Debit,Credit,Balance",
      "not-a-date,Bad date,100,,0",
      `${dmy(daysAgo(4))},Zero row,0,,0`,
      `${dmy(daysAgo(3))},Good row,750,,0`
    ].join("\n");
    const mapping = detectStatementMapping(["Date", "Particulars", "Debit", "Credit", "Balance"]);

    const preview = await previewStatementImport(db(), actor, { accountId, text: csv, mapping });
    expect(preview.errorCount).toBe(2);
    expect(preview.importableCount).toBe(1);
    const result = await confirmStatementImport(db(), actor, { accountId, text: csv, mapping });
    expect(result).toEqual({ imported: 1, skippedDuplicates: 0, skippedErrors: 2, totalRows: 3 });
    expect(await entryCount(accountId)).toBe(1);
  });

  it("imports a single signed amount column with statement sign convention", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const accountId = await makeAccount(user, {
      type: "depository",
      name: "eSewa",
      currency: "NPR",
      openingBalanceDisplayMinor: 0
    });
    const csv = [
      "Date,Description,Amount",
      "2026-11-01,Card payment,-250.50",
      "2026-11-02,Refund,1000"
    ].join("\n");
    const mapping = { date: 0, description: 1, amount: 2, debit: null, credit: null };

    const result = await confirmStatementImport(db(), actor, { accountId, text: csv, mapping });
    expect(result.imported).toBe(2);
    const rows = await entriesFor(accountId);
    expect(rows.map((r) => [r.name, r.amountMinor])).toContainEqual(["Card payment", 25050]);
    expect(rows.map((r) => [r.name, r.amountMinor])).toContainEqual(["Refund", -100000]);
  });

  it("rolls the import back when recalculation fails, so a retry heals it", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const accountId = await makeAccount(user, {
      type: "depository",
      name: "Nabil Savings",
      currency: "NPR",
      openingBalanceDisplayMinor: 0
    });
    const csv = [
      "Date,Particulars,Debit,Credit,Balance",
      `${dmy(daysAgo(5))},ATM Withdrawal,5000,,95000`,
      `${dmy(daysAgo(4))},Salary,,20000,115000`,
      `${dmy(daysAgo(3))},Grocery Store,1250.50,,113749.50`
    ].join("\n");
    const mapping = detectStatementMapping(["Date", "Particulars", "Debit", "Credit", "Balance"]);
    const balanceBefore = await latestBalance(accountId);

    // The balance rebuild fails after the entries were written: the whole
    // import must roll back, not leave committed entries with stale balances.
    recalcCtl.fail = true;
    await expect(
      confirmStatementImport(db(), actor, { accountId, text: csv, mapping })
    ).rejects.toThrow("injected recalculation failure");
    expect(await entryCount(accountId)).toBe(0);
    expect(await latestBalance(accountId)).toEqual(balanceBefore);
    recalcCtl.fail = false;

    // Retry imports cleanly instead of finding every row already duplicated
    // with balances still stale.
    const retry = await confirmStatementImport(db(), actor, { accountId, text: csv, mapping });
    expect(retry).toEqual({ imported: 3, skippedDuplicates: 0, skippedErrors: 0, totalRows: 3 });
    expect(await entryCount(accountId)).toBe(3);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(1374950);
  });

  it("refuses an account the actor cannot manage", async () => {
    const user1 = await makeUser({ currency: "NPR" });
    const user2 = await makeUser({ currency: "NPR" });
    await joinFamily(user2, user1.familyId);
    const privateAccount = await makeAccount(user2, { joint: false, currency: "NPR" });
    const csv = "Date,Particulars,Debit,Credit\n2026-11-01,Shop,100,";
    const mapping = detectStatementMapping(["Date", "Particulars", "Debit", "Credit"]);
    await expect(
      confirmStatementImport(db(), actorOf(user1), {
        accountId: privateAccount,
        text: csv,
        mapping
      })
    ).rejects.toThrow();
  });
});
