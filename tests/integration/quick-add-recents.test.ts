import { describe, it, expect, beforeEach } from "vitest";
import { listEntriesPage } from "@/server/domain/entries";
import { createCategory } from "@/server/domain/categories";
import { recentPayees, recentCategories } from "@/lib/recent-transactions";
import { db, truncateAll, makeUser, makeAccount, addTxn, actorOf, daysAgo } from "../helpers";

describe("quick add recents (listEntriesPage -> recent helpers)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("surfaces the most recent merchants and categories for the family", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makeAccount(user);
    const groceries = await createCategory(db(), actor, { name: "Groceries" });
    const transport = await createCategory(db(), actor, { name: "Transport" });
    await addTxn(user, accountId, {
      amountLedgerMinor: 1000,
      date: daysAgo(5),
      name: "Weekly shop",
      merchant: "Old Mart",
      categoryId: groceries.categoryId
    });
    await addTxn(user, accountId, {
      amountLedgerMinor: 2000,
      date: daysAgo(2),
      name: "Bus fare",
      merchant: "Sajha Bus",
      categoryId: transport.categoryId
    });
    await addTxn(user, accountId, {
      amountLedgerMinor: 1500,
      date: daysAgo(1),
      name: "Top-up shop",
      merchant: "Old Mart",
      categoryId: groceries.categoryId
    });
    // Dated today so it is unambiguously the most recent entry:
    // same-day ties order by random UUID in listEntriesPage.
    await addTxn(user, accountId, {
      amountLedgerMinor: 500,
      date: daysAgo(0),
      name: "No merchant",
      merchant: null,
      categoryId: null
    });

    const page = await listEntriesPage(db(), actor, { limit: 50 });
    // The merchant-less entry contributes its description as a payee
    // chip (Quick Add saves merchant:null); it is the most recent, so
    // it sorts first.
    expect(recentPayees(page.items)).toEqual([
      { name: "No merchant", categoryId: null },
      { name: "Old Mart", categoryId: groceries.categoryId },
      { name: "Sajha Bus", categoryId: transport.categoryId }
    ]);
    expect(recentCategories(page.items)).toEqual([
      { id: groceries.categoryId, name: "Groceries" },
      { id: transport.categoryId, name: "Transport" }
    ]);
  });
});
