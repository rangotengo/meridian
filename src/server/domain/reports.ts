import { sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import type { Family } from "../auth/context";
import { getRateInfo, convertMinor, type RateInfo } from "./exchange-rates";
import { captureDebugLog } from "../observability/debug-log";
import {
  addDays,
  addMonths,
  endOfMonth,
  monthKeyIn,
  monthKeyOf,
  startOfMonth,
  todayIn
} from "@/lib/datetime";
import { errors } from "@/lib/errors";

function safeParseMinor(raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw errors.validation("Amount exceeds safe integer range.");
  }
  return n;
}

function safeAdd(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw errors.validation("Report aggregate exceeds safe integer bounds.");
  }
  return sum;
}

export type FxIssue = {
  base: string;
  quote: string;
  date: string;
  /** Total amount (minor units of `base`) excluded because no rate existed. */
  amountMinor: number;
};

/** A rate a report actually converted with, including its quoted-on date. */
export type FxRateUsed = RateInfo;

export type ConversionContext = {
  issues: Map<string, FxIssue>;
  rateCache: Map<string, RateInfo | null>;
  /** Successful conversions, keyed by `base:quote`, for stale-rate display. */
  usedRates: Map<string, RateInfo>;
};

function newConversionContext(): ConversionContext {
  return { issues: new Map(), rateCache: new Map(), usedRates: new Map() };
}

/**
 * Completeness metadata returned alongside converted totals. When a rate is
 * missing, the affected amounts are excluded from the totals and reported in
 * `fxIssues` (with the excluded amount per currency pair) instead of silently
 * understating the result; `fxRates` lists the rates that were used.
 */
export type FxCompleteness = {
  incompleteFx: boolean;
  fxIssues: FxIssue[];
  fxRates: FxRateUsed[];
};

function completenessOf(ctx: ConversionContext): FxCompleteness {
  return {
    incompleteFx: ctx.issues.size > 0,
    fxIssues: Array.from(ctx.issues.values()),
    fxRates: Array.from(ctx.usedRates.values())
  };
}

/**
 * Merge completeness from several computations (e.g. every widget on a page)
 * into one summary for a shared warning banner. Issues and rates are deduped
 * by currency pair; an issue's `amountMinor` is per-computation and not
 * additive across computations, so the first reporter of a pair wins.
 */
export function mergeFxCompleteness(...parts: FxCompleteness[]): FxCompleteness {
  const issues = new Map<string, FxIssue>();
  const rates = new Map<string, FxRateUsed>();
  for (const part of parts) {
    for (const issue of part.fxIssues) {
      const key = `${issue.base}:${issue.quote}`;
      if (!issues.has(key)) issues.set(key, issue);
    }
    for (const rate of part.fxRates) {
      const key = `${rate.base}:${rate.quote}`;
      const existing = rates.get(key);
      if (!existing || rate.quotedOn > existing.quotedOn) rates.set(key, rate);
    }
  }
  return {
    incompleteFx: issues.size > 0,
    fxIssues: [...issues.values()],
    fxRates: [...rates.values()]
  };
}

async function convertTo(
  exec: Executor,
  amountMinor: number,
  from: string,
  to: string,
  onDate: string,
  ctx: ConversionContext
): Promise<number> {
  if (from === to) return amountMinor;
  const cacheKey = `${from}:${to}:${onDate}`;
  let info: RateInfo | null;
  if (ctx.rateCache.has(cacheKey)) {
    info = ctx.rateCache.get(cacheKey)!;
  } else {
    info = await getRateInfo(exec, from, to, onDate);
    ctx.rateCache.set(cacheKey, info);
  }
  if (info === null) {
    const key = `${from}:${to}`;
    const existing = ctx.issues.get(key);
    if (existing) {
      existing.amountMinor = safeAdd(existing.amountMinor, amountMinor);
    } else {
      ctx.issues.set(key, { base: from, quote: to, date: onDate, amountMinor });
    }
    return 0;
  }
  const usedKey = `${from}:${to}`;
  const previous = ctx.usedRates.get(usedKey);
  if (!previous || info.quotedOn > previous.quotedOn) ctx.usedRates.set(usedKey, info);
  return convertMinor(amountMinor, info.rate, from, to);
}

export type DashboardSummary = {
  netWorthMinor: number;
  assetsMinor: number;
  liabilitiesMinor: number;
  incomeThisMonthMinor: number;
  expenseThisMonthMinor: number;
  topCategories: { categoryId: string | null; name: string; totalMinor: number }[];
  recentEntries: {
    id: string;
    date: string;
    name: string;
    amountMinor: number;
    currency: string;
    accountName: string;
    transferId: string | null;
  }[];
  monthKey: string;
  incompleteFx?: boolean;
  fxIssues?: FxIssue[];
  /** Rates the totals were converted with, so the UI can show their dates. */
  fxRates?: FxRateUsed[];
};

const ACCESS_SQL = (userId: string) =>
  sql`(\n  a.owner_id IS NULL\n  OR a.owner_id = ${userId}\n  OR EXISTS (\n    SELECT 1 FROM account_shares s\n    WHERE s.account_id = a.id AND s.user_id = ${userId}\n  )\n)`;

/**
 * Optional extra account restriction for report queries (e.g. an MCP
 * grant's account ceiling). `undefined` leaves the query unrestricted
 * beyond ACCESS_SQL; an empty list matches nothing.
 */
function accountFilter(accountIds?: string[]) {
  if (!accountIds) return sql``;
  if (accountIds.length === 0) return sql`AND 1 = 0`;
  return sql`AND a.id IN (${sql.join(
    accountIds.map((id) => sql`${id}`),
    sql`, `
  )})`;
}

export async function dashboardSummary(
  exec: Executor,
  family: Family,
  userId: string
): Promise<DashboardSummary> {
  const ctx = newConversionContext();
  const today = todayIn(family.timezone);
  const currency = family.currency;

  const balanceRows = await exec.execute<{
    account_id: string;
    balance_minor: string;
    currency: string;
    type: string;
  }>(sql`
    SELECT
      CAST(b.account_id AS TEXT) AS account_id, CAST(b.balance_minor AS TEXT) AS balance_minor, b.currency, a.type
    FROM balances b
    JOIN accounts a ON a.id = b.account_id
    WHERE a.family_id = ${family.id}
      AND a.status = 'active'
      AND a.included_in_reports = true
      AND ${ACCESS_SQL(userId)}
      AND b.as_of = (SELECT max(latest.as_of) FROM balances latest WHERE latest.account_id = b.account_id AND latest.as_of <= ${today})
    ORDER BY b.account_id
  `);

  let assetsMinor = 0;
  let liabilitiesMinor = 0;
  let netWorth = 0;
  for (const r of balanceRows.rows ?? []) {
    const converted = await convertTo(
      exec,
      safeParseMinor(r.balance_minor),
      r.currency,
      currency,
      today,
      ctx
    );
    if (r.type === "credit_card" || r.type === "other_liability") {
      liabilitiesMinor = safeAdd(liabilitiesMinor, -Math.min(0, converted));
    } else {
      assetsMinor = safeAdd(assetsMinor, converted);
    }
    netWorth = safeAdd(netWorth, converted);
  }

  const mk = monthKeyIn(family.timezone);
  const from = startOfMonth(`${mk}-01`);
  const to = endOfMonth(`${mk}-01`);

  const flows = await exec.execute<{
    outflow_minor: string;
    inflow_minor: string;
    outflow_currency: string;
  }>(sql`
    SELECT
      CAST(COALESCE(SUM(CASE WHEN e.amount_minor > 0 THEN e.amount_minor ELSE 0 END), 0) AS TEXT) AS outflow_minor,
      CAST(COALESCE(SUM(CASE WHEN e.amount_minor < 0 THEN -e.amount_minor ELSE 0 END), 0) AS TEXT) AS inflow_minor,
      e.currency AS outflow_currency
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    JOIN transactions t ON t.entry_id = e.id
    WHERE a.family_id = ${family.id}
      AND a.included_in_reports = true
      AND a.status = 'active'
      AND ${ACCESS_SQL(userId)}
      AND e.entryable_type = 'transaction'
      AND t.transfer_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM entries c WHERE c.parent_entry_id = e.id)
      AND e.date BETWEEN ${from} AND ${to}
    GROUP BY e.currency
  `);

  let expenseThisMonthMinor = 0;
  let incomeThisMonthMinor = 0;
  for (const r of flows.rows ?? []) {
    const convertedOutflow = await convertTo(
      exec,
      safeParseMinor(r.outflow_minor),
      r.outflow_currency,
      currency,
      today,
      ctx
    );
    const convertedInflow = await convertTo(
      exec,
      safeParseMinor(r.inflow_minor),
      r.outflow_currency,
      currency,
      today,
      ctx
    );
    expenseThisMonthMinor = safeAdd(expenseThisMonthMinor, convertedOutflow);
    incomeThisMonthMinor = safeAdd(incomeThisMonthMinor, convertedInflow);
  }

  const categoryRows = await exec.execute<{
    category_id: string | null;
    name: string | null;
    total_minor: string;
    currency: string;
  }>(sql`
    SELECT CAST(t.category_id AS TEXT) AS category_id, c.name, CAST(SUM(e.amount_minor) AS TEXT) AS total_minor, e.currency
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    JOIN transactions t ON t.entry_id = e.id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE a.family_id = ${family.id}
      AND a.included_in_reports = true
      AND a.status = 'active'
      AND ${ACCESS_SQL(userId)}
      AND e.entryable_type = 'transaction'
      AND t.transfer_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM entries c WHERE c.parent_entry_id = e.id)
      AND e.amount_minor > 0
      AND e.date BETWEEN ${from} AND ${to}
    GROUP BY t.category_id, c.name, e.currency
    ORDER BY 4 DESC
  `);

  const catTotals = new Map<
    string,
    { categoryId: string | null; name: string; totalMinor: number }
  >();
  for (const r of categoryRows.rows ?? []) {
    const converted = await convertTo(
      exec,
      safeParseMinor(r.total_minor),
      r.currency,
      currency,
      today,
      ctx
    );
    const key = r.category_id ?? "uncategorized";
    const existing = catTotals.get(key);
    catTotals.set(key, {
      categoryId: r.category_id,
      name: r.name ?? "Uncategorized",
      totalMinor: safeAdd(existing?.totalMinor ?? 0, converted)
    });
  }
  const topCategories = [...catTotals.values()]
    .sort((a, b) => b.totalMinor - a.totalMinor)
    .slice(0, 5);

  const recent = await exec.execute<{
    id: string;
    date: string;
    name: string;
    amount_minor: string;
    currency: string;
    account_name: string;
    transfer_id: string | null;
  }>(sql`
    SELECT CAST(e.id AS TEXT) AS id, CAST(e.date AS TEXT) AS date, e.name, CAST(e.amount_minor AS TEXT) AS amount_minor,
           e.currency, a.name AS account_name, CAST(t.transfer_id AS TEXT) AS transfer_id
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    JOIN transactions t ON t.entry_id = e.id
    WHERE a.family_id = ${family.id}
      AND a.status = 'active'
      AND ${ACCESS_SQL(userId)}
      AND NOT EXISTS (SELECT 1 FROM entries c WHERE c.parent_entry_id = e.id)
    ORDER BY e.date DESC, e.created_at DESC
    LIMIT 8
  `);

  const fx = completenessOf(ctx);
  const fxIssues = fx.incompleteFx ? fx.fxIssues : undefined;
  const fxRates = fx.fxRates.length > 0 ? fx.fxRates : undefined;

  await reportFxIssues(exec, ctx, family.id, "dashboard");

  return {
    netWorthMinor: netWorth,
    assetsMinor,
    liabilitiesMinor,
    incomeThisMonthMinor,
    expenseThisMonthMinor,
    topCategories,
    recentEntries: (recent.rows ?? []).map((r) => ({
      id: r.id,
      date: r.date.slice(0, 10),
      name: r.name,
      amountMinor: safeParseMinor(r.amount_minor),
      currency: r.currency,
      accountName: r.account_name,
      transferId: r.transfer_id
    })),
    monthKey: mk,
    incompleteFx: fx.incompleteFx,
    fxIssues,
    fxRates
  };
}

export async function reportFxIssues(
  exec: Executor,
  ctx: ConversionContext,
  familyId: string,
  source: string
): Promise<void> {
  for (const issue of ctx.issues.values()) {
    await captureDebugLog(exec, {
      category: "fx",
      level: "warn",
      message: `Missing exchange rate ${issue.base}->${issue.quote}; affected totals exclude those amounts`,
      source,
      providerKey: "exchange_rates",
      familyId,
      metadata: { ...issue }
    });
  }
  ctx.issues.clear();
}

export type NetWorthPoint = { date: string; valueMinor: number };

export type AccountsNetWorth = {
  netWorthMinor: number;
  fx: FxCompleteness;
};

/**
 * Net worth for an already-loaded account list (e.g. the sidebar), converting each
 * balance into the family currency. Accounts with no known rate are excluded,
 * mirroring dashboardSummary's behavior, and reported in the returned `fx`
 * completeness metadata.
 */
export async function netWorthMinorForAccounts(
  exec: Executor,
  family: Pick<Family, "id" | "currency">,
  accounts: { displayBalanceMinor: number; currency: string }[],
  onDate: string
): Promise<AccountsNetWorth> {
  const ctx = newConversionContext();
  let netWorth = 0;
  for (const account of accounts) {
    const converted = await convertTo(
      exec,
      account.displayBalanceMinor,
      account.currency,
      family.currency,
      onDate,
      ctx
    );
    netWorth = safeAdd(netWorth, converted);
  }
  const fx = completenessOf(ctx);
  await reportFxIssues(exec, ctx, family.id, "sidebar");
  return { netWorthMinor: netWorth, fx };
}

export type NetWorthSeriesResult = {
  points: NetWorthPoint[];
  fx: FxCompleteness;
};

export async function netWorthSeries(
  exec: Executor,
  family: Family,
  userId: string,
  days: number | "all" = 90,
  accountIds?: string[]
): Promise<NetWorthSeriesResult> {
  const ctx = newConversionContext();
  const today = todayIn(family.timezone);
  const cutoff =
    days === "all" ? sql`` : sql`AND b.as_of >= ${addDays(today, -days)} AND b.as_of <= ${today}`;
  const res = await exec.execute<{
    as_of: string;
    balance_minor: string;
    currency: string;
    type: string;
  }>(sql`
    SELECT CAST(b.as_of AS TEXT) AS as_of, CAST(b.balance_minor AS TEXT) AS balance_minor, b.currency, a.type
    FROM balances b
    JOIN accounts a ON a.id = b.account_id
    WHERE a.family_id = ${family.id}
      AND a.status = 'active'
      AND a.included_in_reports = true
      AND ${ACCESS_SQL(userId)}
      ${accountFilter(accountIds)}
      ${cutoff}
    ORDER BY b.as_of
  `);

  const byDate = new Map<string, number>();
  for (const r of res.rows ?? []) {
    const d = r.as_of.slice(0, 10);
    const converted = await convertTo(
      exec,
      safeParseMinor(r.balance_minor),
      r.currency,
      family.currency,
      d,
      ctx
    );
    byDate.set(d, safeAdd(byDate.get(d) ?? 0, converted));
  }

  const fx = completenessOf(ctx);
  await reportFxIssues(exec, ctx, family.id, "net_worth_series");
  return {
    points: [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, valueMinor: v })),
    fx
  };
}

export type MonthFlow = { monthKey: string; incomeMinor: number; expenseMinor: number };

export type IncomeExpenseSeriesResult = {
  flows: MonthFlow[];
  fx: FxCompleteness;
};

export async function incomeExpenseSeries(
  exec: Executor,
  family: Family,
  userId: string,
  months = 12,
  accountIds?: string[]
): Promise<IncomeExpenseSeriesResult> {
  const ctx = newConversionContext();
  const currentMk = monthKeyIn(family.timezone);
  const startMk = addMonths(currentMk, -(months - 1));
  const fromDate = startOfMonth(`${startMk}-01`);
  const toDate = endOfMonth(`${currentMk}-01`);

  const res = await exec.execute<{
    mk: string;
    currency: string;
    outflow: string;
    inflow: string;
  }>(sql`
    SELECT substr(CAST(e.date AS TEXT), 1, 7) AS mk, e.currency,
           CAST(COALESCE(SUM(CASE WHEN e.amount_minor > 0 THEN e.amount_minor ELSE 0 END), 0) AS TEXT) AS outflow,
           CAST(COALESCE(SUM(CASE WHEN e.amount_minor < 0 THEN -e.amount_minor ELSE 0 END), 0) AS TEXT) AS inflow
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    JOIN transactions t ON t.entry_id = e.id
    WHERE a.family_id = ${family.id}
      AND a.included_in_reports = true
      AND a.status = 'active'
      AND ${ACCESS_SQL(userId)}
      ${accountFilter(accountIds)}
      AND e.entryable_type = 'transaction'
      AND t.transfer_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM entries c WHERE c.parent_entry_id = e.id)
      AND e.date BETWEEN ${fromDate} AND ${toDate}
    GROUP BY mk, e.currency
  `);

  const byMonth = new Map<string, MonthFlow>();
  for (let i = 0; i < months; i++) {
    const mk = addMonths(startMk, i);
    byMonth.set(mk, { monthKey: mk, incomeMinor: 0, expenseMinor: 0 });
  }

  for (const r of res.rows ?? []) {
    const entry = byMonth.get(r.mk);
    if (!entry) continue;
    const anchor = endOfMonth(`${r.mk}-01`);
    const convertedExpense = await convertTo(
      exec,
      safeParseMinor(r.outflow),
      r.currency,
      family.currency,
      anchor,
      ctx
    );
    const convertedIncome = await convertTo(
      exec,
      safeParseMinor(r.inflow),
      r.currency,
      family.currency,
      anchor,
      ctx
    );
    entry.expenseMinor = safeAdd(entry.expenseMinor, convertedExpense);
    entry.incomeMinor = safeAdd(entry.incomeMinor, convertedIncome);
  }

  const fx = completenessOf(ctx);
  await reportFxIssues(exec, ctx, family.id, "income_expense_series");
  return { flows: [...byMonth.values()], fx };
}

export { incomeExpenseSeries as monthlyIncomeExpenseSeries };

export type CategorySpending = {
  categoryId: string | null;
  name: string;
  totalMinor: number;
  share: number;
};

export type SpendingByCategoryResult = {
  categories: CategorySpending[];
  fx: FxCompleteness;
};

export async function spendingByCategory(
  exec: Executor,
  family: Family,
  userId: string,
  range: { from: string; to: string },
  accountIds?: string[]
): Promise<SpendingByCategoryResult> {
  const ctx = newConversionContext();
  const res = await exec.execute<{
    category_id: string | null;
    name: string | null;
    total_minor: string;
    currency: string;
  }>(sql`
    SELECT CAST(t.category_id AS TEXT) AS category_id, c.name, CAST(SUM(e.amount_minor) AS TEXT) AS total_minor, e.currency
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    JOIN transactions t ON t.entry_id = e.id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE a.family_id = ${family.id}
      AND a.included_in_reports = true
      AND a.status = 'active'
      AND ${ACCESS_SQL(userId)}
      ${accountFilter(accountIds)}
      AND e.entryable_type = 'transaction'
      AND t.transfer_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM entries c WHERE c.parent_entry_id = e.id)
      AND e.amount_minor > 0
      AND e.date BETWEEN ${range.from} AND ${range.to}
    GROUP BY t.category_id, c.name, e.currency
  `);

  const totals = new Map<string, { categoryId: string | null; name: string; totalMinor: number }>();
  let grand = 0;
  for (const r of res.rows ?? []) {
    const converted = await convertTo(
      exec,
      safeParseMinor(r.total_minor),
      r.currency,
      family.currency,
      range.to,
      ctx
    );
    const key = r.category_id ?? "uncategorized";
    const existing = totals.get(key);
    const next = safeAdd(existing?.totalMinor ?? 0, converted);
    totals.set(key, {
      categoryId: r.category_id,
      name: r.name ?? "Uncategorized",
      totalMinor: next
    });
    grand = safeAdd(grand, converted);
  }

  const fx = completenessOf(ctx);
  await reportFxIssues(exec, ctx, family.id, "spending_by_category");

  return {
    categories: [...totals.values()]
      .map((v) => ({ ...v, share: grand > 0 ? v.totalMinor / grand : 0 }))
      .sort((a, b) => b.totalMinor - a.totalMinor),
    fx
  };
}

export type MerchantSpending = {
  merchant: string | null;
  totalMinor: number;
  share: number;
};

export type SpendingByMerchantResult = {
  merchants: MerchantSpending[];
  fx: FxCompleteness;
};

/**
 * Spending grouped by merchant over a range — the merchant counterpart of
 * spendingByCategory, with identical filters and FX completeness semantics.
 * Entries without a merchant form the `null` group.
 */
export async function spendingByMerchant(
  exec: Executor,
  family: Family,
  userId: string,
  range: { from: string; to: string },
  accountIds?: string[]
): Promise<SpendingByMerchantResult> {
  const ctx = newConversionContext();
  const res = await exec.execute<{
    merchant: string | null;
    total_minor: string;
    currency: string;
  }>(sql`
    SELECT t.merchant, CAST(SUM(e.amount_minor) AS TEXT) AS total_minor, e.currency
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    JOIN transactions t ON t.entry_id = e.id
    WHERE a.family_id = ${family.id}
      AND a.included_in_reports = true
      AND a.status = 'active'
      AND ${ACCESS_SQL(userId)}
      ${accountFilter(accountIds)}
      AND e.entryable_type = 'transaction'
      AND t.transfer_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM entries c WHERE c.parent_entry_id = e.id)
      AND e.amount_minor > 0
      AND e.date BETWEEN ${range.from} AND ${range.to}
    GROUP BY t.merchant, e.currency
  `);

  const totals = new Map<string, { merchant: string | null; totalMinor: number }>();
  let grand = 0;
  for (const r of res.rows ?? []) {
    const converted = await convertTo(
      exec,
      safeParseMinor(r.total_minor),
      r.currency,
      family.currency,
      range.to,
      ctx
    );
    const key = r.merchant ?? "";
    const existing = totals.get(key);
    totals.set(key, {
      merchant: r.merchant,
      totalMinor: safeAdd(existing?.totalMinor ?? 0, converted)
    });
    grand = safeAdd(grand, converted);
  }

  const fx = completenessOf(ctx);
  await reportFxIssues(exec, ctx, family.id, "spending_by_merchant");

  return {
    merchants: [...totals.values()]
      .map((v) => ({ ...v, share: grand > 0 ? v.totalMinor / grand : 0 }))
      .sort((a, b) => b.totalMinor - a.totalMinor),
    fx
  };
}

export type DailySpendingPoint = { date: string; amountMinor: number };

export type DailySpendingSeriesResult = {
  points: DailySpendingPoint[];
  fx: FxCompleteness;
};

export async function dailySpendingSeries(
  exec: Executor,
  family: Family,
  userId: string,
  days = 365
): Promise<DailySpendingSeriesResult> {
  const ctx = newConversionContext();
  const today = todayIn(family.timezone);
  const from = addDays(today, -(days - 1));
  const res = await exec.execute<{ d: string; currency: string; outflow: string }>(sql`
    SELECT CAST(e.date AS TEXT) AS d, e.currency,
           CAST(COALESCE(SUM(CASE WHEN e.amount_minor > 0 THEN e.amount_minor ELSE 0 END), 0) AS TEXT) AS outflow
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    JOIN transactions t ON t.entry_id = e.id
    WHERE a.family_id = ${family.id}
      AND a.included_in_reports = true
      AND a.status = 'active'
      AND ${ACCESS_SQL(userId)}
      AND e.entryable_type = 'transaction'
      AND t.transfer_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM entries c WHERE c.parent_entry_id = e.id)
      AND e.date BETWEEN ${from} AND ${today}
    GROUP BY e.date, e.currency
  `);

  const byDate = new Map<string, number>();
  for (const r of res.rows ?? []) {
    const d = r.d.slice(0, 10);
    const converted = await convertTo(
      exec,
      safeParseMinor(r.outflow),
      r.currency,
      family.currency,
      d,
      ctx
    );
    byDate.set(d, safeAdd(byDate.get(d) ?? 0, converted));
  }
  const fx = completenessOf(ctx);
  await reportFxIssues(exec, ctx, family.id, "daily_spending");

  const points: DailySpendingPoint[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    points.push({ date, amountMinor: byDate.get(date) ?? 0 });
  }
  return { points, fx };
}

export function currentMonthRange(timezone: string): { from: string; to: string } {
  const mk = monthKeyIn(timezone);
  return { from: startOfMonth(`${mk}-01`), to: endOfMonth(`${mk}-01`) };
}

export function monthRangeOf(monthKey: string): { from: string; to: string } {
  return { from: startOfMonth(`${monthKey}-01`), to: endOfMonth(`${monthKey}-01`) };
}

export function monthOf(iso: string): string {
  return monthKeyOf(iso);
}
