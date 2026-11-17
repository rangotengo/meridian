import { and, desc, eq, isNotNull, max, ne, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { accounts, entries, transactions } from "../db/schema";
import type { Actor } from "../auth/context";

/**
 * Distinct merchants (the payee name on a transaction) the actor can see,
 * most recently used first, across the actor's full visible history.
 *
 * Visibility matches listEntriesPage: an account's merchants are visible
 * only when the account is joint (owner_id null), owned by the actor, or
 * shared with them. Merchants from another member's unshared accounts
 * never reach the client — the layout sends this list to every family
 * member, so the predicate has to live here, not in the caller.
 *
 * Merchants are grouped by name over the full history (no recent-row
 * window), so a payee that has not been used lately stays searchable in
 * the command palette. The palette caps rendered rows at 12 after
 * filtering instead of slicing before it.
 */
export async function listRecentMerchants(
  exec: Executor,
  actor: Actor,
  limit?: number
): Promise<string[]> {
  if (limit !== undefined && limit <= 0) return [];
  const rows = await exec
    .select({ merchant: transactions.merchant, lastUsed: max(entries.date) })
    .from(transactions)
    .innerJoin(entries, eq(transactions.entryId, entries.id))
    .innerJoin(accounts, eq(entries.accountId, accounts.id))
    .where(
      and(
        eq(accounts.familyId, actor.familyId),
        isNotNull(transactions.merchant),
        ne(transactions.merchant, ""),
        sql`(
          accounts.owner_id IS NULL
          OR accounts.owner_id = ${actor.userId}
          OR EXISTS (
            SELECT 1 FROM account_shares s
            WHERE s.account_id = accounts.id AND s.user_id = ${actor.userId}
          )
        )`
      )
    )
    .groupBy(transactions.merchant)
    .orderBy(desc(max(entries.date)));
  const seen = new Set<string>();
  const merchants: string[] = [];
  for (const row of rows) {
    const merchant = row.merchant?.trim();
    if (!merchant || seen.has(merchant)) continue;
    seen.add(merchant);
    merchants.push(merchant);
    if (limit !== undefined && merchants.length >= limit) break;
  }
  return merchants;
}
