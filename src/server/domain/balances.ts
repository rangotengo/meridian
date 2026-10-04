import { sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { chunkParams, chunkRows } from "../db/params";
import { balances as balancesTable } from "../db/schema";
import { isValuationDriven } from "../authorization/access";
import { addDays, diffDays, isIsoDate, minDate, todayIn } from "@/lib/datetime";
import { errors } from "@/lib/errors";

function safeParseMinor(raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw errors.validation("Amount exceeds safe integer range.");
  }
  return n;
}

function safeSubtract(a: number, b: number): number {
  const res = a - b;
  if (!Number.isSafeInteger(res)) {
    throw errors.validation("Calculated balance exceeds safe integer bounds.");
  }
  return res;
}

type AccountMeta = {
  id: string;
  currency: string;
  type: string;
  openingBalanceMinor: number;
  openedOn: string;
  timezone: string;
};

async function loadAccountMeta(exec: Executor, accountId: string): Promise<AccountMeta | null> {
  const res = await exec.execute<AccountMeta>(sql`
    SELECT CAST(a.id AS TEXT) AS id, a.currency, a.type,
           CAST(a.opening_balance_minor AS TEXT) AS opening_balance_minor,
           CAST(a.opened_on AS TEXT) AS opened_on,
           f.timezone
    FROM accounts a
    JOIN families f ON f.id = a.family_id
    WHERE a.id = ${accountId}
  `);
  const row = (res.rows ?? [])[0] as
    | {
        id: string;
        currency: string;
        type: string;
        opening_balance_minor: string;
        opened_on: string;
        timezone: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    currency: row.currency,
    type: row.type,
    openingBalanceMinor: safeParseMinor(row.opening_balance_minor),
    openedOn: row.opened_on.slice(0, 10),
    timezone: row.timezone
  };
}

export async function recalculateAccount(
  exec: Executor,
  accountId: string,
  fromDate?: string
): Promise<void> {
  const meta = await loadAccountMeta(exec, accountId);
  if (!meta) return;

  const today = todayIn(meta.timezone);

  let start = meta.openedOn;
  if (fromDate && isIsoDate(fromDate)) {
    start = minDate(meta.openedOn, fromDate);
  }

  const dayCount = Math.max(1, diffDays(today, start) + 1);

  // F04: Allow up to 36,500 days (100 years of ledger history), but fail visibly if exceeded
  const MAX_SUPPORTED_DAYS = 36500;
  if (dayCount > MAX_SUPPORTED_DAYS) {
    throw errors.validation(
      `Account history span of ${dayCount} days exceeds the maximum supported limit (${MAX_SUPPORTED_DAYS} days).`
    );
  }

  const eventsByDate = new Map<string, number>();

  if (isValuationDriven(meta.type)) {
    const res = await exec.execute<{ date: string; amount_minor: string }>(sql`
      SELECT CAST(date AS TEXT) AS date, CAST(amount_minor AS TEXT) AS amount_minor
      FROM entries
      WHERE account_id = ${accountId}
        AND entryable_type = 'valuation'
      ORDER BY date ASC, created_at ASC
    `);
    for (const r of res.rows ?? []) {
      eventsByDate.set(r.date.slice(0, 10), safeParseMinor(r.amount_minor));
    }
  } else {
    const res = await exec.execute<{ date: string; sum_minor: string }>(sql`
      SELECT CAST(date AS TEXT) AS date, CAST(coalesce(sum(amount_minor), 0) AS TEXT) AS sum_minor
      FROM entries
      WHERE account_id = ${accountId}
        AND entryable_type = 'transaction'
        AND NOT EXISTS (
          SELECT 1 FROM entries c WHERE c.parent_entry_id = entries.id
        )
      GROUP BY date
      ORDER BY date ASC
    `);
    for (const r of res.rows ?? []) {
      eventsByDate.set(r.date.slice(0, 10), safeParseMinor(r.sum_minor));
    }
  }

  let baseline = meta.openingBalanceMinor;
  if (start > meta.openedOn) {
    const [prev] = await exec
      .select({ balanceMinor: balancesTable.balanceMinor })
      .from(balancesTable)
      .where(sql`${balancesTable.accountId} = ${accountId} AND ${balancesTable.asOf} < ${start}`)
      .orderBy(sql`${balancesTable.asOf} DESC`)
      .limit(1);
    if (prev) baseline = safeParseMinor(prev.balanceMinor);
  }

  const rows: { accountId: string; asOf: string; balanceMinor: number; currency: string }[] = [];
  let displayBalance = baseline;
  if (isValuationDriven(meta.type)) displayBalance = meta.openingBalanceMinor;

  let cursor = start;
  while (cursor <= today) {
    if (isValuationDriven(meta.type)) {
      const event = eventsByDate.get(cursor);
      if (event !== undefined) displayBalance = event;
    } else {
      const delta = eventsByDate.get(cursor);
      if (delta !== undefined) displayBalance = safeSubtract(displayBalance, delta);
    }
    rows.push({ accountId, asOf: cursor, balanceMinor: displayBalance, currency: meta.currency });
    cursor = addDays(cursor, 1);
  }

  await exec.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM balances WHERE account_id = ${accountId} AND as_of >= ${start}`
    );
    // Cloudflare SQLite caps one statement at 100 bound parameters, so chunk
    // by the 4 balance columns (25 rows per statement on the cloud backend).
    for (const chunk of chunkRows(rows, 4)) {
      await tx.insert(balancesTable).values(
        chunk.map((r) => ({
          accountId: r.accountId,
          asOf: r.asOf,
          balanceMinor: r.balanceMinor,
          currency: r.currency
        }))
      );
    }
  });
}

export async function latestBalancesFor(
  exec: Executor,
  accountIds: string[]
): Promise<Map<string, { balanceMinor: number; asOf: string; currency: string }>> {
  const result = new Map<string, { balanceMinor: number; asOf: string; currency: string }>();
  if (!accountIds.length) return result;
  // Chunk the IN(...) list: cloud SQLite caps a statement at 100 parameters.
  for (const idChunk of chunkParams(accountIds)) {
    const res = await exec.execute<{
      account_id: string;
      balance_minor: string;
      as_of: string;
      currency: string;
    }>(sql`
      SELECT
        CAST(account_id AS TEXT) AS account_id,
        CAST(balance_minor AS TEXT) AS balance_minor,
        CAST(as_of AS TEXT) AS as_of,
        currency
      FROM balances b
      WHERE as_of = (SELECT max(latest.as_of) FROM balances latest WHERE latest.account_id = b.account_id)
      AND account_id IN (${sql.join(
        idChunk.map((id) => sql`${id}`),
        sql`, `
      )})
      ORDER BY account_id, as_of DESC
    `);
    for (const r of res.rows ?? []) {
      result.set(r.account_id, {
        balanceMinor: safeParseMinor(r.balance_minor),
        asOf: r.as_of.slice(0, 10),
        currency: r.currency
      });
    }
  }
  return result;
}
