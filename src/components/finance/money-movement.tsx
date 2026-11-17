"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useDashboardData } from "@/components/finance/dashboard-data";
import { fmtMoney, fmtMonth, fmtSignedMoney } from "@/lib/format";
import { minorToMajor } from "@/lib/money";
import { compareFlowWindows, monthVsLastMonth, type PeriodDelta } from "@/lib/period-comparison";
import { ArrowDownLeftIcon, ArrowUpRightIcon } from "lucide-react";

const chartConfig = {
  moneyIn: { label: "Money in", color: "var(--color-primary)" },
  moneyOut: { label: "Money out", color: "var(--color-muted-foreground)" }
} satisfies ChartConfig;

function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  return `${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(1)}%`;
}

function DeltaLine({
  delta,
  currency,
  privacy,
  label
}: {
  delta: PeriodDelta;
  currency: string;
  privacy: boolean;
  label: string;
}) {
  if (privacy) {
    return <p className="text-[11px] text-muted-foreground">{label}: ••••</p>;
  }
  return (
    <p className="text-[11px] text-muted-foreground">
      {label}:{" "}
      <span
        className={`font-semibold tabular-nums ${
          delta.deltaMinor >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
        }`}
      >
        {fmtSignedMoney(delta.deltaMinor, currency)} ({formatPct(delta.pct)})
      </span>
    </p>
  );
}

export function MoneyMovement() {
  const { flows, currency, privacy, locale } = useDashboardData();
  const [months, setMonths] = useState<"3" | "6" | "12">("6");

  const sliced = useMemo(() => flows.slice(-Number(months)), [flows, months]);
  const data = sliced.map((flow) => ({
    label: fmtMonth(flow.monthKey, locale),
    moneyIn: minorToMajor(flow.incomeMinor, currency),
    moneyOut: minorToMajor(flow.expenseMinor, currency)
  }));
  const totals = sliced.reduce(
    (acc, flow) => ({
      in: acc.in + flow.incomeMinor,
      out: acc.out + flow.expenseMinor
    }),
    { in: 0, out: 0 }
  );
  const net = totals.in - totals.out;

  const comparison = useMemo(() => {
    const n = Number(months);
    const previous = flows.slice(-2 * n, -n);
    return compareFlowWindows(sliced, previous);
  }, [flows, sliced, months]);

  const monthComparison = useMemo(() => monthVsLastMonth(flows), [flows]);

  const previousLabel =
    comparison.previousMonths === 0
      ? null
      : comparison.previousMonths < Number(months)
        ? `vs previous ${comparison.previousMonths} mo (partial history)`
        : `vs previous ${months} mo`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="text-base font-semibold">Money movement</CardTitle>
        <Select
          value={months}
          onValueChange={(value) => value && setMonths(value as "3" | "6" | "12")}
        >
          <SelectTrigger aria-label="Money movement period" className="h-8 w-[110px] text-xs">
            {/* Base UI's Value falls back to the raw value ("6") once the
                popup is closed and its items unmount, so render the label
                explicitly. */}
            <SelectValue>{`${months} months`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="3">3 months</SelectItem>
            <SelectItem value="6">6 months</SelectItem>
            <SelectItem value="12">12 months</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-emerald-50 px-3 py-2.5 dark:bg-emerald-950/30">
            <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/50">
              <ArrowDownLeftIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-medium text-emerald-600/70 dark:text-emerald-400/70">
                Money in
              </p>
              <p className="text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                {privacy ? "••••" : fmtMoney(totals.in, currency)}
              </p>
              {previousLabel ? (
                <DeltaLine
                  delta={comparison.in}
                  currency={currency}
                  privacy={privacy}
                  label={previousLabel}
                />
              ) : (
                <p className="text-[11px] text-muted-foreground">No previous period</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2.5 rounded-xl bg-rose-50 px-3 py-2.5 dark:bg-rose-950/30">
            <div className="flex size-8 items-center justify-center rounded-lg bg-rose-100 dark:bg-rose-900/50">
              <ArrowUpRightIcon className="size-4 text-rose-600 dark:text-rose-400" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-medium text-rose-600/70 dark:text-rose-400/70">
                Money out
              </p>
              <p className="text-sm font-bold tabular-nums text-rose-700 dark:text-rose-300">
                {privacy ? "••••" : fmtMoney(totals.out, currency)}
              </p>
              {previousLabel ? (
                <DeltaLine
                  delta={comparison.out}
                  currency={currency}
                  privacy={privacy}
                  label={previousLabel}
                />
              ) : (
                <p className="text-[11px] text-muted-foreground">No previous period</p>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <span className="text-xs text-muted-foreground">
            Net flow
            {previousLabel && (
              <span className="ml-2">
                {privacy ? (
                  "••••"
                ) : (
                  <span
                    className={`font-semibold tabular-nums ${
                      comparison.net.deltaMinor >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-destructive"
                    }`}
                  >
                    {fmtSignedMoney(comparison.net.deltaMinor, currency)} (
                    {formatPct(comparison.net.pct)})
                  </span>
                )}
              </span>
            )}
          </span>
          <span
            className={`text-sm font-bold tabular-nums ${
              net >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
            }`}
          >
            {privacy ? "••••" : fmtMoney(net, currency, "en", "always")}
          </span>
        </div>
        {monthComparison && (
          <div className="rounded-lg border px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">This month vs last month</p>
            <div className="mt-1.5 grid grid-cols-3 gap-2 text-xs">
              <div>
                <p className="text-muted-foreground">
                  {fmtMonth(monthComparison.current.monthKey, locale)}
                </p>
                <p className="font-semibold tabular-nums">
                  {privacy ? "••••" : fmtMoney(monthComparison.current.inMinor, currency)}
                </p>
                <p className="text-muted-foreground">in</p>
              </div>
              <div>
                <p className="text-muted-foreground">
                  {fmtMonth(monthComparison.previous.monthKey, locale)}
                </p>
                <p className="font-semibold tabular-nums">
                  {privacy ? "••••" : fmtMoney(monthComparison.previous.inMinor, currency)}
                </p>
                <p className="text-muted-foreground">in</p>
              </div>
              <div>
                <p className="text-muted-foreground">Change</p>
                <p
                  className={`font-semibold tabular-nums ${
                    monthComparison.in.deltaMinor >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-destructive"
                  }`}
                >
                  {privacy
                    ? "••••"
                    : `${fmtSignedMoney(monthComparison.in.deltaMinor, currency)} (${formatPct(monthComparison.in.pct)})`}
                </p>
                <p className="text-muted-foreground">in</p>
              </div>
              <div>
                <p className="font-semibold tabular-nums">
                  {privacy ? "••••" : fmtMoney(monthComparison.current.outMinor, currency)}
                </p>
                <p className="text-muted-foreground">out</p>
              </div>
              <div>
                <p className="font-semibold tabular-nums">
                  {privacy ? "••••" : fmtMoney(monthComparison.previous.outMinor, currency)}
                </p>
                <p className="text-muted-foreground">out</p>
              </div>
              <div>
                <p
                  className={`font-semibold tabular-nums ${
                    monthComparison.out.deltaMinor >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-destructive"
                  }`}
                >
                  {privacy
                    ? "••••"
                    : `${fmtSignedMoney(monthComparison.out.deltaMinor, currency)} (${formatPct(monthComparison.out.pct)})`}
                </p>
                <p className="text-muted-foreground">out</p>
              </div>
              <div>
                <p className="font-semibold tabular-nums">
                  {privacy ? "••••" : fmtMoney(monthComparison.current.netMinor, currency)}
                </p>
                <p className="text-muted-foreground">net</p>
              </div>
              <div>
                <p className="font-semibold tabular-nums">
                  {privacy ? "••••" : fmtMoney(monthComparison.previous.netMinor, currency)}
                </p>
                <p className="text-muted-foreground">net</p>
              </div>
              <div>
                <p
                  className={`font-semibold tabular-nums ${
                    monthComparison.net.deltaMinor >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-destructive"
                  }`}
                >
                  {privacy
                    ? "••••"
                    : `${fmtSignedMoney(monthComparison.net.deltaMinor, currency)} (${formatPct(monthComparison.net.pct)})`}
                </p>
                <p className="text-muted-foreground">net</p>
              </div>
            </div>
          </div>
        )}
        <ChartContainer config={chartConfig} className="h-[180px] w-full">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -24 }} barGap={2}>
            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="var(--color-border)"
              strokeOpacity={0.4}
            />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              fontSize={11}
              tickMargin={6}
              stroke="var(--color-muted-foreground)"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              fontSize={11}
              tickMargin={4}
              stroke="var(--color-muted-foreground)"
              tickFormatter={(value) => (privacy ? "••" : `${Math.round(Number(value))}`)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) =>
                    privacy
                      ? "••••"
                      : typeof value === "number"
                        ? value.toLocaleString(locale, { style: "currency", currency })
                        : String(value)
                  }
                />
              }
            />
            <Bar
              dataKey="moneyIn"
              fill="var(--color-primary)"
              radius={[6, 6, 0, 0]}
              maxBarSize={24}
            />
            <Bar
              dataKey="moneyOut"
              fill="var(--color-muted-foreground)"
              radius={[6, 6, 0, 0]}
              maxBarSize={24}
              fillOpacity={0.6}
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
