"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { useDashboardData } from "@/components/finance/dashboard-data";
import { fmtMoney } from "@/lib/format";
import { ShieldCheckIcon } from "lucide-react";

export function SpendingLimit() {
  const { budgetOverall, expenseThisMonthMinor, currency, privacy } = useDashboardData();

  if (!budgetOverall) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-base font-semibold">Monthly spending limit</CardTitle>
          <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
            <ShieldCheckIcon className="size-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            No overall cap yet. Spent {privacy ? "••••" : fmtMoney(expenseThisMonthMinor, currency)}{" "}
            this month.
          </p>
          <Button size="sm" variant="outline" render={<Link href="/budgets" />}>
            Set a budget
          </Button>
        </CardContent>
      </Card>
    );
  }

  const percentUsed = Math.min(150, Math.round(budgetOverall.pct * 100));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base font-semibold">Monthly spending limit</CardTitle>
        <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
          <ShieldCheckIcon className="size-4 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground">Budget</p>
          <p className="text-2xl font-bold tabular-nums tracking-tight">
            {privacy ? "••••" : fmtMoney(budgetOverall.effectiveLimitMinor, currency)}
          </p>
          {budgetOverall.rolloverCreditMinor > 0 ? (
            <p className="text-xs text-muted-foreground">
              Includes {privacy ? "••••" : fmtMoney(budgetOverall.rolloverCreditMinor, currency)}{" "}
              rolled over from last month
            </p>
          ) : null}
        </div>
        <Progress value={Math.min(percentUsed, 100)} className="h-2" />
        <div className="flex items-center justify-between text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Spend</p>
            <p className="font-semibold tabular-nums">
              {privacy ? "••••" : fmtMoney(budgetOverall.spentMinor, currency)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Remaining</p>
            <p
              className={`font-semibold tabular-nums ${
                budgetOverall.remainingMinor >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-destructive"
              }`}
            >
              {privacy ? "••••" : fmtMoney(budgetOverall.remainingMinor, currency)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
