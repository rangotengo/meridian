import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarClockIcon } from "lucide-react";
import { useDashboardData, type DashboardBill } from "@/components/finance/dashboard-data";
import { fmtDate, fmtMoney } from "@/lib/format";

function dueLabel(bill: DashboardBill): string {
  if (bill.status === "missed") {
    return bill.daysUntilDue === -1 ? "Due yesterday" : `Overdue by ${-bill.daysUntilDue} days`;
  }
  if (bill.daysUntilDue === 0) return "Due today";
  if (bill.daysUntilDue === 1) return "Due tomorrow";
  return `Due in ${bill.daysUntilDue} days`;
}

function BillRow({ bill, privacy }: { bill: DashboardBill; privacy: boolean }) {
  return (
    <li className="flex items-start justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{bill.name}</p>
        <p className="text-xs text-muted-foreground">
          {fmtDate(bill.dueDate)} · {bill.accountName} · {dueLabel(bill)}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-medium tabular-nums">
          {privacy ? "••••" : fmtMoney(Math.abs(bill.amountMinor), bill.currency)}
        </p>
        {bill.status === "missed" ? (
          <Badge variant="destructive">Missed</Badge>
        ) : bill.status === "due-soon" ? (
          <Badge variant="outline">Due soon</Badge>
        ) : null}
      </div>
    </li>
  );
}

export function BillsWidget() {
  const { bills, privacy } = useDashboardData();
  const missedCount = bills.missed.length;
  const dueSoonCount = bills.dueSoon.length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base font-semibold">Bills &amp; reminders</CardTitle>
        <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
          <CalendarClockIcon className="size-4 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {missedCount > 0 ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-destructive">
              Missed · {missedCount}
            </p>
            <ul className="mt-2 space-y-2">
              {bills.missed.map((bill) => (
                <BillRow key={bill.seriesId} bill={bill} privacy={privacy} />
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Missed means the due date passed with no posted transaction for that occurrence. The
              scheduled poster will still post it when it next runs — check the amount before paying
              it by hand.
            </p>
          </div>
        ) : null}
        {dueSoonCount > 0 || bills.upcoming.length > 0 ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Next 30 days · {dueSoonCount + bills.upcoming.length}
            </p>
            <ul className="mt-2 space-y-2">
              {[...bills.dueSoon, ...bills.upcoming].map((bill) => (
                <BillRow key={bill.seriesId} bill={bill} privacy={privacy} />
              ))}
            </ul>
          </div>
        ) : null}
        {missedCount === 0 && dueSoonCount === 0 && bills.upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bills due in the next 30 days.</p>
        ) : null}
        <Button size="sm" variant="outline" render={<Link href="/settings/recurring" />}>
          Manage recurring
        </Button>
      </CardContent>
    </Card>
  );
}
