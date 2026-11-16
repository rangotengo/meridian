import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { statementTimestamp, usesCloudStorage } from "../db/dialect";
import {
  accounts,
  entries,
  families,
  meroShareAccounts,
  portfolioHoldings,
  valuations
} from "../db/schema";
import type { Actor } from "../auth/context";
import {
  assertAccountAccessLevel,
  assertAccountOpen,
  isValuationTracked
} from "../authorization/access";
import { errors } from "@/lib/errors";
import { displayToLedgerBalance } from "@/lib/money";
import { todayIn } from "@/lib/datetime";
import { recordAudit } from "../observability/audit";
import { recalculateAccount } from "./balances";

/**
 * Manual portfolio holdings: user-entered stock positions on other_asset
 * (valuation-driven) accounts, for portfolios that can never arrive via a
 * MeroShare sync — a demat held with another DP, or one tracked on someone
 * else's behalf.
 *
 * Balance integration mirrors how MeroShare portfolios integrate: while an
 * account has at least one holding, its value is holdings-managed. Every
 * mutation recomputes the portfolio total and writes a valuation entry for
 * today (externalSource "holdings", one per day), then recalculates
 * balances — so the account balance always equals the sum of its holdings.
 * Manual valuations are rejected by the valuations domain while holdings
 * exist (see valuations.ts), and an account with an active MeroShare link
 * is rejected here: exactly one controller manages an account's value.
 *
 * Concurrency: every writer for an account — holdings CRUD, buy/sell, CSV
 * import, and the valuations domain paths that interact with holdings
 * mode — runs inside withHoldingsAccountLock, which takes a
 * transaction-scoped advisory lock keyed by the account BEFORE any
 * position is read or total computed, and holds it through the position
 * write, the daily-valuation write, and recalculation. The
 * balance-tracking switch takes the SAME lock (see balance-tracking.ts):
 * it is one of the account's balance-controller writers. Because the
 * guard checks that authorize a mutation (access, open state, tracking
 * mode, controller) run before a caller queues on the lock, every writer
 * RE-RESOLVES them inside the lock against fresh reads before mutating —
 * a switch that committed while this writer waited must be seen, never
 * overwritten from a stale snapshot. Positions are read
 * under READ COMMITTED statement snapshots, so without the lock two
 * writers can each read pre-mutation state and silently lose each other's
 * changes. On the cloud backend the Durable Object executor serializes
 * access behind its mutex and a transaction holds it across awaits, so
 * the same transaction discipline is correct there and the advisory lock
 * is a no-op. Operations touch a single account, so there is no lock
 * ordering to violate.
 *
 * Same-day valuation precedence: balances resolve competing valuations
 * for one date by write order — (date, created_at, insertion order) —
 * the latest write wins. Two properties make "latest" mean the actual
 * last writer rather than an accident of timing. First, every valuation
 * writer (this sync, recordValuation, the MeroShare sync) stamps
 * created_at EXPLICITLY at statement-execution time (see
 * statementTimestamp in db/dialect): the column default is the
 * transaction's start time, so a writer whose transaction began before
 * it acquired the account lock would otherwise be stamped earlier than
 * a competitor that committed in the meantime, and lose despite writing
 * last. Second, the balance engine breaks exact timestamp ties by a
 * monotonic insertion-order key (a sequence on PostgreSQL, rowid on
 * SQLite), allocated when each INSERT executes — under the lock, that
 * is lock order. The holdings sync also REPLACES its daily entry
 * instead of updating it in place, so (re)activation of holdings
 * management — including the zero-value write when the last holding is
 * removed — always outranks manual entries written earlier that day,
 * and a manual valuation recorded while holdings are inactive (a fresh
 * insert) equally outranks a stale holdings entry. Valuation history
 * before today is never touched. A manual valuation dated in the
 * FUTURE is the one case ordering cannot settle (it would silently
 * take over when its date arrives), so entering holdings management
 * while one exists is rejected until it is removed or re-dated.
 *
 * Cost provenance: averageCostMinor is a per-share average that applies
 * to averageCostQuantity shares of the position, not necessarily all of
 * them. Shares acquired without a recorded cost (a buy into a position
 * whose cost was unknown) grow only the known portion; summaries cost
 * and gain only the known portion and report the position as partial
 * until the user explicitly supplies a whole-position cost (a CSV cost,
 * or an edit that asserts the cost covers all shares — a plain edit
 * never promotes a partial cost on its own).
 *
 * Priceability: a position's value may only be stated without inventing
 * numbers when it has a current price, or an average cost covering the
 * FULL quantity (the fallback values every share at that cost). A
 * partial average is never extrapolated across shares it does not
 * cover, and a position with neither price has no value at all. Every
 * mutation validates the priceability of the account's resulting
 * positions centrally in syncPortfolioValuation before a valuation is
 * published, so no path — including a trade against a legacy restored
 * position that was never priced — can publish a fabricated value.
 * Positions that are not priceable can still exist (a restore keeps
 * them); read paths exclude them from totals and flag the value as
 * incomplete instead of writing anything.
 *
 * All quantity math is exact: quantities are decimal strings with up to 6
 * decimal places, scaled to integers (×10^6) and multiplied with BigInt, so
 * no float ever touches a share count or a money value.
 */

export type PortfolioHoldingRow = typeof portfolioHoldings.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;

export const HOLDINGS_VALUATION_NAME = "Portfolio valuation";
const HOLDINGS_SOURCE = "holdings";
const QUANTITY_SCALE = 6;
const QUANTITY_FACTOR = 10n ** BigInt(QUANTITY_SCALE);

/** Normalize a ticker for storage and lookup: trimmed and upper-cased. */
export function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase();
}

export function assertValidTicker(ticker: string): void {
  if (!ticker) throw errors.validation("Enter a ticker symbol.");
  if (ticker.length > 32) throw errors.validation("Ticker symbols are at most 32 characters.");
  if (/\s/.test(ticker)) throw errors.validation("Ticker symbols cannot contain spaces.");
}

/**
 * Parse a quantity decimal string into its scaled integer form (×10^6).
 * Accepts commas as group separators; rejects signs, exponents, and more
 * than 6 decimal places. Returns the scaled value and the canonical string
 * form (no group separators, no trailing fraction zeros).
 */
export function parseQuantity(raw: string): { scaled: bigint; normalized: string } {
  const cleaned = String(raw ?? "")
    .replace(/,/g, "")
    .trim();
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) {
    throw errors.validation(`"${raw}" is not a valid quantity.`);
  }
  const [wholePart, fracPart = ""] = cleaned.split(".");
  if (fracPart.length > QUANTITY_SCALE) {
    throw errors.validation(
      `Quantities support at most ${QUANTITY_SCALE} decimal places; "${raw}" has more.`
    );
  }
  const whole = BigInt(wholePart || "0");
  const frac = BigInt((fracPart + "0".repeat(QUANTITY_SCALE)).slice(0, QUANTITY_SCALE));
  const scaled = whole * QUANTITY_FACTOR + frac;
  return { scaled, normalized: formatQuantity(scaled) };
}

/** Canonical decimal-string form of a scaled quantity. */
export function formatQuantity(scaled: bigint): string {
  const whole = scaled / QUANTITY_FACTOR;
  const frac = scaled % QUANTITY_FACTOR;
  if (frac === 0n) return whole.toString();
  const fracText = frac.toString().padStart(QUANTITY_SCALE, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracText}`;
}

function assertPriceMinor(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw errors.validation(`${field} must be a non-negative amount.`);
  }
  return value;
}

/** The price-bearing shape of a position, stored or about to be written. */
export type PositionPricing = {
  ticker: string;
  quantity: string;
  averageCostMinor: number | null;
  averageCostQuantity: string;
  currentPriceMinor: number | null;
};

/**
 * A position is PRICEABLE when its value can be stated without inventing
 * numbers: it has a current price, or an average cost that covers the
 * FULL quantity (the value fallback then prices every share at that
 * cost). A partial average must never be extrapolated across the shares
 * it does not cover, and a position with neither price has no value at
 * all. An explicit price of 0 is a real price — only absence, or partial
 * coverage without a current price, makes a position unpriceable.
 */
export function isPositionPriceable(row: PositionPricing): boolean {
  if (row.currentPriceMinor !== null) return true;
  if (row.averageCostMinor === null) return false;
  return knownCostScaled(row) >= parseQuantity(row.quantity).scaled;
}

function assertPositionPriceable(row: PositionPricing): void {
  if (isPositionPriceable(row)) return;
  throw errors.validation(
    `${row.ticker} has no usable price: set a current price, or supply an average cost that covers all ${row.quantity} shares. The portfolio value is only updated when every holding is priced.`
  );
}

/** Σ quantity × price over rows, in minor units, rounded per holding. */
export function holdingValueMinor(quantityScaled: bigint, priceMinor: number): number {
  const product = quantityScaled * BigInt(priceMinor);
  // Round half up to the nearest minor unit (all values are non-negative).
  const rounded = (product + QUANTITY_FACTOR / 2n) / QUANTITY_FACTOR;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw errors.validation("Holding value exceeds the supported range.");
  }
  return Number(rounded);
}

/**
 * The scaled quantity that the row's average cost is known for: zero when
 * the cost itself is unknown, otherwise the recorded cost quantity clamped
 * to the position size.
 */
export function knownCostScaled(row: {
  quantity: string;
  averageCostMinor: number | null;
  averageCostQuantity: string;
}): bigint {
  if (row.averageCostMinor === null) return 0n;
  const { scaled } = parseQuantity(row.quantity);
  const known = parseQuantity(row.averageCostQuantity).scaled;
  return known > scaled ? scaled : known;
}

export type HoldingsSummary = {
  totalValueMinor: number;
  /** Σ known-cost quantity × average cost; null when no cost is known at all. */
  totalCostMinor: number | null;
  /** True when part of any position has no known cost, so the cost total is partial. */
  partialCost: boolean;
  /**
   * False when at least one position is not priceable (see
   * isPositionPriceable): totalValueMinor then covers only the priced
   * positions and must be presented as incomplete, never as the
   * portfolio's full value.
   */
  valueComplete: boolean;
  /** Gain over the cost-known portions only; null when no cost is known. */
  unrealizedGainMinor: number | null;
  unrealizedGainPercent: number | null;
};

export function summarizeHoldings(rows: PortfolioHoldingRow[]): HoldingsSummary {
  let totalValueMinor = 0;
  let totalCostMinor: number | null = null;
  let coveredValueMinor = 0;
  let partialCost = false;
  let valueComplete = true;
  for (const row of rows) {
    const { scaled } = parseQuantity(row.quantity);
    const known = knownCostScaled(row);
    if (scaled > 0n && known < scaled) partialCost = true;
    if (isPositionPriceable(row)) {
      // Priceable guarantees one of the two prices exists; the average
      // is only used when it covers the full quantity.
      const unitPrice = row.currentPriceMinor ?? row.averageCostMinor ?? 0;
      totalValueMinor += holdingValueMinor(scaled, unitPrice);
    } else {
      // No honest value exists for this position (reachable via legacy
      // restored data): contribute nothing and flag the total.
      valueComplete = false;
    }
    if (row.averageCostMinor === null || known === 0n) continue;
    totalCostMinor = (totalCostMinor ?? 0) + holdingValueMinor(known, row.averageCostMinor);
    coveredValueMinor += holdingValueMinor(known, row.currentPriceMinor ?? row.averageCostMinor);
  }
  const unrealizedGainMinor = totalCostMinor === null ? null : coveredValueMinor - totalCostMinor;
  const unrealizedGainPercent =
    unrealizedGainMinor === null || totalCostMinor === null || totalCostMinor === 0
      ? null
      : (unrealizedGainMinor / totalCostMinor) * 100;
  return {
    totalValueMinor,
    totalCostMinor,
    partialCost,
    valueComplete,
    unrealizedGainMinor,
    unrealizedGainPercent
  };
}

export async function countHoldings(exec: Executor, accountId: string): Promise<number> {
  const rows = await exec
    .select({ id: portfolioHoldings.id })
    .from(portfolioHoldings)
    .where(eq(portfolioHoldings.accountId, accountId));
  return rows.length;
}

export async function accountHasHoldings(exec: Executor, accountId: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: portfolioHoldings.id })
    .from(portfolioHoldings)
    .where(eq(portfolioHoldings.accountId, accountId))
    .limit(1);
  return row !== undefined;
}

/**
 * True while a MeroShare connection actively manages this account (a
 * mero_share_accounts link exists). Disconnecting deletes the link, so a
 * formerly linked account returns false and accepts manual holdings.
 */
export async function accountHasActiveMeroShareLink(
  exec: Executor,
  accountId: string
): Promise<boolean> {
  const [row] = await exec
    .select({ id: meroShareAccounts.id })
    .from(meroShareAccounts)
    .where(eq(meroShareAccounts.accountId, accountId))
    .limit(1);
  return row !== undefined;
}

/**
 * Takes the per-account holdings advisory lock (Postgres). Must be called
 * inside a transaction; the lock is held until that transaction ends. On
 * the cloud backend the Durable Object executor serializes writers, so
 * this is a no-op and the surrounding transaction provides the guarantee.
 */
export async function lockHoldingsAccount(tx: Executor, accountId: string): Promise<void> {
  if (usesCloudStorage) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"holdings-account:" + accountId}))`);
}

/**
 * Runs `fn` in a transaction that first takes the account's holdings lock,
 * so every read of positions and every computed total inside `fn` is
 * serialized against all other writers for the account.
 */
export async function withHoldingsAccountLock<T>(
  exec: Executor,
  accountId: string,
  fn: (tx: Executor) => Promise<T>
): Promise<T> {
  return exec.transaction(async (tx) => {
    await lockHoldingsAccount(tx, accountId);
    return fn(tx);
  });
}

/**
 * Entering holdings management is refused while a manual (non-holdings)
 * valuation is dated in the future: same-day precedence is resolved by
 * write order, but a future entry would silently take over the balance
 * when its date arrives while the portfolio is the active controller.
 */
async function assertNoFutureManualValuation(
  exec: Executor,
  accountId: string,
  today: string
): Promise<void> {
  const [row] = await exec
    .select({ date: entries.date })
    .from(entries)
    .where(
      and(
        eq(entries.accountId, accountId),
        eq(entries.entryableType, "valuation"),
        gt(entries.date, today),
        or(isNull(entries.externalSource), ne(entries.externalSource, HOLDINGS_SOURCE))
      )
    )
    .orderBy(asc(entries.date))
    .limit(1);
  if (row) {
    throw errors.validation(
      `This account has a valuation dated ${row.date}, in the future. Remove it or change its date before adding holdings — it would override the portfolio value when its date arrives.`
    );
  }
}

/**
 * Guard for transitions INTO holdings management (the account currently
 * has no holdings): refuses while a future-dated manual valuation exists.
 * Call inside the account's holdings lock, before the first position is
 * written. No-op once any holding exists.
 */
export async function assertHoldingsActivationAllowed(
  exec: Executor,
  actor: Actor,
  accountId: string
): Promise<void> {
  if ((await countHoldings(exec, accountId)) > 0) return;
  const today = await familyToday(exec, actor.familyId);
  await assertNoFutureManualValuation(exec, accountId, today);
}

async function loadViewableAccount(
  exec: Executor,
  actor: Actor,
  accountId: string
): Promise<AccountRow> {
  await assertAccountAccessLevel(exec, actor, accountId);
  const [account] = await exec.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) throw errors.notFound("Account");
  return account;
}

/** Full-control + open + other_asset + valuation-tracked + not-MeroShare-linked guard for mutations. */
export async function loadManagedAccount(
  exec: Executor,
  actor: Actor,
  accountId: string
): Promise<AccountRow> {
  const level = await assertAccountAccessLevel(exec, actor, accountId);
  if (level !== "full_control") {
    throw errors.forbidden("Only full-control access can manage holdings.");
  }
  const { account } = await assertAccountOpen(exec, actor, accountId, "manage");
  if (account.type !== "other_asset") {
    throw errors.validation("Holdings can only be managed on other-asset accounts.");
  }
  if (!isValuationTracked(account)) {
    throw errors.validation(
      "This account tracks its balance from its transactions, so holdings would not affect it. Switch the account to valuation tracking (Account settings → Balance tracking) before managing holdings."
    );
  }
  if (await accountHasActiveMeroShareLink(exec, account.id)) {
    throw errors.validation(
      "This account is linked to MeroShare and its value is managed by that sync. Disconnect MeroShare before managing holdings manually."
    );
  }
  return account;
}

async function familyToday(exec: Executor, familyId: string): Promise<string> {
  const [family] = await exec
    .select({ timezone: families.timezone })
    .from(families)
    .where(eq(families.id, familyId))
    .limit(1);
  return todayIn(family?.timezone ?? "Etc/UTC");
}

/**
 * Recompute the portfolio total from the account's holdings and persist it
 * as today's valuation entry (one holdings valuation per day), then
 * recalculate balances from today. The previous holdings entry for the
 * date is REPLACED, not updated in place: balances pick the same-date
 * valuation by write order, so a fresh insert — stamped at
 * statement-execution time, under the account lock — is what makes the
 * active controller's write win over other entries for the date.
 *
 * This is also the central priceability gate: EVERY holdings mutation
 * ends here, so before anything is published, every resulting position
 * must be priceable (see isPositionPriceable). A mutation whose end
 * state contains an unpriceable position is rejected and rolls back —
 * including a trade against a legacy restored position that was never
 * priced. An empty portfolio is priceable and publishes 0.
 *
 * Runs inside the caller's (locked) transaction. Returns the total and
 * the date used.
 */
export async function syncPortfolioValuation(
  exec: Executor,
  actor: Actor,
  account: AccountRow
): Promise<{ date: string; portfolioValueMinor: number; holdingsCount: number }> {
  const rows = await exec
    .select()
    .from(portfolioHoldings)
    .where(eq(portfolioHoldings.accountId, account.id))
    .orderBy(asc(portfolioHoldings.ticker));
  for (const row of rows) assertPositionPriceable(row);
  const total = summarizeHoldings(rows).totalValueMinor;
  const date = await familyToday(exec, actor.familyId);
  const ledgerAmount = displayToLedgerBalance(total, account.type);
  const externalId = `valuation:${date}`;

  const [existing] = await exec
    .select({ id: entries.id })
    .from(entries)
    .where(
      and(
        eq(entries.accountId, account.id),
        eq(entries.externalSource, HOLDINGS_SOURCE),
        eq(entries.externalId, externalId)
      )
    )
    .limit(1);
  if (existing) {
    // The valuations row is removed by the entries FK cascade.
    await exec.delete(entries).where(eq(entries.id, existing.id));
  }
  const [entry] = await exec
    .insert(entries)
    .values({
      accountId: account.id,
      date,
      amountMinor: ledgerAmount,
      currency: account.currency,
      name: HOLDINGS_VALUATION_NAME,
      externalSource: HOLDINGS_SOURCE,
      externalId,
      entryableType: "valuation",
      // Stamped at statement-execution time (after the account lock was
      // acquired), not the transaction-start default — see the header.
      createdAt: statementTimestamp()
    })
    .returning({ id: entries.id });
  if (!entry) throw errors.conflict("Could not record the portfolio valuation.");
  await exec.insert(valuations).values({ entryId: entry.id, kind: "current" });

  await recalculateAccount(exec, account.id, date);
  return { date, portfolioValueMinor: total, holdingsCount: rows.length };
}

export type HoldingMutationResult = {
  accountId: string;
  date: string;
  portfolioValueMinor: number;
  holdingsCount: number;
};

export async function listHoldings(
  exec: Executor,
  actor: Actor,
  accountId: string
): Promise<PortfolioHoldingRow[]> {
  await loadViewableAccount(exec, actor, accountId);
  return exec
    .select()
    .from(portfolioHoldings)
    .where(eq(portfolioHoldings.accountId, accountId))
    .orderBy(asc(portfolioHoldings.ticker));
}

export async function addHolding(
  exec: Executor,
  actor: Actor,
  input: {
    accountId: string;
    ticker: string;
    companyName?: string | null;
    quantity: string;
    averageCostMinor?: number | null;
    currentPriceMinor?: number | null;
  }
): Promise<HoldingMutationResult & { holdingId: string }> {
  const account = await loadManagedAccount(exec, actor, input.accountId);
  const ticker = normalizeTicker(input.ticker);
  assertValidTicker(ticker);
  const { scaled, normalized } = parseQuantity(input.quantity);
  if (scaled === 0n) {
    throw errors.validation("Quantity must be greater than zero.");
  }
  const averageCostMinor = assertPriceMinor(input.averageCostMinor, "Average cost");
  const currentPriceMinor = assertPriceMinor(input.currentPriceMinor, "Current price");
  // A new position's supplied cost covers its whole initial quantity, so
  // priceability here reduces to "at least one price present".
  assertPositionPriceable({
    ticker,
    quantity: normalized,
    averageCostMinor,
    averageCostQuantity: averageCostMinor !== null ? normalized : "0",
    currentPriceMinor
  });
  const companyName = input.companyName?.trim() ? input.companyName.trim().slice(0, 200) : null;

  let holdingId = "";
  const result = await withHoldingsAccountLock(exec, account.id, async (tx) => {
    // Re-resolve the managed-account guards inside the lock: the checks
    // above ran before this writer queued on it, and a balance-tracking
    // switch holding the same lock may have committed in between.
    const managed = await loadManagedAccount(tx, actor, account.id);
    await assertHoldingsActivationAllowed(tx, actor, account.id);
    const [duplicate] = await tx
      .select({ id: portfolioHoldings.id })
      .from(portfolioHoldings)
      .where(and(eq(portfolioHoldings.accountId, account.id), eq(portfolioHoldings.ticker, ticker)))
      .limit(1);
    if (duplicate) {
      throw errors.validation(
        `A holding for ${ticker} already exists on this account. Edit it instead.`
      );
    }
    const [row] = await tx
      .insert(portfolioHoldings)
      .values({
        accountId: account.id,
        ticker,
        companyName,
        quantity: normalized,
        averageCostMinor,
        // An explicitly supplied cost describes the whole new position.
        averageCostQuantity: averageCostMinor !== null ? normalized : "0",
        currentPriceMinor
      })
      .returning({ id: portfolioHoldings.id });
    if (!row) throw errors.conflict("Could not create the holding.");
    holdingId = row.id;
    return syncPortfolioValuation(tx, actor, managed);
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "holding.created",
    entityType: "account",
    entityId: account.id,
    metadata: { accountId: account.id, ticker }
  });

  return { accountId: account.id, holdingId, ...result };
}

async function loadHolding(
  exec: Executor,
  accountId: string,
  holdingId: string
): Promise<PortfolioHoldingRow> {
  const [row] = await exec
    .select()
    .from(portfolioHoldings)
    .where(and(eq(portfolioHoldings.id, holdingId), eq(portfolioHoldings.accountId, accountId)))
    .limit(1);
  if (!row) throw errors.notFound("Holding");
  return row;
}

export async function updateHolding(
  exec: Executor,
  actor: Actor,
  input: {
    accountId: string;
    holdingId: string;
    companyName?: string | null;
    quantity: string;
    averageCostMinor?: number | null;
    currentPriceMinor?: number | null;
    /**
     * Explicit assertion that the supplied average cost covers EVERY
     * share of the position. Without it, an edit PRESERVES cost
     * provenance: the supplied average re-prices only the previously
     * known portion, and the known quantity stays as stored (clamped
     * down if the edit shrinks the position below it; shares added by a
     * quantity increase are cost-unknown). This matters because the
     * edit form prefills the stored average — resubmitting it unchanged
     * (a price-only or name-only edit) must not silently promote a
     * partial cost to full coverage. When the stored cost is unknown
     * (known portion zero), a cost supplied without the assertion is
     * recorded but applies to zero shares until coverage is asserted;
     * the form's copy says so next to the checkbox that sets this flag.
     */
    costCoversAllShares?: boolean;
  }
): Promise<HoldingMutationResult> {
  const account = await loadManagedAccount(exec, actor, input.accountId);
  const { scaled, normalized } = parseQuantity(input.quantity);
  if (scaled === 0n) {
    throw errors.validation("Quantity must be greater than zero. Delete the holding instead.");
  }
  const averageCostMinor = assertPriceMinor(input.averageCostMinor, "Average cost");
  const currentPriceMinor = assertPriceMinor(input.currentPriceMinor, "Current price");
  const companyName = input.companyName?.trim() ? input.companyName.trim().slice(0, 200) : null;

  let ticker = "";
  const result = await withHoldingsAccountLock(exec, account.id, async (tx) => {
    // Re-resolve the guards inside the lock (see addHolding).
    const managed = await loadManagedAccount(tx, actor, account.id);
    const holding = await loadHolding(tx, account.id, input.holdingId);
    ticker = holding.ticker;
    let averageCostQuantity: string;
    if (averageCostMinor === null) {
      // Clearing the cost makes the whole position's cost unknown.
      averageCostQuantity = "0";
    } else if (input.costCoversAllShares) {
      averageCostQuantity = normalized;
    } else {
      const known = knownCostScaled(holding);
      averageCostQuantity = formatQuantity(known > scaled ? scaled : known);
    }
    // The resulting position must be priceable (the sync re-checks the
    // whole account centrally; checking here names this holding before
    // anything is written).
    assertPositionPriceable({
      ticker: holding.ticker,
      quantity: normalized,
      averageCostMinor,
      averageCostQuantity,
      currentPriceMinor
    });
    await tx
      .update(portfolioHoldings)
      .set({
        companyName,
        quantity: normalized,
        averageCostMinor,
        averageCostQuantity,
        currentPriceMinor,
        updatedAt: new Date()
      })
      .where(eq(portfolioHoldings.id, holding.id));
    return syncPortfolioValuation(tx, actor, managed);
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "holding.updated",
    entityType: "account",
    entityId: account.id,
    metadata: { accountId: account.id, ticker }
  });

  return { accountId: account.id, ...result };
}

export async function deleteHolding(
  exec: Executor,
  actor: Actor,
  input: { accountId: string; holdingId: string }
): Promise<HoldingMutationResult> {
  const account = await loadManagedAccount(exec, actor, input.accountId);

  let ticker = "";
  const result = await withHoldingsAccountLock(exec, account.id, async (tx) => {
    // Re-resolve the guards inside the lock (see addHolding).
    const managed = await loadManagedAccount(tx, actor, account.id);
    const holding = await loadHolding(tx, account.id, input.holdingId);
    ticker = holding.ticker;
    await tx.delete(portfolioHoldings).where(eq(portfolioHoldings.id, holding.id));
    return syncPortfolioValuation(tx, actor, managed);
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "holding.deleted",
    entityType: "account",
    entityId: account.id,
    metadata: { accountId: account.id, ticker }
  });

  return { accountId: account.id, ...result };
}

/**
 * Record a buy or sell against a holding, creating it on a first buy.
 *
 * Buy: the bought shares join the cost-known portion of the position at
 * the trade price — the average cost becomes the quantity-weighted
 * average over the known portion (existing known shares at their average
 * plus the new shares at the trade price). Shares whose cost was never
 * recorded stay unknown: buying never fabricates a cost for them. A buy
 * into a brand-new position seeds its cost (and current price) from the
 * trade price.
 * Sell: the quantity decreases, consuming the cost-unknown portion first
 * so documented cost survives longest; the per-share average cost of the
 * remaining known portion is unchanged. Selling the entire position
 * removes the holding (`removed: true`).
 * A trade never changes the stored current price, except that a holding
 * created by a buy starts with the trade price as its current price.
 */
export async function adjustHolding(
  exec: Executor,
  actor: Actor,
  input: {
    accountId: string;
    ticker: string;
    side: "buy" | "sell";
    quantity: string;
    priceMinor: number;
  }
): Promise<HoldingMutationResult & { removed: boolean }> {
  const account = await loadManagedAccount(exec, actor, input.accountId);
  const ticker = normalizeTicker(input.ticker);
  assertValidTicker(ticker);
  const { scaled: tradeScaled } = parseQuantity(input.quantity);
  if (tradeScaled === 0n) throw errors.validation("Quantity must be greater than zero.");
  const priceMinor = assertPriceMinor(input.priceMinor, "Price");
  if (priceMinor === null) throw errors.validation("Enter the trade price.");

  let removed = false;
  const result = await withHoldingsAccountLock(exec, account.id, async (tx) => {
    // Re-resolve the guards inside the lock (see addHolding).
    const managed = await loadManagedAccount(tx, actor, account.id);
    const [existing] = await tx
      .select()
      .from(portfolioHoldings)
      .where(and(eq(portfolioHoldings.accountId, account.id), eq(portfolioHoldings.ticker, ticker)))
      .limit(1);

    if (input.side === "buy") {
      if (!existing) {
        await assertHoldingsActivationAllowed(tx, actor, account.id);
        await tx.insert(portfolioHoldings).values({
          accountId: account.id,
          ticker,
          companyName: null,
          quantity: formatQuantity(tradeScaled),
          averageCostMinor: priceMinor,
          averageCostQuantity: formatQuantity(tradeScaled),
          currentPriceMinor: priceMinor
        });
      } else {
        const { scaled: heldScaled } = parseQuantity(existing.quantity);
        const knownScaled = knownCostScaled(existing);
        const newKnownScaled = knownScaled + tradeScaled;
        const previousAverage = existing.averageCostMinor ?? 0;
        const averageCostMinor = Number(
          (knownScaled * BigInt(previousAverage) +
            tradeScaled * BigInt(priceMinor) +
            newKnownScaled / 2n) /
            newKnownScaled
        );
        await tx
          .update(portfolioHoldings)
          .set({
            quantity: formatQuantity(heldScaled + tradeScaled),
            averageCostMinor,
            averageCostQuantity: formatQuantity(newKnownScaled),
            updatedAt: new Date()
          })
          .where(eq(portfolioHoldings.id, existing.id));
      }
    } else {
      if (!existing) {
        throw errors.validation(`You do not hold ${ticker} on this account.`);
      }
      const { scaled: heldScaled } = parseQuantity(existing.quantity);
      if (tradeScaled > heldScaled) {
        throw errors.validation(
          `You cannot sell ${formatQuantity(tradeScaled)} shares of ${ticker}; only ${existing.quantity} are held.`
        );
      }
      if (tradeScaled === heldScaled) {
        await tx.delete(portfolioHoldings).where(eq(portfolioHoldings.id, existing.id));
        removed = true;
      } else {
        const knownScaled = knownCostScaled(existing);
        const unknownScaled = heldScaled - knownScaled;
        const fromUnknown = tradeScaled < unknownScaled ? tradeScaled : unknownScaled;
        const newKnownScaled = knownScaled - (tradeScaled - fromUnknown);
        await tx
          .update(portfolioHoldings)
          .set({
            quantity: formatQuantity(heldScaled - tradeScaled),
            averageCostMinor: newKnownScaled === 0n ? null : existing.averageCostMinor,
            averageCostQuantity: formatQuantity(newKnownScaled),
            updatedAt: new Date()
          })
          .where(eq(portfolioHoldings.id, existing.id));
      }
    }
    return syncPortfolioValuation(tx, actor, managed);
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "holding.adjusted",
    entityType: "account",
    entityId: account.id,
    metadata: { accountId: account.id, ticker, side: input.side }
  });

  return { accountId: account.id, removed, ...result };
}
