import {
  addMonths,
  diffDays,
  endOfMonth,
  isIsoDate,
  monthKeyOf,
  startOfMonth
} from "./datetime";

export const REPORT_PERIODS = [
  { key: "monthly", label: "Monthly", months: 1, days: 30 },
  { key: "quarterly", label: "Quarterly", months: 3, days: 90 },
  { key: "ytd", label: "Year to date", months: 12, days: 365 },
  { key: "six_months", label: "Last 6 months", months: 6, days: 180 }
] as const;

export type ReportPeriodKey = (typeof REPORT_PERIODS)[number]["key"];

export type ResolvedReportRange = {
  key: ReportPeriodKey | "custom";
  label: string;
  /** Effective range, always snapped to whole months. */
  from: string;
  to: string;
  fromMonth: string;
  toMonth: string;
  /** Months spanned by the current window (max 12). */
  months: number;
  /**
   * Months to ask incomeExpenseSeries for, ending at the current month.
   * Covers the previous window too when comparing, so the page can split
   * one query into current vs previous instead of issuing two.
   */
  monthsBack: number;
  /** Days for the trailing net-worth series. */
  days: number;
  /** Same-length window immediately before the current one. */
  previousFrom: string;
  previousTo: string;
  previousFromMonth: string;
  previousToMonth: string;
  isCustom: boolean;
};

/**
 * Custom ranges cover whole months within the last year: a range longer
 * than 12 months, or ending more than a year ago, is clamped to what the
 * monthly-flows query can answer exactly, and the effective range is what
 * the page displays. Unparseable or reversed dates fall back to monthly.
 */
const MAX_MONTHS = 12;

function monthDiff(fromMonth: string, toMonth: string): number {
  const [fy = 0, fm = 0] = fromMonth.split("-").map(Number);
  const [ty = 0, tm = 0] = toMonth.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export function resolveReportRange(input: {
  period?: string;
  from?: string;
  to?: string;
  compare?: boolean;
  currentMonth: string;
}): ResolvedReportRange {
  const { period, from, to, compare, currentMonth } = input;

  const build = (
    key: ReportPeriodKey | "custom",
    label: string,
    fromMonth: string,
    toMonth: string,
    days: number
  ): ResolvedReportRange => {
    const fromDate = startOfMonth(`${fromMonth}-01`);
    const toDate = endOfMonth(`${toMonth}-01`);
    const months = monthDiff(fromMonth, toMonth) + 1;
    const previousFromMonth = addMonths(fromMonth, -months);
    const previousToMonth = addMonths(fromMonth, -1);
    // The previous window is month-based (whole months), matching the
    // monthly flows the comparison totals come from.
    const previousFrom = startOfMonth(`${previousFromMonth}-01`);
    const previousTo = endOfMonth(`${previousToMonth}-01`);
    const monthsBack = compare
      ? monthDiff(previousFromMonth, currentMonth) + 1
      : monthDiff(fromMonth, currentMonth) + 1;
    return {
      key,
      label,
      from: fromDate,
      to: toDate,
      fromMonth,
      toMonth,
      months,
      monthsBack,
      days,
      previousFrom,
      previousTo,
      previousFromMonth,
      previousToMonth,
      isCustom: key === "custom"
    };
  };

  if (from && to && isIsoDate(from) && isIsoDate(to) && from <= to) {
    // Clamp into the last year, then snap to whole months.
    const oldestMonth = addMonths(currentMonth, -(MAX_MONTHS - 1));
    const toMonth = monthKeyOf(to) > currentMonth ? currentMonth : monthKeyOf(to);
    let fromMonth = monthKeyOf(from);
    if (fromMonth < oldestMonth) fromMonth = oldestMonth;
    if (fromMonth > toMonth) return resolveReportRange({ ...input, from: undefined, to: undefined });
    const days = Math.min(diffDays(startOfMonth(`${fromMonth}-01`), endOfMonth(`${toMonth}-01`)) + 1, 365);
    return build("custom", "Custom", fromMonth, toMonth, days);
  }

  const selected =
    REPORT_PERIODS.find((item) => item.key === period) ?? REPORT_PERIODS[0];
  const months = selected.key === "ytd" ? Number(currentMonth.slice(5, 7)) : selected.months;
  const fromMonth = addMonths(currentMonth, -(months - 1));
  const days =
    selected.key === "ytd" ? Math.max(30, months * 30) : selected.days;
  return build(selected.key, selected.label, fromMonth, currentMonth, days);
}
