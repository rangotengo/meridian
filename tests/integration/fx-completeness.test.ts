import { describe, it, expect, beforeAll } from "vitest";
import { db, makeUser, makeAccount, addTxn, truncateAll, actorOf, daysAgo } from "../helpers";
import * as reportsSvc from "@/server/domain/reports";
import * as budgetsSvc from "@/server/domain/budgets";
import * as categoriesSvc from "@/server/domain/categories";
import * as exchangeRatesSvc from "@/server/domain/exchange-rates";
import { executeTool, buildToolContext } from "@/server/ai/tools";
import { currentFamily, type Family } from "@/server/auth/context";
import { endOfMonth } from "@/lib/datetime";
import type { TestUser } from "../helpers";

// Every household here is NPR-based. AUD has a rate (90 NPR, quoted
// yesterday); CAD deliberately never gets one, so CAD amounts must be
// excluded from converted totals and reported in the fx completeness
// metadata of every affected service.
const AUD_RATE = 90;

beforeAll(async () => {
  await truncateAll();
  await exchangeRatesSvc.upsertRate(db(), {
    base: "AUD",
    quote: "NPR",
    rate: String(AUD_RATE),
    quotedOn: daysAgo(1)
  });
});

async function makeHousehold(): Promise<{ user: TestUser; family: Family }> {
  const user = await makeUser({ currency: "NPR", timezone: "UTC" });
  const family = await currentFamily(actorOf(user));
  return { user, family };
}

describe("fx completeness beyond the dashboard", () => {
  it("sidebar net worth excludes the unrated currency and reports the excluded amount", async () => {
    const { family } = await makeHousehold();

    const result = await reportsSvc.netWorthMinorForAccounts(
      db(),
      family,
      [
        { displayBalanceMinor: 5000, currency: "NPR" },
        { displayBalanceMinor: 10000, currency: "AUD" },
        { displayBalanceMinor: 20000, currency: "CAD" }
      ],
      daysAgo(0)
    );

    expect(result.netWorthMinor).toBe(5000 + 10000 * AUD_RATE);
    expect(result.fx.incompleteFx).toBe(true);
    expect(result.fx.fxIssues).toHaveLength(1);
    expect(result.fx.fxIssues[0]).toMatchObject({
      base: "CAD",
      quote: "NPR",
      amountMinor: 20000
    });
    expect(result.fx.fxRates).toHaveLength(1);
    expect(result.fx.fxRates[0]).toMatchObject({ base: "AUD", quote: "NPR" });

    // Control: with every currency rated, there is nothing to warn about.
    const complete = await reportsSvc.netWorthMinorForAccounts(
      db(),
      family,
      [
        { displayBalanceMinor: 5000, currency: "NPR" },
        { displayBalanceMinor: 10000, currency: "AUD" }
      ],
      daysAgo(0)
    );
    expect(complete.netWorthMinor).toBe(5000 + 10000 * AUD_RATE);
    expect(complete.fx.incompleteFx).toBe(false);
    expect(complete.fx.fxIssues).toHaveLength(0);
  });

  it("net worth series excludes the unrated account on every point and reports it", async () => {
    const { user, family } = await makeHousehold();
    await makeAccount(user, { currency: "AUD", openingBalanceDisplayMinor: 10000 });
    await makeAccount(user, { currency: "CAD", openingBalanceDisplayMinor: 20000 });

    const { points, fx } = await reportsSvc.netWorthSeries(db(), family, user.userId, 10);

    expect(points.length).toBeGreaterThan(0);
    expect(points[points.length - 1]!.valueMinor).toBe(10000 * AUD_RATE);
    expect(fx.incompleteFx).toBe(true);
    const issue = fx.fxIssues.find((i) => i.base === "CAD");
    expect(issue).toBeDefined();
    expect(issue!.quote).toBe("NPR");
    // Balances are materialized daily, so the excluded amount accumulates
    // once per daily snapshot — always a positive multiple of the balance.
    expect(issue!.amountMinor).toBeGreaterThanOrEqual(20000);
    expect(issue!.amountMinor % 20000).toBe(0);
  });

  it("income/expense series converts rated flows, excludes unrated ones, and reports them", async () => {
    const { user, family } = await makeHousehold();
    const aud = await makeAccount(user, { currency: "AUD" });
    const cad = await makeAccount(user, { currency: "CAD" });
    await addTxn(user, aud, { amountLedgerMinor: 3000, date: daysAgo(0), name: "AUD spend" });
    await addTxn(user, aud, { amountLedgerMinor: -1000, date: daysAgo(0), name: "AUD income" });
    await addTxn(user, cad, { amountLedgerMinor: 4000, date: daysAgo(0), name: "CAD spend" });

    const { flows, fx } = await reportsSvc.incomeExpenseSeries(db(), family, user.userId, 1);

    expect(flows).toHaveLength(1);
    expect(flows[0]!.expenseMinor).toBe(3000 * AUD_RATE);
    expect(flows[0]!.incomeMinor).toBe(1000 * AUD_RATE);
    expect(fx.incompleteFx).toBe(true);
    expect(fx.fxIssues).toHaveLength(1);
    expect(fx.fxIssues[0]).toMatchObject({ base: "CAD", quote: "NPR", amountMinor: 4000 });
  });

  it("a rate quoted today does not repair a past month that had no effective rate", async () => {
    const { user, family } = await makeHousehold();
    const aud = await makeAccount(user, { currency: "AUD", openedOn: daysAgo(60) });
    // The only AUD rate was quoted yesterday; 40 days ago no rate was in
    // effect, so that month must stay excluded even though a rate exists now.
    await addTxn(user, aud, { amountLedgerMinor: 5000, date: daysAgo(40), name: "Old AUD spend" });

    const { flows, fx } = await reportsSvc.incomeExpenseSeries(db(), family, user.userId, 3);
    const oldMonth = daysAgo(40).slice(0, 7);
    const flow = flows.find((f) => f.monthKey === oldMonth);

    expect(flow).toBeDefined();
    expect(flow!.expenseMinor).toBe(0);
    expect(fx.incompleteFx).toBe(true);
    expect(fx.fxIssues).toHaveLength(1);
    expect(fx.fxIssues[0]).toMatchObject({
      base: "AUD",
      quote: "NPR",
      amountMinor: 5000,
      date: endOfMonth(`${oldMonth}-01`)
    });
    expect(fx.fxRates).toHaveLength(0);
  });

  it("spending by category excludes unrated spending from totals and shares, and reports it", async () => {
    const { user, family } = await makeHousehold();
    const { categoryId } = await categoriesSvc.createCategory(db(), actorOf(user), {
      name: "Food"
    });
    const aud = await makeAccount(user, { currency: "AUD" });
    const cad = await makeAccount(user, { currency: "CAD" });
    const npr = await makeAccount(user, { currency: "NPR" });
    await addTxn(user, aud, { amountLedgerMinor: 3000, date: daysAgo(0), categoryId });
    await addTxn(user, cad, { amountLedgerMinor: 4000, date: daysAgo(0), categoryId });
    await addTxn(user, npr, { amountLedgerMinor: 5000, date: daysAgo(0), categoryId });

    const { categories, fx } = await reportsSvc.spendingByCategory(db(), family, user.userId, {
      from: daysAgo(3),
      to: daysAgo(0)
    });

    const food = categories.find((c) => c.categoryId === categoryId);
    expect(food).toBeDefined();
    expect(food!.totalMinor).toBe(3000 * AUD_RATE + 5000);
    expect(food!.share).toBe(1);
    expect(fx.incompleteFx).toBe(true);
    expect(fx.fxIssues).toHaveLength(1);
    expect(fx.fxIssues[0]).toMatchObject({ base: "CAD", quote: "NPR", amountMinor: 4000 });
  });

  it("daily spending series reports unrated spending it had to drop", async () => {
    const { user, family } = await makeHousehold();
    const aud = await makeAccount(user, { currency: "AUD" });
    const cad = await makeAccount(user, { currency: "CAD" });
    await addTxn(user, aud, { amountLedgerMinor: 2000, date: daysAgo(0), name: "AUD spend" });
    await addTxn(user, cad, { amountLedgerMinor: 4000, date: daysAgo(1), name: "CAD spend" });

    const { points, fx } = await reportsSvc.dailySpendingSeries(db(), family, user.userId, 7);

    expect(points).toHaveLength(7);
    expect(points.reduce((acc, p) => acc + p.amountMinor, 0)).toBe(2000 * AUD_RATE);
    expect(fx.incompleteFx).toBe(true);
    expect(fx.fxIssues).toHaveLength(1);
    expect(fx.fxIssues[0]).toMatchObject({ base: "CAD", quote: "NPR", amountMinor: 4000 });
  });

  it("budget overview bases progress on converted spending only and reports the exclusion", async () => {
    const { user, family } = await makeHousehold();
    const { categoryId } = await categoriesSvc.createCategory(db(), actorOf(user), {
      name: "Food"
    });
    await budgetsSvc.setBudget(db(), actorOf(user), {
      categoryId,
      amountLedgerMinor: 500000
    });
    await budgetsSvc.setBudget(db(), actorOf(user), {
      categoryId: null,
      amountLedgerMinor: 1000000
    });
    const aud = await makeAccount(user, { currency: "AUD" });
    const cad = await makeAccount(user, { currency: "CAD" });
    await addTxn(user, aud, { amountLedgerMinor: 3000, date: daysAgo(0), categoryId });
    await addTxn(user, cad, { amountLedgerMinor: 4000, date: daysAgo(0), categoryId });

    const overview = await budgetsSvc.budgetOverview(db(), family, user.userId);

    const food = overview.perCategory.find((p) => p.categoryId === categoryId);
    expect(food).toBeDefined();
    expect(food!.spentMinor).toBe(3000 * AUD_RATE);
    expect(food!.pct).toBeCloseTo((3000 * AUD_RATE) / 500000);
    expect(overview.overall?.spentMinor).toBe(3000 * AUD_RATE);
    expect(overview.fx.incompleteFx).toBe(true);
    expect(overview.fx.fxIssues).toHaveLength(1);
    expect(overview.fx.fxIssues[0]).toMatchObject({
      base: "CAD",
      quote: "NPR",
      amountMinor: 4000
    });
  });

  it("reports no warning metadata when every currency has a rate", async () => {
    const { user, family } = await makeHousehold();
    // NZD gets a rate old enough to be effective across the whole series
    // window (the AUD rate was only quoted yesterday, so it cannot cover
    // older series points — see the historical test above).
    await exchangeRatesSvc.upsertRate(db(), {
      base: "NZD",
      quote: "NPR",
      rate: "80",
      quotedOn: daysAgo(30)
    });
    const aud = await makeAccount(user, {
      currency: "NZD",
      openingBalanceDisplayMinor: 10000
    });
    await addTxn(user, aud, { amountLedgerMinor: 2000, date: daysAgo(0), name: "NZD spend" });

    const { points, fx } = await reportsSvc.netWorthSeries(db(), family, user.userId, 10);
    expect(points[points.length - 1]!.valueMinor).toBeGreaterThan(0);
    expect(fx.incompleteFx).toBe(false);
    expect(fx.fxIssues).toHaveLength(0);

    const spend = await reportsSvc.spendingByCategory(db(), family, user.userId, {
      from: daysAgo(3),
      to: daysAgo(0)
    });
    expect(spend.fx.incompleteFx).toBe(false);
    expect(spend.fx.fxIssues).toHaveLength(0);
  });

  it("dashboard_summary AI tool forwards the fx completeness warnings", async () => {
    const { user } = await makeHousehold();
    await makeAccount(user, { currency: "CAD", openingBalanceDisplayMinor: 20000 });

    const ctx = await buildToolContext(db(), actorOf(user));
    const res = (await executeTool("dashboard_summary", "{}", ctx)) as {
      netWorthMinor: number;
      fx: reportsSvc.FxCompleteness;
    };

    // The CAD balance is excluded from the converted total, and the tool
    // result carries the same `fx` shape as query_spending /
    // monthly_income_expense instead of dropping the warning.
    expect(res.netWorthMinor).toBe(0);
    expect(res.fx.incompleteFx).toBe(true);
    expect(res.fx.fxIssues).toHaveLength(1);
    expect(res.fx.fxIssues[0]).toMatchObject({
      base: "CAD",
      quote: "NPR",
      amountMinor: 20000
    });

    // Control: a household with only family-currency accounts gets a
    // complete, empty fx block (arrays present, not undefined).
    const { user: plainUser } = await makeHousehold();
    await makeAccount(plainUser, { currency: "NPR", openingBalanceDisplayMinor: 5000 });
    const plainCtx = await buildToolContext(db(), actorOf(plainUser));
    const plain = (await executeTool("dashboard_summary", "{}", plainCtx)) as {
      netWorthMinor: number;
      fx: reportsSvc.FxCompleteness;
    };
    expect(plain.netWorthMinor).toBe(5000);
    expect(plain.fx.incompleteFx).toBe(false);
    expect(plain.fx.fxIssues).toEqual([]);
    expect(plain.fx.fxRates).toEqual([]);
  });
});
