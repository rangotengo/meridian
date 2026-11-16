import { and, asc, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { usesCloudStorage } from "../db/dialect";
import { accounts, entries, meroShareAccounts, transactions, valuations } from "../db/schema";
import type { Actor } from "../auth/context";
import {
  canManageAccountSettings,
  getAccountAccess,
  isValuationDriven,
  isValuationTracked,
  type AccountRow,
  type BalanceTracking
} from "../authorization/access";
import { errors } from "@/lib/errors";
import { todayIn } from "@/lib/datetime";
import { recordAudit } from "../observability/audit";
import { latestBalancesFor, recalculateAccount } from "./balances";

/**
 * Per-account balance tracking for the valuation-driven types
 * (other_asset / other_liability). An account either tracks its balance
 * from valuations it records (property, investments) or from its
 * transactions (a loan that is lent and collected). Switching modes is a
 * deliberate, confirmed operation: the preview computes the exact outcome
 * first, and switching valuation → transactions converts the earliest
 * valuation into the opening transaction and removes the later ones —
 * they are balance snapshots and have no meaning as transactions.
 */

export type BalanceTrackingPreview = {
  accountId: string;
  from: BalanceTracking;
  to: BalanceTracking;
  /** Current materialized balance (ledger minor units). */
  currentBalanceMinor: number;
  /** Balance the account will show immediately after the switch. */
  resultingBalanceMinor: number;
  valuationCount: number;
  earliestValuationDate: string | null;
  meroshareLinked: boolean;
};

export type BalanceTrackingSwitchResult = {
  accountId: string;
  from: BalanceTracking;
  to: BalanceTracking;
  resultingBalanceMinor: number;
  convertedValuationDate: string | null;
  removedValuations: number;
};

function safeParseMinor(raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw errors.validation("Amount exceeds safe integer range.");
  }
  return n;
}

async function requireSwitchAccess(
  exec: Executor,
  actor: Actor,
  accountId: string
): Promise<AccountRow> {
  const access = await getAccountAccess(exec, actor, accountId);
  if (!access.granted) throw errors.notFound("Account");
  if (!canManageAccountSettings(access.level)) {
    throw errors.forbidden("Only full-control access can change balance tracking.");
  }
  if (!isValuationDriven(access.account.type)) {
    throw errors.validation(
      "Balance tracking can only be changed for other asset and other liability accounts."
    );
  }
  return access.account;
}

async function isMeroShareLinked(exec: Executor, accountId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: meroShareAccounts.id })
    .from(meroShareAccounts)
    .where(eq(meroShareAccounts.accountId, accountId))
    .limit(1);
  return !!row;
}

type ValuationEntryRow = typeof entries.$inferSelect;

async function listValuationEntries(
  exec: Executor,
  accountId: string
): Promise<ValuationEntryRow[]> {
  return exec
    .select()
    .from(entries)
    .where(and(eq(entries.accountId, accountId), eq(entries.entryableType, "valuation")))
    .orderBy(asc(entries.date), asc(entries.createdAt), asc(entries.id));
}

/**
 * The balance the engine settles on for a mode, computed with the same
 * rules recalculateAccount applies on its final day: only entries dated
 * within [openedOn, today] count, split parents are excluded (their leaf
 * children count), and a valuation sets the balance outright.
 */
async function projectedBalance(
  exec: Executor,
  account: AccountRow,
  mode: BalanceTracking,
  valuationEntries: ValuationEntryRow[]
): Promise<number> {
  const [family] = await exec
    .execute<{ timezone: string }>(
      sql`SELECT timezone FROM families WHERE id = ${account.familyId}`
    )
    .then((r) => r.rows ?? []);
  const today = todayIn(family?.timezone ?? "UTC");
  const inWindow = (date: string) => date >= account.openedOn && date <= today;

  if (mode === "valuation") {
    let balance = account.openingBalanceMinor;
    for (const entry of valuationEntries) {
      if (inWindow(entry.date)) balance = entry.amountMinor;
    }
    return balance;
  }

  const res = await exec.execute<{ sum_minor: string }>(sql`
    SELECT CAST(coalesce(sum(amount_minor), 0) AS TEXT) AS sum_minor
    FROM entries
    WHERE account_id = ${account.id}
      AND entryable_type = 'transaction'
      AND date >= ${account.openedOn}
      AND date <= ${today}
      AND NOT EXISTS (
        SELECT 1 FROM entries c WHERE c.parent_entry_id = entries.id
      )
  `);
  const txSum = safeParseMinor((res.rows ?? [])[0]?.sum_minor ?? "0");
  // The earliest valuation becomes the opening transaction on switch: its
  // stored amount flips sign, so it contributes its valuation amount.
  const earliest = valuationEntries[0];
  const converted = earliest && inWindow(earliest.date) ? earliest.amountMinor : 0;
  const result = account.openingBalanceMinor - txSum + converted;
  if (!Number.isSafeInteger(result)) {
    throw errors.validation("Calculated balance exceeds safe integer bounds.");
  }
  return result;
}

export async function previewBalanceTracking(
  exec: Executor,
  actor: Actor,
  accountId: string,
  to: BalanceTracking
): Promise<BalanceTrackingPreview> {
  const account = await requireSwitchAccess(exec, actor, accountId);
  const from: BalanceTracking = isValuationTracked(account) ? "valuation" : "transactions";
  const valuationEntries = await listValuationEntries(exec, accountId);
  const current = await latestBalancesFor(exec, [accountId]);
  const resulting =
    to === from
      ? (current.get(accountId)?.balanceMinor ?? account.openingBalanceMinor)
      : await projectedBalance(exec, account, to, valuationEntries);
  return {
    accountId,
    from,
    to,
    currentBalanceMinor: current.get(accountId)?.balanceMinor ?? account.openingBalanceMinor,
    resultingBalanceMinor: resulting,
    valuationCount: valuationEntries.length,
    earliestValuationDate: valuationEntries[0]?.date ?? null,
    meroshareLinked: await isMeroShareLinked(exec, accountId)
  };
}

export async function switchBalanceTracking(
  exec: Executor,
  actor: Actor,
  input: { accountId: string; to: BalanceTracking }
): Promise<BalanceTrackingSwitchResult> {
  return exec.transaction(async (tx) => {
    // Serialize switches per account (Postgres advisory transaction lock;
    // the cloud Durable Object executor is already serialized).
    if (!usesCloudStorage) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"balance-tracking:" + input.accountId}))`
      );
    }

    const account = await requireSwitchAccess(tx, actor, input.accountId);
    if (account.status !== "active") {
      throw errors.conflict("This account is closed and can no longer be modified.");
    }
    const from: BalanceTracking = isValuationTracked(account) ? "valuation" : "transactions";
    if (input.to === from) {
      throw errors.validation(
        from === "valuation"
          ? "This account already tracks its balance from valuations."
          : "This account already tracks its balance from transactions."
      );
    }
    if (input.to === "transactions" && (await isMeroShareLinked(tx, account.id))) {
      throw errors.conflict(
        "This account is linked to MeroShare, which controls its balance through valuations. Disconnect MeroShare before switching it to transaction tracking."
      );
    }

    let convertedValuationDate: string | null = null;
    let removedValuations = 0;

    if (from === "valuation" && input.to === "transactions") {
      const valuationEntries = await listValuationEntries(tx, account.id);
      const [earliest, ...later] = valuationEntries;
      if (earliest) {
        convertedValuationDate = earliest.date;
        // Convert in place: the entry keeps its date and name, its amount
        // flips from "the balance on that date" to the ledger transaction
        // that produces that balance (ledger amounts are outflow-positive,
        // so the opening transaction stores the negated valuation amount),
        // and its detail row moves from valuations to transactions.
        await tx.delete(valuations).where(eq(valuations.entryId, earliest.id));
        await tx
          .update(entries)
          .set({ entryableType: "transaction", amountMinor: -earliest.amountMinor })
          .where(eq(entries.id, earliest.id));
        await tx.insert(transactions).values({ entryId: earliest.id });
      }
      for (const entry of later) {
        // The valuations detail row is removed by the entries FK cascade.
        await tx.delete(entries).where(eq(entries.id, entry.id));
        removedValuations += 1;
      }
    }

    await tx
      .update(accounts)
      .set({ balanceTracking: input.to, updatedAt: new Date() })
      .where(eq(accounts.id, account.id));

    await recalculateAccount(tx, account.id);
    const balances = await latestBalancesFor(tx, [account.id]);
    const resultingBalanceMinor =
      balances.get(account.id)?.balanceMinor ?? account.openingBalanceMinor;

    await recordAudit(tx, {
      familyId: actor.familyId,
      actorUserId: actor.userId,
      action: "account.balance_tracking_changed",
      entityType: "account",
      entityId: account.id,
      metadata: {
        from,
        to: input.to,
        convertedValuationDate,
        removedValuations,
        resultingBalanceMinor
      }
    });

    return {
      accountId: account.id,
      from,
      to: input.to,
      resultingBalanceMinor,
      convertedValuationDate,
      removedValuations
    };
  });
}
