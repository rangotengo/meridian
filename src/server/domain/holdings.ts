import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../db/client";
import { accounts, entries, families, portfolioHoldings, valuations } from "../db/schema";
import type { Actor } from "../auth/context";
import { assertAccountAccessLevel, assertAccountOpen } from "../authorization/access";
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
 * mutation recomputes the portfolio total and upserts a valuation entry for
 * today (externalSource "holdings", one per day, updated in place), then
 * recalculates balances — so the account balance always equals the sum of
 * its holdings. Manual valuations are rejected by the valuations domain
 * while holdings exist (see valuations.ts).
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

function assertValidTicker(ticker: string): void {
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

export type HoldingsSummary = {
  totalValueMinor: number;
  /** Σ quantity × average cost over holdings whose cost is known; null when none is. */
  totalCostMinor: number | null;
  /** True when at least one holding has no average cost, so the cost total is partial. */
  partialCost: boolean;
  /** Gain over the cost-known holdings only; null when no cost is known. */
  unrealizedGainMinor: number | null;
  unrealizedGainPercent: number | null;
};

export function summarizeHoldings(rows: PortfolioHoldingRow[]): HoldingsSummary {
  let totalValueMinor = 0;
  let totalCostMinor: number | null = null;
  let coveredValueMinor = 0;
  let partialCost = false;
  for (const row of rows) {
    const { scaled } = parseQuantity(row.quantity);
    const unitPrice = row.currentPriceMinor ?? row.averageCostMinor ?? 0;
    const value = holdingValueMinor(scaled, unitPrice);
    totalValueMinor += value;
    if (row.averageCostMinor === null) {
      if (scaled > 0n) partialCost = true;
      continue;
    }
    totalCostMinor = (totalCostMinor ?? 0) + holdingValueMinor(scaled, row.averageCostMinor);
    coveredValueMinor += value;
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

/** Full-control + open + other_asset guard shared by every holdings mutation. */
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
 * as today's valuation entry (upserted — one holdings valuation per day),
 * then recalculate balances from today. Runs inside the caller's executor,
 * which actions wrap in a transaction. Returns the total and the date used.
 */
export async function syncPortfolioValuation(
  exec: Executor,
  actor: Actor,
  account: AccountRow
): Promise<{ date: string; portfolioValueMinor: number; holdingsCount: number }> {
  const rows = await exec
    .select()
    .from(portfolioHoldings)
    .where(eq(portfolioHoldings.accountId, account.id));
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
    await exec
      .update(entries)
      .set({ amountMinor: ledgerAmount, updatedAt: new Date() })
      .where(eq(entries.id, existing.id));
  } else {
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
        entryableType: "valuation"
      })
      .returning({ id: entries.id });
    if (!entry) throw errors.conflict("Could not record the portfolio valuation.");
    await exec.insert(valuations).values({ entryId: entry.id, kind: "current" });
  }

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
  const companyName = input.companyName?.trim() ? input.companyName.trim().slice(0, 200) : null;

  const [duplicate] = await exec
    .select({ id: portfolioHoldings.id })
    .from(portfolioHoldings)
    .where(and(eq(portfolioHoldings.accountId, account.id), eq(portfolioHoldings.ticker, ticker)))
    .limit(1);
  if (duplicate) {
    throw errors.validation(
      `A holding for ${ticker} already exists on this account. Edit it instead.`
    );
  }

  let holdingId = "";
  const result = await exec.transaction(async (tx) => {
    const [row] = await tx
      .insert(portfolioHoldings)
      .values({
        accountId: account.id,
        ticker,
        companyName,
        quantity: normalized,
        averageCostMinor,
        currentPriceMinor
      })
      .returning({ id: portfolioHoldings.id });
    if (!row) throw errors.conflict("Could not create the holding.");
    holdingId = row.id;
    return syncPortfolioValuation(tx, actor, account);
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
  }
): Promise<HoldingMutationResult> {
  const account = await loadManagedAccount(exec, actor, input.accountId);
  const holding = await loadHolding(exec, account.id, input.holdingId);
  const { scaled, normalized } = parseQuantity(input.quantity);
  if (scaled === 0n) {
    throw errors.validation("Quantity must be greater than zero. Delete the holding instead.");
  }
  const averageCostMinor = assertPriceMinor(input.averageCostMinor, "Average cost");
  const currentPriceMinor = assertPriceMinor(input.currentPriceMinor, "Current price");
  const companyName = input.companyName?.trim() ? input.companyName.trim().slice(0, 200) : null;

  const result = await exec.transaction(async (tx) => {
    await tx
      .update(portfolioHoldings)
      .set({
        companyName,
        quantity: normalized,
        averageCostMinor,
        currentPriceMinor,
        updatedAt: new Date()
      })
      .where(eq(portfolioHoldings.id, holding.id));
    return syncPortfolioValuation(tx, actor, account);
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "holding.updated",
    entityType: "account",
    entityId: account.id,
    metadata: { accountId: account.id, ticker: holding.ticker }
  });

  return { accountId: account.id, ...result };
}

export async function deleteHolding(
  exec: Executor,
  actor: Actor,
  input: { accountId: string; holdingId: string }
): Promise<HoldingMutationResult> {
  const account = await loadManagedAccount(exec, actor, input.accountId);
  const holding = await loadHolding(exec, account.id, input.holdingId);

  const result = await exec.transaction(async (tx) => {
    await tx.delete(portfolioHoldings).where(eq(portfolioHoldings.id, holding.id));
    return syncPortfolioValuation(tx, actor, account);
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "holding.deleted",
    entityType: "account",
    entityId: account.id,
    metadata: { accountId: account.id, ticker: holding.ticker }
  });

  return { accountId: account.id, ...result };
}

/**
 * Record a buy or sell against a holding, creating it on a first buy.
 *
 * Buy: the average cost becomes the quantity-weighted average of the
 * existing position and the new shares at the trade price; when the
 * existing average cost is unknown, the trade price becomes the average.
 * Sell: the quantity decreases and the per-share average cost is unchanged;
 * selling the entire position removes the holding (`removed: true`).
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

  const [existing] = await exec
    .select()
    .from(portfolioHoldings)
    .where(and(eq(portfolioHoldings.accountId, account.id), eq(portfolioHoldings.ticker, ticker)))
    .limit(1);

  let removed = false;
  const result = await exec.transaction(async (tx) => {
    if (input.side === "buy") {
      if (!existing) {
        await tx.insert(portfolioHoldings).values({
          accountId: account.id,
          ticker,
          companyName: null,
          quantity: formatQuantity(tradeScaled),
          averageCostMinor: priceMinor,
          currentPriceMinor: priceMinor
        });
      } else {
        const { scaled: heldScaled } = parseQuantity(existing.quantity);
        const newScaled = heldScaled + tradeScaled;
        const averageCostMinor =
          existing.averageCostMinor === null
            ? priceMinor
            : Number(
                (heldScaled * BigInt(existing.averageCostMinor) +
                  tradeScaled * BigInt(priceMinor) +
                  newScaled / 2n) /
                  newScaled
              );
        await tx
          .update(portfolioHoldings)
          .set({ quantity: formatQuantity(newScaled), averageCostMinor, updatedAt: new Date() })
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
        await tx
          .update(portfolioHoldings)
          .set({ quantity: formatQuantity(heldScaled - tradeScaled), updatedAt: new Date() })
          .where(eq(portfolioHoldings.id, existing.id));
      }
    }
    return syncPortfolioValuation(tx, actor, account);
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
