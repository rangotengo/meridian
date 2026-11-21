"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboardData } from "@/components/finance/dashboard-data";
import { fmtMoney, fmtPercent, fmtSignedMoney } from "@/lib/format";
import { monthVsLastMonth } from "@/lib/period-comparison";
import { cn } from "@/lib/utils";
import { ArrowDownLeftIcon, ArrowUpRightIcon, PiggyBankIcon } from "lucide-react";

/**
 * Dashboard widget: this month's income, spending, net saved and savings
 * rate at a glance, with a compact comparison against last month.
 */
export function MonthlySnapshot() {
  const { incomeThisMonthMinor, expenseThisMonthMinor, flows, currency, locale, privacy } =
    useDashboardData();

  const net = incomeThisMonthMinor - expenseThisMonthMinor;
  const savingsRate = incomeThisMonthMinor > 0 ? net / incomeThisMonthMinor : null;
  const comparison = monthVsLastMonth(flows);
  const ratePercent = savingsRate === null ? 0 : Math.max(0, Math.min(100, savingsRate * 100));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base font-semibold">Monthly snapshot</CardTitle>
        <Link href="/reports" className="text-xs font-medium text-primary hover:underline">
          Reports
        </Link>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-emerald-50 px-2.5 py-2 dark:bg-emerald-950/30">
            <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-emerald-600/80 dark:text-emerald-400/80">
              <ArrowDownLeftIcon className="size-3" />
              In
            </p>
            <p className="mt-0.5 text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
              {privacy ? "••••" : fmtMoney(incomeThisMonthMinor, currency, locale)}
            </p>
          </div>
          <div className="rounded-lg bg-rose-50 px-2.5 py-2 dark:bg-rose-950/30">
            <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-rose-600/80 dark:text-rose-400/80">
              <ArrowUpRightIcon className="size-3" />
              Out
            </p>
            <p className="mt-0.5 text-sm font-bold tabular-nums text-rose-700 dark:text-rose-300">
              {privacy ? "••••" : fmtMoney(expenseThisMonthMinor, currency, locale)}
            </p>
          </div>
        </div>

        <div className="rounded-lg border px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <PiggyBankIcon className="size-3.5" />
              Net saved
            </span>
            <span
              className={cn(
                "text-sm font-bold tabular-nums",
                net >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
              )}
            >
              {privacy ? "••••" : fmtSignedMoney(net, currency, locale)}
            </span>
          </div>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border/60"
            role="progressbar"
            aria-label="Savings rate"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratePercent)}
          >
            <div
              className={cn("h-full rounded-full", net >= 0 ? "bg-emerald-500" : "bg-destructive")}
              style={{ width: `${ratePercent}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {privacy
              ? "•••• of income kept"
              : savingsRate === null
                ? "No income recorded this month."
                : `${fmtPercent(savingsRate, locale)} of income kept`}
          </p>
          {comparison ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Net vs last month:{" "}
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  comparison.net.deltaMinor >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-destructive"
                )}
              >
                {privacy ? "••••" : fmtSignedMoney(comparison.net.deltaMinor, currency, locale)}
              </span>
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
