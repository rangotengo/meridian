import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  truncateAll,
  actorOf,
  latestBalance,
  joinFamily,
  type TestUser
} from "../helpers";
import { importSureExport } from "@/server/domain/sure-import";
import * as orchestrate from "@/server/domain/orchestrate";
import * as entriesSvc from "@/server/domain/entries";
import * as accountsSvc from "@/server/domain/accounts";
import * as valuationsSvc from "@/server/domain/valuations";

beforeAll(async () => {
  await truncateAll();
});

async function importFixture(user: TestUser, ndjson: string) {
  const actor = actorOf(user);
  const result = await importSureExport(
    db(),
    actor,
    "sure.ndjson",
    new TextEncoder().encode(ndjson)
  );
  if (result.accounts === 0) throw new Error("fixture import created no accounts");
  return actor;
}

async function accountIdByExternal(externalId: string, familyId: string): Promise<string> {
  const res = await db().execute<{ id: string }>(
    sql`SELECT id::text AS id FROM accounts WHERE external_id = ${externalId} AND family_id = ${familyId}::uuid`
  );
  const row = (res.rows ?? [])[0];
  if (!row) throw new Error(`account ${externalId} not imported`);
  return row.id;
}

async function entryIdByExternal(externalId: string, familyId: string): Promise<string> {
  const res = await db().execute<{ id: string }>(sql`
    SELECT e.id::text AS id FROM entries e
    JOIN accounts a ON a.id = e.account_id
    WHERE e.external_id = ${externalId} AND a.family_id = ${familyId}::uuid
  `);
  const row = (res.rows ?? [])[0];
  if (!row) throw new Error(`entry ${externalId} not imported`);
  return row.id;
}

async function balanceOn(accountId: string, date: string): Promise<number | null> {
  const res = await db().execute<{ balance_minor: string }>(sql`
    SELECT balance_minor::text AS balance_minor FROM balances
    WHERE account_id = ${accountId}::uuid AND as_of = ${date}::date
  `);
  const row = (res.rows ?? [])[0];
  return row ? Number(row.balance_minor) : null;
}

const householdNdjson = [
  {
    type: "Account",
    data: {
      id: "bank",
      name: "Bank",
      accountable_type: "Depository",
      balance: "100.00",
      currency: "USD",
      created_at: "2026-01-01"
    }
  },
  {
    type: "Account",
    data: {
      id: "loan",
      name: "Friend Loan",
      accountable_type: "LoanReceivable",
      balance: "200.00",
      currency: "USD",
      created_at: "2025-06-14"
    }
  },
  { type: "Category", data: { id: "food", name: "Food", color: "orange" } },
  { type: "Category", data: { id: "fun", name: "Fun", color: "purple" } },
  {
    type: "Transaction",
    data: {
      id: "t-bank-1",
      account_id: "bank",
      date: "2026-08-10",
      amount: "10.00",
      name: "Groceries",
      category_id: "food",
      tag_ids: []
    }
  },
  {
    type: "Transaction",
    data: {
      id: "t-bank-2",
      account_id: "bank",
      date: "2026-08-11",
      amount: "25.00",
      name: "Transfer to Friend Loan",
      tag_ids: []
    }
  },
  {
    type: "Transaction",
    data: {
      id: "t-loan-in",
      account_id: "loan",
      date: "2026-08-11",
      amount: "-25.00",
      name: "Transfer from Bank",
      tag_ids: []
    }
  },
  {
    type: "Transaction",
    data: {
      id: "t-loan-1",
      account_id: "loan",
      date: "2025-07-16",
      amount: "-40.00",
      name: "Hospital help",
      tag_ids: []
    }
  },
  {
    type: "Valuation",
    data: {
      id: "v-loan-1",
      entry_id: "e-loan-1",
      account_id: "loan",
      date: "2025-06-14",
      amount: "200.00",
      currency: "USD",
      name: "Original principal",
      kind: "opening_anchor"
    }
  },
  {
    type: "Transfer",
    data: {
      id: "xfer-1",
      outflow_transaction_id: "t-bank-2",
      inflow_transaction_id: "t-loan-in",
      status: "confirmed"
    }
  }
]
  .map((row) => JSON.stringify(row))
  .join("\n");

describe("Sure-imported transactions can be edited and deleted", () => {
  it("runs the full edit/delete lifecycle on imported entries", async () => {
    const user = await makeUser({ familyName: "Imported household" });
    const actor = await importFixture(user, householdNdjson);
    const bankId = await accountIdByExternal("bank", user.familyId);
    const loanId = await accountIdByExternal("loan", user.familyId);
    const bankTxn = await entryIdByExternal("t-bank-1", user.familyId);
    const loanTxn = await entryIdByExternal("t-loan-1", user.familyId);
    const outLeg = await entryIdByExternal("t-bank-2", user.familyId);
    const inLeg = await entryIdByExternal("t-loan-in", user.familyId);

    // Imported balances match the Sure balances.
    expect((await latestBalance(bankId))?.balanceMinor).toBe(10000);
    expect((await latestBalance(loanId))?.balanceMinor).toBe(20000);

    const categories = await db().execute<{ id: string; external_id: string }>(
      sql`SELECT id::text AS id, external_id FROM categories`
    );
    const funCategory = (categories.rows ?? []).find((c) => c.external_id === "fun");
    if (!funCategory) throw new Error("category not imported");

    // Edit an imported bank transaction: name, date, amount, category.
    await orchestrate.editTransaction(db(), actor, bankTxn, {
      name: "Groceries edited",
      date: "2026-08-12",
      amountLedgerMinor: 1200,
      categoryId: funCategory.id
    });
    const edited = await entriesSvc.getEntryDetail(db(), actor, bankTxn);
    expect(edited.entry.name).toBe("Groceries edited");
    expect(edited.entry.date).toBe("2026-08-12");
    expect(edited.entry.amountMinor).toBe(1200);
    expect(edited.categoryId).toBe(funCategory.id);
    expect(edited.level).toBe("full_control");
    // Balance recalculated: 100.00 - 2.00 extra outflow.
    expect((await latestBalance(bankId))?.balanceMinor).toBe(9800);

    // Edit an imported transaction on a valuation-driven (other_asset) account.
    await orchestrate.editTransaction(db(), actor, loanTxn, {
      name: "Hospital help (edited)",
      amountLedgerMinor: -4500
    });
    const editedLoan = await entriesSvc.getEntryDetail(db(), actor, loanTxn);
    expect(editedLoan.entry.name).toBe("Hospital help (edited)");
    expect(editedLoan.entry.amountMinor).toBe(-4500);
    // Valuation-driven balance is set by valuations, not transactions.
    expect((await latestBalance(loanId))?.balanceMinor).toBe(20000);

    // Transfer legs: annotations may change, amount/date may not (by design).
    await orchestrate.editTransaction(db(), actor, outLeg, { notes: "annotated" });
    await expect(
      orchestrate.editTransaction(db(), actor, outLeg, { amountLedgerMinor: 2600 })
    ).rejects.toThrow(/linked transfer/);

    // Delete an imported transaction; the balance recalculates.
    await orchestrate.removeEntry(db(), actor, bankTxn);
    await expect(entriesSvc.getEntryDetail(db(), actor, bankTxn)).rejects.toMatchObject({
      code: "resource.not_found"
    });
    expect((await latestBalance(bankId))?.balanceMinor).toBe(11000);

    // Delete an imported transaction on the valuation-driven account.
    await orchestrate.removeEntry(db(), actor, loanTxn);
    await expect(entriesSvc.getEntryDetail(db(), actor, loanTxn)).rejects.toMatchObject({
      code: "resource.not_found"
    });
    expect((await latestBalance(loanId))?.balanceMinor).toBe(20000);

    // Deleting one transfer leg removes the transfer and leaves the partner
    // as an ordinary, still-consistent transaction.
    await orchestrate.removeEntry(db(), actor, outLeg);
    const transfers = await db().execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM transfers`
    );
    expect(Number((transfers.rows ?? [])[0]?.count)).toBe(0);
    const partner = await entriesSvc.getEntryDetail(db(), actor, inLeg);
    expect(partner.transferId).toBeNull();
    expect((await latestBalance(bankId))?.balanceMinor).toBe(13500);
    expect((await latestBalance(loanId))?.balanceMinor).toBe(20000);
  });
});

const propertyNdjson = [
  {
    type: "Account",
    data: {
      id: "house",
      name: "House",
      accountable_type: "Property",
      balance: "1000.00",
      currency: "USD",
      created_at: "2026-01-05"
    }
  },
  {
    type: "Valuation",
    data: {
      id: "val-house-1",
      entry_id: "e-house-1",
      account_id: "house",
      date: "2026-01-05",
      amount: "1000.00",
      currency: "USD",
      name: "Opening value",
      kind: "opening_anchor"
    }
  }
]
  .map((row) => JSON.stringify(row))
  .join("\n");

describe("valuation entries can be edited and deleted", () => {
  it("edits an imported valuation (amount and date) and recalculates", async () => {
    const user = await makeUser({ familyName: "Valuation household" });
    const actor = await importFixture(user, propertyNdjson);
    const houseId = await accountIdByExternal("house", user.familyId);
    const valuationEntry = await entryIdByExternal("valuation:val-house-1", user.familyId);

    expect((await latestBalance(houseId))?.balanceMinor).toBe(100000);
    expect(await balanceOn(houseId, "2026-01-10")).toBe(100000);

    await valuationsSvc.updateValuation(db(), actor, {
      entryId: valuationEntry,
      date: "2026-01-05",
      amountDisplayMinor: 120000,
      kind: "current"
    });
    // The action layer recalculates after the domain write.
    const { recalculateAccount } = await import("@/server/domain/balances");
    await recalculateAccount(db(), houseId, "2026-01-05");
    expect((await latestBalance(houseId))?.balanceMinor).toBe(120000);

    // Moving the valuation later leaves the earlier days at the opening balance.
    await valuationsSvc.updateValuation(db(), actor, {
      entryId: valuationEntry,
      date: "2026-02-01",
      amountDisplayMinor: 120000
    });
    await recalculateAccount(db(), houseId, "2026-01-05");
    expect(await balanceOn(houseId, "2026-01-10")).toBe(0);
    expect((await latestBalance(houseId))?.balanceMinor).toBe(120000);
  });

  it("deletes valuations and falls back to the previous value, then opening", async () => {
    const user = await makeUser({ familyName: "Valuation delete household" });
    const actor = await importFixture(user, propertyNdjson);
    const houseId = await accountIdByExternal("house", user.familyId);
    const importedValuation = await entryIdByExternal("valuation:val-house-1", user.familyId);
    const { recalculateAccount } = await import("@/server/domain/balances");

    const recorded = await valuationsSvc.recordValuation(db(), actor, {
      accountId: houseId,
      date: "2026-03-01",
      amountDisplayMinor: 150000,
      kind: "current"
    });
    await recalculateAccount(db(), houseId, "2026-03-01");
    expect((await latestBalance(houseId))?.balanceMinor).toBe(150000);

    await valuationsSvc.deleteValuation(db(), actor, recorded.entryId);
    await recalculateAccount(db(), houseId, "2026-03-01");
    expect((await latestBalance(houseId))?.balanceMinor).toBe(100000);

    await valuationsSvc.deleteValuation(db(), actor, importedValuation);
    await recalculateAccount(db(), houseId, "2026-01-05");
    expect((await latestBalance(houseId))?.balanceMinor).toBe(0);

    const remaining = await db().execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM valuations v
      JOIN entries e ON e.id = v.entry_id WHERE e.account_id = ${houseId}::uuid
    `);
    expect(Number((remaining.rows ?? [])[0]?.count)).toBe(0);
  });

  it("rejects valuation changes without full control and on non-valuation entries", async () => {
    const owner = await makeUser({ familyName: "Valuation guards" });
    const ownerActor = actorOf(owner);
    const accountId = await makeAccount(owner, {
      type: "other_asset",
      name: "Plot",
      joint: false
    });
    const { entryId } = await valuationsSvc.recordValuation(db(), ownerActor, {
      accountId,
      date: "2026-01-01",
      amountDisplayMinor: 50000,
      kind: "current"
    });
    const txnId = await entriesSvc
      .createTransactionEntry(db(), ownerActor, {
        accountId,
        date: "2026-01-02",
        amountLedgerMinor: 100,
        name: "Not a valuation"
      })
      .then((r) => r.entryId);

    // A transaction entry is not a valuation.
    await expect(
      valuationsSvc.updateValuation(db(), ownerActor, {
        entryId: txnId,
        date: "2026-01-03",
        amountDisplayMinor: 1
      })
    ).rejects.toMatchObject({ code: "resource.not_found" });
    await expect(valuationsSvc.deleteValuation(db(), ownerActor, txnId)).rejects.toMatchObject({
      code: "resource.not_found"
    });

    // A read-only share cannot change valuations.
    const member = await makeUser({
      email: `val-member-${Date.now()}@test.local`,
      familyName: "Other"
    });
    await joinFamily(member, owner.familyId);
    await accountsSvc.shareAccount(db(), ownerActor, accountId, member.userId, "read_only");
    await expect(
      valuationsSvc.updateValuation(db(), actorOf(member), {
        entryId,
        date: "2026-01-03",
        amountDisplayMinor: 1
      })
    ).rejects.toMatchObject({ code: "access.denied" });
    await expect(
      valuationsSvc.deleteValuation(db(), actorOf(member), entryId)
    ).rejects.toMatchObject({ code: "access.denied" });

    // Another family cannot see the entry at all.
    const outsider = await makeUser({ familyName: "Outsider" });
    await expect(
      valuationsSvc.deleteValuation(db(), actorOf(outsider), entryId)
    ).rejects.toMatchObject({ code: "resource.not_found" });
  });
});
