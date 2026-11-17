import { Skeleton } from "@/components/ui/skeleton";

/** Transactions loading state: filter card, then the table with rows. */
export default function TransactionsLoading() {
  return (
    <div className="space-y-4 pb-6 lg:pb-12" aria-busy="true" aria-live="polite">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-8 w-36 rounded-lg" />
      </div>
      <Skeleton className="min-h-[120px] rounded-xl" />
      <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
        <div className="border-b border-border px-4 py-3">
          <Skeleton className="h-4 w-2/3" />
        </div>
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between px-4 py-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
