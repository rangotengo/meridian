"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from "@/components/ui/chart";
import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis, type DotProps } from "recharts";
import { useDashboardData } from "@/components/finance/dashboard-data";
import { fmtMoney, fmtSignedMoney, formatPct } from "@/lib/format";
import { minorToMajor } from "@/lib/money";
import { netWorthChange } from "@/lib/period-comparison";

function SquareDot({
  cx,
  cy,
  fill,
  opacity = 1,
  size = 6
}: DotProps & { size?: number; opacity?: number | string }) {
  if (cx == null || cy == null) return null;
  return (
    <rect
      x={cx - size / 2}
      y={cy - size / 2}
      width={size}
      height={size}
      fill={fill}
      fillOpacity={opacity}
      rx={1}
    />
  );
}

const chartConfig: ChartConfig = {
  netWorth: {
    label: "Net Worth",
    color: "var(--color-primary)"
  },
  projected: {
    label: "Projected",
    color: "var(--color-muted-foreground)"
  }
};

export function FinancialOverview() {
  const { series, projection, currency, netWorthMinor, assetsMinor, liabilitiesMinor, privacy } =
    useDashboardData();

  const formattedData = useMemo(() => {
    const history = (series ?? []).map((point: { date: string; valueMinor: number }) => ({
      date: point.date,
      valueMinor: point.valueMinor,
      value: minorToMajor(point.valueMinor, currency) as number | undefined,
      projected: undefined as number | undefined
    }));
    if (!projection || projection.points.length < 2) return history;
    // The first projection point is the join: same date/value as the last
    // history point. The dashed line starts there; the Area ends there.
    const merged = [...history];
    projection.points.forEach((point, i) => {
      const projected = minorToMajor(point.valueMinor, currency);
      if (i === 0 && merged.length > 0 && merged[merged.length - 1]!.date === point.date) {
        merged[merged.length - 1] = { ...merged[merged.length - 1]!, projected };
      } else {
        merged.push({
          date: point.date,
          valueMinor: point.valueMinor,
          value: undefined,
          projected
        });
      }
    });
    return merged;
  }, [series, projection, currency]);

  const change = useMemo(() => netWorthChange(series), [series]);
  const startLabel = change
    ? new Date(change.startDate).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric"
      })
    : null;

  return (
    <Card className="col-span-full">
      <CardHeader>
        <CardTitle>Net Worth History</CardTitle>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-1">
          <span className="text-2xl font-bold tabular-nums">
            {privacy ? "••••••" : fmtMoney(netWorthMinor, currency)}
          </span>
          {change && (
            <span
              className={`text-sm font-semibold tabular-nums ${
                change.deltaMinor >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-destructive"
              }`}
            >
              {privacy
                ? "••••"
                : `${fmtSignedMoney(change.deltaMinor, currency)} (${formatPct(change.pct)})`}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                vs {startLabel}
              </span>
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Assets {privacy ? "••••" : fmtMoney(assetsMinor, currency)}
          {" · "}Liabilities {privacy ? "••••" : fmtMoney(liabilitiesMinor, currency)}
        </p>
      </CardHeader>
      <CardContent>
        {formattedData.length === 0 ? (
          <div className="flex h-[300px] w-full items-center justify-center text-muted-foreground">
            No history available
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[300px] w-full">
            <AreaChart data={formattedData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
              <defs>
                <linearGradient id="nwFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value) => {
                  const d = new Date(value);
                  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
                }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(val) => {
                  return val.toLocaleString(undefined, { maximumFractionDigits: 0 });
                }}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(_val, _name, item) => {
                      const minor = item.payload.valueMinor;
                      const isProjection =
                        item.payload.value == null && item.payload.projected != null;
                      return isProjection
                        ? `${fmtMoney(minor, currency)} (projection)`
                        : fmtMoney(minor, currency);
                    }}
                  />
                }
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="var(--color-primary)"
                strokeWidth={2}
                fill="url(#nwFill)"
                dot={false}
                activeDot={(props) => <SquareDot {...props} fill="var(--color-primary)" size={7} />}
              />
              <Line
                type="monotone"
                dataKey="projected"
                stroke="var(--color-muted-foreground)"
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                activeDot={(props) => (
                  <SquareDot {...props} fill="var(--color-muted-foreground)" size={7} />
                )}
              />
            </AreaChart>
          </ChartContainer>
        )}
        {projection && formattedData.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Dashed line: projection to{" "}
            {new Date(projection.horizonEnd).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric"
            })}{" "}
            from scheduled recurring flows only — projection, not a guarantee. Overdue occurrences
            are not projected.
            {projection.valuationAccountCount > 0
              ? ` ${privacy ? "••••" : fmtMoney(projection.valuationFlatMinor, currency)} sits in valuation accounts held flat at today's value.`
              : ""}
            {projection.skippedSeries > 0
              ? ` ${projection.skippedSeries} scheduled series skipped (invalid schedule).`
              : ""}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
