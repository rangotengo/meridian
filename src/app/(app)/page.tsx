import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { dashboardSummary, incomeExpenseSeries, netWorthSeries } from "@/server/domain/reports";
import { budgetOverview } from "@/server/domain/budgets";
import { getUserPrivacyMode } from "@/server/domain/users";
import { listAccountsForActor } from "@/server/domain/accounts";
import { DashboardCustomizer } from "@/components/finance/dashboard-customizer";
import type { DashboardData, HealthFactor } from "@/components/finance/dashboard-data";
import { isStaleRate } from "@/server/domain/exchange-rates";
import { todayIn } from "@/lib/datetime";

export const metadata = { title: "Dashboard" };

const NW_RANGES = new Set(["90", "180", "365", "all"]);

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function factor(id: string, label: string, score: number, description: string): HealthFactor {
  const clamped = clamp(score);
  const status: HealthFactor["status"] =
    clamped >= 80 ? "excellent" : clamped >= 60 ? "good" : clamped >= 40 ? "fair" : "poor";
  return { id, label, score: clamped, status, description };
}

export default async function DashboardPage({
  searchParams
}: {
  searchParams: Promise<{ nw?: string }>;
}) {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const db = getDb();
  const { nw } = await searchParams;
  const nwRange = nw && NW_RANGES.has(nw) ? nw : "90";
  const seriesDays = nwRange === "all" ? ("all" as const) : Number(nwRange);

  const [summary, accounts, series, budget, flows] = await Promise.all([
    dashboardSummary(db, family, actor.userId),
    listAccountsForActor(db, actor),
    netWorthSeries(db, family, actor.userId, seriesDays),
    budgetOverview(db, family, actor.userId),
    incomeExpenseSeries(db, family, actor.userId, 12)
  ]);

  const privacy = await getUserPrivacyMode(db, actor.userId);
  const income = summary.incomeThisMonthMinor;
  const expense = summary.expenseThisMonthMinor;
  const savingsRate = income > 0 ? (income - expense) / income : 0;
  const savingsScore = income > 0 ? 50 + savingsRate * 100 : expense === 0 ? 70 : 30;
  const spendScore = income > 0 ? 100 - (expense / income) * 80 : expense === 0 ? 70 : 25;
  const netWorthScore =
    summary.netWorthMinor >= 0 ? 70 + Math.min(30, summary.assetsMinor > 0 ? 20 : 0) : 25;
  const budgetScore = budget.overall ? 120 - budget.overall.pct * 100 : 55;
  const activeAccounts = accounts.filter((a) => a.status === "active");
  const activityScore = Math.min(
    100,
    activeAccounts.length * 15 + summary.recentEntries.length * 8
  );
  const factors = [
    factor("savings", "Savings rate", savingsScore, "Income kept after this month's spending."),
    factor("spending", "Spending load", spendScore, "How heavy expenses are relative to income."),
    factor(
      "networth",
      "Net worth",
      netWorthScore,
      "Assets versus liabilities on reportable accounts."
    ),
    factor(
      "budget",
      "Budget discipline",
      budgetScore,
      budget.overall
        ? "Progress against your overall monthly cap."
        : "Set an overall cap to score this factor."
    ),
    factor(
      "activity",
      "Ledger activity",
      activityScore,
      "Active accounts and recent transactions keep the picture current."
    )
  ];
  const overall = clamp(factors.reduce((sum, item) => sum + item.score, 0) / factors.length);

  const hasHistory =
    activeAccounts.length > 0 && (summary.recentEntries.length > 0 || flows.length > 0);
  const insufficientData = !hasHistory;

  // Real historical trend comparing this month to prior month:
  const lastMonthFlow = flows.length >= 2 ? flows[flows.length - 2] : null;
  const lastMonthIncome = lastMonthFlow?.incomeMinor ?? 0;
  const lastMonthExpense = lastMonthFlow?.expenseMinor ?? 0;
  const lastMonthSavingsRate =
    lastMonthIncome > 0 ? (lastMonthIncome - lastMonthExpense) / lastMonthIncome : 0;
  const trendDiff = (savingsRate - lastMonthSavingsRate) * 100;
  const trend = trendDiff >= 0 ? "up" : "down";
  const trendDelta = Math.round(trendDiff);

  const data: DashboardData = {
    greeting: `Welcome back, ${actor.name.split(" ")[0] ?? actor.name}`,
    dateLabel: new Intl.DateTimeFormat(family.locale, {
      dateStyle: "full",
      timeZone: family.timezone
    }).format(new Date()),
    currency: family.currency,
    locale: family.locale,
    privacy,
    netWorthMinor: summary.netWorthMinor,
    assetsMinor: summary.assetsMinor,
    liabilitiesMinor: summary.liabilitiesMinor,
    incomeThisMonthMinor: summary.incomeThisMonthMinor,
    expenseThisMonthMinor: summary.expenseThisMonthMinor,
    series,
    flows,
    topCategories: summary.topCategories.map((item) => ({
      name: item.name,
      totalMinor: item.totalMinor
    })),
    recent: summary.recentEntries,
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      type: account.type,
      displayBalanceMinor: account.displayBalanceMinor,
      currency: account.currency,
      institution: account.institution,
      status: account.status
    })),
    budgetOverall: budget.overall
      ? {
          limitMinor: budget.overall.limitMinor,
          spentMinor: budget.overall.spentMinor,
          remainingMinor: budget.overall.remainingMinor,
          pct: budget.overall.pct
        }
      : null,
    fx: {
      incomplete: summary.incompleteFx ?? false,
      issues: summary.fxIssues ?? [],
      rates: (summary.fxRates ?? []).map((r) => ({
        base: r.base,
        quote: r.quote,
        rate: r.rate,
        quotedOn: r.quotedOn,
        stale: isStaleRate(r.quotedOn, todayIn(family.timezone))
      }))
    },
    health: {
      overall,
      trend,
      trendDelta,
      factors,
      insufficientData
    }
  };

  return <DashboardCustomizer data={data} />;
}
