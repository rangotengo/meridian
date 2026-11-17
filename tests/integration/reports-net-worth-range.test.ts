import { describe, it, expect, beforeEach } from "vitest";
import { currentFamily } from "@/server/auth/context";
import * as reportsSvc from "@/server/domain/reports";
import { resolveReportRange, selectNetWorthInRange } from "@/lib/report-range";
import { addMonths, endOfMonth, monthKeyOf } from "@/lib/datetime";
import { db, truncateAll, makeUser, makeAccount, addTxn, daysAgo, actorOf } from "../helpers";

/**
 * Historical custom ranges must constrain net worth to the chosen dates.
 * Regression: the page fetched a trailing window ending today (and the
 * old custom-range span math even produced a negative day count, so the
 * series came back empty and the headline read 0). The headline for
 * Sep–Oct must be the Oct 31 snapshot, not today's value.
 */
describe("reports net worth follows the chosen range", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("headlines the last snapshot inside a historical range, not today", async () => {
    const user = await makeUser({ currency: "NPR", timezone: "UTC" });
    const family = await currentFamily(actorOf(user));
    const today = daysAgo(0);
    const currentMonth = monthKeyOf(today);
    const fromMonth = addMonths(currentMonth, -2);
    const toMonth = addMonths(currentMonth, -1);
    const range = resolveReportRange({
      currentMonth,
      from: `${fromMonth}-15`,
      to: `${toMonth}-10`,
      today
    });
    expect(range.from).toBe(`${fromMonth}-01`);
    expect(range.to).toBe(endOfMonth(`${toMonth}-01`));
    expect(range.netWorthDays).toBeGreaterThan(0);

    const accountId = await makeAccount(user, {
      currency: "NPR",
      openedOn: daysAgo(90),
      openingBalanceDisplayMinor: 0
    });
    // Balance steps through the range: 100,000 from mid-September,
    // 150,000 from the end of October, 999,000 today.
    await addTxn(user, accountId, {
      amountLedgerMinor: -100000,
      date: `${fromMonth}-15`,
      name: "September income"
    });
    await addTxn(user, accountId, {
      amountLedgerMinor: -50000,
      date: endOfMonth(`${toMonth}-01`),
      name: "October income"
    });
    await addTxn(user, accountId, {
      amountLedgerMinor: -849000,
      date: today,
      name: "November income"
    });

    const { points } = await reportsSvc.netWorthSeries(
      db(),
      family,
      user.userId,
      range.netWorthDays
    );
    expect(points.length).toBeGreaterThan(0);
    // Unfiltered, the series ends at today's value — the old headline.
    expect(points[points.length - 1]?.valueMinor).toBe(999000);

    const { points: inRange, latest } = selectNetWorthInRange(points, range.from, range.to);
    expect(inRange.length).toBeGreaterThan(0);
    expect(inRange.every((p) => p.date >= range.from && p.date <= range.to)).toBe(true);
    expect(latest?.date).toBe(endOfMonth(`${toMonth}-01`));
    expect(latest?.valueMinor).toBe(150000);
  });
});
