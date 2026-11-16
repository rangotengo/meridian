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
  joinFamily,
  latestBalance,
  type TestUser
} from "../helpers";
import * as orchestrate from "@/server/domain/orchestrate";
import * as accountsSvc from "@/server/domain/accounts";
import * as categoriesSvc from "@/server/domain/categories";
import * as tagsSvc from "@/server/domain/tags";
import * as budgetsSvc from "@/server/domain/budgets";
import * as recurringSvc from "@/server/domain/recurring";
import * as savedFiltersSvc from "@/server/domain/saved-filters";
import * as valuationsSvc from "@/server/domain/valuations";
import { recalculateAccount } from "@/server/domain/balances";
import { nextOccurrence } from "@/server/domain/recurring";
import * as exportsSvc from "@/server/domain/exports";
import * as holdingsSvc from "@/server/domain/holdings";
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

describe("family export v3 → restore round-trip", () => {
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
    expect(exported.version).toBe(3);
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
    // The importing admin is not a platform super-admin, so the uploaded
    // rate is skipped rather than written to the global table (the row
    // below is the one inserted directly before the export, unchanged).
    expect(result.exchangeRates).toBe(0);
    const rateRows = await exec
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.baseCurrency, "USD"));
    expect(rateRows).toHaveLength(1);
    expect(result.skipped).toEqual({ shares: 0, savedFilters: 0, exchangeRates: 1 });

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

describe("restore hardening (PR #6 review fixes)", () => {
  type MutableExport = {
    accounts: { id: string; currency: string }[];
    entries: {
      id: string;
      accountId: string;
      kind: string;
      name: string;
      amountMinor: number;
      currency: string;
      date: string;
      parentEntryId: string | null;
      transferId: string | null;
    }[];
    recurring: { id: string; accountId: string; name: string; currency: string }[];
    savedFilters: { params: Record<string, unknown> }[];
  };
  const mutable = (value: unknown): MutableExport =>
    JSON.parse(JSON.stringify(value)) as MutableExport;

  async function expectFamilyEmpty(familyId: string): Promise<void> {
    const rows = await db().select().from(accounts).where(eq(accounts.familyId, familyId));
    expect(rows).toHaveLength(0);
  }

  it("never writes global exchange rates from a household restore by a non-super-admin", async () => {
    const exec = db();
    const source = await makeUser();
    await makeAccount(source, { name: "FX Source Account" });
    await exec.execute(
      sql`DELETE FROM exchange_rates WHERE base_currency = 'USD' AND quote_currency = 'NPR'`
    );
    await exec.insert(exchangeRates).values({
      baseCurrency: "USD",
      quoteCurrency: "NPR",
      rate: "999.00000000",
      quotedOn: daysAgo(0)
    });
    const exported = await exportsSvc.buildFamilyExport(exec, actorOf(source));
    expect(exported.exchangeRates.some((r) => (r as { quote: string }).quote === "NPR")).toBe(true);
    // Simulate the target instance: it does not have this rate yet.
    await exec.execute(
      sql`DELETE FROM exchange_rates WHERE base_currency = 'USD' AND quote_currency = 'NPR'`
    );

    const target = await makeUser();
    const result = await importFamilyExport(
      exec,
      actorOf(target),
      parseFamilyExport(encode(exported))
    );
    expect(result.exchangeRates).toBe(0);
    expect(result.skipped.exchangeRates).toBeGreaterThan(0);
    // The global table — what every other household's lookups read — is
    // untouched by the uploaded file.
    const rows = await exec
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.quoteCurrency, "NPR"));
    expect(rows).toHaveLength(0);
  });

  it("applies uploaded exchange rates when the importer is a platform super-admin", async () => {
    const exec = db();
    const source = await makeUser();
    await makeAccount(source, { name: "FX Admin Source" });
    await exec.execute(
      sql`DELETE FROM exchange_rates WHERE base_currency = 'USD' AND quote_currency = 'NPR'`
    );
    await exec.insert(exchangeRates).values({
      baseCurrency: "USD",
      quoteCurrency: "NPR",
      rate: "133.50000000",
      quotedOn: daysAgo(1)
    });
    const exported = await exportsSvc.buildFamilyExport(exec, actorOf(source));
    await exec.execute(
      sql`DELETE FROM exchange_rates WHERE base_currency = 'USD' AND quote_currency = 'NPR'`
    );

    const target = await makeUser();
    const superActor = { ...actorOf(target), platformRole: "super_admin" as const };
    const result = await importFamilyExport(exec, superActor, parseFamilyExport(encode(exported)));
    expect(result.exchangeRates).toBeGreaterThan(0);
    expect(result.skipped.exchangeRates).toBe(0);
    const rows = await exec
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.quoteCurrency, "NPR"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rate).toBe("133.50000000");
    await exec.execute(
      sql`DELETE FROM exchange_rates WHERE base_currency = 'USD' AND quote_currency = 'NPR'`
    );
  });

  it("rejects a budget-bearing export whose reporting currency differs from the target family", async () => {
    const source = await makeUser({ currency: "USD" });
    await makeAccount(source, { name: "USD Budget Account" });
    await budgetsSvc.setBudget(db(), actorOf(source), {
      categoryId: null,
      amountLedgerMinor: 10_000 // a $100 budget
    });
    const exported = await exportsSvc.buildFamilyExport(db(), actorOf(source));

    const target = await makeUser({ currency: "JPY" });
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/budgets are in USD, but this family reports in JPY/);
    await expectFamilyEmpty(target.familyId);
    const targetBudgets = await db()
      .select()
      .from(budgets)
      .where(eq(budgets.familyId, target.familyId));
    expect(targetBudgets).toHaveLength(0);
  });

  it("imports a budget-free export across reporting currencies without reinterpretation", async () => {
    const source = await makeUser({ currency: "USD" });
    const accountId = await makeAccount(source, { name: "Portable Account", currency: "EUR" });
    await addTxn(source, accountId, { amountLedgerMinor: 2_500, name: "Portable txn" });
    const exported = await exportsSvc.buildFamilyExport(db(), actorOf(source));

    const target = await makeUser({ currency: "JPY" });
    const result = await importFamilyExport(
      db(),
      actorOf(target),
      parseFamilyExport(encode(exported))
    );
    expect(result.accounts).toBe(1);
    expect(result.budgets).toBe(0);
    const restored = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.familyId, target.familyId));
    expect(restored[0]!.currency).toBe("EUR");
  });

  it("rejects a tampered transfer whose legs do not balance, and restores nothing", async () => {
    const source = await makeUser();
    const a = await makeAccount(source, {
      name: "Tamper A",
      openingBalanceDisplayMinor: 100_000
    });
    const b = await makeAccount(source, { name: "Tamper B" });
    await orchestrate.makeTransferWithEntries(db(), actorOf(source), {
      fromAccountId: a,
      toAccountId: b,
      date: daysAgo(0),
      amountDisplayMinor: 20_000
    });
    const exported = mutable(await exportsSvc.buildFamilyExport(db(), actorOf(source)));
    const inflow = exported.entries.find((e) => e.amountMinor < 0)!;
    inflow.amountMinor = -100; // was -20_000: legs no longer balance

    const target = await makeUser();
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/do not have equal amounts/);
    await expectFamilyEmpty(target.familyId);
  });

  it("rejects a transfer whose legs fall outside the supported date window", async () => {
    const source = await makeUser();
    const a = await makeAccount(source, {
      name: "Window A",
      openingBalanceDisplayMinor: 100_000
    });
    const b = await makeAccount(source, { name: "Window B" });
    await orchestrate.makeTransferWithEntries(db(), actorOf(source), {
      fromAccountId: a,
      toAccountId: b,
      date: daysAgo(0),
      amountDisplayMinor: 5_000
    });
    const exported = mutable(await exportsSvc.buildFamilyExport(db(), actorOf(source)));
    const inflow = exported.entries.find((e) => e.amountMinor < 0)!;
    inflow.date = daysAgo(30);

    const target = await makeUser();
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/days apart/);
    await expectFamilyEmpty(target.familyId);
  });

  it("rejects a cross-currency transfer in the export", async () => {
    const source = await makeUser();
    const a = await makeAccount(source, {
      name: "FX Leg A",
      openingBalanceDisplayMinor: 100_000
    });
    const b = await makeAccount(source, { name: "FX Leg B" });
    await orchestrate.makeTransferWithEntries(db(), actorOf(source), {
      fromAccountId: a,
      toAccountId: b,
      date: daysAgo(0),
      amountDisplayMinor: 5_000
    });
    const exported = mutable(await exportsSvc.buildFamilyExport(db(), actorOf(source)));
    // Make leg B a EUR leg of a EUR account: each leg still matches its own
    // account, so the per-record currency check passes and the transfer
    // itself is what is cross-currency.
    exported.accounts.find((acc) => acc.id === b)!.currency = "EUR";
    exported.entries.find((e) => e.accountId === b)!.currency = "EUR";

    const target = await makeUser();
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/cross-currency/i);
    await expectFamilyEmpty(target.familyId);
  });

  it("rejects a tampered split whose parts do not sum to the parent, and restores nothing", async () => {
    const source = await makeUser();
    const a = await makeAccount(source, { name: "Split Tamper Account" });
    const parent = await addTxn(source, a, { amountLedgerMinor: 10_000, name: "Split shop" });
    await orchestrate.splitTransaction(db(), actorOf(source), parent, [
      { amountLedgerMinor: 6_000 },
      { amountLedgerMinor: 4_000 }
    ]);
    const exported = mutable(await exportsSvc.buildFamilyExport(db(), actorOf(source)));
    const child = exported.entries.find((e) => e.parentEntryId !== null)!;
    child.amountMinor += 1;

    const target = await makeUser();
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/do not add up to the original/);
    await expectFamilyEmpty(target.familyId);
  });

  it("rejects the reviewer probe: entry and recurring currencies flipped away from their USD account", async () => {
    const source = await makeUser();
    const accountId = await makeAccount(source, { name: "Probe USD Account" });
    await addTxn(source, accountId, { amountLedgerMinor: 10_000, name: "Probe txn" });
    await recurringSvc.createSeries(db(), actorOf(source), {
      accountId,
      name: "Probe rent",
      amountLedgerMinor: 10_000,
      frequency: "monthly",
      config: { dayOfMonth: 1 },
      nextDue: daysAgo(-15)
    });
    const exported = mutable(await exportsSvc.buildFamilyExport(db(), actorOf(source)));
    // Change only the two exported currency fields to JPY; the account
    // itself stays USD. Before the fix this imported successfully and the
    // JPY amounts were silently rebuilt as USD balances.
    exported.entries.find((e) => e.name === "Probe txn")!.currency = "JPY";
    exported.recurring[0]!.currency = "JPY";

    const target = await makeUser();
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/does not match its account's currency/);
    await expectFamilyEmpty(target.familyId);
    const restoredSeries = await db()
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.familyId, target.familyId));
    expect(restoredSeries).toHaveLength(0);
  });

  it("rejects a valuation whose currency differs from its account, and restores nothing", async () => {
    const source = await makeUser();
    const house = await makeAccount(source, { name: "Valuation House", type: "other_asset" });
    await valuationsSvc.recordValuation(db(), actorOf(source), {
      accountId: house,
      date: daysAgo(1),
      amountDisplayMinor: 900_000,
      kind: "current",
      name: "House valuation"
    });
    const exported = mutable(await exportsSvc.buildFamilyExport(db(), actorOf(source)));
    const valuation = exported.entries.find((e) => e.kind === "valuation")!;
    valuation.currency = "JPY";

    const target = await makeUser();
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/does not match its account's currency/);
    await expectFamilyEmpty(target.familyId);
  });

  it("rejects a recurring definition whose currency differs from its account, and restores nothing", async () => {
    const source = await makeUser();
    const accountId = await makeAccount(source, { name: "Recurring USD Account" });
    await recurringSvc.createSeries(db(), actorOf(source), {
      accountId,
      name: "Currency-flipped rent",
      amountLedgerMinor: 120_000,
      frequency: "monthly",
      config: { dayOfMonth: 1 },
      nextDue: daysAgo(-15)
    });
    const exported = mutable(await exportsSvc.buildFamilyExport(db(), actorOf(source)));
    exported.recurring[0]!.currency = "JPY";

    const target = await makeUser();
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/does not match its account's currency/);
    await expectFamilyEmpty(target.familyId);
    const restoredSeries = await db()
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.familyId, target.familyId));
    expect(restoredSeries).toHaveLength(0);
  });

  it("rejects a transfer whose legs both differ from their accounts' currency, and restores nothing", async () => {
    const source = await makeUser();
    const a = await makeAccount(source, {
      name: "Leg Currency A",
      openingBalanceDisplayMinor: 100_000
    });
    const b = await makeAccount(source, { name: "Leg Currency B" });
    await orchestrate.makeTransferWithEntries(db(), actorOf(source), {
      fromAccountId: a,
      toAccountId: b,
      date: daysAgo(0),
      amountDisplayMinor: 5_000
    });
    const exported = mutable(await exportsSvc.buildFamilyExport(db(), actorOf(source)));
    // Flip BOTH legs to JPY: they still match each other and balance, so
    // the within-transfer checks pass — but each leg now disagrees with
    // its own USD account.
    for (const entry of exported.entries) entry.currency = "JPY";

    const target = await makeUser();
    await expect(
      importFamilyExport(db(), actorOf(target), parseFamilyExport(encode(exported)))
    ).rejects.toThrow(/does not match its account's currency/);
    await expectFamilyEmpty(target.familyId);
  });

  it("imports a valid mixed-currency export where every record matches its own account", async () => {
    const source = await makeUser();
    const usd = await makeAccount(source, { name: "Mixed USD", currency: "USD" });
    const eur = await makeAccount(source, { name: "Mixed EUR", currency: "EUR" });
    await addTxn(source, usd, { amountLedgerMinor: 10_000, name: "USD txn" });
    await addTxn(source, eur, { amountLedgerMinor: 20_000, name: "EUR txn" });
    await recurringSvc.createSeries(db(), actorOf(source), {
      accountId: eur,
      name: "EUR series",
      amountLedgerMinor: 30_000,
      frequency: "monthly",
      config: { dayOfMonth: 1 },
      nextDue: daysAgo(-15)
    });
    const exported = await exportsSvc.buildFamilyExport(db(), actorOf(source));

    const target = await makeUser();
    const result = await importFamilyExport(
      db(),
      actorOf(target),
      parseFamilyExport(encode(exported))
    );
    expect(result.accounts).toBe(2);
    expect(result.entries).toBe(2);
    expect(result.recurring).toBe(1);

    const restoredAccounts = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.familyId, target.familyId));
    const currencyByAccount = new Map(restoredAccounts.map((a) => [a.id, a.currency]));
    expect([...currencyByAccount.values()].sort()).toEqual(["EUR", "USD"]);
    const restoredEntries = await db()
      .select()
      .from(entries)
      .where(
        sql`${entries.accountId} IN (SELECT id FROM accounts WHERE family_id = ${target.familyId}::uuid)`
      );
    expect(restoredEntries).toHaveLength(2);
    for (const entry of restoredEntries) {
      expect(entry.currency).toBe(currencyByAccount.get(entry.accountId));
    }
    const restoredSeries = await db()
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.familyId, target.familyId));
    expect(restoredSeries).toHaveLength(1);
    expect(restoredSeries[0]!.currency).toBe(currencyByAccount.get(restoredSeries[0]!.accountId));
  });

  it("rejects an invalid recurring config at parse time and bounds nextOccurrence", () => {
    const bad = {
      version: 2,
      family: {
        id: "11111111-1111-1111-1111-111111111111",
        name: "Bad Config Family",
        currency: "USD",
        locale: "en-US",
        timezone: "UTC",
        createdAt: new Date().toISOString(),
        members: []
      },
      accounts: [],
      categories: [],
      tags: [],
      entries: [],
      recurring: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          accountId: "33333333-3333-3333-3333-333333333333",
          createdBy: null,
          name: "Bad weekly",
          merchant: null,
          amountMinor: 1_000,
          currency: "USD",
          categoryId: null,
          frequency: "weekly",
          config: { weekday: 99 },
          nextDue: daysAgo(-1),
          active: true,
          lastPostedEntryId: null
        }
      ]
    };
    expect(() => parseFamilyExport(encode(bad))).toThrow(/weekday/);
    // The wedge itself is bounded even if a bad row reaches the worker.
    expect(() => nextOccurrence("weekly", { weekday: 99 }, daysAgo(0))).toThrow(/weekday/);
  });

  it("preserves joint account ownership through a restore", async () => {
    const admin = await makeUser({ familyName: "JointRestoreFam" });
    const member = await makeUser();
    await joinFamily(member, admin.familyId);
    await makeAccount(admin, { name: "Joint Account", joint: true });
    await makeAccount(admin, { name: "Private Account", joint: false });

    const exported = await exportsSvc.buildFamilyExport(db(), actorOf(admin));
    await wipeFamilyData(admin.familyId);
    await importFamilyExport(db(), actorOf(admin), parseFamilyExport(encode(exported)));

    const restored = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.familyId, admin.familyId));
    expect(restored.find((a) => a.name === "Joint Account")!.ownerId).toBeNull();
    expect(restored.find((a) => a.name === "Private Account")!.ownerId).toBe(admin.userId);

    const memberVisible = await accountsSvc.listAccountsForActor(db(), actorOf(member, "member"));
    expect(memberVisible.map((a) => a.name)).toContain("Joint Account");
    expect(memberVisible.map((a) => a.name)).not.toContain("Private Account");
  });

  it("exports only the exporting member's own saved filters", async () => {
    const admin = await makeUser();
    const member = await makeUser();
    await joinFamily(member, admin.familyId);
    await savedFiltersSvc.createSavedFilter(db(), member.userId, "Private medical spending", {
      q: "medical"
    });
    await savedFiltersSvc.createSavedFilter(db(), admin.userId, "Admin rent search", {
      q: "rent"
    });

    const exported = await exportsSvc.buildFamilyExport(db(), actorOf(admin));
    const names = exported.savedFilters.map((f) => f.name);
    expect(names).toContain("Admin rent search");
    expect(names).not.toContain("Private medical spending");
  });

  it("remaps saved-filter params to restored ids and drops unremappable references", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const account = await makeAccount(user, { name: "Remap Account" });
    const cat = await categoriesSvc.createCategory(db(), actor, { name: "RemapCat" });
    const tag = await tagsSvc.createTag(db(), actor, { name: "remaptag" });
    await savedFiltersSvc.createSavedFilter(db(), user.userId, "Remapped", {
      account,
      category: cat.categoryId,
      tag: tag.tagId,
      q: "x"
    });

    const exported = await exportsSvc.buildFamilyExport(db(), actor);
    await wipeFamilyData(user.familyId);
    await importFamilyExport(db(), actor, parseFamilyExport(encode(exported)));

    const restoredAccount = (
      await db().select().from(accounts).where(eq(accounts.familyId, user.familyId))
    )[0]!;
    const restoredCategory = (
      await db().select().from(categories).where(eq(categories.familyId, user.familyId))
    )[0]!;
    const restoredFilters = await db()
      .select()
      .from(savedFilters)
      .where(eq(savedFilters.userId, user.userId));
    expect(restoredFilters).toHaveLength(1);
    const params = restoredFilters[0]!.params as Record<string, string>;
    expect(params.account).toBe(restoredAccount.id);
    expect(params.account).not.toBe(account);
    expect(params.category).toBe(restoredCategory.id);
    expect(params.q).toBe("x");
    expect(params.tag).toBeTruthy();
    expect(params.tag).not.toBe(tag.tagId);

    // A reference that is not part of the export is dropped, not copied.
    const tampered = mutable(exported);
    tampered.savedFilters[0]!.params.account = "99999999-9999-9999-9999-999999999999";
    await wipeFamilyData(user.familyId);
    await importFamilyExport(db(), actor, parseFamilyExport(encode(tampered)));
    const refilters = await db()
      .select()
      .from(savedFilters)
      .where(eq(savedFilters.userId, user.userId));
    expect(refilters).toHaveLength(1);
    const reparsed = refilters[0]!.params as Record<string, string>;
    expect(reparsed.account).toBeUndefined();
    expect(reparsed.category).toBeTruthy();
  });

  it("does not export a transfer whose other leg is in an account the exporter cannot see", async () => {
    const admin = await makeUser();
    const member = await makeUser();
    await joinFamily(member, admin.familyId);
    const shared = await makeAccount(admin, { name: "Shared Pot", joint: true });
    const priv = await makeAccount(admin, { name: "Admin Private", joint: false });
    await orchestrate.makeTransferWithEntries(db(), actorOf(admin), {
      fromAccountId: shared,
      toAccountId: priv,
      date: daysAgo(0),
      amountDisplayMinor: 5_000
    });

    const memberExport = await exportsSvc.buildFamilyExport(db(), actorOf(member, "member"));
    expect(memberExport.transfers).toHaveLength(0);
    const memberEntries = memberExport.entries as {
      amountMinor: number;
      transferId: string | null;
    }[];
    const visibleLeg = memberEntries.find((e) => e.amountMinor === 5_000);
    expect(visibleLeg).toBeTruthy();
    expect(visibleLeg!.transferId).toBeNull();

    const adminExport = await exportsSvc.buildFamilyExport(db(), actorOf(admin));
    expect(adminExport.transfers).toHaveLength(1);
  });
});

describe("manual holdings export → restore round-trip", () => {
  it("carries holdings with remapped account ids and matching balances", async () => {
    const user = await makeUser({ familyName: "HoldingsFamily" });
    const actor = actorOf(user);
    const exec = db();

    const brokerage = await makeAccount(user, {
      name: "RT Brokerage",
      type: "other_asset",
      openingBalanceDisplayMinor: 0
    });
    await holdingsSvc.addHolding(exec, actor, {
      accountId: brokerage,
      ticker: "NABIL",
      companyName: "Nabil Bank",
      quantity: "100",
      averageCostMinor: 200_00,
      currentPriceMinor: 250_00
    });
    await holdingsSvc.addHolding(exec, actor, {
      accountId: brokerage,
      ticker: "HIDCL",
      quantity: "50.5",
      averageCostMinor: 100_00,
      currentPriceMinor: null
    });
    const sourceBalance = (await latestBalance(brokerage))?.balanceMinor;
    expect(sourceBalance).toBe(2_500_000 + 505_000);

    const exported = await exportsSvc.buildFamilyExport(exec, actor);
    expect(exported.version).toBe(3);
    expect(exported.holdings).toHaveLength(2);
    expect(exported.holdings.find((h) => h.ticker === "HIDCL")).toMatchObject({
      quantity: "50.5",
      currentPriceMinor: null
    });

    await wipeFamilyData(user.familyId);

    const result = await importFamilyExport(
      exec,
      actor,
      parseFamilyExport(encode(JSON.parse(JSON.stringify(exported))))
    );
    expect(result.holdings).toBe(2);

    const [restored] = await exec.select().from(accounts).where(eq(accounts.name, "RT Brokerage"));
    expect(restored).toBeTruthy();
    expect(restored!.id).not.toBe(brokerage);

    const restoredHoldings = await holdingsSvc.listHoldings(exec, actor, restored!.id);
    expect(restoredHoldings).toHaveLength(2);
    expect(restoredHoldings.find((h) => h.ticker === "NABIL")).toMatchObject({
      companyName: "Nabil Bank",
      quantity: "100",
      averageCostMinor: 200_00,
      currentPriceMinor: 250_00
    });
    expect(restoredHoldings.find((h) => h.ticker === "HIDCL")).toMatchObject({
      quantity: "50.5",
      currentPriceMinor: null
    });
    expect((await latestBalance(restored!.id))?.balanceMinor).toBe(sourceBalance);
  });

  it("rejects a tampered export whose holding references a missing account", async () => {
    const user = await makeUser({ familyName: "TamperedHoldingsFamily" });
    const actor = actorOf(user);
    const brokerage = await makeAccount(user, {
      name: "Tamper Brokerage",
      type: "other_asset",
      openingBalanceDisplayMinor: 0
    });
    await holdingsSvc.addHolding(db(), actor, {
      accountId: brokerage,
      ticker: "NABIL",
      quantity: "10",
      averageCostMinor: 100_00
    });
    const exported = await exportsSvc.buildFamilyExport(db(), actor);
    const tampered = JSON.parse(JSON.stringify(exported)) as {
      holdings: { accountId: string }[];
    };
    tampered.holdings[0]!.accountId = "00000000-0000-0000-0000-000000000000";
    await wipeFamilyData(user.familyId);
    await expect(
      importFamilyExport(db(), actor, parseFamilyExport(encode(tampered)))
    ).rejects.toThrow(/references an account that is not part of the export/);
  });
});
