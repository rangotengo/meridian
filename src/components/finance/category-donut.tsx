"use client";

import { useMemo } from "react";
import { Pie, PieChart, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from "@/components/ui/chart";
import { fmtMoney } from "@/lib/format";

const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-primary)"
];

export function CategoryDonut({
  items,
  currency,
  privacy,
  title = "Spending by category",
  action
}: {
  items: { name: string; totalMinor: number }[];
  currency: string;
  privacy: boolean;
  title?: string;
  /** Optional header action, e.g. an Export CSV link on the reports page. */
  action?: React.ReactNode;
}) {
  const total = items.reduce((sum, item) => sum + item.totalMinor, 0);
  const pieData = items.map((item, index) => ({
    name: item.name,
    value: item.totalMinor,
    fill: COLORS[index % COLORS.length]
  }));
  const chartConfig = useMemo(() => {
    const config: ChartConfig = {};
    for (const [index, item] of items.entries()) {
      config[item.name] = { label: item.name, color: COLORS[index % COLORS.length] };
    }
    return config;
  }, [items]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No spending recorded for this period.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[180px_1fr] sm:items-center">
            <ChartContainer config={chartConfig} className="mx-auto aspect-square h-[180px]">
              <PieChart>
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => (privacy ? "••••" : fmtMoney(Number(value), currency))}
                    />
                  }
                />
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={48}
                  outerRadius={74}
                  paddingAngle={2}
                >
                  {pieData.map((entry) => (
                    <Cell key={entry.name} fill={entry.fill} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <ul className="space-y-2">
              {items.slice(0, 6).map((item, index) => (
                <li key={item.name} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: COLORS[index % COLORS.length] }}
                    />
                    <span className="truncate">{item.name}</span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {privacy
                      ? "••••"
                      : `${fmtMoney(item.totalMinor, currency)} · ${total > 0 ? Math.round((item.totalMinor / total) * 100) : 0}%`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
