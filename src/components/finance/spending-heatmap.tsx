"use client";

import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtMoney } from "@/lib/format";

const CELL_SIZE = 13;
const CELL_GAP = 3;
const TOTAL = CELL_SIZE + CELL_GAP;

function intensityClass(amount: number, max: number): string {
  if (amount === 0) return "fill-muted/40";
  const ratio = amount / max;
  if (ratio < 0.2) return "fill-primary/10";
  if (ratio < 0.4) return "fill-primary/25";
  if (ratio < 0.65) return "fill-primary/45";
  return "fill-primary/70";
}

export function SpendingHeatmap({
  points,
  currency,
  privacy
}: {
  points: { date: string; amountMinor: number }[];
  currency: string;
  privacy: boolean;
}) {
  const { grid, monthLabels, yearTotal, max } = useMemo(() => {
    const maxValue = Math.max(0, ...points.map((point) => point.amountMinor));
    const yearTotalValue = points.reduce((sum, point) => sum + point.amountMinor, 0);
    const firstDate = points[0]?.date;
    if (!firstDate) {
      return { grid: [], monthLabels: [], yearTotal: 0, max: 0 };
    }
    const first = new Date(`${firstDate}T00:00:00`);
    const gridStart = new Date(first);
    gridStart.setDate(gridStart.getDate() - first.getDay());
    const lookup = new Map(points.map((point) => [point.date, point.amountMinor]));
    const weeks: { date: string; amount: number; col: number; row: number }[] = [];
    const months: { label: string; col: number }[] = [];
    const seenMonths = new Set<string>();

    for (let col = 0; col < 53; col++) {
      for (let row = 0; row < 7; row++) {
        const day = new Date(gridStart);
        day.setDate(day.getDate() + col * 7 + row);
        const key = day.toISOString().slice(0, 10);
        weeks.push({ date: key, amount: lookup.get(key) ?? 0, col, row });
        const monthKey = `${day.getFullYear()}-${day.getMonth()}`;
        if (!seenMonths.has(monthKey) && row === 0) {
          seenMonths.add(monthKey);
          months.push({
            label: day.toLocaleDateString("en-US", { month: "short" }),
            col
          });
        }
      }
    }
    return { grid: weeks, monthLabels: months, yearTotal: yearTotalValue, max: maxValue };
  }, [points]);

  const width = 53 * TOTAL;
  const height = 7 * TOTAL + 18;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base font-semibold">Spending heatmap</CardTitle>
            <CardDescription>
              {privacy ? "••••" : fmtMoney(yearTotal, currency)} spent over the last year
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {/* Fluid via viewBox: the grid scales with the card instead of
            sitting at a fixed 848px with dead space on wide screens. The
            max width caps the scale so cells and month labels stay
            proportionate; below 680px the container scrolls horizontally. */}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="mx-auto block h-auto w-full max-w-[1100px] min-w-[680px]"
          role="img"
          aria-label="Daily spending over the last year"
        >
          {monthLabels.map((month) => (
            <text
              key={`${month.label}-${month.col}`}
              x={month.col * TOTAL}
              y={10}
              className="fill-muted-foreground text-[10px]"
            >
              {month.label}
            </text>
          ))}
          {grid.map((cell) => (
            <rect
              key={cell.date}
              x={cell.col * TOTAL}
              y={18 + cell.row * TOTAL}
              width={CELL_SIZE}
              height={CELL_SIZE}
              rx={2}
              className={intensityClass(cell.amount, max || 1)}
            >
              <title>
                {cell.date}: {privacy ? "••••" : fmtMoney(cell.amount, currency)}
              </title>
            </rect>
          ))}
        </svg>
      </CardContent>
    </Card>
  );
}
