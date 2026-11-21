"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { CategoryDonut } from "@/components/finance/category-donut";
import { useDashboardData } from "@/components/finance/dashboard-data";
import { cn } from "@/lib/utils";

/**
 * Dashboard widget: the month's top spending categories as a donut plus
 * a ranked list, linking through to the full reports page.
 */
export function SpendingBreakdown() {
  const { topCategories, currency, privacy } = useDashboardData();

  return (
    <CategoryDonut
      items={topCategories}
      currency={currency}
      privacy={privacy}
      title="Spending by category"
      action={
        <Link
          href="/reports"
          className={cn(buttonVariants({ variant: "ghost", size: "xs" }), "text-xs")}
        >
          View report
        </Link>
      }
    />
  );
}
