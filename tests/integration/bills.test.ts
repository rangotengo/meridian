import { beforeEach, describe, expect, it } from "vitest";
import {
  addTxn,
  actorOf,
  daysAgo,
  db,
  joinFamily,
  makeAccount,
  makeUser,
  truncateAll
} from "../helpers";
import { createSeries, setSeriesActive } from "@/server/domain/recurring";
import { listUpcomingBills } from "@/server/domain/bills";

function dayOf(date: string): number {
  return Number(date.slice(8, 10));
}

describe("bills & reminders", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("buckets active series into missed, due-soon, and upcoming", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });
    const today = daysAgo(0);

    await createSeries(db(), actor, {
      accountId,
      name: "Overdue rent",
      amountLedgerMinor: 50_000,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(2)) },
      nextDue: daysAgo(2)
    });
    await createSeries(db(), actor, {
      accountId,
      name: "Internet",
      amountLedgerMinor: 5_000,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(0)) },
      nextDue: daysAgo(0)
    });
    await createSeries(db(), actor, {
      accountId,
      name: "Gym",
      amountLedgerMinor: 3_000,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(-10)) },
      nextDue: daysAgo(-10)
    });
    await createSeries(db(), actor, {
      accountId,
      name: "Far away",
      amountLedgerMinor: 1_000,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(-31)) },
      nextDue: daysAgo(-31)
    });

    const bills = await listUpcomingBills(db(), actor, today);
    expect(bills.missed.map((b) => b.name)).toEqual(["Overdue rent"]);
    expect(bills.missed[0]?.daysUntilDue).toBe(-2);
    expect(bills.dueSoon.map((b) => b.name)).toEqual(["Internet"]);
    expect(bills.dueSoon[0]?.daysUntilDue).toBe(0);
    expect(bills.upcoming.map((b) => b.name)).toEqual(["Gym"]);
    expect(bills.upcoming[0]?.daysUntilDue).toBe(10);
  });

  it("excludes inactive series", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });
    const seriesId = await createSeries(db(), actor, {
      accountId,
      name: "Paused bill",
      amountLedgerMinor: 5_000,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(1)) },
      nextDue: daysAgo(1)
    });
    await setSeriesActive(db(), actor, seriesId, false);

    const bills = await listUpcomingBills(db(), actor, daysAgo(0));
    expect(bills.missed).toEqual([]);
    expect(bills.dueSoon).toEqual([]);
    expect(bills.upcoming).toEqual([]);
  });

  it("a matching hand-recorded payment clears the missed flag", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });
    const today = daysAgo(0);

    await createSeries(db(), actor, {
      accountId,
      name: "Internet bill",
      merchant: "WorldLink",
      amountLedgerMinor: 5_000,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(2)) },
      nextDue: daysAgo(2)
    });
    await createSeries(db(), actor, {
      accountId,
      name: "Water bill",
      merchant: "KUKL",
      amountLedgerMinor: 800,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(2)) },
      nextDue: daysAgo(2)
    });

    // Paid the internet bill by hand today (same amount + name).
    await addTxn(user, accountId, {
      date: today,
      name: "Internet bill",
      merchant: "WorldLink",
      amountLedgerMinor: 5_000
    });
    // A wrong-amount payment for the water bill does not clear it.
    await addTxn(user, accountId, {
      date: today,
      name: "Water bill",
      merchant: "KUKL",
      amountLedgerMinor: 999
    });

    const bills = await listUpcomingBills(db(), actor, today);
    expect(bills.missed.map((b) => b.name)).toEqual(["Water bill"]);
  });

  it("hides series on another member's unshared account", async () => {
    const user1 = await makeUser();
    const user2 = await makeUser();
    await joinFamily(user2, user1.familyId);
    const privateAccount = await makeAccount(user2, { joint: false });
    await createSeries(db(), actorOf(user2), {
      accountId: privateAccount,
      name: "Private bill",
      amountLedgerMinor: 5_000,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(-3)) },
      nextDue: daysAgo(-3)
    });

    const billsForUser1 = await listUpcomingBills(db(), actorOf(user1), daysAgo(0));
    expect(billsForUser1.dueSoon).toEqual([]);
    const billsForUser2 = await listUpcomingBills(db(), actorOf(user2), daysAgo(0));
    expect(billsForUser2.dueSoon.map((b) => b.name)).toEqual(["Private bill"]);
  });
});
