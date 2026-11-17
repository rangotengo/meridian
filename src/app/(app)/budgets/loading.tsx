import { Skeleton } from "@/components/ui/skeleton";

/** Budgets loading state: rings, overall cap, category budgets + form. */
export default function BudgetsLoading() {
  return (
    <div className="space-y-6 pb-6 lg:pb-12" aria-busy="true" aria-live="polite">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="min-h-[220px] rounded-xl" />
      <Skeleton className="min-h-[140px] rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="min-h-[260px] rounded-xl" />
        <Skeleton className="min-h-[260px] rounded-xl" />
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
