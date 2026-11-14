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
 * Recalculates every active account, attempting ALL accounts even when some
 * fail (one broken account must not block repairs for the rest). Per-account
 * failures are logged and REPORTED in the result — never swallowed — so the
 * caller (the maintenance:balances queue handler) can fail the job and let
 * the queue retry it instead of marking the repair complete.
 */
export async function recalculateAllActiveAccounts(
  exec: Executor
): Promise<BalanceRecalculationResult> {
  const res = await exec.execute<{ id: string }>(sql`
    SELECT CAST(id AS TEXT) AS id FROM accounts WHERE status = 'active' ORDER BY created_at
  `);
  const ids = (res.rows ?? []).map((r) => r.id);
  let recalculated = 0;
  const failures: BalanceRecalculationFailure[] = [];
  for (const id of ids) {
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
