import { sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { recalculateAccount } from "./balances";
import { captureDebugLog } from "../observability/debug-log";

export type BalanceRecalculationFailure = {
  accountId: string;
  error: string;
};

export type BalanceRecalculationResult = {
  recalculated: number;
  failures: BalanceRecalculationFailure[];
};

/**
 * Recalculates each given account, attempting ALL of them even when some
 * fail (one broken account must not block repairs for the rest). Per-account
 * failures are logged and REPORTED in the result — never swallowed — so the
 * caller (the maintenance:balances queue handler) can fail the job and let
 * the queue retry it instead of marking the repair complete.
 */
export async function recalculateAccounts(
  exec: Executor,
  accountIds: string[]
): Promise<BalanceRecalculationResult> {
  let recalculated = 0;
  const failures: BalanceRecalculationFailure[] = [];
  for (const id of accountIds) {
    try {
      await recalculateAccount(exec, id);
      recalculated++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push({ accountId: id, error: message });
      await captureDebugLog(exec, {
        category: "balances",
        level: "error",
        message: "Scheduled balance recalculation failed for an account",
        source: "worker",
        metadata: { accountId: id, error: message }
      });
    }
  }
  return { recalculated, failures };
}

/**
 * Recalculates every active account. Used by the nightly full rebuild and
 * by untargeted repair jobs.
 */
export async function recalculateAllActiveAccounts(
  exec: Executor
): Promise<BalanceRecalculationResult> {
  const res = await exec.execute<{ id: string }>(sql`
    SELECT CAST(id AS TEXT) AS id FROM accounts WHERE status = 'active' ORDER BY created_at
  `);
  const ids = (res.rows ?? []).map((r) => r.id);
  return recalculateAccounts(exec, ids);
}

/**
 * Recalculates only the named accounts (duplicates collapsed). Used by
 * account-targeted repair jobs — e.g. the repair intent committed by
 * recurring posting for one specific account — so a repair pass does not
 * rebuild every active account when only one needs it. Accounts outside
 * the target set are untouched.
 */
export async function recalculateTargetedAccounts(
  exec: Executor,
  accountIds: string[]
): Promise<BalanceRecalculationResult> {
  return recalculateAccounts(exec, [...new Set(accountIds)]);
}
