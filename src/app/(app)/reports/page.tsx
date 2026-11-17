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
import { fmtMoney, fmtMonth } from "@/lib/format";
import { monthKeyIn, todayIn } from "@/lib/datetime";
import { REPORT_PERIODS, resolveReportRange } from "@/lib/report-range";
import { PrintButton } from "./print-button";
import { cn } from "@/lib/utils";

export const metadata = { title: "Reports" };

// NOTE: duplicates the shared helper in src/lib/period-comparison.ts
// (PR #22, unmerged at the time of writing). Replace with that import
// once it lands instead of keeping two copies.
function deltaWithPct(
  currentMinor: number,
  previousMinor: number
): { deltaMinor: number; pct: number | null } {
  const deltaMinor = currentMinor - previousMinor;
  if (previousMinor === 0) return { deltaMinor, pct: null };
  return { deltaMinor, pct: deltaMinor / Math.abs(previousMinor) };
}

function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  return `${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(1)}%`;
}

function DeltaLine({
  currentMinor,
  previousMinor,
  currency,
  privacy
}: {
  currentMinor: number;
  previousMinor: number;
  currency: string;
  privacy: boolean;
}) {
  const { deltaMinor, pct } = deltaWithPct(currentMinor, previousMinor);
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      vs previous:{" "}
      {privacy ? (
        "••••"
      ) : (
        <span
          className={`font-semibold tabular-nums ${
            deltaMinor >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-destructive"
          }`}
        >
          {deltaMinor >= 0 ? "+" : ""}
          {fmtMoney(deltaMinor, currency, "en", "always")} ({formatPct(pct)})
        </span>
      )}
    </p>
  );
}

type SearchParams = Promise<{
  period?: string;
  from?: string;
  to?: string;
  compare?: string;
}>;

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const db = getDb();
  const privacy = await getUserPrivacyMode(db, actor.userId);
  const compare = sp.compare === "1";
  const currentMonth = monthKeyIn(family.timezone);
  const range = resolveReportRange({
    period: sp.period,
    from: sp.from,
    to: sp.to,
    compare,
    currentMonth
  });

  const [seriesResult, flowsResult, spendResult, heatmapResult] = await Promise.all([
    netWorthSeries(db, family, actor.userId, range.days),
    incomeExpenseSeries(db, family, actor.userId, range.monthsBack),
    spendingByCategory(db, family, actor.userId, { from: range.from, to: range.to }),
    dailySpendingSeries(db, family, actor.userId, 365)
  ]);
  const series = seriesResult.points;
  const allFlows = flowsResult.flows;
  const flows = allFlows.filter(
    (flow) => flow.monthKey >= range.fromMonth && flow.monthKey <= range.toMonth
  );
  const prevFlows = compare
    ? allFlows.filter(
        (flow) =>
          flow.monthKey >= range.previousFromMonth && flow.monthKey <= range.previousToMonth
      )
    : [];
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
  const sumFlows = (list: typeof flows) => ({
    income: list.reduce((total, flow) => total + flow.incomeMinor, 0),
    expense: list.reduce((total, flow) => total + flow.expenseMinor, 0)
  });
  const latest = sumFlows(flows);
  const previous = sumFlows(prevFlows);
  const latestIncome = latest.income;
  const latestExpense = latest.expense;
  const latestNet = latestIncome - latestExpense;
  const previousNet = previous.income - previous.expense;
  const topSpend = spend[0];
  const latestNetWorth = series[series.length - 1]?.valueMinor ?? 0;

  // Links that keep the current range/compare selection.
  const pageUrl = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const next = {
      period: range.key === "custom" ? undefined : range.key,
      from: range.isCustom ? range.from : undefined,
      to: range.isCustom ? range.to : undefined,
      compare: compare ? "1" : undefined,
      ...patch
    };
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined) params.set(key, value);
    }
    const qs = params.toString();
    return qs ? `/reports?${qs}` : "/reports";
  };
  const exportUrl = (report: "income-expense" | "spending-by-category") => {
    const params = new URLSearchParams({
      report,
      period: range.key,
      from: range.from,
      to: range.to
    });
    return `/reports/export?${params.toString()}`;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        subtitle="Server-computed from your ledger. Transfers are excluded from income and spending."
        actions={<PrintButton />}
      />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div
          className="flex max-w-fit gap-1 overflow-x-auto rounded-lg bg-muted p-1"
          role="tablist"
          aria-label="Report period"
        >
          {REPORT_PERIODS.map((item) => (
            <a
              key={item.key}
              href={pageUrl({ period: item.key, from: undefined, to: undefined })}
              role="tab"
              aria-selected={range.key === item.key}
              className={cn(
                "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                range.key === item.key
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent"
              )}
            >
              {item.label}
            </a>
          ))}
          {range.isCustom ? (
            <span
              role="tab"
              aria-selected
              className="whitespace-nowrap rounded-md bg-card px-3 py-1.5 text-sm font-medium text-foreground shadow-sm"
            >
              Custom
            </span>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {range.from} &ndash; {range.to}
        </span>
      </div>

      <form
        method="get"
        action="/reports"
        className="no-print flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card px-4 py-3"
      >
        <div>
          <label htmlFor="from" className="block text-xs font-medium text-muted-foreground">
            From
          </label>
          <input
            id="from"
            name="from"
            type="date"
            required
            defaultValue={range.isCustom ? range.from : ""}
            className="mt-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label htmlFor="to" className="block text-xs font-medium text-muted-foreground">
            To
          </label>
          <input
            id="to"
            name="to"
            type="date"
            required
            defaultValue={range.isCustom ? range.to : ""}
            className="mt-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
          />
        </div>
        {compare ? <input type="hidden" name="compare" value="1" /> : null}
        <button
          type="submit"
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          Apply custom range
        </button>
        <span className="text-xs text-muted-foreground">
          Custom ranges cover whole months within the last year.
        </span>
        {range.isCustom ? (
          <a href="/reports?period=monthly" className="text-xs text-primary hover:underline">
            Clear custom range
          </a>
        ) : null}
      </form>

      <div className="no-print flex flex-wrap items-center gap-3 text-sm">
        {compare ? (
          <>
            <span className="text-muted-foreground">
              Comparing with {range.previousFrom} &ndash; {range.previousTo}
            </span>
            <a
              href={pageUrl({ compare: undefined })}
              className="text-primary hover:underline"
            >
              Turn off comparison
            </a>
          </>
        ) : (
          <a href={pageUrl({ compare: "1" })} className="text-primary hover:underline">
            Compare with previous period
          </a>
        )}
      </div>

      <FxIssuesAlert fx={fxAlert} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <p className="text-sm text-muted-foreground">Income · {range.label}</p>
          <p className="tabular mt-2 text-2xl font-semibold text-income">
            <Amount minor={latestIncome} currency={family.currency} masked={privacy} />
          </p>
          {compare ? (
            <DeltaLine
              currentMinor={latestIncome}
              previousMinor={previous.income}
              currency={family.currency}
              privacy={privacy}
            />
          ) : null}
        </Card>
        <Card>
          <p className="text-sm text-muted-foreground">Spending · {range.label}</p>
          <p className="tabular mt-2 text-2xl font-semibold">
            <Amount minor={latestExpense} currency={family.currency} masked={privacy} />
          </p>
          {compare ? (
            <DeltaLine
              currentMinor={latestExpense}
              previousMinor={previous.expense}
              currency={family.currency}
              privacy={privacy}
            />
          ) : null}
        </Card>
        <Card>
          <p className="text-sm text-muted-foreground">Net savings</p>
          <p
            className={`tabular mt-2 text-2xl font-semibold ${latestNet >= 0 ? "text-income" : "text-destructive"}`}
          >
            <Amount minor={latestNet} currency={family.currency} masked={privacy} signed />
          </p>
          {compare ? (
            <DeltaLine
              currentMinor={latestNet}
              previousMinor={previousNet}
              currency={family.currency}
              privacy={privacy}
            />
          ) : null}
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
          title={`Spending · ${range.label}`}
          action={
            <a
              href={exportUrl("spending-by-category")}
              className="no-print text-xs font-medium text-primary hover:underline"
            >
              Export CSV
            </a>
          }
        />
        <Card>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Income vs spending by month</h2>
            <a
              href={exportUrl("income-expense")}
              className="no-print text-xs font-medium text-primary hover:underline"
            >
              Export CSV
            </a>
          </div>
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
