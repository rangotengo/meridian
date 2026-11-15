import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import {
  netWorthSeries,
  incomeExpenseSeries,
  spendingByCategory,
  dailySpendingSeries,
  mergeFxCompleteness
} from "@/server/domain/reports";
import { isStaleRate } from "@/server/domain/exchange-rates";
import { getUserPrivacyMode } from "@/server/domain/users";
import { Card, PageHeader, EmptyState } from "@/components/ds/card";
import { Amount } from "@/components/finance/amount";
import { CategoryDonut } from "@/components/finance/category-donut";
import { FxIssuesAlert } from "@/components/finance/fx-issues-alert";
import { SpendingHeatmap } from "@/components/finance/spending-heatmap";
import { fmtMonth } from "@/lib/format";
import { addMonths, endOfMonth, monthKeyIn, startOfMonth, todayIn } from "@/lib/datetime";
import { PrintButton } from "./print-button";
import { cn } from "@/lib/utils";

export const metadata = { title: "Reports" };

const PERIODS = [
  { key: "monthly", label: "Monthly", months: 1, days: 30 },
  { key: "quarterly", label: "Quarterly", months: 3, days: 90 },
  { key: "ytd", label: "Year to date", months: 12, days: 365 },
  { key: "six_months", label: "Last 6 months", months: 6, days: 180 }
] as const;

type PeriodKey = (typeof PERIODS)[number]["key"];

export default async function ReportsPage({
  searchParams
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const db = getDb();
  const privacy = await getUserPrivacyMode(db, actor.userId);
  const requestedPeriod = (await searchParams).period;
  const period = PERIODS.some((item) => item.key === requestedPeriod)
    ? (requestedPeriod as PeriodKey)
    : "monthly";
  const selected = PERIODS.find((item) => item.key === period) ?? PERIODS[0];
  const currentMonth = monthKeyIn(family.timezone);
  const periodMonths = period === "ytd" ? Number(currentMonth.slice(5, 7)) : selected.months;
  const periodRange = {
    from: startOfMonth(`${addMonths(currentMonth, -(periodMonths - 1))}-01`),
    to: endOfMonth(`${currentMonth}-01`)
  };

  const periodDays = period === "ytd" ? Math.max(30, periodMonths * 30) : selected.days;

  const [seriesResult, flowsResult, spendResult, heatmapResult] = await Promise.all([
    netWorthSeries(db, family, actor.userId, periodDays),
    incomeExpenseSeries(db, family, actor.userId, periodMonths),
    spendingByCategory(db, family, actor.userId, periodRange),
    dailySpendingSeries(db, family, actor.userId, 365)
  ]);
  const series = seriesResult.points;
  const flows = flowsResult.flows;
  const spend = spendResult.categories;
  const heatmap = heatmapResult.points;
  const fxMerged = mergeFxCompleteness(
    seriesResult.fx,
    flowsResult.fx,
    spendResult.fx,
    heatmapResult.fx
  );
  const fxAlert = {
    incomplete: fxMerged.incompleteFx,
    issues: fxMerged.fxIssues,
    rates: fxMerged.fxRates.map((r) => ({
      base: r.base,
      quote: r.quote,
      rate: r.rate,
      quotedOn: r.quotedOn,
      stale: isStaleRate(r.quotedOn, todayIn(family.timezone))
    }))
  };
  const latestIncome = flows.reduce((total, flow) => total + flow.incomeMinor, 0);
  const latestExpense = flows.reduce((total, flow) => total + flow.expenseMinor, 0);
  const latestNet = latestIncome - latestExpense;
  const topSpend = spend[0];
  const latestNetWorth = series[series.length - 1]?.valueMinor ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        subtitle="Server-computed from your ledger. Transfers are excluded from income and spending."
        actions={<PrintButton />}
      />

      <div className="flex items-center justify-between gap-4 overflow-x-auto">
        <div
          className="flex max-w-fit gap-1 rounded-lg bg-muted p-1"
          role="tablist"
          aria-label="Report period"
        >
          {PERIODS.map((item) => (
            <a
              key={item.key}
              href={`/reports?period=${item.key}`}
              role="tab"
              aria-selected={period === item.key}
              className={cn(
                "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                period === item.key
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent"
              )}
            >
              {item.label}
            </a>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {periodRange.from} &ndash; {periodRange.to}
        </span>
      </div>

      <FxIssuesAlert fx={fxAlert} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <p className="text-sm text-muted-foreground">Income · {selected.label}</p>
          <p className="tabular mt-2 text-2xl font-semibold text-income">
            <Amount minor={latestIncome} currency={family.currency} masked={privacy} />
          </p>
        </Card>
        <Card>
          <p className="text-sm text-muted-foreground">Spending · {selected.label}</p>
          <p className="tabular mt-2 text-2xl font-semibold">
            <Amount minor={latestExpense} currency={family.currency} masked={privacy} />
          </p>
        </Card>
        <Card>
          <p className="text-sm text-muted-foreground">Net savings</p>
          <p
            className={`tabular mt-2 text-2xl font-semibold ${latestNet >= 0 ? "text-income" : "text-destructive"}`}
          >
            <Amount minor={latestNet} currency={family.currency} masked={privacy} signed />
          </p>
        </Card>
        <Card>
          <p className="text-sm text-muted-foreground">Net worth</p>
          <p className="tabular mt-2 text-2xl font-semibold">
            <Amount minor={latestNetWorth} currency={family.currency} masked={privacy} />
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {topSpend ? `Top category: ${topSpend.name}` : "Add transactions to see trends"}
          </p>
        </Card>
      </div>

      <SpendingHeatmap points={heatmap} currency={family.currency} privacy={privacy} />

      <div className="grid gap-6 lg:grid-cols-2">
        <CategoryDonut
          items={spend.map((item) => ({ name: item.name, totalMinor: item.totalMinor }))}
          currency={family.currency}
          privacy={privacy}
          title={`Spending · ${selected.label}`}
        />
        <Card>
          <h2 className="mb-3 text-base font-semibold">Income vs spending by month</h2>
          {flows.length === 0 ? (
            <EmptyState title="No data yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th scope="col" className="py-2 font-medium">
                      Month
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      Income
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      Spending
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      Net
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[...flows].reverse().map((flow) => (
                    <tr key={flow.monthKey}>
                      <td className="py-2">{fmtMonth(flow.monthKey)}</td>
                      <td className="py-2 text-right tabular">
                        <Amount
                          minor={flow.incomeMinor}
                          currency={family.currency}
                          masked={privacy}
                        />
                      </td>
                      <td className="py-2 text-right tabular">
                        <Amount
                          minor={flow.expenseMinor}
                          currency={family.currency}
                          masked={privacy}
                        />
                      </td>
                      <td className="py-2 text-right tabular font-medium">
                        <Amount
                          minor={flow.incomeMinor - flow.expenseMinor}
                          currency={family.currency}
                          masked={privacy}
                          signed
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
