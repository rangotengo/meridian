/**
 * Pure helpers for the recurring-series summary line.
 */

export type NextDueLike = { nextDue: string; active: boolean };

/**
 * Earliest next-due date among ACTIVE series only. A paused series has
 * no next scheduled occurrence — its stored nextDue is frozen at pause
 * time — so it must never supply the summary "next due". Returns
 * undefined when no series is active (including an empty list), in
 * which case the summary omits the next-due part entirely.
 */
export function nextDueFromActiveSeries(series: NextDueLike[]): string | undefined {
  const active = series
    .filter((s) => s.active)
    .map((s) => s.nextDue)
    .sort();
  return active.at(0);
}
