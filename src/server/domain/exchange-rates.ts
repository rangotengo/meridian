import { desc, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { exchangeRates } from "../db/schema";
import { isValidCurrency, currencyExponent } from "@/lib/money";
import { errors } from "@/lib/errors";
import { diffDays, isIsoDate } from "@/lib/datetime";

/** A rate that was actually used / stored, with the date it was quoted on. */
export type RateInfo = { base: string; quote: string; rate: string; quotedOn: string };

/** Rates older than this many days are surfaced as stale in the UI. */
export const FX_STALE_DAYS = 30;

export function isStaleRate(quotedOn: string, today: string, staleDays = FX_STALE_DAYS): boolean {
  if (!isIsoDate(quotedOn) || !isIsoDate(today)) return false;
  return diffDays(today, quotedOn) > staleDays;
}

export async function upsertRate(
  exec: Executor,
  input: { base: string; quote: string; rate: string; quotedOn: string }
): Promise<void> {
  const base = input.base.toUpperCase();
  const quote = input.quote.toUpperCase();
  if (!isValidCurrency(base) || !isValidCurrency(quote))
    throw errors.validation("Unknown currency code.");
  if (base === quote) throw errors.validation("Base and quote currencies must differ.");
  const rate = Number(input.rate);
  if (!Number.isFinite(rate) || rate <= 0)
    throw errors.validation("Rate must be a positive number.");
  if (!isIsoDate(input.quotedOn)) throw errors.validation("Quoted-on date must be YYYY-MM-DD.");
  await exec
    .insert(exchangeRates)
    .values({
      baseCurrency: base,
      quoteCurrency: quote,
      rate: input.rate,
      quotedOn: input.quotedOn
    })
    .onConflictDoUpdate({
      target: [exchangeRates.baseCurrency, exchangeRates.quoteCurrency, exchangeRates.quotedOn],
      set: { rate: input.rate }
    });
}

export async function getRateInfo(
  exec: Executor,
  base: string,
  quote: string,
  onOrBefore: string
): Promise<RateInfo | null> {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();
  if (b === q) return { base: b, quote: q, rate: "1", quotedOn: onOrBefore };
  const res = await exec.execute<{ rate: string; quoted_on: string }>(sql`
    SELECT CAST(rate AS TEXT) AS rate, CAST(quoted_on AS TEXT) AS quoted_on FROM (
      SELECT rate, quoted_on FROM exchange_rates
      WHERE base_currency = ${b} AND quote_currency = ${q}
        AND quoted_on <= ${onOrBefore}
      UNION ALL
      SELECT 1.0 / CAST(rate AS NUMERIC) AS rate, quoted_on FROM exchange_rates
      WHERE base_currency = ${q} AND quote_currency = ${b}
        AND quoted_on <= ${onOrBefore}
    ) pairs
    ORDER BY quoted_on DESC
    LIMIT 1
  `);
  const row = (res.rows ?? [])[0];
  if (!row) return null;
  return { base: b, quote: q, rate: row.rate, quotedOn: String(row.quoted_on ?? "").slice(0, 10) };
}

export async function getRate(
  exec: Executor,
  base: string,
  quote: string,
  onOrBefore: string
): Promise<string | null> {
  const info = await getRateInfo(exec, base, quote, onOrBefore);
  return info?.rate ?? null;
}

/**
 * Latest stored rate for every ordered pair, newest quoted_on first per pair.
 * Deliberately returns only pairs that were explicitly stored (no derived
 * inverses) so the settings UI shows exactly what exists in the table.
 */
export async function listLatestRates(exec: Executor): Promise<RateInfo[]> {
  const rows = await exec
    .select({
      base: exchangeRates.baseCurrency,
      quote: exchangeRates.quoteCurrency,
      rate: exchangeRates.rate,
      quotedOn: exchangeRates.quotedOn
    })
    .from(exchangeRates)
    .orderBy(desc(exchangeRates.quotedOn));
  const latest = new Map<string, RateInfo>();
  for (const r of rows) {
    const key = `${r.base}:${r.quote}`;
    if (!latest.has(key)) {
      latest.set(key, {
        base: r.base,
        quote: r.quote,
        rate: String(r.rate),
        quotedOn: String(r.quotedOn).slice(0, 10)
      });
    }
  }
  return [...latest.values()].sort((a, b) =>
    `${a.base}${a.quote}`.localeCompare(`${b.base}${b.quote}`)
  );
}

export function convertMinor(
  amountMinor: number,
  rate: string | number,
  fromCurrency?: string,
  toCurrency?: string
): number {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) throw errors.validation("Invalid exchange rate.");

  let scale = 1;
  if (fromCurrency && toCurrency) {
    const fromExp = currencyExponent(fromCurrency);
    const toExp = currencyExponent(toCurrency);
    scale = 10 ** (toExp - fromExp);
  }

  const converted = amountMinor * r * scale;
  if (Math.abs(converted) > Number.MAX_SAFE_INTEGER) {
    throw errors.money("Converted amount exceeds the supported range.");
  }
  return converted >= 0 ? Math.round(converted) : -Math.round(-converted);
}
