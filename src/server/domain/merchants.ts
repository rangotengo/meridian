import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { Executor } from "../db/client";
import { accounts, entries, transactions } from "../db/schema";

/**
 * Distinct merchants (the payee name on a transaction) for a family, most
 * recently used first. Reads the most recent rows and dedupes in code so
 * the query stays a plain select/join/orderBy/limit on both backends.
 */
export async function listRecentMerchants(
  exec: Executor,
  familyId: string,
  limit = 50
): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await exec
    .select({ merchant: transactions.merchant, date: entries.date })
    .from(transactions)
    .innerJoin(entries, eq(transactions.entryId, entries.id))
    .innerJoin(accounts, eq(entries.accountId, accounts.id))
    .where(
      and(
        eq(accounts.familyId, familyId),
        isNotNull(transactions.merchant),
        ne(transactions.merchant, "")
      )
    )
    .orderBy(desc(entries.date))
    .limit(500);
  const seen = new Set<string>();
  const merchants: string[] = [];
  for (const row of rows) {
    const merchant = row.merchant?.trim();
    if (!merchant || seen.has(merchant)) continue;
    seen.add(merchant);
    merchants.push(merchant);
    if (merchants.length >= limit) break;
  }
  return merchants;
}
