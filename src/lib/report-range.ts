import { addMonths, diffDays, endOfMonth, isIsoDate, monthKeyOf, startOfMonth } from "./datetime";

export const REPORT_PERIODS = [
  { key: "monthly", label: "Monthly", months: 1 },
  { key: "quarterly", label: "Quarterly", months: 3 },
  { key: "ytd", label: "Year to date", months: 12 },
  { key: "six_months", label: "Last 6 months", months: 6 }
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
  /**
   * Days of net-worth coverage to fetch, ending today and reaching back
   * to `from` — so a historical range fetches its own period instead of
   * a trailing window ending today. The page then constrains the points
   * to [from, to] with selectNetWorthInRange.
   */
  netWorthDays: number;
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
  /** Today's date (ISO). Callers that show net worth pass it so the
   * fetch window reaches back to `from`; without it the window ends at
   * the end of the current month instead. */
  today?: string;
}): ResolvedReportRange {
  const { period, from, to, compare, currentMonth, today } = input;
  const todayIso = today ?? endOfMonth(`${currentMonth}-01`);

  const build = (
    key: ReportPeriodKey | "custom",
    label: string,
    fromMonth: string,
    toMonth: string
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
    // Fetch coverage back to `from`, not a trailing window ending today:
    // a Sep–Oct range selected in November used to ask for a trailing
    // span (and the old span math even produced a negative day count,
    // so the series came back empty and the headline read 0).
    const netWorthDays = Math.min(diffDays(todayIso, fromDate) + 1, 366);
    return {
      key,
      label,
      from: fromDate,
      to: toDate,
      fromMonth,
      toMonth,
      months,
      monthsBack,
      netWorthDays,
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
    if (fromMonth > toMonth)
      return resolveReportRange({ ...input, from: undefined, to: undefined });
    return build("custom", "Custom", fromMonth, toMonth);
  }

  const selected = REPORT_PERIODS.find((item) => item.key === period) ?? REPORT_PERIODS[0];
  const months = selected.key === "ytd" ? Number(currentMonth.slice(5, 7)) : selected.months;
  const fromMonth = addMonths(currentMonth, -(months - 1));
  return build(selected.key, selected.label, fromMonth, currentMonth);
}

export type NetWorthPoint = { date: string; valueMinor: number };

/**
 * Constrain net-worth points to the chosen dates and pick the headline:
 * the latest point inside the range, with its date, so the card can
 * label the value "as of" that date instead of implying it is today's.
 * Null when no snapshot falls inside the range.
 */
export function selectNetWorthInRange(
  points: NetWorthPoint[],
  from: string,
  to: string
): { points: NetWorthPoint[]; latest: NetWorthPoint | null } {
  const inRange = points.filter((point) => point.date >= from && point.date <= to);
  return {
    points: inRange,
    latest: inRange.length > 0 ? inRange[inRange.length - 1]! : null
  };
}
