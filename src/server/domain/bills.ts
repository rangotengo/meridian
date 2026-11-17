import { and, eq, gte, isNull, lte } from "drizzle-orm";
import type { Executor } from "../db/client";
import { entries, transactions } from "../db/schema";
import type { Actor } from "../auth/context";
import { listSeries, type Frequency } from "./recurring";

export type BillStatus = "missed" | "due-soon" | "upcoming";

export type UpcomingBill = {
  seriesId: string;
  name: string;
  merchant: string | null;
  /** Ledger amount in minor units (positive = money out, negative = money in). */
  amountMinor: number;
  currency: string;
  accountId: string;
  accountName: string;
  dueDate: string;
  frequency: Frequency;
  status: BillStatus;
  /** Days from today to the due date; negative when missed. */
  daysUntilDue: number;
};

export type BillsOverview = {
  missed: UpcomingBill[];
  dueSoon: UpcomingBill[];
  upcoming: UpcomingBill[];
};

/** Due within this many days (including today) gets the due-soon badge. */
export const DUE_SOON_DAYS = 7;
/** Due within this many days shows in the 30-day view. */
export const UPCOMING_DAYS = 30;

/** Days from `today` to `date` (negative when `date` is past). Both YYYY-MM-DD. */
export function daysBetween(today: string, date: string): number {
  const a = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10))
  );
  const b = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10))
  );
  return Math.round((b - a) / 86_400_000);
}

export function classifyBill(
  dueDate: string,
  today: string
): { status: BillStatus | null; daysUntilDue: number } {
  const daysUntilDue = daysBetween(today, dueDate);
  if (daysUntilDue < 0) return { status: "missed", daysUntilDue };
  if (daysUntilDue <= DUE_SOON_DAYS) return { status: "due-soon", daysUntilDue };
  if (daysUntilDue <= UPCOMING_DAYS) return { status: "upcoming", daysUntilDue };
  return { status: null, daysUntilDue };
}

/**
 * "Missed" means the due date passed with no posted transaction for that
 * occurrence. The scheduled poster normally posts on the due date and
 * advances nextDue, so a past nextDue means it has not posted yet. A
 * payment the user recorded by hand still counts: same account, same
 * ledger amount, dated on/after the due date, and either the series'
 * name or its merchant (or an entry the series itself posted). Split
 * parts are excluded — only the parent entry represents the payment.
 *
 * An early payment (dated before the due date) does NOT count: it cannot
 * be told apart from the previous occurrence's payment, and the scheduled
 * poster will still post on the due date.
 */
async function hasManualPayment(
  exec: Executor,
  series: {
    id: string;
    accountId: string;
    name: string;
    merchant: string | null;
    amountMinor: number;
  },
  nextDue: string,
  today: string
): Promise<boolean> {
  const rows = await exec
    .select({
      name: entries.name,
      merchant: transactions.merchant,
      seriesId: entries.recurringSeriesId
    })
    .from(entries)
    .leftJoin(transactions, eq(transactions.entryId, entries.id))
    .where(
      and(
        eq(entries.accountId, series.accountId),
        gte(entries.date, nextDue),
        lte(entries.date, today),
        eq(entries.amountMinor, series.amountMinor),
        isNull(entries.parentEntryId)
      )
    );
  const name = series.name.trim().toLowerCase();
  const merchant = series.merchant?.trim().toLowerCase() ?? null;
  return rows.some((row) => {
    if (row.seriesId === series.id) return true;
    if (row.name.trim().toLowerCase() === name) return true;
    if (merchant && row.merchant?.trim().toLowerCase() === merchant) return true;
    return false;
  });
}

/**
 * One row per active series on an account the actor can see, for the
 * outstanding occurrence only (the series' current nextDue). Inactive
 * series and series on disabled accounts are excluded — the poster
 * pauses those itself.
 */
export async function listUpcomingBills(
  exec: Executor,
  actor: Actor,
  today: string
): Promise<BillsOverview> {
  const series = await listSeries(exec, actor);
  const overview: BillsOverview = { missed: [], dueSoon: [], upcoming: [] };
  for (const s of series) {
    if (!s.active || s.accountStatus !== "active") continue;
    const { status, daysUntilDue } = classifyBill(s.nextDue, today);
    if (!status) continue;
    if (status === "missed" && (await hasManualPayment(exec, s, s.nextDue, today))) continue;
    const bill: UpcomingBill = {
      seriesId: s.id,
      name: s.name,
      merchant: s.merchant,
      amountMinor: s.amountMinor,
      currency: s.currency,
      accountId: s.accountId,
      accountName: s.accountName,
      dueDate: s.nextDue,
      frequency: s.frequency as Frequency,
      status,
      daysUntilDue
    };
    if (status === "missed") overview.missed.push(bill);
    else if (status === "due-soon") overview.dueSoon.push(bill);
    else overview.upcoming.push(bill);
  }
  for (const list of [overview.missed, overview.dueSoon, overview.upcoming]) {
    list.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  }
  return overview;
}
