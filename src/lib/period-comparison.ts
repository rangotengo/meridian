/**
 * Pure helpers for dashboard period comparisons.
 *
 * All money stays in integer minor units; percentages are ratios computed
 * from those integers. A zero previous value never produces Infinity or
 * NaN — the percentage is null and callers render an em dash instead.
 */

export type FlowLike = { incomeMinor: number; expenseMinor: number };

export type PeriodDelta = {
  /** current - previous, in integer minor units. */
  deltaMinor: number;
  /** delta / |previous|, or null when the previous value is zero. */
  pct: number | null;
};

/** Delta + percentage change between two integer minor-unit amounts. */
export function deltaWithPct(currentMinor: number, previousMinor: number): PeriodDelta {
  const deltaMinor = currentMinor - previousMinor;
  if (previousMinor === 0) return { deltaMinor, pct: null };
  return { deltaMinor, pct: deltaMinor / Math.abs(previousMinor) };
}

export type NetWorthChange = {
  currentMinor: number;
  startMinor: number;
  startDate: string;
  deltaMinor: number;
  /** null when there is only one point or the starting value is zero. */
  pct: number | null;
};

/**
 * Change in net worth from the first point of the shown series to the
 * last. Returns null when the series is empty. A single-point series
 * has a zero change.
 */
export function netWorthChange(
  series: { date: string; valueMinor: number }[]
): NetWorthChange | null {
  if (!series || series.length === 0) return null;
  const first = series.at(0);
  const last = series.at(-1);
  if (!first || !last) return null;
  const { deltaMinor, pct } = deltaWithPct(last.valueMinor, first.valueMinor);
  return {
    currentMinor: last.valueMinor,
    startMinor: first.valueMinor,
    startDate: first.date,
    deltaMinor,
    pct: series.length < 2 ? null : pct
  };
}

export type FlowTotals = { inMinor: number; outMinor: number; netMinor: number };

/** Integer minor-unit totals for a window of monthly flows. */
export function sumFlows(flows: FlowLike[]): FlowTotals {
  let inMinor = 0;
  let outMinor = 0;
  for (const flow of flows) {
    inMinor += flow.incomeMinor;
    outMinor += flow.expenseMinor;
  }
  return { inMinor, outMinor, netMinor: inMinor - outMinor };
}

export type FlowWindowComparison = {
  current: FlowTotals;
  previous: FlowTotals;
  /** Months actually present in the previous window (may be fewer than requested). */
  previousMonths: number;
  in: PeriodDelta;
  out: PeriodDelta;
  net: PeriodDelta;
};

/**
 * Compare a window of flows against the immediately preceding window of
 * the same length. The previous window may be shorter than requested
 * when history is thin — callers should label that with previousMonths.
 */
export function compareFlowWindows(
  currentFlows: FlowLike[],
  previousFlows: FlowLike[]
): FlowWindowComparison {
  const current = sumFlows(currentFlows);
  const previous = sumFlows(previousFlows);
  return {
    current,
    previous,
    previousMonths: previousFlows.length,
    in: deltaWithPct(current.inMinor, previous.inMinor),
    out: deltaWithPct(current.outMinor, previous.outMinor),
    net: deltaWithPct(current.netMinor, previous.netMinor)
  };
}

export type MonthComparison = {
  current: FlowTotals & { monthKey: string };
  previous: FlowTotals & { monthKey: string };
  in: PeriodDelta;
  out: PeriodDelta;
  net: PeriodDelta;
};

/** This month vs last month, from the last two monthly flow entries. Null when fewer than two months exist. */
export function monthVsLastMonth(
  flows: ({ monthKey: string } & FlowLike)[]
): MonthComparison | null {
  if (!flows || flows.length < 2) return null;
  const currentFlow = flows.at(-1);
  const previousFlow = flows.at(-2);
  if (!currentFlow || !previousFlow) return null;
  const current = { ...sumFlows([currentFlow]), monthKey: currentFlow.monthKey };
  const previous = { ...sumFlows([previousFlow]), monthKey: previousFlow.monthKey };
  return {
    current,
    previous,
    in: deltaWithPct(current.inMinor, previous.inMinor),
    out: deltaWithPct(current.outMinor, previous.outMinor),
    net: deltaWithPct(current.netMinor, previous.netMinor)
  };
}
