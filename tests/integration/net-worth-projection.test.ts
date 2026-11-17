import { beforeEach, describe, expect, it } from "vitest";
import { actorOf, daysAgo, db, makeAccount, makeUser, truncateAll } from "../helpers";
import { currentFamily } from "@/server/auth/context";
import { createSeries, setSeriesActive } from "@/server/domain/recurring";
import { netWorthProjectionSeries, netWorthSeries } from "@/server/domain/reports";
import { recordValuation } from "@/server/domain/valuations";
import { recalculateAccount } from "@/server/domain/balances";
import { ensureDefaultFlags, isFlagEnabled, setFlagEnabled } from "@/server/flags";

function dayOf(date: string): number {
  return Number(date.slice(8, 10));
}

describe("net worth projection", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("projects scheduled outflows from today's balances, holding valuation accounts flat", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const today = daysAgo(0);

    const checkingId = await makeAccount(user, {
      type: "depository",
      name: "Checking",
      currency: "NPR",
      openingBalanceDisplayMinor: 100_000
    });
    const investmentId = await makeAccount(user, {
      type: "other_asset",
      name: "Portfolio",
      currency: "NPR",
      openingBalanceDisplayMinor: 0
    });
    await recordValuation(db(), actor, {
      accountId: investmentId,
      date: daysAgo(30),
      amountDisplayMinor: 50_000,
      kind: "opening",
      name: "Principal"
    });
    await recalculateAccount(db(), investmentId, daysAgo(30));

    await createSeries(db(), actor, {
      accountId: checkingId,
      name: "Rent",
      amountLedgerMinor: 5_000,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(-10)) },
      nextDue: daysAgo(-10)
    });

    const result = await netWorthProjectionSeries(db(), family, user.userId, { today });
    expect(result.startingMinor).toBe(150_000);
    expect(result.valuationFlatMinor).toBe(50_000);
    expect(result.valuationAccountCount).toBe(1);
    expect(result.horizonEnd).toBe(daysAgo(-90));
    expect(result.skippedSeries).toBe(0);
    expect(result.fx.incompleteFx).toBe(false);
    expect(result.points[0]).toEqual({ date: today, valueMinor: 150_000 });
    // First rent lands 10 days out: the +14-day point is the first to drop.
    expect(result.points[2]).toEqual({ date: daysAgo(-14), valueMinor: 145_000 });
    // Three monthly rents inside 90 days (days +10, +40, +70).
    expect(result.points[result.points.length - 1]).toEqual({
      date: daysAgo(-90),
      valueMinor: 135_000
    });
  });

  it("joins exactly onto the last historical point", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const checkingId = await makeAccount(user, {
      type: "depository",
      name: "Checking",
      currency: "NPR",
      openingBalanceDisplayMinor: 80_000
    });
    await createSeries(db(), actor, {
      accountId: checkingId,
      name: "Subscription",
      amountLedgerMinor: 2_000,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(-5)) },
      nextDue: daysAgo(-5)
    });

    const history = await netWorthSeries(db(), family, user.userId, 90);
    expect(history.points.length).toBeGreaterThan(0);
    const last = history.points[history.points.length - 1]!;
    const result = await netWorthProjectionSeries(db(), family, user.userId, {
      today: daysAgo(0),
      start: { date: last.date, valueMinor: last.valueMinor }
    });
    expect(result.points[0]).toEqual({ date: last.date, valueMinor: last.valueMinor });
    expect(result.startingMinor).toBe(last.valueMinor);
  });

  it("ignores inactive series and overdue occurrences", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const checkingId = await makeAccount(user, {
      type: "depository",
      name: "Checking",
      currency: "NPR",
      openingBalanceDisplayMinor: 100_000
    });
    const pausedId = await createSeries(db(), actor, {
      accountId: checkingId,
      name: "Paused",
      amountLedgerMinor: 999_999,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(-5)) },
      nextDue: daysAgo(-5)
    });
    await setSeriesActive(db(), actor, pausedId, false);
    await createSeries(db(), actor, {
      accountId: checkingId,
      name: "Overdue",
      amountLedgerMinor: 10_000,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(3)) },
      nextDue: daysAgo(3)
    });

    const result = await netWorthProjectionSeries(db(), family, user.userId, { today: daysAgo(0) });
    // The overdue occurrence itself is not projected, but the series' next
    // three monthly occurrences are (100,000 - 3 x 10,000). The paused
    // series contributes nothing.
    expect(result.points[result.points.length - 1]?.valueMinor).toBe(70_000);
  });

  it("excludes amounts with no exchange rate and reports the FX gap", async () => {
    const user = await makeUser({ currency: "NPR" });
    const actor = actorOf(user);
    const family = await currentFamily(actor);
    const nprId = await makeAccount(user, {
      type: "depository",
      name: "NPR checking",
      currency: "NPR",
      openingBalanceDisplayMinor: 100_000
    });
    const usdId = await makeAccount(user, {
      type: "depository",
      name: "USD checking",
      currency: "USD",
      openingBalanceDisplayMinor: 1_000
    });
    await createSeries(db(), actor, {
      accountId: usdId,
      name: "USD subscription",
      amountLedgerMinor: 500,
      frequency: "monthly",
      config: { dayOfMonth: dayOf(daysAgo(-5)) },
      nextDue: daysAgo(-5)
    });
    void nprId;

    const result = await netWorthProjectionSeries(db(), family, user.userId, { today: daysAgo(0) });
    expect(result.startingMinor).toBe(100_000);
    expect(result.fx.incompleteFx).toBe(true);
    expect(result.points.every((p) => p.valueMinor === 100_000)).toBe(true);
  });

  it("the flag gates the feature: off by default, toggleable", async () => {
    await ensureDefaultFlags(db());
    expect(await isFlagEnabled(db(), "net_worth_projections")).toBe(false);
    expect(await setFlagEnabled(db(), "net_worth_projections", true)).toBe(true);
    expect(await isFlagEnabled(db(), "net_worth_projections")).toBe(true);
  });
});
