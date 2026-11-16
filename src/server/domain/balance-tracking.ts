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
import { accountHasHoldings, lockHoldingsAccount } from "./holdings";

/**
 * Per-account balance tracking for the valuation-driven types
 * (other_asset / other_liability). An account either tracks its balance
 * from valuations it records (property, investments) or from its
 * transactions (a loan that is lent and collected). Switching modes is a
 * deliberate, confirmed operation: the preview computes the exact outcome
 * first with the same plan the switch executes, and switching
 * valuation → transactions converts the earliest valuation into the
 * opening transaction and removes the later ones — they are balance
 * snapshots and have no meaning as transactions.
 *
 * The conversion is a NORMALIZED anchor, not a raw sign flip. A valuation
 * states the account's whole balance on its date, so the converted entry
 * carries the reconciliation plug: the amount that makes the opening
 * balance plus every transaction dated up to the anchor date add up to
 * exactly the valuation. Anything the history already represents of that
 * value — a nonzero opening balance, pre-anchor transactions, or an
 * earlier switch's opening adjustment (recognized by its durable source
 * marker, wherever it is dated) — is therefore never counted twice, and
 * repeated mode round trips are stable. Transactions dated after the
 * anchor keep their full effect, which is what makes the motivating loan
 * shape work: principal valuation + later lend/repay activity lands on
 * principal + activity, not on the stale latest snapshot.
 *
 * Concurrency: the switch takes the SAME per-account advisory lock as
 * the holdings and valuation writers (holdings-account:<id>, see
 * holdings.ts), and resolves every guard — access, open state, mode,
 * MeroShare link, holdings — after the lock is held. Those writers
 * re-resolve the same state inside the lock before mutating, so a switch
 * and a writer queued behind each other can never both act on pre-switch
 * state. On the cloud backend the Durable Object executor serializes the
 * whole transaction, which provides the same guarantee.
 */

/**
 * entries.external_source value marking the opening transaction a switch
 * creates from the earliest valuation. It is the entry's durable
 * classification: report flow queries exclude it (it is a balance-only
 * opening adjustment, not income or spending — see reports.ts), and a
 * later conversion recognizes it as already-represented principal so a
 * round trip never counts the same principal twice. Household exports
 * carry external_source verbatim, so the classification survives a
 * household restore; operator backups copy raw rows, so it survives
 * those too.
 */
export const BALANCE_TRACKING_OPENING_SOURCE = "balance_tracking";

export type BalanceTrackingPreview = {
  accountId: string;
  from: BalanceTracking;
  to: BalanceTracking;
  /** Current materialized balance (ledger minor units). */
  currentBalanceMinor: number;
  /** Balance the account will show immediately after the switch. */
  resultingBalanceMinor: number;
  /**
   * The amount_minor the converted opening transaction will carry
   * (ledger convention, outflow-positive; its balance contribution is
   * the negation), or null when switching to valuations or when there
   * is no valuation to convert. This is the normalized reconciliation
   * plug, not the raw negated valuation: it is reduced by whatever the
   * opening balance and earlier history already represent.
   */
  openingTransactionAmountMinor: number | null;
  valuationCount: number;
  earliestValuationDate: string | null;
  meroshareLinked: boolean;
  /** True while manual portfolio holdings manage this account's value. */
  holdingsManaged: boolean;
};

export type BalanceTrackingSwitchResult = {
  accountId: string;
  from: BalanceTracking;
  to: BalanceTracking;
  resultingBalanceMinor: number;
  convertedValuationDate: string | null;
  /** The amount_minor the converted opening transaction carries. */
  openingTransactionAmountMinor: number | null;
  removedValuations: number;
};

function safeParseMinor(raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw errors.validation("Amount exceeds safe integer range.");
  }
  return n;
}

function safeAdd(a: number, b: number): number {
  const res = a + b;
  if (!Number.isSafeInteger(res)) {
    throw errors.validation("Calculated balance exceeds safe integer bounds.");
  }
  return res;
}

function safeSubtract(a: number, b: number): number {
  return safeAdd(a, -b);
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
  // Match the balance engine, including exact timestamp ties restored
  // from bulk history. UUID order is unrelated to valuation precedence.
  return exec
    .select()
    .from(entries)
    .where(and(eq(entries.accountId, accountId), eq(entries.entryableType, "valuation")))
    .orderBy(
      asc(entries.date),
      asc(entries.createdAt),
      usesCloudStorage ? sql`"entries"."rowid" ASC` : asc(entries.writeSeq)
    );
}

async function familyToday(exec: Executor, familyId: string): Promise<string> {
  const [family] = await exec
    .execute<{ timezone: string }>(sql`SELECT timezone FROM families WHERE id = ${familyId}`)
    .then((r) => r.rows ?? []);
  return todayIn(family?.timezone ?? "UTC");
}

/**
 * The balance the engine settles on in valuation mode: the opening
 * balance, overridden by each in-window valuation in write order. Only
 * entries dated within [openedOn, today] count.
 */
async function projectedValuationBalance(
  exec: Executor,
  account: AccountRow,
  valuationEntries: ValuationEntryRow[]
): Promise<number> {
  const today = await familyToday(exec, account.familyId);
  const inWindow = (date: string) => date >= account.openedOn && date <= today;
  let balance = account.openingBalanceMinor;
  for (const entry of valuationEntries) {
    if (inWindow(entry.date)) balance = entry.amountMinor;
  }
  return balance;
}

export type ConversionPlan = {
  /** The valuation entry that becomes the opening transaction, if any. */
  anchor: ValuationEntryRow | null;
  /**
   * The amount_minor the converted entry will carry: the reconciliation
   * plug that makes the transaction-mode balance ON the anchor date
   * equal the anchor valuation exactly. Null when there is no valuation
   * to convert.
   */
  openingTransactionAmountMinor: number | null;
  /** Balance immediately after the switch, under engine window rules. */
  resultingBalanceMinor: number;
};

/**
 * The single normalized plan for a valuation → transactions switch. The
 * preview and the switch both execute this, so the number the user
 * confirms is the number the switch produces.
 *
 * The anchor valuation is an absolute balance at its date, so the plug
 * is: opening balance − (transactions already representing that value)
 * − the valuation amount. "Already representing" is every in-window
 * transaction dated on or before the anchor date, plus any earlier
 * conversion's opening adjustment (source-marked) wherever it is dated —
 * its principal is already in the ledger and must not be counted again
 * when a later valuation is converted on a round trip. Transactions
 * dated after the anchor are untouched and keep their full effect.
 */
async function planConversionToTransactions(
  exec: Executor,
  account: AccountRow,
  valuationEntries: ValuationEntryRow[]
): Promise<ConversionPlan> {
  const today = await familyToday(exec, account.familyId);
  const inWindow = (date: string) => date >= account.openedOn && date <= today;

  const res = await exec.execute<{
    date: string;
    amount_minor: string;
    external_source: string | null;
  }>(sql`
    SELECT CAST(date AS TEXT) AS date, CAST(amount_minor AS TEXT) AS amount_minor, external_source
    FROM entries
    WHERE account_id = ${account.id}
      AND entryable_type = 'transaction'
      AND date >= ${account.openedOn}
      AND date <= ${today}
      AND NOT EXISTS (
        SELECT 1 FROM entries c WHERE c.parent_entry_id = entries.id
      )
  `);
  const txRows = (res.rows ?? []).map((r) => ({
    date: r.date.slice(0, 10),
    amountMinor: safeParseMinor(r.amount_minor),
    openingAdjustment: r.external_source === BALANCE_TRACKING_OPENING_SOURCE
  }));
  let totalTx = 0;
  for (const row of txRows) totalTx = safeAdd(totalTx, row.amountMinor);

  const anchor = valuationEntries[0] ?? null;
  if (!anchor) {
    return {
      anchor: null,
      openingTransactionAmountMinor: null,
      resultingBalanceMinor: safeSubtract(account.openingBalanceMinor, totalTx)
    };
  }

  let represented = 0;
  for (const row of txRows) {
    if (row.date <= anchor.date || row.openingAdjustment) {
      represented = safeAdd(represented, row.amountMinor);
    }
  }
  const plug = safeSubtract(
    safeSubtract(account.openingBalanceMinor, represented),
    anchor.amountMinor
  );
  // The converted entry sits on the anchor date, so it contributes to
  // today's balance only when that date is inside the engine window —
  // exactly how recalculateAccount will treat it after the switch.
  const resulting = inWindow(anchor.date)
    ? safeSubtract(safeSubtract(account.openingBalanceMinor, totalTx), plug)
    : safeSubtract(account.openingBalanceMinor, totalTx);
  return { anchor, openingTransactionAmountMinor: plug, resultingBalanceMinor: resulting };
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
  const currentBalanceMinor = current.get(accountId)?.balanceMinor ?? account.openingBalanceMinor;
  let resulting = currentBalanceMinor;
  let openingTransactionAmountMinor: number | null = null;
  if (to !== from) {
    if (to === "transactions") {
      const plan = await planConversionToTransactions(exec, account, valuationEntries);
      resulting = plan.resultingBalanceMinor;
      openingTransactionAmountMinor = plan.openingTransactionAmountMinor;
    } else {
      resulting = await projectedValuationBalance(exec, account, valuationEntries);
    }
  }
  return {
    accountId,
    from,
    to,
    currentBalanceMinor,
    resultingBalanceMinor: resulting,
    openingTransactionAmountMinor,
    valuationCount: valuationEntries.length,
    earliestValuationDate: valuationEntries[0]?.date ?? null,
    meroshareLinked: await isMeroShareLinked(exec, accountId),
    holdingsManaged: await accountHasHoldings(exec, accountId)
  };
}

export async function switchBalanceTracking(
  exec: Executor,
  actor: Actor,
  input: { accountId: string; to: BalanceTracking }
): Promise<BalanceTrackingSwitchResult> {
  return exec.transaction(async (tx) => {
    // Serialize against every other writer of this account's balance
    // under the shared per-account protocol: the switch takes the same
    // advisory lock as the holdings and valuation writers (see
    // holdings.ts), and every guard below is resolved after the lock is
    // held. On the cloud backend the lock call is a no-op and the
    // Durable Object executor serializes the whole transaction instead.
    await lockHoldingsAccount(tx, input.accountId);

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
    if (input.to === "transactions" && (await accountHasHoldings(tx, account.id))) {
      throw errors.conflict(
        "This account's value is managed by its portfolio holdings, which publish its balance as a valuation. Remove all holdings before switching it to transaction tracking."
      );
    }

    let convertedValuationDate: string | null = null;
    let openingTransactionAmountMinor: number | null = null;
    let removedValuations = 0;

    if (from === "valuation" && input.to === "transactions") {
      const valuationEntries = await listValuationEntries(tx, account.id);
      // The switch executes exactly the plan the preview showed.
      const plan = await planConversionToTransactions(tx, account, valuationEntries);
      const [earliest, ...later] = valuationEntries;
      if (earliest) {
        convertedValuationDate = earliest.date;
        openingTransactionAmountMinor = plan.openingTransactionAmountMinor;
        // Convert in place: the entry keeps its date and name, but its
        // amount becomes the plan's reconciliation plug — the amount
        // that makes the opening balance and the transactions up to
        // that date add up to the valuation's absolute balance — and
        // its detail row moves from valuations to transactions. The
        // source marker classifies it durably as a balance-only opening
        // adjustment (report flows exclude it; a later conversion
        // recognizes its principal as already represented), and any
        // source identity the valuation carried is dropped so no sync
        // can mistake it for its own entry later.
        await tx.delete(valuations).where(eq(valuations.entryId, earliest.id));
        await tx
          .update(entries)
          .set({
            entryableType: "transaction",
            amountMinor: plan.openingTransactionAmountMinor!,
            externalSource: BALANCE_TRACKING_OPENING_SOURCE,
            externalId: null
          })
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
        openingTransactionAmountMinor,
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
      openingTransactionAmountMinor,
      removedValuations
    };
  });
}
