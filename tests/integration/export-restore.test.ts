import { describe, it, expect, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  addTxn,
  truncateAll,
  actorOf,
  daysAgo,
  latestBalance,
  type TestUser
} from "../helpers";
import * as orchestrate from "@/server/domain/orchestrate";
import * as categoriesSvc from "@/server/domain/categories";
import * as tagsSvc from "@/server/domain/tags";
import * as budgetsSvc from "@/server/domain/budgets";
import * as recurringSvc from "@/server/domain/recurring";
import * as savedFiltersSvc from "@/server/domain/saved-filters";
import * as valuationsSvc from "@/server/domain/valuations";
import { recalculateAccount } from "@/server/domain/balances";
import * as exportsSvc from "@/server/domain/exports";
import { importFamilyExport, parseFamilyExport } from "@/server/domain/family-import";
import {
  accounts,
  budgets,
  categories,
  entries,
  exchangeRates,
  recurringSeries,
  savedFilters,
  transfers
} from "@/server/db/schema";

beforeAll(async () => {
  await truncateAll();
});

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Delete every data row of a family (keeping the family and its users) so it can accept a restore. */
async function wipeFamilyData(familyId: string): Promise<void> {
  const exec = db();
  await exec.execute(
    sql`DELETE FROM transaction_tags WHERE transaction_id IN (SELECT t.id FROM transactions t JOIN entries e ON e.id = t.entry_id JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM transfers WHERE outflow_entry_id IN (SELECT e.id FROM entries e JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM transactions WHERE entry_id IN (SELECT e.id FROM entries e JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM valuations WHERE entry_id IN (SELECT e.id FROM entries e JOIN accounts a ON a.id = e.account_id WHERE a.family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM entries WHERE account_id IN (SELECT id FROM accounts WHERE family_id = ${familyId}::uuid)`
  );
  await exec.execute(sql`DELETE FROM recurring_series WHERE family_id = ${familyId}::uuid`);
  await exec.execute(sql`DELETE FROM budgets WHERE family_id = ${familyId}::uuid`);
  await exec.execute(
    sql`DELETE FROM saved_filters WHERE user_id IN (SELECT id FROM users WHERE family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM account_shares WHERE account_id IN (SELECT id FROM accounts WHERE family_id = ${familyId}::uuid)`
  );
  await exec.execute(
    sql`DELETE FROM balances WHERE account_id IN (SELECT id FROM accounts WHERE family_id = ${familyId}::uuid)`
  );
  await exec.execute(sql`DELETE FROM accounts WHERE family_id = ${familyId}::uuid`);
  await exec.execute(sql`DELETE FROM tags WHERE family_id = ${familyId}::uuid`);
  await exec.execute(sql`DELETE FROM categories WHERE family_id = ${familyId}::uuid`);
}

describe("family export v2 → restore round-trip", () => {
  it("recreates every entity type with remapped ids and matching balances", async () => {
    const user = await makeUser({ familyName: "RoundTripFamily" });
    const actor = actorOf(user);
    const exec = db();

    const food = await categoriesSvc.createCategory(exec, actor, { name: "Food" });
    const groceries = await categoriesSvc.createCategory(exec, actor, {
      name: "Groceries",
      parentId: food.categoryId
    });
    const tag = await tagsSvc.createTag(exec, actor, { name: "essential" });

    const checking = await makeAccount(user, {
      name: "RT Checking",
      openingBalanceDisplayMinor: 100_000
    });
    const savings = await makeAccount(user, {
      name: "RT Savings",
      openingBalanceDisplayMinor: 50_000
    });
    const house = await makeAccount(user, {
      name: "RT House",
      type: "other_asset",
      openingBalanceDisplayMinor: 0
    });

    await addTxn(user, checking, { amountLedgerMinor: -300_000, name: "Salary" });
    await addTxn(user, checking, {
      amountLedgerMinor: 40_000,
      name: "Supermarket",
      categoryId: groceries.categoryId,
      merchant: "Mart",
      tagIds: [tag.tagId]
    });
    const splitParent = await addTxn(user, checking, {
      amountLedgerMinor: 10_000,
      name: "Split shop"
    });
    await orchestrate.splitTransaction(exec, actor, splitParent, [
      { amountLedgerMinor: 6_000, categoryId: groceries.categoryId },
      { amountLedgerMinor: 4_000, categoryId: food.categoryId }
    ]);
    await orchestrate.makeTransferWithEntries(exec, actor, {
      fromAccountId: checking,
      toAccountId: savings,
      date: daysAgo(0),
      amountDisplayMinor: 20_000
    });
    await valuationsSvc.recordValuation(exec, actor, {
      accountId: house,
      date: daysAgo(1),
      amountDisplayMinor: 900_000,
      kind: "current",
      name: "House valuation"
    });

    await budgetsSvc.setBudget(exec, actor, {
      categoryId: groceries.categoryId,
      amountLedgerMinor: 50_000
    });
    await budgetsSvc.setBudget(exec, actor, { categoryId: null, amountLedgerMinor: 200_000 });

    const seriesId = await recurringSvc.createSeries(exec, actor, {
      accountId: checking,
      name: "Rent",
      amountLedgerMinor: 120_000,
      categoryId: food.categoryId,
      frequency: "monthly",
      config: { dayOfMonth: 1 },
      nextDue: daysAgo(-15)
    });

    await savedFiltersSvc.createSavedFilter(exec, user.userId, "Big expenses", {
      q: "Mart",
      account: "checking"
    });

    await exec
      .insert(exchangeRates)
      .values({
        baseCurrency: "USD",
        quoteCurrency: "EUR",
        rate: "0.92000000",
        quotedOn: daysAgo(2)
      })
      .onConflictDoNothing();

    for (const accountId of [checking, savings, house]) await recalculateAccount(exec, accountId);
    const sourceBalances = new Map<string, number | null>();
    for (const [name, id] of [
      ["RT Checking", checking],
      ["RT Savings", savings],
      ["RT House", house]
    ] as const) {
      sourceBalances.set(name, (await latestBalance(id))?.balanceMinor ?? null);
    }

    const exported = await exportsSvc.buildFamilyExport(exec, actor);
    expect(exported.version).toBe(2);
    expect(exported.budgets).toHaveLength(2);
    expect(exported.recurring).toHaveLength(1);
    expect(exported.savedFilters).toHaveLength(1);
    expect(exported.transfers).toHaveLength(1);

    await wipeFamilyData(user.familyId);

    const result = await importFamilyExport(
      exec,
      actor,
      parseFamilyExport(encode(JSON.parse(JSON.stringify(exported))))
    );

    expect(result.accounts).toBe(3);
    expect(result.categories).toBe(2);
    expect(result.tags).toBe(1);
    expect(result.transfers).toBe(1);
    expect(result.valuations).toBe(1);
    expect(result.budgets).toBe(2);
    expect(result.recurring).toBe(1);
    expect(result.savedFilters).toBe(1);
    // The rate already exists in this instance (the source household's export
    // came from here), so the restore inserts no duplicate.
    expect(result.exchangeRates).toBe(0);
    const rateRows = await exec
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.baseCurrency, "USD"));
    expect(rateRows).toHaveLength(1);
    expect(result.skipped).toEqual({ shares: 0, savedFilters: 0 });

    const restoredAccounts = await exec
      .select()
      .from(accounts)
      .where(eq(accounts.familyId, user.familyId));
    expect(restoredAccounts).toHaveLength(3);
    const restoredByName = new Map(restoredAccounts.map((a) => [a.name, a]));
    // Ids are remapped, never reused.
    expect(restoredByName.get("RT Checking")!.id).not.toBe(checking);
    for (const [name, id] of restoredByName) {
      const balance = (await latestBalance(id.id))?.balanceMinor ?? null;
      expect(balance, `balance of ${name}`).toBe(sourceBalances.get(name));
    }

    const restoredCategories = await exec
      .select()
      .from(categories)
      .where(eq(categories.familyId, user.familyId));
    const restoredFood = restoredCategories.find((c) => c.name === "Food")!;
    const restoredGroceries = restoredCategories.find((c) => c.name === "Groceries")!;
    expect(restoredGroceries.parentId).toBe(restoredFood.id);
    expect(restoredFood.id).not.toBe(food.categoryId);

    const restoredEntries = await exec
      .select()
      .from(entries)
      .where(eq(entries.accountId, restoredByName.get("RT Checking")!.id));
    const splitChildren = restoredEntries.filter((e) => e.parentEntryId !== null);
    expect(splitChildren).toHaveLength(2);
    expect(splitChildren.reduce((sum, e) => sum + e.amountMinor, 0)).toBe(10_000);

    const restoredTransfers = await exec.select().from(transfers);
    const familyTransfers = restoredTransfers.filter((t) =>
      restoredEntries.some((e) => e.id === t.outflowEntryId || e.id === t.inflowEntryId)
    );
    expect(familyTransfers).toHaveLength(1);
    const legIds = [familyTransfers[0]!.outflowEntryId, familyTransfers[0]!.inflowEntryId];
    const legs = await exec
      .select()
      .from(entries)
      .where(sql`${entries.id} IN (${legIds[0]}, ${legIds[1]})`);
    expect(legs).toHaveLength(2);
    expect(legs.reduce((sum, e) => sum + e.amountMinor, 0)).toBe(0);
    expect(legs.find((e) => e.id === legIds[0])!.amountMinor).toBeGreaterThan(0);
    expect(legs.find((e) => e.id === legIds[1])!.amountMinor).toBeLessThan(0);

    const restoredBudgets = await exec
      .select()
      .from(budgets)
      .where(eq(budgets.familyId, user.familyId));
    expect(restoredBudgets).toHaveLength(2);
    expect(restoredBudgets.find((b) => b.categoryId)?.categoryId).toBe(restoredGroceries.id);

    const restoredSeries = await exec
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.familyId, user.familyId));
    expect(restoredSeries).toHaveLength(1);
    expect(restoredSeries[0]!.id).not.toBe(seriesId);
    expect(restoredSeries[0]!.accountId).toBe(restoredByName.get("RT Checking")!.id);
    expect(restoredSeries[0]!.categoryId).toBe(restoredFood.id);

    const restoredFilters = await exec
      .select()
      .from(savedFilters)
      .where(eq(savedFilters.userId, user.userId));
    expect(restoredFilters).toHaveLength(1);
    expect(restoredFilters[0]!.name).toBe("Big expenses");
  });

  it("rejects a restore into a non-empty family and changes nothing", async () => {
    const source = await makeUser();
    await makeAccount(source, { name: "Source Account" });
    const exported = await exportsSvc.buildFamilyExport(db(), actorOf(source));

    const target = await makeUser();
    const existing = await makeAccount(target, { name: "Existing Account" });
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/empty Meridian family/);

    const targetAccounts = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.familyId, target.familyId));
    expect(targetAccounts.map((a) => a.id)).toEqual([existing]);
  });

  it("rejects a restore by a non-admin member", async () => {
    const source = await makeUser();
    const exported = await exportsSvc.buildFamilyExport(db(), actorOf(source));
    const target = await makeUser();
    await expect(
      importFamilyExport(db(), actorOf(target, "member"), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/family admin/);
  });

  it("rolls back everything when the export references a missing account", async () => {
    const source = await makeUser();
    const accountId = await makeAccount(source, { name: "Rollback Account" });
    await addTxn(source, accountId, { amountLedgerMinor: 5_000, name: "Seed txn" });
    const exported = JSON.parse(
      JSON.stringify(await exportsSvc.buildFamilyExport(db(), actorOf(source)))
    ) as { entries: { accountId: string }[] };
    // Corrupt one entry to reference an account that is not in the export:
    // parsing succeeds, the failure happens mid-transaction, after other
    // rows have already been inserted.
    exported.entries[0]!.accountId = "00000000-0000-0000-0000-000000000999";

    const target = await makeUser();
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/not part of the export/);

    const exec = db();
    const accountsAfter = await exec
      .select()
      .from(accounts)
      .where(eq(accounts.familyId, target.familyId));
    const categoriesAfter = await exec
      .select()
      .from(categories)
      .where(eq(categories.familyId, target.familyId));
    expect(accountsAfter).toHaveLength(0);
    expect(categoriesAfter).toHaveLength(0);
  });

  it("rejects malformed exports at parse time", () => {
    expect(() => parseFamilyExport(new TextEncoder().encode("not json"))).toThrow(/not valid JSON/);
    expect(() => parseFamilyExport(encode({ version: 99 }))).toThrow(/not supported/);
    expect(() => parseFamilyExport(encode({ version: 2 }))).toThrow(/family record/);
  });
});

describe("family export v1 backward compatibility", () => {
  it("imports a v1 export and rebuilds transfers from entry transferIds", async () => {
    const target: TestUser = await makeUser({ email: "v1-owner@test.local" });
    const v1 = {
      version: 1,
      exportedAt: new Date().toISOString(),
      family: {
        id: "11111111-1111-1111-1111-111111111111",
        name: "Legacy Family",
        currency: "USD",
        locale: "en-US",
        timezone: "UTC",
        createdAt: new Date().toISOString(),
        members: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            email: target.email,
            name: "V1 Owner",
            role: "admin"
          }
        ]
      },
      shares: [],
      accounts: [
        {
          id: "33333333-3333-3333-3333-333333333333",
          name: "V1 Checking",
          type: "depository",
          subtype: null,
          institution: null,
          currency: "USD",
          status: "active",
          includedInReports: true,
          openingBalanceMinor: -10_000,
          openedOn: daysAgo(30),
          ownerId: "22222222-2222-2222-2222-222222222222"
        },
        {
          id: "44444444-4444-4444-4444-444444444444",
          name: "V1 Savings",
          type: "depository",
          subtype: null,
          institution: null,
          currency: "USD",
          status: "active",
          includedInReports: true,
          openingBalanceMinor: 0,
          openedOn: daysAgo(30),
          ownerId: "22222222-2222-2222-2222-222222222222"
        }
      ],
      categories: [
        { id: "55555555-5555-5555-5555-555555555555", name: "Bills", color: null, parentId: null }
      ],
      tags: [],
      entries: [
        {
          id: "66666666-6666-6666-6666-666666666666",
          accountId: "33333333-3333-3333-3333-333333333333",
          parentEntryId: null,
          date: daysAgo(1),
          amountMinor: 3_000,
          currency: "USD",
          name: "Move to savings",
          notes: null,
          externalSource: null,
          externalId: null,
          kind: "transaction",
          categoryId: null,
          merchant: null,
          transferId: "77777777-7777-7777-7777-777777777777",
          valuationKind: null,
          tagIds: []
        },
        {
          id: "88888888-8888-8888-8888-888888888888",
          accountId: "44444444-4444-4444-4444-444444444444",
          parentEntryId: null,
          date: daysAgo(1),
          amountMinor: -3_000,
          currency: "USD",
          name: "Move to savings",
          notes: null,
          externalSource: null,
          externalId: null,
          kind: "transaction",
          categoryId: "55555555-5555-5555-5555-555555555555",
          merchant: null,
          transferId: "77777777-7777-7777-7777-777777777777",
          valuationKind: null,
          tagIds: []
        }
      ],
      exchangeRates: []
    };

    const result = await importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(v1)));
    expect(result.accounts).toBe(2);
    expect(result.entries).toBe(2);
    expect(result.transfers).toBe(1);
    expect(result.budgets).toBe(0);
    expect(result.recurring).toBe(0);

    const restoredAccounts = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.familyId, target.familyId));
    const checking = restoredAccounts.find((a) => a.name === "V1 Checking")!;
    const savings = restoredAccounts.find((a) => a.name === "V1 Savings")!;
    expect(checking.id).not.toBe("33333333-3333-3333-3333-333333333333");

    const restoredEntries = await db()
      .select()
      .from(entries)
      .where(eq(entries.accountId, checking.id));
    const savingsEntries = await db()
      .select()
      .from(entries)
      .where(eq(entries.accountId, savings.id));
    const restoredTransfers = (await db().select().from(transfers)).filter(
      (t) => t.outflowEntryId === restoredEntries[0]!.id
    );
    expect(restoredTransfers).toHaveLength(1);
    expect(restoredTransfers[0]!.inflowEntryId).toBe(savingsEntries[0]!.id);

    // Balances were materialized for both accounts.
    expect(await latestBalance(checking.id)).not.toBeNull();
    expect(await latestBalance(savings.id)).not.toBeNull();
  });
});
