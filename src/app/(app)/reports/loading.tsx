import { Skeleton } from "@/components/ui/skeleton";

/** Reports loading state: stat cards, heatmap, donut + monthly table. */
export default function ReportsLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-20 rounded-lg" />
      </div>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-9 w-72 rounded-lg" />
        <Skeleton className="h-4 w-44" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="min-h-[96px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="min-h-[180px] rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="min-h-[280px] rounded-xl" />
        <Skeleton className="min-h-[280px] rounded-xl" />
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
