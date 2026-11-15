import Link from "next/link";
import { Alert } from "@/components/ds/card";
import type { DashboardData } from "@/components/finance/dashboard-data";

export type FxAlertData = DashboardData["fx"];

/**
 * Shared currency-conversion completeness warning. Totals in Meridian
 * exclude amounts that cannot be converted (see reports.ts), so without
 * this banner a partial total looks complete. Used by the dashboard,
 * reports, and budgets surfaces with the same presentation everywhere.
 */
export function FxIssuesAlert({ fx }: { fx: FxAlertData }) {
  const staleRates = fx.rates.filter((r) => r.stale);
  if (!fx.incomplete && staleRates.length === 0) return null;

  return (
    <Alert
      tone="warning"
      title={
        fx.incomplete
          ? "Some totals are incomplete — missing exchange rates"
          : "Some exchange rates are stale"
      }
    >
      {fx.issues.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
          {fx.issues.map((issue) => (
            <li key={`${issue.base}:${issue.quote}`}>
              <strong>
                {issue.base} → {issue.quote}
              </strong>
              : no exchange rate, so amounts in {issue.base} are excluded from these totals.
            </li>
          ))}
        </ul>
      ) : null}
      {fx.rates.length > 0 ? (
        <p className="mt-1.5 text-xs">
          Rates used:{" "}
          {fx.rates
            .map(
              (r) =>
                `${r.base} → ${r.quote} ${r.rate} (as of ${r.quotedOn}${r.stale ? ", stale" : ""})`
            )
            .join(" · ")}
        </p>
      ) : null}
      <p className="mt-2">
        <Link href="/settings/exchange-rates" className="font-medium underline underline-offset-2">
          Add or refresh exchange rates
        </Link>
      </p>
    </Alert>
  );
}
