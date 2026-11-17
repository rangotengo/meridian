import { Skeleton } from "@/components/ui/skeleton";

/**
 * Dashboard loading state, mirroring the dashboard widget grid
 * (DashboardCustomizer): net-worth chart + accounts on the first row,
 * actions/money-movement/health on the second, recent transactions full
 * width below. Other routes under (app) override this with their own
 * loading.tsx; this file is also their fallback.
 */
export default function AppLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="grid grid-cols-12 gap-4">
        <Skeleton className="col-span-12 min-h-[380px] rounded-xl lg:col-span-8" />
        <Skeleton className="col-span-12 min-h-[380px] rounded-xl lg:col-span-4" />
        <Skeleton className="col-span-12 min-h-[280px] rounded-xl lg:col-span-4" />
        <Skeleton className="col-span-12 min-h-[280px] rounded-xl lg:col-span-4" />
        <Skeleton className="col-span-12 min-h-[280px] rounded-xl lg:col-span-4" />
        <Skeleton className="col-span-12 min-h-[300px] rounded-xl" />
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
