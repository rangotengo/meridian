"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ds/card";
import { useDashboardData } from "@/components/finance/dashboard-data";
import { fmtMoney } from "@/lib/format";

/** Dashboard widget: the household's active goals with live progress. */
export function GoalsWidget() {
  const { goals, privacy } = useDashboardData();
  const active = goals.filter((g) => g.status === "active");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="text-base font-semibold">Goals</CardTitle>
        <Link href="/goals" className="text-xs font-medium text-primary hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent className="space-y-3">
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active goals.{" "}
            <Link href="/goals" className="font-medium text-primary hover:underline">
              Create one
            </Link>{" "}
            to track savings toward a target.
          </p>
        ) : (
          active.slice(0, 3).map((goal) => {
            const pct = goal.pct === null ? 0 : Math.min(goal.pct, 1);
            return (
              <div key={goal.id} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate font-medium">{goal.name}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {goal.linkRemoved || goal.progressMinor === null
                      ? "—"
                      : privacy
                        ? "••••"
                        : `${fmtMoney(goal.progressMinor, goal.currency)} / ${fmtMoney(goal.targetMinor, goal.currency)}`}
                  </span>
                </div>
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-border/60"
                  role="progressbar"
                  aria-valuenow={goal.pct === null ? undefined : Math.round(goal.pct * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className={`h-full rounded-full ${goal.reached ? "bg-success" : "bg-primary"}`}
                    style={{ width: `${pct * 100}%` }}
                  />
                </div>
                <div className="flex gap-1.5">
                  {goal.reached ? <Badge tone="success">Reached</Badge> : null}
                  {goal.pastDue ? <Badge tone="warning">Past due</Badge> : null}
                  {goal.linkRemoved ? <Badge tone="destructive">Link removed</Badge> : null}
                  {goal.deadline ? (
                    <span className="text-xs text-muted-foreground">due {goal.deadline}</span>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
        {active.length > 3 ? (
          <p className="text-xs text-muted-foreground">
            +{active.length - 3} more goal{active.length - 3 === 1 ? "" : "s"} on the Goals page.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
