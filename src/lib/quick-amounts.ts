import { minorToDecimal, tryParseAmountToMinor } from "./money";

/** Amount chips shown under the Quick Add amount field, in major units. */
export const QUICK_AMOUNT_CHIPS = [100, 500, 1000, 5000] as const;

/**
 * Add a chip amount to the current draft amount. Amounts stay in integer
 * minor units throughout, so 0.1 + 0.2 style float errors cannot creep in.
 * An unparseable draft is treated as empty; the result is a decimal string
 * the amount field can display and the server can parse back.
 */
export function addAmountToDraft(
  current: string,
  addMinor: number,
  currency: string
): string {
  const currentMinor = tryParseAmountToMinor(current.trim(), currency) ?? 0;
  return minorToDecimal(currentMinor + addMinor, currency);
}
