import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  db,
  makeUser,
  makeAccount,
  truncateAll,
  actorOf,
  daysAgo,
  latestBalance
} from "../helpers";
import {
  createSeries,
  postDueSeries,
  MAX_CATCHUP_OCCURRENCES_PER_RUN
} from "@/server/domain/recurring";
import { addDays } from "@/lib/datetime";

beforeAll(async () => {
  await truncateAll();
});

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

async function entryCountFor(seriesId: string): Promise<number> {
  const res = await db().execute<{ c: number }>(
    sql`SELECT CAST(count(*) AS INTEGER) AS c FROM entries WHERE recurring_series_id = ${seriesId}::uuid`
  );
  return Number(res.rows?.[0]?.c ?? 0);
}

async function nextDueOf(seriesId: string): Promise<string> {
  const res = await db().execute<{ next_due: string }>(
    sql`SELECT CAST(next_due AS TEXT) AS next_due FROM recurring_series WHERE id = ${seriesId}::uuid`
  );
  return (res.rows?.[0]?.next_due ?? "").slice(0, 10);
}

describe("postDueSeries", () => {
  it("posts catch-up occurrences, advances the schedule, recalculates balances, and is idempotent", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 0 });
    const start = daysAgo(21);
    const seriesId = await createSeries(db(), actorOf(user), {
      accountId,
      name: "Weekly bill",
      amountLedgerMinor: 1000,
      frequency: "weekly",
      config: { weekday: weekdayOf(start) },
      nextDue: start
    });

    const result = await postDueSeries(db(), new Date());
    expect(result.failed).toBe(0);
    expect(result.posted).toBe(1);

    // Occurrences on daysAgo(21), (14), (7) and (0) are all due.
    expect(await entryCountFor(seriesId)).toBe(4);
    // Schedule advanced past today, to the next weekly occurrence.
    expect(await nextDueOf(seriesId)).toBe(addDays(daysAgo(0), 7));
    // Balances were recalculated for the committed entries:
    // display balance = opening (0) − Σ amounts (4 × 1000).
    const balance = await latestBalance(accountId);
    expect(balance?.balanceMinor).toBe(-4000);

    // A retry / second run posts nothing new and keeps the same balance.
    const again = await postDueSeries(db(), new Date());
    expect(again.posted).toBe(0);
    expect(again.failed).toBe(0);
    expect(await entryCountFor(seriesId)).toBe(4);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(-4000);
  });

  it("bounds catch-up per run and resumes from the first unposted occurrence", async () => {
    const user = await makeUser();
    // openedOn must precede the backlog: balance recalculation starts at the
    // account's opening date, so an account opened 30 days ago (the helper
    // default) would legitimately ignore older entries.
    const accountId = await makeAccount(user, {
      openingBalanceDisplayMinor: 0,
      openedOn: daysAgo(900)
    });
    // 116 weekly occurrences are due (805 days back through today).
    const start = daysAgo(7 * 115);
    const seriesId = await createSeries(db(), actorOf(user), {
      accountId,
      name: "Ancient weekly",
      amountLedgerMinor: 100,
      frequency: "weekly",
      config: { weekday: weekdayOf(start) },
      nextDue: start
    });

    const first = await postDueSeries(db(), new Date());
    expect(first.failed).toBe(0);
    expect(await entryCountFor(seriesId)).toBe(MAX_CATCHUP_OCCURRENCES_PER_RUN);
    // Still behind: next_due points at the first unposted occurrence.
    expect((await nextDueOf(seriesId)) <= daysAgo(0)).toBe(true);

    const second = await postDueSeries(db(), new Date());
    expect(second.failed).toBe(0);
    expect(await entryCountFor(seriesId)).toBe(116);
    expect((await nextDueOf(seriesId)) > daysAgo(0)).toBe(true);
    expect((await latestBalance(accountId))?.balanceMinor).toBe(-11600);
  });
});
