"use client";

import { useDashboardData } from "@/components/finance/dashboard-data";
import { FxIssuesAlert } from "@/components/finance/fx-issues-alert";

/**
 * Surfaces incomplete / stale currency conversion on the dashboard.
 * Rendered outside the sortable widgets so it cannot be hidden by layout
 * customisation. The presentation is shared with reports and budgets via
 * FxIssuesAlert.
 */
export function FxWarning() {
  const data = useDashboardData();
  return <FxIssuesAlert fx={data.fx} />;
}
